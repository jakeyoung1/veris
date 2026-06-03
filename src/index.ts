#!/usr/bin/env node
// veris MCP server — provenance-first web access for AI agents.
// Tools: web_search, web_read, web_research.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getSearchProvider } from "./search.js";
import { readUrl } from "./read.js";
import { getFilings, getFinancials } from "./edgar.js";
import { FileCacheStore } from "./cache.js";
import type { ReadResult, SearchResponse } from "./types.js";

const cache = new FileCacheStore();
const READ_TTL = 24 * 60 * 60 * 1000; // 24h
const SEARCH_TTL = 60 * 60 * 1000; // 1h

const server = new McpServer({ name: "veris", version: "0.1.0" });

// --- web_search -----------------------------------------------------------
server.registerTool(
  "web_search",
  {
    title: "Web Search",
    description:
      "Search the web. Returns ranked results (title, url, snippet) as structured JSON. " +
      "Uses Brave Search when BRAVE_API_KEY is set, otherwise keyless DuckDuckGo.",
    inputSchema: {
      query: z.string().describe("Search query"),
      n: z.number().int().min(1).max(20).optional().describe("Max results (default 5)"),
    },
  },
  async ({ query, n }) => {
    const count = n ?? 5;
    const cacheKey = `search:${query}:${count}`;
    let resp = await cache.get<SearchResponse>(cacheKey);
    if (!resp) {
      const provider = getSearchProvider();
      const results = await provider.search(query, count);
      resp = {
        query,
        provider: provider.name,
        results,
        fetchedAt: new Date().toISOString(),
      };
      await cache.set(cacheKey, resp, SEARCH_TTL);
    }
    return { content: [{ type: "text", text: JSON.stringify(resp, null, 2) }] };
  },
);

// --- web_read -------------------------------------------------------------
server.registerTool(
  "web_read",
  {
    title: "Web Read (provenance-tracked)",
    description:
      "Fetch a URL and return clean markdown PLUS provenance: published date, author, " +
      "canonical URL, content hash, fetch time, and license signals. The provenance is the " +
      "point — verifiable source metadata an AI normally cannot get.",
    inputSchema: {
      url: z.string().url().describe("URL to read"),
      fresh: z.boolean().optional().describe("Bypass cache and refetch (default false)"),
    },
  },
  async ({ url, fresh }) => {
    const cacheKey = `read:${url}`;
    let result = fresh ? null : await cache.get<ReadResult>(cacheKey);
    let fromCache = result !== null;
    if (!result) {
      result = await readUrl(url);
      await cache.set(cacheKey, result, READ_TTL);
      fromCache = false;
    }
    const text =
      `## ${result.provenance.title ?? url}\n\n` +
      result.content +
      `\n\n---\n### Provenance\n\`\`\`json\n` +
      JSON.stringify({ ...result.provenance, fromCache }, null, 2) +
      `\n\`\`\``;
    return { content: [{ type: "text", text }] };
  },
);

// --- web_research ---------------------------------------------------------
server.registerTool(
  "web_research",
  {
    title: "Web Research (search + read + cite)",
    description:
      "One-shot research: search the web, fetch the top results, and return their clean content " +
      "bundled with full provenance per source. Ideal for grounding an answer with citations.",
    inputSchema: {
      query: z.string().describe("Research question or topic"),
      n: z.number().int().min(1).max(5).optional().describe("Sources to read (default 3)"),
    },
  },
  async ({ query, n }) => {
    const count = n ?? 3;
    const provider = getSearchProvider();
    const results = await provider.search(query, count);

    const reads = await Promise.allSettled(
      results.map(async (r) => {
        const key = `read:${r.url}`;
        const cached = await cache.get<ReadResult>(key);
        if (cached) return cached;
        const fresh = await readUrl(r.url);
        await cache.set(key, fresh, READ_TTL);
        return fresh;
      }),
    );

    const sections: string[] = [
      `# Research: ${query}\n_${count} sources via ${provider.name}_`,
    ];
    reads.forEach((settled, i) => {
      const src = results[i];
      if (settled.status === "fulfilled") {
        const { content, provenance } = settled.value;
        const excerpt =
          content.length > 4000 ? content.slice(0, 4000) + "\n…[truncated]" : content;
        sections.push(
          `## [${i + 1}] ${provenance.title ?? src.title}\n` +
            `Source: ${provenance.url}\n` +
            `Published: ${provenance.publishedAt ?? "unknown"} | ` +
            `Author: ${provenance.author ?? "unknown"} | ` +
            `Fetched: ${provenance.fetchedAt} | ` +
            `Hash: ${provenance.contentHash.slice(0, 12)}\n\n` +
            excerpt,
        );
      } else {
        sections.push(
          `## [${i + 1}] ${src.title}\nSource: ${src.url}\n_Failed to read: ${String(settled.reason)}_`,
        );
      }
    });

    return { content: [{ type: "text", text: sections.join("\n\n---\n\n") }] };
  },
);

// --- finance_filings (SEC EDGAR) ------------------------------------------
server.registerTool(
  "finance_filings",
  {
    title: "SEC Filings (EDGAR)",
    description:
      "List a company's recent SEC filings from EDGAR by ticker, name, or CIK. Free, official, " +
      "no API key. Returns form type, filing/report dates, accession number, and direct document " +
      "URL — provenance is authoritative (straight from SEC).",
    inputSchema: {
      query: z.string().describe("Ticker (e.g. NVDA), company name, or CIK"),
      formType: z.string().optional().describe('Filter by form, e.g. "10-K", "10-Q", "8-K"'),
      limit: z.number().int().min(1).max(50).optional().describe("Max filings (default 10)"),
    },
  },
  async ({ query, formType, limit }) => {
    const result = await getFilings(query, { formType, limit }, cache);
    const c = result.company;
    const lines: string[] = [
      `Company: ${c.name}${c.ticker ? ` (${c.ticker})` : ""} — CIK ${c.cik}` +
        (c.sicDescription ? ` — ${c.sicDescription}` : ""),
      `Source: ${result.source} (fetched ${result.fetchedAt})`,
      `${formType ? `Recent ${formType} filings` : "Recent filings"} (${result.filings.length}):`,
      "",
    ];
    result.filings.forEach((f, i) => {
      lines.push(
        `[${i + 1}] ${f.form} | filed ${f.filingDate}` +
          (f.reportDate ? ` | report ${f.reportDate}` : "") +
          ` | ${f.accession}\n    ${f.docUrl}`,
      );
    });
    lines.push("", "```json", JSON.stringify(result, null, 2), "```");
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// --- finance_filing_read --------------------------------------------------
server.registerTool(
  "finance_filing_read",
  {
    title: "Read SEC Filing",
    description:
      "Fetch and clean a specific SEC filing. Pass a filing document URL, OR a company query " +
      "plus formType to auto-read the most recent matching filing (e.g. latest 10-K for NVDA). " +
      "Returns clean text plus provenance.",
    inputSchema: {
      url: z.string().url().optional().describe("EDGAR filing document URL"),
      query: z.string().optional().describe("Ticker/name/CIK (used when url is omitted)"),
      formType: z.string().optional().describe('Form to auto-pick with query, e.g. "10-K"'),
    },
  },
  async ({ url, query, formType }) => {
    let docUrl = url;
    let header = "";
    let filed: string | null = null; // authoritative EDGAR filing date
    if (!docUrl) {
      if (!query) throw new Error("Provide either url, or query (+ optional formType).");
      const res = await getFilings(query, { formType, limit: 1 }, cache);
      const f = res.filings[0];
      if (!f) throw new Error(`No ${formType ?? ""} filing found for "${query}".`);
      docUrl = f.docUrl;
      filed = f.filingDate;
      header = `## ${res.company.name} — ${f.form} (filed ${f.filingDate})\n`;
    }
    const cacheKey = `read:${docUrl}`;
    let read = await cache.get<ReadResult>(cacheKey);
    if (!read) {
      read = await readUrl(docUrl);
      await cache.set(cacheKey, read, READ_TTL);
    }
    const MAX = 12000;
    const body =
      read.content.length > MAX
        ? read.content.slice(0, MAX) + "\n…[truncated — full content cached]"
        : read.content;
    const text =
      (header || `## ${read.provenance.title ?? docUrl}\n`) +
      `Source: ${docUrl}\n` +
      `Filed: ${filed ?? read.provenance.publishedAt ?? "see filing"} | ` +
      `Hash: ${read.provenance.contentHash.slice(0, 12)} | Words: ${read.provenance.wordCount}\n\n` +
      body;
    return { content: [{ type: "text", text }] };
  },
);

// --- finance_financials (SEC XBRL) ----------------------------------------
server.registerTool(
  "finance_financials",
  {
    title: "Company Financials (SEC XBRL)",
    description:
      "Key structured financials (revenue, net income, total assets, cash, diluted EPS) from SEC " +
      "XBRL data. Each figure is stamped with the exact filing it came from (form, filed date, " +
      "accession, fiscal period) — authoritative provenance. Ticker / name / CIK. No API key.",
    inputSchema: {
      query: z.string().describe("Ticker (e.g. NVDA), company name, or CIK"),
    },
  },
  async ({ query }) => {
    const { company, facts } = await getFinancials(query, cache);
    const money = (v: number, unit: string): string => {
      if (unit === "USD") {
        const a = Math.abs(v);
        if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
        if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
        return `$${Math.round(v).toLocaleString()}`;
      }
      if (unit.includes("shares")) return `$${v.toFixed(2)}`;
      return String(v);
    };
    const lines: string[] = [
      `Financials: ${company.name}${company.ticker ? ` (${company.ticker})` : ""} — CIK ${company.cik}`,
      "",
    ];
    if (!facts.length) {
      lines.push("_No us-gaap XBRL facts found for this company._");
    }
    facts.forEach((f) => {
      lines.push(
        `- **${f.label}**: ${money(f.value, f.unit)}  ` +
          `(${f.fiscalPeriod ?? "?"} ${f.fiscalYear ?? ""}, period end ${f.periodEnd})  ` +
          `— ${f.form} filed ${f.filed}, accession ${f.accession}`,
      );
    });
    lines.push("", "```json", JSON.stringify({ company, facts }, null, 2), "```");
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("veris MCP server running on stdio");
