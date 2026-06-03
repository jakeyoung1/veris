// SEC EDGAR — Stage 2 finance vertical. Free, official, provenance-native.
// No API key. SEC requires an identifying User-Agent (override via SEC_USER_AGENT).
// Docs: https://www.sec.gov/search-filings/edgar-application-programming-interfaces

import type { CacheStore } from "./cache.js";

// SEC's fair-access policy requires a "Name email@domain" style UA; a URL-style
// UA gets 403. Override with your own contact via SEC_USER_AGENT (recommended).
const SEC_UA = process.env.SEC_USER_AGENT ?? "veris-mcp admin@veris.dev";
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const submissionsUrl = (cik10: string): string =>
  `https://data.sec.gov/submissions/CIK${cik10}.json`;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export interface Company {
  cik: string; // 10-digit zero-padded
  name: string;
  ticker: string | null;
  sicDescription: string | null;
}

export interface FilingRef {
  form: string;
  filingDate: string;
  reportDate: string | null;
  accession: string;
  primaryDocument: string;
  primaryDocDescription: string | null;
  docUrl: string;
  indexUrl: string;
}

export interface FilingsResult {
  company: Company;
  filings: FilingRef[];
  source: string; // submissions URL — provenance
  fetchedAt: string;
}

async function secFetchJson<T>(
  url: string,
  cache: CacheStore,
  ttl: number,
): Promise<T> {
  const cacheKey = `edgar:${url}`;
  const cached = await cache.get<T>(cacheKey);
  if (cached) return cached;
  const res = await fetch(url, {
    headers: { "User-Agent": SEC_UA, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`SEC fetch failed: ${res.status} ${res.statusText} for ${url}`);
  }
  const data = (await res.json()) as T;
  await cache.set(cacheKey, data, ttl);
  return data;
}

const pad10 = (cik: string | number): string =>
  String(cik).replace(/\D/g, "").padStart(10, "0");

export async function resolveCompany(
  query: string,
  cache: CacheStore,
): Promise<Company | null> {
  const q = query.trim();
  // Pure number → treat as a CIK directly.
  if (/^\d{1,10}$/.test(q)) {
    return { cik: pad10(q), name: q, ticker: null, sicDescription: null };
  }
  const map = await secFetchJson<
    Record<string, { cik_str: number; ticker: string; title: string }>
  >(TICKERS_URL, cache, DAY);
  const entries = Object.values(map);
  const upper = q.toUpperCase();
  // Exact ticker match wins, else first name that contains the query.
  let hit = entries.find((e) => e.ticker.toUpperCase() === upper);
  if (!hit) hit = entries.find((e) => e.title.toUpperCase().includes(upper));
  if (!hit) return null;
  return {
    cik: pad10(hit.cik_str),
    name: hit.title,
    ticker: hit.ticker,
    sicDescription: null,
  };
}

export async function getFilings(
  query: string,
  opts: { formType?: string; limit?: number },
  cache: CacheStore,
): Promise<FilingsResult> {
  const company = await resolveCompany(query, cache);
  if (!company) throw new Error(`No SEC company found for "${query}"`);

  const url = submissionsUrl(company.cik);
  const sub = await secFetchJson<any>(url, cache, HOUR);

  const name: string = sub.name ?? company.name;
  const ticker =
    company.ticker ??
    (Array.isArray(sub.tickers) ? (sub.tickers[0] ?? null) : null);
  const sic: string | null = sub.sicDescription ?? null;
  const cikInt = String(parseInt(company.cik, 10));

  const r = sub.filings?.recent ?? {};
  const total: number = (r.accessionNumber ?? []).length;
  const wantForm = opts.formType?.toUpperCase();
  const limit = opts.limit ?? 10;

  const filings: FilingRef[] = [];
  for (let i = 0; i < total && filings.length < limit; i++) {
    const form: string = r.form[i];
    if (wantForm && form.toUpperCase() !== wantForm) continue;
    const accession: string = r.accessionNumber[i];
    const accNo = accession.replace(/-/g, "");
    const primaryDocument: string = r.primaryDocument?.[i] ?? "";
    const base = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNo}`;
    filings.push({
      form,
      filingDate: r.filingDate?.[i] ?? "",
      reportDate: r.reportDate?.[i] || null,
      accession,
      primaryDocument,
      primaryDocDescription: r.primaryDocDescription?.[i] || null,
      docUrl: primaryDocument ? `${base}/${primaryDocument}` : `${base}/`,
      indexUrl: `${base}/`,
    });
  }

  return {
    company: { cik: company.cik, name, ticker, sicDescription: sic },
    filings,
    source: url,
    fetchedAt: new Date().toISOString(),
  };
}
