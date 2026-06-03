# veris

**Provenance-first web access for AI agents.** Clean content *plus* verifiable source metadata, in one call.

Today an AI agent reading the web gets a wall of text. It does **not** get: when the page was published, whether the content changed since last time, who wrote it, the canonical source, or the license terms. veris attaches all of that to every read.

```
web_read("https://example.com/article")
  → clean markdown
  + { publishedAt, modifiedAt, author, canonicalUrl, contentHash, license, fetchedAt }
```

That metadata is not a nice-to-have. It is the foundation the rest of the AI-web economy needs: freshness, change-detection, citation, and — eventually — paying the people who wrote the content.

---

## Why this exists

The web is being scraped by AI with no attribution and no payment. Publishers are responding by blocking bots and locking content. AI gets worse; publishers lose. The fix is a layer between agents and publishers that reads cleanly, tracks provenance, and (later) settles payment.

veris is the **agent-side** of that layer — the SDK every agent imports to consume the web responsibly. Think "Plaid for the AI web": you don't own the publishers, you own the integration developers reach for.

## Roadmap (one codebase, three stages)

| Stage | What | Status |
|-------|------|--------|
| **1. Clean + provenance** | Search, read, research with verifiable source metadata | ✅ this repo |
| **2. Policy** | robots.txt + RSL parsing, license-aware fetching | 🚧 seam in `policy.ts` |
| **3. Settlement** | Micropayment + attribution handshake; cache becomes the ledger | 🔜 seam in `cache.ts` |

The Stage 2/3 seams already exist in the code so growth is additive, not a rewrite.

## Tools

| Tool | Does |
|------|------|
| `web_search(query, n?)` | Ranked results as structured JSON. Brave (with key) or keyless DuckDuckGo. |
| `web_read(url, fresh?)` | URL → clean markdown + provenance block. 24h cache. |
| `web_research(query, n?)` | Search + read top N + bundle with per-source citations. |

## Install

```bash
cd "mcp-servers/veris"
npm install
npm run build
```

Optional — better search quality with a free Brave key (2k queries/mo):

```bash
export BRAVE_API_KEY=your_key   # from https://search.brave.com/app/keys
```

Without a key it falls back to keyless DuckDuckGo automatically.

## Use in Claude Code

Add to your MCP config (`.mcp.json`):

```json
{
  "mcpServers": {
    "veris": {
      "command": "node",
      "args": ["mcp-servers/veris/dist/index.js"],
      "env": { "BRAVE_API_KEY": "optional_key_here" }
    }
  }
}
```

Restart Claude Code, then ask it to `web_research` something.

## Design notes

- **Provenance from raw HTML.** We fetch the page ourselves and pull dates/author/canonical from `<meta>`, JSON-LD, and Open Graph *before* readability strips them.
- **Content hash.** sha256 of extracted text — detects whether a page changed and enables dedupe across agents (the basis for a shared web index).
- **Provider interface.** Swap search backends without touching tool code.
- **Cache → ledger.** The same keyed store that caches reads today records read events for settlement tomorrow.

## License

MIT
