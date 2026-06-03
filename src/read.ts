// The crown jewel: fetch a URL, extract provenance, return clean markdown.
// Unlike a plain reader, we fetch the raw HTML ourselves so we can hash the
// content and pull published date / author / canonical / license BEFORE
// readability strips the page down.

import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { Provenance, ReadResult } from "./types.js";
import { detectLicense } from "./policy.js";

// Polite bot UA first (good web citizen); fall back to a browser UA only when a
// site hard-blocks the bot. Cuts easy 403s without lying by default.
const POLITE_UA = "VerisBot/0.1 (+https://github.com/veris-mcp; AI agent web access)";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 15000;
const BLOCK_STATUS = new Set([401, 403, 405, 406, 429]);

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

export async function readUrl(requestedUrl: string): Promise<ReadResult> {
  const fetchedAt = new Date().toISOString();

  const res = await fetchPage(requestedUrl);

  const finalUrl = res.url || requestedUrl;
  const contentType = res.headers.get("content-type");
  const httpStatus = res.status;
  if (!res.ok) {
    throw new Error(`Fetch failed: ${httpStatus} ${res.statusText} for ${requestedUrl}`);
  }

  const body = await res.text();
  const isHtml = (contentType ?? "").includes("html") || /^\s*<!?[a-z]/i.test(body);

  // Non-HTML (JSON, plain text, etc.): return as-is with minimal provenance.
  if (!isHtml) {
    const content = body.trim();
    return {
      content,
      provenance: baseProvenance({
        requestedUrl,
        finalUrl,
        fetchedAt,
        httpStatus,
        contentType,
        title: null,
        text: content,
        license: emptyLicense(),
      }),
      fromCache: false,
    };
  }

  const dom = new JSDOM(body, { url: finalUrl });
  const doc = dom.window.document;

  const meta = extractMetadata(doc);
  const license = await detectLicense(finalUrl, doc);

  // Readability mutates the document, so parse a clone.
  const reader = new Readability(doc.cloneNode(true) as Document);
  const article = reader.parse();

  const contentHtml = article?.content ?? doc.body?.innerHTML ?? "";
  let markdown = turndown.turndown(contentHtml).trim();
  // Fallback: if readability produced almost nothing, convert the cleaned body.
  if (markdown.length < 200) {
    const fallback = bodyFallbackMarkdown(doc);
    if (fallback.length > markdown.length) markdown = fallback;
  }
  const textForHash = (article?.textContent ?? markdown).trim();

  const provenance: Provenance = {
    url: finalUrl,
    requestedUrl,
    canonicalUrl: meta.canonical,
    fetchedAt,
    publishedAt: meta.published,
    modifiedAt: meta.modified,
    author: article?.byline ?? meta.author,
    siteName: article?.siteName ?? meta.siteName,
    title: article?.title ?? meta.title,
    contentHash: sha256(textForHash),
    httpStatus,
    contentType,
    wordCount: wordCount(textForHash),
    license,
  };

  return { content: markdown, provenance, fromCache: false };
}

interface MetaBits {
  title: string | null;
  canonical: string | null;
  published: string | null;
  modified: string | null;
  author: string | null;
  siteName: string | null;
}

function extractMetadata(doc: Document): MetaBits {
  const m = (sel: string, attr = "content"): string | null =>
    doc.querySelector(sel)?.getAttribute(attr)?.trim() || null;

  // JSON-LD usually holds the most reliable publish/modify dates and author.
  let ldPublished: string | null = null;
  let ldModified: string | null = null;
  let ldAuthor: string | null = null;
  for (const node of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(node.textContent || "");
      const graph: any[] = Array.isArray(data) ? data : [data, ...(data["@graph"] ?? [])];
      for (const obj of graph) {
        if (!obj || typeof obj !== "object") continue;
        ldPublished ??= obj.datePublished ?? null;
        ldModified ??= obj.dateModified ?? null;
        if (!ldAuthor && obj.author) {
          ldAuthor =
            typeof obj.author === "string" ? obj.author : (obj.author?.name ?? null);
        }
      }
    } catch {
      // ignore malformed ld+json
    }
  }

  return {
    title:
      m('meta[property="og:title"]') ??
      doc.querySelector("title")?.textContent?.trim() ??
      null,
    canonical:
      doc.querySelector('link[rel="canonical"]')?.getAttribute("href")?.trim() || null,
    published:
      ldPublished ??
      m('meta[property="article:published_time"]') ??
      m('meta[name="date"]') ??
      m('meta[name="pubdate"]') ??
      m('meta[itemprop="datePublished"]'),
    modified:
      ldModified ??
      m('meta[property="article:modified_time"]') ??
      m('meta[itemprop="dateModified"]'),
    author: ldAuthor ?? m('meta[name="author"]') ?? m('meta[property="article:author"]'),
    siteName: m('meta[property="og:site_name"]'),
  };
}

function baseProvenance(p: {
  requestedUrl: string;
  finalUrl: string;
  fetchedAt: string;
  httpStatus: number;
  contentType: string | null;
  title: string | null;
  text: string;
  license: Provenance["license"];
}): Provenance {
  return {
    url: p.finalUrl,
    requestedUrl: p.requestedUrl,
    canonicalUrl: null,
    fetchedAt: p.fetchedAt,
    publishedAt: null,
    modifiedAt: null,
    author: null,
    siteName: null,
    title: p.title,
    contentHash: sha256(p.text),
    httpStatus: p.httpStatus,
    contentType: p.contentType,
    wordCount: wordCount(p.text),
    license: p.license,
  };
}

function emptyLicense(): Provenance["license"] {
  return { robotsAllowed: null, rslDetected: false, terms: null, priceHint: null };
}

function reqHeaders(ua: string): Record<string, string> {
  return {
    "User-Agent": ua,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

async function fetchOnce(url: string, ua: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: reqHeaders(ua),
      redirect: "follow",
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function toFetchError(e: unknown, url: string): Error {
  if (e instanceof Error && e.name === "AbortError") {
    return new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s for ${url}`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

// Polite UA first; retry once with a browser UA if the site blocks the bot.
async function fetchPage(url: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetchOnce(url, POLITE_UA);
  } catch (e) {
    throw toFetchError(e, url);
  }
  if (BLOCK_STATUS.has(res.status)) {
    try {
      res = await fetchOnce(url, BROWSER_UA);
    } catch (e) {
      throw toFetchError(e, url);
    }
  }
  return res;
}

function bodyFallbackMarkdown(doc: Document): string {
  const body = doc.body;
  if (!body) return "";
  body
    .querySelectorAll("script,style,noscript,template,svg")
    .forEach((n) => n.remove());
  return turndown.turndown(body.innerHTML).trim();
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;
