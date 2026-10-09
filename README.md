# veris

[![CI](https://github.com/jakeyoung1/veris/actions/workflows/ci.yml/badge.svg)](https://github.com/jakeyoung1/veris/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/veris-mcp.svg)](https://www.npmjs.com/package/veris-mcp) [![license](https://img.shields.io/npm/l/veris-mcp.svg)](./LICENSE) · `npx -y veris-mcp`

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
| **3. Settlement** | license-aware access + attribution ledger + payment intents | ✅ v0.3.0 (payments stubbed, no money moves) |
| **3b. Live payments** | plug a provider (RSL license server / x402 / Stripe) into `settlement.ts` | 🔜 |

### Stage 3: what v0.3.0 does

Every content read passes a policy gate first: `web_read`, `web_research`, `finance_filing_read`, URL watches (`watch_manage` refuses to add a URL it may not read; `watch_check` reports it as `withheld` and keeps the old baseline), and filing reads in `veris-mcp digest`. EDGAR index lookups use the SEC JSON API and are not page reads.

1. **robots.txt.** Fetched per origin and matched for the `VerisBot` token (falls back to `*`), per RFC 9309: longest match wins, `*` and `$` wildcards, missing file = allow, 5xx = disallow. A disallowed URL returns `status: "blocked"` with the exact rule (e.g. `Disallow: /cgi-bin`) and the page is never requested.
2. **RSL licenses.** Discovered from robots.txt `License:` lines, `<link rel="license" type="application/rsl+xml">`, or inline `<script type="application/rsl+xml">`. The gate picks the `<content>` scope covering the URL and the license that permits `ai-input` use.
3. **Price.** If the license charges (`purchase`, `subscription`, `crawl`, `use`), the tool returns `status: "payment_required"` with the terms, price, and the RSL document URL instead of content. When the license is declared in robots.txt, the page is not fetched at all. `priceHint` is filled only from a declared `<amount>`, copied verbatim. A paid license with no amount reports `price: null`; veris never estimates one.
4. **Ledger.** Every read, block, and payment requirement is appended to `~/.veris/ledger.jsonl` (override `VERIS_LEDGER_FILE`) with URL, content hash, timestamp, tool, and the full license record. Entries are hash-chained, so edits or deletions are detectable: `veris-mcp ledger --verify`. List with `veris-mcp ledger [--kind read|blocked|payment_required|payment_intent] [--url U] [--since ISO] [--limit N]`.
5. **Settlement stub.** A paid license also records a `payment_intent` entry (declared price, terms, license server). The default provider is `none`: status `recorded`, nothing charged, content withheld. A real provider implements `PaymentProvider.authorize()` in `src/settlement.ts` and registers with `setPaymentProvider()`.

Every license field names its source (`robotsUrl` + `robotsRule`, `rslUrl`, `price.source`), so any verdict can be re-fetched and checked. Tool input schemas are unchanged from v0.2.

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
| `finance_financials(query)` | Revenue, net income, total assets, cash, diluted EPS from SEC XBRL — each figure stamped with the exact filing it came from. |

> **Why EDGAR first?** Filings carry *authoritative* dates and identifiers straight from the SEC — provenance isn't guessed, it's official. Free, structured, no auth. One call gets an agent the latest 10-K with a verifiable source:
>
> ```
> finance_filing_read({ query: "NVDA", formType: "10-K" })
>   → NVIDIA CORP — 10-K (filed 2026-02-25)
>     clean text + { source, filed date, contentHash, wordCount }
> ```

**Watch — change detection & alerts**

| Tool | Does |
|------|------|
| `watch_manage(action, target?, formType?)` | Add/remove/list watches: a company's SEC filings (ticker + optional form like `8-K`) or any URL (content-hash watch). |
| `watch_check()` | Check all watches; returns only what's NEW (new filings / changed pages) and rolls baselines forward. Run it on a schedule → alert feed. |

Filings watches default to **material forms only** — `8-K`, `10-K`, `10-Q`, `20-F`, `SC 13D/G`,
merger proxies, offerings, late-filing notices. Routine `Form 4` / `13F-HR` traffic is suppressed,
because an alert feed nobody reads is worse than none. Pass `formType: "ALL"` to see everything,
or a specific form to watch just that one.

## Alerts by email (`veris-mcp digest`)

`watch_check` returns JSON to an MCP client. `digest` turns the same data into an email a
human actually reads: it checks every watch, reads each new material filing, summarizes what
changed, and delivers it.

```bash
veris-mcp digest --dry-run          # print the digest, send nothing
veris-mcp digest                    # check, summarize, email
veris-mcp digest --to a@co.com      # override recipients
veris-mcp mailtest                  # verify SMTP without sending
```

Every summary carries verbatim quotes from the filing, and each quote is checked against the
source text before sending — quotes that can't be matched are flagged in the email rather than
presented as fact. Filings longer than the character budget are marked as partially read; they
are never silently truncated.

| Env | Does |
|-----|------|
| `ANTHROPIC_API_KEY` | Enables filing summaries. Without it, digests still send as raw filing notices. |
| `VERIS_SUMMARY_MODEL` | Model for summaries (default `claude-opus-5`). |
| `VERIS_SUMMARY_CHAR_BUDGET` | Chars of filing text summarized (default 250,000). |
| `VERIS_SMTP_URL` | e.g. `smtps://user:pass@smtp.gmail.com:465` |
| `VERIS_MAIL_FROM` | e.g. `"Veris Alerts <alerts@yourdomain>"` |
| `VERIS_MAIL_TO` | Comma-separated default recipients. |

Run it on a schedule for a live alert feed:

```bash
*/15 * * * * ANTHROPIC_API_KEY=... VERIS_SMTP_URL=... veris-mcp digest
```

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

## Remote server (HTTP)

Run veris as a remote MCP server (Streamable HTTP) and connect from any MCP client by URL:

```bash
npx -y veris-mcp http                            # http://127.0.0.1:8787/mcp
VERIS_HTTP_HOST=0.0.0.0 npx -y veris-mcp http    # expose it (put TLS in front)
```

| Env | Does |
|-----|------|
| `VERIS_PORT` / `PORT` | Port (default `8787`) |
| `VERIS_HTTP_HOST` | Bind host (default `127.0.0.1`) |
| `VERIS_API_KEYS` | Comma-separated keys. If set, `/mcp` requires `Authorization: Bearer <key>` (or `x-api-key`). Unset = open. |
| `VERIS_RATE_LIMIT` | Requests/min/IP (default `60`) |

Self-hosting is free, forever. `VERIS_API_KEYS` exists so a hosted instance can be metered.

### Docker

```bash
docker build -t veris .
docker run -p 8787:8787 veris
```

Works as-is on Fly.io / Render / Railway — anything that runs a Dockerfile.

## Design notes

- **Provenance from raw HTML.** We fetch the page ourselves and pull dates/author/canonical from `<meta>`, JSON-LD, and Open Graph *before* readability strips them.
- **Content hash.** sha256 of extracted text — detects whether a page changed and enables dedupe across agents (the basis for a shared web index).
- **Provider interface.** Swap search backends without touching tool code.
- **Cache + ledger.** `cache.ts` keeps the keyed read cache and the append-only, hash-chained attribution ledger side by side.

## License

MIT
