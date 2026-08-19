// Which SEC forms actually matter to a human watching a company.
//
// A raw "all filings" watch is mostly noise: Form 4s (insider grants), 13F-HR
// (fund holdings), 24F-2NT, and similar fire constantly and almost never mean
// anything on their own. Alerting on those trains the reader to ignore the
// feed — which is the only failure mode that actually kills an alert product.
//
// So a filings watch defaults to MATERIAL forms. "ALL" opts back in to
// everything; naming a specific form watches exactly that form.

/** Forms that are worth waking someone up for, by prefix. */
const MATERIAL_PREFIXES = [
  "8-K", // material events — the headline generator
  "10-K", // annual report (incl. 10-K/A amendments)
  "10-Q", // quarterly report
  "20-F", // annual report, foreign private issuer
  "40-F", // annual report, Canadian issuer
  "6-K", // interim report, foreign private issuer
  "SC 13D", // activist stake — control intent
  "SC 13G", // passive 5%+ stake
  "SC TO", // tender offer
  "DEFM14A", // merger proxy
  "DEFA14A", // additional proxy solicitation material
  "PREM14A", // preliminary merger proxy
  "S-1", // IPO registration
  "S-3", // shelf registration
  "S-4", // M&A registration
  "424B", // prospectus (pricing — offerings)
  "NT 10-K", // late annual filing — a real distress signal
  "NT 10-Q", // late quarterly filing
  "25-NSE", // delisting notice
];

/** Sentinel meaning "do not filter — alert on every form". */
export const ALL_FORMS = "ALL";

/**
 * Is this form material by default?
 * Matches on prefix so amendments (`10-K/A`, `8-K/A`) and variants
 * (`424B5`, `SC 13D/A`) are caught alongside the base form.
 */
export function isMaterialForm(form: string): boolean {
  const f = form.trim().toUpperCase();
  return MATERIAL_PREFIXES.some((p) => f === p || f.startsWith(p));
}

/**
 * Decide whether a form passes a watch's filter.
 * - `null`/undefined → default material set
 * - `"ALL"`          → everything
 * - anything else    → exact form match (prefix-tolerant for amendments)
 */
export function passesFilter(form: string, formType: string | null): boolean {
  if (!formType) return isMaterialForm(form);
  const want = formType.trim().toUpperCase();
  if (want === ALL_FORMS) return true;
  const f = form.trim().toUpperCase();
  return f === want || f.startsWith(`${want}/`);
}

/**
 * Plain-English label for a form, used in alert subject lines so the reader
 * knows what happened without opening anything.
 */
export function formLabel(form: string): string {
  const f = form.trim().toUpperCase();
  if (f.startsWith("8-K")) return "material event";
  if (f.startsWith("10-K") || f.startsWith("20-F") || f.startsWith("40-F"))
    return "annual report";
  if (f.startsWith("10-Q")) return "quarterly report";
  if (f.startsWith("6-K")) return "interim report";
  if (f.startsWith("SC 13D")) return "activist stake";
  if (f.startsWith("SC 13G")) return "passive 5%+ stake";
  if (f.startsWith("SC TO")) return "tender offer";
  if (f.includes("M14A")) return "merger proxy";
  if (f.startsWith("S-4")) return "M&A registration";
  if (f.startsWith("S-1")) return "IPO registration";
  if (f.startsWith("S-3") || f.startsWith("424B")) return "offering";
  if (f.startsWith("NT ")) return "LATE FILING";
  if (f.startsWith("25-NSE")) return "delisting notice";
  return form;
}
