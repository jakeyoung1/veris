// Stage 3 settlement — STUB. No money moves.
//
// When the policy gate finds a paid RSL license, it records a payment intent
// in the ledger: what the publisher declared (price, terms, license server),
// verbatim. A real provider plugs in via setPaymentProvider(); until then the
// default provider returns "recorded" and never contacts anyone.
//
// Provider hook contract: authorize() must not deliver content itself. It
// returns a status + provider reference, which the ledger stores. Content is
// only released by a later read once a provider reports "authorized" (not
// wired yet; the gate still withholds paid content).

import { recordLedger, type LedgerEntry, type PaymentIntentRecord } from "./cache.js";
import type { RslTerms } from "./policy.js";
import type { LicenseInfo } from "./types.js";

export interface PaymentRequest {
  url: string;
  terms: RslTerms;
}

export interface PaymentResult {
  status: PaymentIntentRecord["status"];
  providerRef: string | null;
}

export interface PaymentProvider {
  name: string;
  authorize(req: PaymentRequest): Promise<PaymentResult>;
}

// Default: record only. Swap for an RSL license-server / x402 / Stripe client.
export const nullProvider: PaymentProvider = {
  name: "none",
  async authorize() {
    return { status: "recorded", providerRef: null };
  },
};

let provider: PaymentProvider = nullProvider;

export function setPaymentProvider(p: PaymentProvider): void {
  provider = p;
}

export function getPaymentProvider(): PaymentProvider {
  return provider;
}

export async function recordPaymentIntent(
  req: PaymentRequest,
  license: LicenseInfo,
  tool: string,
): Promise<LedgerEntry> {
  let result: PaymentResult;
  try {
    result = await provider.authorize(req);
  } catch {
    result = { status: "failed", providerRef: null };
  }
  return recordLedger({
    kind: "payment_intent",
    url: req.url,
    finalUrl: null,
    contentHash: null,
    fromCache: null,
    tool,
    license,
    reason: null,
    intent: {
      price: req.terms.price,
      terms: req.terms.terms,
      licenseServer: req.terms.server,
      provider: provider.name,
      status: result.status,
      providerRef: result.providerRef,
    },
  });
}
