# veris

[![npm version](https://img.shields.io/npm/v/veris-mcp.svg)](https://www.npmjs.com/package/veris-mcp) [![license](https://img.shields.io/npm/l/veris-mcp.svg)](./LICENSE) · `npx -y veris-mcp`

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
| **1. Clean + provenance** | search / read / research with verifiable source metadata | ✅ |
| **2. Finance vertical** | SEC EDGAR filings with authoritative, official provenance | ✅ |
| **3. Settlement** | license-aware access + micropayment + attribution | 🔜 seams in `policy.ts` + `cache.ts` |

The Stage 3 seams already exist in the code (`policy.ts`, `cache.ts`) so growth is additive, not a rewrite.

## Tools

**Web**

| Tool | Does |
|------|------|
| `web_search(query, n?)` | Ranked results as structured JSON. Brave (with key) or keyless DuckDuckGo. |
| `web_read(url, fresh?)` | URL → clean markdown + provenance block. 24h cache. |
| `web_research(query, n?)` | Search + read top N + bundle with per-source citations. |

**Finance — SEC EDGAR** (free, official, no API key)

| Tool | Does |
|------|------|
| `finance_filings(query, formType?, limit?)` | Ticker / name / CIK → recent SEC filings: form, official filing & report dates, accession, direct document URL. |
| `finance_filing_read(url or query, formType?)` | Read a filing by URL, or auto-read the latest matching form for a company. Clean text + provenance. |

> **Why EDGAR first?** Filings carry *authoritative* dates and identifiers straight from the SEC — provenance isn't guessed, it's official. Free, structured, no auth. One call gets an agent the latest 10-K with a verifiable source:
>
> ```
> finance_filing_read({ query: "NVDA", formType: "10-K" })
>   → NVIDIA CORP — 10-K (filed 2026-02-25)
>     clean text + { source, filed date, contentHash, wordCount }
> ```

## Install

```bash
npx -y veris-mcp        # zero-install, always latest
```

Or from source:

```bash
git clone https://github.com/jakeyoung1/veris && cd veris
npm install && npm run build
```

Optional env:

```bash
export BRAVE_API_KEY=your_key                      # better search; https://search.brave.com/app/keys
export SEC_USER_AGENT="Your Name you@email.com"    # SEC fair-access policy (recommended)
```

Without a Brave key, search falls back to keyless DuckDuckGo automatically. SEC requires a
`Name email@domain` style User-Agent — veris ships a default, but set your own contact.

## Use in Claude Code

Add to your MCP config (`.mcp.json`):

```json
{
  "mcpServers": {
    "veris": {
      "command": "npx",
      "args": ["-y", "veris-mcp"],
      "env": { "BRAVE_API_KEY": "optional", "SEC_USER_AGENT": "Your Name you@email.com" }
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
