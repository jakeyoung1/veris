// Shared types for the veris MCP server.
// Provenance is the core differentiator: AI normally gets clean text from
// readers like Jina/Firecrawl, but no verifiable source metadata. We attach it.

export interface LicenseInfo {
  // Populated by the policy layer (policy.ts). Every value points back to the
  // document it came from, so a caller can re-fetch and check it.
  robotsAllowed: boolean | null; // robots.txt verdict for VerisBot (null = could not check)
  rslDetected: boolean; // Really Simple Licensing reference present (page or robots.txt)?
  terms: string | null; // RSL <standard>/<custom> terms URL, else the page's rel=license
  priceHint: string | null; // e.g. "0.002 USD (crawl)" — ONLY from a declared RSL <amount>
  // Stage 3 provenance for the fields above. Optional so v0.2 cache entries still load.
  robotsUrl?: string | null; // robots.txt consulted
  robotsRule?: string | null; // exact matching line, e.g. "Disallow: /private"
  rslUrl?: string | null; // RSL document the terms/price were read from
  paymentType?: string | null; // RSL <payment type>: free | purchase | subscription | crawl | use | ...
  price?: PriceDeclaration | null; // structured form of priceHint
}

export interface PriceDeclaration {
  amount: string; // verbatim decimal from <amount>, never re-formatted
  currency: string | null; // <amount currency="">, null if the publisher omitted it
  paymentType: string;
  source: string; // RSL document URL
}

export interface Provenance {
  url: string; // final URL after redirects
  requestedUrl: string; // what the caller asked for
  canonicalUrl: string | null;
  fetchedAt: string; // ISO timestamp we retrieved it
  publishedAt: string | null; // best-effort from page metadata / JSON-LD
  modifiedAt: string | null;
  author: string | null;
  siteName: string | null;
  title: string | null;
  contentHash: string; // sha256 of extracted text — detects change, enables dedupe
  httpStatus: number;
  contentType: string | null;
  wordCount: number;
  license: LicenseInfo;
}

export interface ReadResult {
  content: string; // clean markdown
  provenance: Provenance;
  fromCache: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  rank: number;
}

export interface SearchResponse {
  query: string;
  provider: string;
  results: SearchResult[];
  fetchedAt: string;
}
