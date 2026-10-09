// Policy gate: every content read goes through here (web_read, web_research,
// finance_filing_read). Kept apart from tools.ts so tool signatures and the
// gate can evolve independently.

import { readUrl } from "./read.js";
import { recordLedger, type CacheStore } from "./cache.js";
import { preflight, requiresPayment, formatPriceHint, type RslTerms } from "./policy.js";
import { recordPaymentIntent } from "./settlement.js";
import type { LicenseInfo, ReadResult } from "./types.js";

// Every content read goes through gatedRead(). Order:
//   1. robots.txt + robots-declared RSL (preflight) — before any content fetch
//   2. cache or fetch
//   3. page-level checks on what came back (redirect target's robots, page RSL)
// Blocked and paid outcomes never return or cache content, and every outcome
// lands in the ledger.

export type GateOutcome =
  | { status: "ok"; result: ReadResult; fromCache: boolean }
  | {
      status: "blocked";
      url: string;
      reason: string;
      robotsUrl: string | null;
      robotsRule: string | null;
      contentFetched: boolean;
    }
  | {
      status: "payment_required";
      url: string;
      price: RslTerms["price"];
      priceHint: string | null;
      paymentType: string | null;
      terms: string | null;
      rslUrl: string;
      licenseServer: string | null;
      contentFetched: boolean;
      ledgerIntentId: string;
      note: string;
    };

const SETTLEMENT_NOTE =
  "Payment intent recorded in the veris ledger. No payment was made and the content was " +
  "withheld. Settlement is not wired to a payment provider yet.";

async function blocked(
  url: string,
  tool: string,
  robotsUrl: string | null,
  robotsRule: string | null,
  license: LicenseInfo | null,
  contentFetched: boolean,
): Promise<GateOutcome> {
  const reason = `robots.txt disallows VerisBot${robotsRule ? ` (${robotsRule})` : ""}`;
  await recordLedger({
    kind: "blocked",
    url,
    finalUrl: null,
    contentHash: null,
    fromCache: null,
    tool,
    license,
    reason,
    intent: null,
  });
  return { status: "blocked", url, reason, robotsUrl, robotsRule, contentFetched };
}

async function paymentRequired(
  url: string,
  tool: string,
  terms: RslTerms,
  license: LicenseInfo,
  contentFetched: boolean,
): Promise<GateOutcome> {
  const reason = `RSL license requires payment (${terms.paymentType})`;
  await recordLedger({
    kind: "payment_required",
    url,
    finalUrl: null,
    contentHash: null,
    fromCache: null,
    tool,
    license,
    reason,
    intent: null,
  });
  const intent = await recordPaymentIntent({ url, terms }, license, tool);
  return {
    status: "payment_required",
    url,
    price: terms.price,
    priceHint: formatPriceHint(terms.price),
    paymentType: terms.paymentType,
    terms: terms.terms,
    rslUrl: terms.rslUrl,
    licenseServer: terms.server,
    contentFetched,
    ledgerIntentId: intent.id,
    note: terms.price
      ? SETTLEMENT_NOTE
      : SETTLEMENT_NOTE + " The publisher declared a paid license without an amount; see terms.",
  };
}

export function createGate(cache: CacheStore, readTtlMs: number) {
  return async function gatedRead(
    url: string,
    tool: string,
    opts: { fresh?: boolean } = {},
  ): Promise<GateOutcome> {
    const pf = await preflight(url);
    const preLicense: LicenseInfo = {
      robotsAllowed: pf.robots.allowed,
      rslDetected: pf.robots.licenseUrls.length > 0,
      terms: pf.rsl?.terms ?? null,
      priceHint: formatPriceHint(pf.rsl?.price ?? null),
      robotsUrl: pf.robots.robotsUrl,
      robotsRule: pf.robots.rule,
      rslUrl: pf.rsl?.rslUrl ?? null,
      paymentType: pf.rsl?.paymentType ?? null,
      price: pf.rsl?.price ?? null,
    };
    if (pf.robots.allowed === false) {
      return blocked(url, tool, pf.robots.robotsUrl, pf.robots.rule, preLicense, false);
    }
    if (requiresPayment(pf.rsl)) {
      return paymentRequired(url, tool, pf.rsl!, preLicense, false);
    }

    const cacheKey = `read:${url}`;
    let result = opts.fresh ? null : await cache.get<ReadResult>(cacheKey);
    const fromCache = result !== null;
    if (!result) result = await readUrl(url);

    // What the page itself (or its redirect target) declared.
    const lic = result.provenance.license;
    if (lic.robotsAllowed === false) {
      return blocked(url, tool, lic.robotsUrl ?? null, lic.robotsRule ?? null, lic, !fromCache);
    }
    if (lic.rslUrl && lic.paymentType) {
      const pageTerms: RslTerms = {
        rslUrl: lic.rslUrl,
        matched: true,
        paymentType: lic.paymentType,
        price: lic.price ?? null,
        terms: lic.terms,
        server: null,
      };
      if (requiresPayment(pageTerms)) {
        return paymentRequired(url, tool, pageTerms, lic, !fromCache);
      }
    }

    if (!fromCache) await cache.set(cacheKey, result, readTtlMs);
    await recordLedger({
      kind: "read",
      url,
      finalUrl: result.provenance.url,
      contentHash: result.provenance.contentHash,
      fromCache,
      tool,
      license: lic,
      reason: null,
      intent: null,
    });
    return { status: "ok", result, fromCache };
  };
}

export function renderWithheld(o: Exclude<GateOutcome, { status: "ok" }>): string {
  const title =
    o.status === "blocked"
      ? `## Blocked: ${o.url}\nrobots.txt disallows this URL for VerisBot. Content was not returned.`
      : `## Payment required: ${o.url}\n` +
        `The publisher's RSL license charges for this use` +
        (o.priceHint ? ` (${o.priceHint})` : "") +
        `. ${o.contentFetched ? "Content was withheld" : "Content was not fetched"}.`;
  return `${title}\n\n\`\`\`json\n${JSON.stringify(o, null, 2)}\n\`\`\``;
}
