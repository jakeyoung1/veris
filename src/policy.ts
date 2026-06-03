// STAGE 2/3 SEAM — keep this signature stable.
//
// v0: detection only. We surface licensing signals (robots, RSL, license links)
// so the agent KNOWS the terms. We do NOT enforce or pay yet.
//
// Stage 2: robots.txt fetch + UA matching fills robotsAllowed; gate fetches.
// Stage 3: parse RSL / price manifests, trigger the micropayment + attribution
//          handshake, and record settlement in the ledger (see cache.ts).

import type { LicenseInfo } from "./types.js";

export async function detectLicense(
  _url: string,
  doc: Document,
): Promise<LicenseInfo> {
  // RSL (Really Simple Licensing) advertises terms via a link element.
  const rslLink =
    doc.querySelector('link[rel="license"][type*="rsl"]') ??
    doc.querySelector('link[type="application/rsl+xml"]');

  const licenseLink =
    doc.querySelector('link[rel="license"]')?.getAttribute("href") || null;

  return {
    robotsAllowed: null, // wired in Stage 2
    rslDetected: rslLink !== null,
    terms: licenseLink,
    priceHint: null, // populated when RSL / price manifest is parsed (Stage 3)
  };
}
