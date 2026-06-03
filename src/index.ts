#!/usr/bin/env node
// veris MCP server — provenance-first web access for AI agents.
// Tools: web_search, web_read, web_research.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getSearchProvider } from "./search.js";
import { readUrl } from "./read.js";
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("veris MCP server running on stdio");
