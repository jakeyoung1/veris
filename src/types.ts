// Shared types for the veris MCP server.
// Provenance is the core differentiator: AI normally gets clean text from
// readers like Jina/Firecrawl, but no verifiable source metadata. We attach it.

export interface LicenseInfo {
  // Populated by the policy layer. v0 = detection only, no enforcement / payment.
  robotsAllowed: boolean | null; // robots.txt verdict for our UA (null = unchecked)
  rslDetected: boolean; // Really Simple Licensing manifest present?
  terms: string | null; // license/terms URL if declared on the page
  priceHint: string | null; // future: per-read price if the site declares one
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
