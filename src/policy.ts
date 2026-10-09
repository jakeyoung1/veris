// STAGE 3 SEAM — keep detectLicense's signature stable.
//
// Detection: robots.txt verdict for our UA token, RSL (Really Simple Licensing)
// terms, and any declared per-use price. Every value we report points back to
// the document it came from (robotsUrl + matched rule, rslUrl), so a caller can
// re-fetch and check it. We never guess: no RSL <amount> → priceHint stays null.
//
// Enforcement lives in tools.ts (the policy gate). Settlement lives in
// settlement.ts and records into the ledger (cache.ts).

import { JSDOM } from "jsdom";
import type { LicenseInfo, PriceDeclaration } from "./types.js";

// Token we match in robots.txt groups. read.ts sends "VerisBot/0.1 (...)".
export const ROBOTS_TOKEN = "VerisBot";
const ROBOTS_UA = "VerisBot/0.1 (+https://github.com/jakeyoung1/veris; AI agent web access)";
// read.ts retries blocked content fetches with a browser UA, so robots.txt must
// be read the same way. Otherwise a site that 403s bots on robots.txt (sec.gov
// does) would look like "no robots.txt" and every path would pass.
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BLOCK_STATUS = new Set([401, 403, 405, 406, 429]);
const POLICY_TIMEOUT_MS = 8000;
const ROBOTS_TTL_MS = 60 * 60 * 1000;
const RSL_TTL_MS = 60 * 60 * 1000;

// Usage we claim when reading: grounding an agent's answer (RSL "ai-input").
export const OUR_USAGE = "ai-input";
// RSL payment types that cost money for an ai-input read. "training" only
// applies to training use; "free" / "attribution" carry no fee.
const PAID_TYPES = new Set(["purchase", "subscription", "crawl", "use"]);

// ---------------------------------------------------------------------------
// robots.txt (RFC 9309)

export interface RobotsVerdict {
  allowed: boolean | null; // null = could not determine (network error)
  robotsUrl: string;
  rule: string | null; // the exact matching line, e.g. "Disallow: /private"
  licenseUrls: string[]; // RSL "License:" directives found in robots.txt
}

interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; path: string; line: string }[];
}

interface ParsedRobots {
  status: "ok" | "none" | "unreachable" | "error";
  httpStatus: number | null;
  groups: RobotsGroup[];
  licenseUrls: string[];
}

const robotsMemo = new Map<string, { at: number; value: ParsedRobots }>();

export function parseRobots(body: string): { groups: RobotsGroup[]; licenseUrls: string[] } {
  const groups: RobotsGroup[] = [];
  const licenseUrls: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === "license") {
      if (value) licenseUrls.push(value);
      continue;
    }
    if ((field === "allow" || field === "disallow") && current) {
      // Empty Disallow means "allow everything"; it adds no rule.
      if (field === "disallow" && !value) continue;
      current.rules.push({
        allow: field === "allow",
        path: value,
        line: `${field === "allow" ? "Allow" : "Disallow"}: ${value}`,
      });
    }
  }
  return { groups, licenseUrls };
}

// robots path pattern → RegExp. Supports "*" and a trailing "$".
function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const esc = body
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + esc + (anchored ? "$" : ""));
}

// Pure verdict for one path. Exported so tests can pin the matching rules.
export function robotsAllows(
  groups: RobotsGroup[],
  pathWithQuery: string,
  token = ROBOTS_TOKEN,
): { allowed: boolean; rule: string | null } {
  const t = token.toLowerCase();
  // Most specific group: our token first, then "*". Merge all groups that name us.
  let chosen = groups.filter((g) => g.agents.some((a) => a !== "*" && a.split("/")[0] === t));
  if (!chosen.length) chosen = groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);

  // Longest match wins; on a tie, Allow wins (RFC 9309 §2.2.2).
  let best: { allow: boolean; path: string; line: string } | null = null;
  for (const r of rules) {
    if (!patternToRegex(r.path).test(pathWithQuery)) continue;
    if (
      !best ||
      r.path.length > best.path.length ||
      (r.path.length === best.path.length && r.allow && !best.allow)
    ) {
      best = r;
    }
  }
  if (!best) return { allowed: true, rule: null };
  return { allowed: best.allow, rule: best.line };
}

async function timedFetch(url: string, accept: string, ua = ROBOTS_UA): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POLICY_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "User-Agent": ua, Accept: accept },
      redirect: "follow",
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function loadRobots(origin: string): Promise<ParsedRobots> {
  const hit = robotsMemo.get(origin);
  if (hit && Date.now() - hit.at < ROBOTS_TTL_MS) return hit.value;
  let value: ParsedRobots;
  try {
    const url = `${origin}/robots.txt`;
    let res = await timedFetch(url, "text/plain,*/*;q=0.5");
    if (BLOCK_STATUS.has(res.status))
      res = await timedFetch(url, "text/plain,*/*;q=0.5", FALLBACK_UA);
    const httpStatus = res.status;
    if (res.ok) {
      value = { status: "ok", httpStatus, ...parseRobots(await res.text()) };
    } else if (res.status >= 400 && res.status < 500) {
      // RFC 9309 §2.3.1.3: unavailable (4xx) → crawler may access anything.
      value = { status: "none", httpStatus, groups: [], licenseUrls: [] };
    } else {
      // RFC 9309 §2.3.1.4: unreachable (5xx) → assume complete disallow.
      value = { status: "unreachable", httpStatus, groups: [], licenseUrls: [] };
    }
  } catch {
    value = { status: "error", httpStatus: null, groups: [], licenseUrls: [] };
  }
  robotsMemo.set(origin, { at: Date.now(), value });
  return value;
}

export async function checkRobots(url: string): Promise<RobotsVerdict> {
  const u = new URL(url);
  const robotsUrl = `${u.origin}/robots.txt`;
  const parsed = await loadRobots(u.origin);
  const licenseUrls = parsed.licenseUrls.map((l) => safeResolve(l, robotsUrl)).filter(isStr);
  switch (parsed.status) {
    case "none":
      return {
        allowed: true,
        robotsUrl,
        rule: `no robots.txt (HTTP ${parsed.httpStatus})`,
        licenseUrls,
      };
    case "unreachable":
      return {
        allowed: false,
        robotsUrl,
        rule: `robots.txt unreachable (HTTP ${parsed.httpStatus}), RFC 9309 full disallow`,
        licenseUrls,
      };
    case "error":
      return { allowed: null, robotsUrl, rule: null, licenseUrls };
  }
  const { allowed, rule } = robotsAllows(parsed.groups, u.pathname + u.search);
  return { allowed, robotsUrl, rule, licenseUrls };
}

// ---------------------------------------------------------------------------
// RSL (https://rslstandard.org) — XML license documents

export interface RslTerms {
  rslUrl: string; // where the terms came from (fetched URL, or page URL for inline)
  matched: boolean; // a <content> element covers the requested URL
  paymentType: string | null; // free | purchase | subscription | training | crawl | use | attribution
  price: PriceDeclaration | null; // only when <amount> is declared
  terms: string | null; // <standard> or <custom> link, if any
  server: string | null; // license server from <content server="">
}

const rslMemo = new Map<string, { at: number; xml: string | null }>();

const byLocal = (root: Document | Element, name: string): Element[] =>
  Array.from(root.getElementsByTagNameNS("*", name));
const childByLocal = (el: Element, name: string): Element | null =>
  Array.from(el.children).find((c) => c.localName === name) ?? null;

function contentCovers(contentUrl: string, target: URL): boolean {
  // Relative content URLs are scoped to the site being read (a collective
  // license file hosted elsewhere still applies to the referring site).
  let scope: URL;
  try {
    scope = new URL(contentUrl, target.origin);
  } catch {
    return false;
  }
  if (scope.origin !== target.origin) return false;
  return patternToRegex(scope.pathname + scope.search).test(target.pathname + target.search);
}

// Pure parser over an RSL XML string. Exported for tests.
export function parseRsl(xml: string, targetUrl: string, rslUrl: string): RslTerms {
  const empty: RslTerms = {
    rslUrl,
    matched: false,
    paymentType: null,
    price: null,
    terms: null,
    server: null,
  };
  let doc: Document;
  try {
    doc = new JSDOM(xml, { contentType: "text/xml" }).window.document;
  } catch {
    return empty;
  }
  if (doc.getElementsByTagName("parsererror").length) return empty;

  const target = new URL(targetUrl);
  // Most specific <content> that covers the URL (longest url attribute).
  const contents = byLocal(doc, "content")
    .filter((c) => contentCovers(c.getAttribute("url") ?? "", target))
    .sort((a, b) => (b.getAttribute("url") ?? "").length - (a.getAttribute("url") ?? "").length);
  const content = contents[0];
  if (!content) return empty;

  // First license that lets us read for ai-input.
  const license = byLocal(content, "license").find((lic) => {
    const prohibits = byLocal(lic, "prohibits")
      .filter((p) => (p.getAttribute("type") ?? "usage") === "usage")
      .flatMap((p) => tokens(p.textContent));
    if (prohibits.some((t) => coversUsage(t))) return false;
    const permits = byLocal(lic, "permits")
      .filter((p) => (p.getAttribute("type") ?? "usage") === "usage")
      .flatMap((p) => tokens(p.textContent));
    return permits.length === 0 || permits.some((t) => coversUsage(t));
  });

  const base: RslTerms = { ...empty, matched: true, server: content.getAttribute("server") };
  if (!license) return base;

  const payment = childByLocal(license, "payment");
  if (!payment) return { ...base, paymentType: "free" };
  const paymentType = (payment.getAttribute("type") ?? "free").trim().toLowerCase();
  const terms =
    childByLocal(payment, "standard")?.textContent?.trim() ||
    childByLocal(payment, "custom")?.textContent?.trim() ||
    null;

  let price: PriceDeclaration | null = null;
  const amountEl = childByLocal(payment, "amount");
  const amount = amountEl?.textContent?.trim() ?? "";
  // Verbatim decimal string — never parsed to float, never defaulted.
  if (amountEl && /^\d+(\.\d+)?$/.test(amount)) {
    price = {
      amount,
      currency: (amountEl.getAttribute("currency") ?? "").trim().toUpperCase() || null,
      paymentType,
      source: rslUrl,
    };
  }
  return { ...base, paymentType, price, terms };
}

const tokens = (s: string | null): string[] =>
  (s ?? "")
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
const coversUsage = (t: string): boolean => t === OUR_USAGE || t === "ai-all" || t === "all";

async function loadRslXml(rslUrl: string): Promise<string | null> {
  const hit = rslMemo.get(rslUrl);
  if (hit && Date.now() - hit.at < RSL_TTL_MS) return hit.xml;
  let xml: string | null = null;
  try {
    const res = await timedFetch(rslUrl, "application/rsl+xml,application/xml,text/xml;q=0.9");
    if (res.ok) xml = await res.text();
  } catch {
    xml = null;
  }
  rslMemo.set(rslUrl, { at: Date.now(), xml });
  return xml;
}

// Fetch each candidate RSL doc and return the first whose terms cover the URL.
export async function resolveRsl(targetUrl: string, rslUrls: string[]): Promise<RslTerms | null> {
  for (const rslUrl of rslUrls) {
    const xml = await loadRslXml(rslUrl);
    if (!xml) continue;
    const terms = parseRsl(xml, targetUrl, rslUrl);
    if (terms.matched) return terms;
  }
  return null;
}

export const requiresPayment = (t: RslTerms | null): boolean =>
  !!t && t.paymentType !== null && PAID_TYPES.has(t.paymentType);

export function formatPriceHint(p: PriceDeclaration | null): string | null {
  if (!p) return null;
  return `${p.amount}${p.currency ? " " + p.currency : ""} (${p.paymentType})`;
}

// ---------------------------------------------------------------------------
// Pre-fetch check used by the policy gate: robots + robots-declared RSL.
// Runs BEFORE the page is fetched, so a disallow or a price costs one small
// robots.txt request, never the content.

export interface Preflight {
  robots: RobotsVerdict;
  rsl: RslTerms | null;
}

export async function preflight(url: string): Promise<Preflight> {
  const robots = await checkRobots(url);
  const rsl = robots.licenseUrls.length ? await resolveRsl(url, robots.licenseUrls) : null;
  return { robots, rsl };
}

// ---------------------------------------------------------------------------

export async function detectLicense(url: string, doc: Document): Promise<LicenseInfo> {
  // Page-level RSL: <link rel="license" type="application/rsl+xml"> or inline script.
  const rslLinkEl =
    doc.querySelector('link[rel="license"][type*="rsl"]') ??
    doc.querySelector('link[type="application/rsl+xml"]');
  const inlineRsl = doc.querySelector('script[type="application/rsl+xml"]');

  const licenseLink = doc.querySelector('link[rel="license"]')?.getAttribute("href") || null;

  let robots: RobotsVerdict | null = null;
  try {
    robots = await checkRobots(url);
  } catch {
    robots = null; // bad URL etc. — leave unchecked rather than guess
  }

  let rsl: RslTerms | null = null;
  if (inlineRsl?.textContent) {
    const t = parseRsl(inlineRsl.textContent, url, url);
    if (t.matched) rsl = t;
  }
  if (!rsl) {
    const candidates = [
      safeResolve(rslLinkEl?.getAttribute("href") ?? "", url),
      ...(robots?.licenseUrls ?? []),
    ].filter(isStr);
    if (candidates.length) rsl = await resolveRsl(url, candidates);
  }

  return {
    robotsAllowed: robots?.allowed ?? null,
    rslDetected: rslLinkEl !== null || inlineRsl !== null || (robots?.licenseUrls.length ?? 0) > 0,
    terms: rsl?.terms ?? licenseLink,
    priceHint: formatPriceHint(rsl?.price ?? null),
    robotsUrl: robots?.robotsUrl ?? null,
    robotsRule: robots?.rule ?? null,
    rslUrl: rsl?.rslUrl ?? null,
    paymentType: rsl?.paymentType ?? null,
    price: rsl?.price ?? null,
  };
}

function safeResolve(href: string, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
const isStr = (s: string | null): s is string => typeof s === "string";
