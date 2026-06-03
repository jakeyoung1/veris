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

// --- Structured financials (XBRL companyconcept) --------------------------
// Each reported value carries its own provenance: the filing it came from
// (accession + filed date + fiscal period), straight from SEC.

export interface FactValue {
  label: string;
  concept: string;
  value: number;
  unit: string;
  periodEnd: string;
  fiscalYear: number | null;
  fiscalPeriod: string | null;
  form: string;
  filed: string; // provenance: filing date
  accession: string; // provenance
}

// Only trust primary financial statements for these figures — not proxies
// (DEF 14A), current reports (8-K), or press exhibits, which can restate.
const FINANCIAL_FORMS = /^(10-K|10-Q|20-F|40-F)(\/A)?$/i;

const FINANCIAL_CONCEPTS: { label: string; candidates: string[] }[] = [
  {
    label: "Revenue",
    candidates: [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "Revenues",
      "SalesRevenueNet",
    ],
  },
  { label: "Net income", candidates: ["NetIncomeLoss"] },
  { label: "Total assets", candidates: ["Assets"] },
  { label: "Cash & equivalents", candidates: ["CashAndCashEquivalentsAtCarryingValue"] },
  { label: "EPS (diluted)", candidates: ["EarningsPerShareDiluted"] },
];

async function fetchConcept(
  cik10: string,
  concept: string,
  cache: CacheStore,
): Promise<any | null> {
  const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik10}/us-gaap/${concept}.json`;
  try {
    return await secFetchJson<any>(url, cache, HOUR);
  } catch {
    return null; // concept simply not reported by this company
  }
}

function durationDays(x: any): number | null {
  if (!x.start || !x.end) return null;
  return (Date.parse(x.end) - Date.parse(x.start)) / 86_400_000;
}

// Newest valid row by period end, tie-broken by filed date.
function pickLatest(series: any[]): any | null {
  return (
    series
      .filter((x) => x && x.val != null && x.end && x.form)
      .sort((a, b) =>
        a.end < b.end ? 1 : a.end > b.end ? -1 : a.filed < b.filed ? 1 : -1,
      )[0] ?? null
  );
}

export async function getFinancials(
  query: string,
  cache: CacheStore,
): Promise<{ company: Company; facts: FactValue[] }> {
  const company = await resolveCompany(query, cache);
  if (!company) throw new Error(`No SEC company found for "${query}"`);

  const facts: FactValue[] = [];
  for (const c of FINANCIAL_CONCEPTS) {
    // Evaluate every candidate concept; keep the one with the NEWEST period
    // (so we never lock onto a deprecated tag that only holds old data).
    let best: { row: any; unit: string; concept: string } | null = null;
    for (const concept of c.candidates) {
      const data = await fetchConcept(company.cik, concept, cache);
      const units = data?.units;
      if (!units) continue;
      const unitKey = Object.keys(units)[0];
      const series: any[] = (units[unitKey] ?? []).filter(
        (x: any) => x && x.val != null && x.end && FINANCIAL_FORMS.test(x.form || ""),
      );
      const isFlow = series.some((x) => x.start); // income/revenue vs balance-sheet

      let pool: any[];
      if (!isFlow) {
        pool = series.filter((x) => !x.start); // instant (assets, cash)
      } else {
        const inRange = (lo: number, hi: number) =>
          series.filter((x) => {
            const d = durationDays(x);
            return d != null && d >= lo && d <= hi;
          });
        const annual = inRange(350, 380);
        pool = annual.length ? annual : inRange(80, 100); // annual, else quarterly
      }

      const row = pickLatest(pool);
      if (row && (!best || row.end > best.row.end)) {
        best = { row, unit: unitKey, concept };
      }
    }

    if (best) {
      const r = best.row;
      facts.push({
        label: c.label,
        concept: best.concept,
        value: r.val,
        unit: best.unit,
        periodEnd: r.end,
        fiscalYear: r.fy ?? null,
        fiscalPeriod: r.fp ?? null,
        form: r.form,
        filed: r.filed,
        accession: r.accn,
      });
    }
  }
  return { company, facts };
}
