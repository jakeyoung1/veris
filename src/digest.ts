// The alert run. One command, start to inbox:
//
//   check every watch → keep only material filings → read the document →
//   summarize it with sourced quotes → render an email → deliver it.
//
// Run it on a cron and veris is an alert service. Everything before this file
// was a library; this is the product.

import { checkWatches } from "./watch.js";
import { FileCacheStore } from "./cache.js";
import { createGate, describeWithheld } from "./gate.js";
import { passesFilter, formLabel } from "./materiality.js";
import {
  summarizeFiling,
  summariesEnabled,
  type SummaryResult,
} from "./summarize.js";
import { sendMail, mailConfigured, type Mail } from "./notify.js";
import type { FilingRef } from "./edgar.js";

export interface Alert {
  company: string;
  target: string;
  filing: FilingRef;
  summary: SummaryResult | null;
  summaryError: string | null;
}

export interface UrlAlert {
  target: string;
  title: string | null;
  detail: string;
}

export interface DigestResult {
  checkedAt: string;
  watchesChecked: number;
  alerts: Alert[];
  urlAlerts: UrlAlert[];
  skippedNonMaterial: number;
  errors: string[];
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const RANK = { high: 0, medium: 1, low: 2 } as const;

/** Run every watch and build the alert set. Does not send. */
export async function buildDigest(): Promise<DigestResult> {
  const cache = new FileCacheStore();
  const report = await checkWatches(cache);
  const gate = createGate(cache);

  const alerts: Alert[] = [];
  const urlAlerts: UrlAlert[] = [];
  const errors: string[] = [];
  let skippedNonMaterial = 0;

  for (const r of report.results) {
    if (r.status === "error") {
      errors.push(`${r.watch.target}: ${r.detail}`);
      continue;
    }
    if (r.status === "withheld") {
      errors.push(`${r.watch.target}: not read, ${r.detail}`);
      continue;
    }

    if (r.status === "changed" && r.watch.type === "url") {
      urlAlerts.push({
        target: r.watch.target,
        title: r.watch.title,
        detail: r.detail ?? "content changed",
      });
      continue;
    }

    if (r.status !== "new_filings" || r.watch.type !== "filings") continue;

    const company = r.watch.company;
    for (const filing of r.newFilings ?? []) {
      if (!passesFilter(filing.form, r.watch.formType)) {
        skippedNonMaterial++;
        continue;
      }

      let summary: SummaryResult | null = null;
      let summaryError: string | null = null;

      if (summariesEnabled()) {
        try {
          const o = await gate(filing.docUrl, "digest");
          if (o.status === "ok") {
            summary = await summarizeFiling(filing, company, o.result.content);
          } else {
            summaryError = `filing not read: ${describeWithheld(o)}`;
          }
        } catch (e) {
          summaryError = e instanceof Error ? e.message : String(e);
        }
      } else {
        summaryError = "summaries disabled (no ANTHROPIC_API_KEY)";
      }

      alerts.push({
        company,
        target: r.watch.target,
        filing,
        summary,
        summaryError,
      });
    }
  }

  alerts.sort((a, b) => {
    const ra = RANK[a.summary?.materiality ?? "medium"];
    const rb = RANK[b.summary?.materiality ?? "medium"];
    if (ra !== rb) return ra - rb;
    return b.filing.filingDate.localeCompare(a.filing.filingDate);
  });

  return {
    checkedAt: report.checkedAt,
    watchesChecked: report.results.length,
    alerts,
    urlAlerts,
    skippedNonMaterial,
    errors,
  };
}

export function subjectFor(d: DigestResult): string {
  const n = d.alerts.length + d.urlAlerts.length;
  if (n === 0) return "Veris: no material filings";
  const top = d.alerts[0];
  if (top) {
    const rest = n - 1;
    const tag = top.summary?.materiality === "high" ? "🔴 " : "";
    const head = top.summary?.headline ?? `${top.filing.form} filed`;
    const suffix = rest > 0 ? ` (+${rest} more)` : "";
    return `${tag}${top.company}: ${head}`.slice(0, 140) + suffix;
  }
  return `Veris: ${n} update${n === 1 ? "" : "s"}`;
}

export function renderText(d: DigestResult): string {
  const L: string[] = [];
  L.push(`VERIS ALERT — ${new Date(d.checkedAt).toUTCString()}`);
  L.push(`${d.watchesChecked} watches checked`);
  L.push("");

  if (!d.alerts.length && !d.urlAlerts.length) {
    L.push("No material filings since last check.");
    if (d.skippedNonMaterial) {
      L.push(`(${d.skippedNonMaterial} routine filings suppressed)`);
    }
  }

  for (const a of d.alerts) {
    const s = a.summary;
    L.push("─".repeat(60));
    L.push(
      `${a.company} — ${a.filing.form} (${formLabel(a.filing.form)}) filed ${a.filing.filingDate}`,
    );
    if (s) {
      L.push(`[${s.materiality.toUpperCase()}] ${s.headline}`);
      L.push("");
      for (const b of s.whatChanged) L.push(`  • ${b}`);
      L.push("");
      L.push(`Why it matters: ${s.whyItMatters}`);
      if (s.evidence.length) {
        L.push("");
        L.push("From the filing:");
        for (const q of s.evidence) L.push(`  "${q}"`);
      }
      if (s.truncated) {
        L.push(
          `\n(summary covers first ${s.charsRead.toLocaleString()} of ${s.charsTotal.toLocaleString()} chars)`,
        );
      }
      if (s.unverifiedQuotes.length) {
        L.push(
          `\n⚠️ ${s.unverifiedQuotes.length} quote(s) not verified against source — read the filing.`,
        );
      }
    } else {
      L.push(`(no summary: ${a.summaryError})`);
    }
    L.push("");
    L.push(`Source: ${a.filing.docUrl}`);
    L.push("");
  }

  for (const u of d.urlAlerts) {
    L.push("─".repeat(60));
    L.push(`PAGE CHANGED — ${u.title ?? u.target}`);
    L.push(u.detail);
    L.push(u.target);
    L.push("");
  }

  if (d.errors.length) {
    L.push("─".repeat(60));
    L.push("Errors:");
    for (const e of d.errors) L.push(`  ! ${e}`);
  }

  L.push("");
  L.push("Every claim above is quoted from the filing itself. Verify at the source link.");
  return L.join("\n");
}

export function renderHtml(d: DigestResult): string {
  const color = { high: "#b91c1c", medium: "#b45309", low: "#525252" } as const;
  const P: string[] = [];

  P.push(
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;` +
      `max-width:640px;margin:0 auto;color:#171717;line-height:1.5">`,
  );
  P.push(
    `<div style="border-bottom:2px solid #171717;padding-bottom:8px;margin-bottom:20px">` +
      `<span style="font-weight:700;letter-spacing:.08em;font-size:13px">VERIS</span>` +
      `<span style="color:#737373;font-size:13px"> · ${esc(new Date(d.checkedAt).toUTCString())}</span>` +
      `</div>`,
  );

  if (!d.alerts.length && !d.urlAlerts.length) {
    P.push(
      `<p style="color:#525252">No material filings since last check` +
        (d.skippedNonMaterial
          ? ` — ${d.skippedNonMaterial} routine filing(s) suppressed.`
          : ".") +
        `</p>`,
    );
  }

  for (const a of d.alerts) {
    const s = a.summary;
    const c = color[s?.materiality ?? "medium"];
    P.push(
      `<div style="border-left:3px solid ${c};padding:2px 0 2px 14px;margin:0 0 28px">`,
    );
    P.push(
      `<div style="font-size:12px;color:#737373;text-transform:uppercase;letter-spacing:.05em">` +
        `${esc(a.company)} · ${esc(a.filing.form)} · ${esc(formLabel(a.filing.form))} · filed ${esc(a.filing.filingDate)}` +
        `</div>`,
    );
    if (s) {
      P.push(
        `<div style="font-size:17px;font-weight:600;margin:6px 0 10px">${esc(s.headline)}</div>`,
      );
      if (s.whatChanged.length) {
        P.push(`<ul style="margin:0 0 12px;padding-left:20px">`);
        for (const b of s.whatChanged)
          P.push(`<li style="margin-bottom:4px">${esc(b)}</li>`);
        P.push(`</ul>`);
      }
      P.push(
        `<div style="margin-bottom:12px"><strong>Why it matters.</strong> ${esc(s.whyItMatters)}</div>`,
      );
      for (const q of s.evidence) {
        P.push(
          `<blockquote style="margin:0 0 8px;padding:8px 12px;background:#fafafa;` +
            `border-left:2px solid #d4d4d4;font-size:14px;color:#404040">${esc(q)}</blockquote>`,
        );
      }
      if (s.truncated) {
        P.push(
          `<div style="font-size:12px;color:#737373">Summary covers the first ` +
            `${s.charsRead.toLocaleString()} of ${s.charsTotal.toLocaleString()} characters.</div>`,
        );
      }
      if (s.unverifiedQuotes.length) {
        P.push(
          `<div style="font-size:12px;color:#b91c1c">⚠️ ${s.unverifiedQuotes.length} quote(s) ` +
            `could not be verified against the source document — read the filing before acting.</div>`,
        );
      }
    } else {
      P.push(
        `<div style="font-size:15px;margin:6px 0 10px;color:#525252">` +
          `New ${esc(a.filing.form)} filing — no summary (${esc(a.summaryError ?? "unknown")}).</div>`,
      );
    }
    P.push(
      `<div style="margin-top:10px"><a href="${esc(a.filing.docUrl)}" ` +
        `style="color:#1d4ed8;font-size:13px">Read the filing at SEC.gov →</a></div>`,
    );
    P.push(`</div>`);
  }

  for (const u of d.urlAlerts) {
    P.push(
      `<div style="border-left:3px solid #525252;padding:2px 0 2px 14px;margin:0 0 28px">` +
        `<div style="font-size:12px;color:#737373;text-transform:uppercase;letter-spacing:.05em">page changed</div>` +
        `<div style="font-size:16px;font-weight:600;margin:6px 0">${esc(u.title ?? u.target)}</div>` +
        `<div style="font-size:13px;color:#525252">${esc(u.detail)}</div>` +
        `<div style="margin-top:8px"><a href="${esc(u.target)}" style="color:#1d4ed8;font-size:13px">${esc(u.target)}</a></div>` +
        `</div>`,
    );
  }

  if (d.errors.length) {
    P.push(
      `<div style="font-size:12px;color:#b91c1c;margin-top:16px">` +
        d.errors.map((e) => esc(e)).join("<br>") +
        `</div>`,
    );
  }

  P.push(
    `<div style="border-top:1px solid #e5e5e5;margin-top:24px;padding-top:12px;` +
      `font-size:12px;color:#737373">Every claim is quoted from the filing itself — ` +
      `follow the source link to verify. ${d.watchesChecked} watches checked.</div>`,
  );
  P.push(`</div>`);
  return P.join("");
}

export function toMail(d: DigestResult): Mail {
  return { subject: subjectFor(d), text: renderText(d), html: renderHtml(d) };
}

/** CLI: `veris-mcp digest [--dry-run] [--to a@b,c@d] [--force]` */
export async function runDigestCli(argv: string[]): Promise<void> {
  const dry = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const toArg = argv.indexOf("--to");
  const to =
    toArg >= 0 && argv[toArg + 1]
      ? argv[toArg + 1].split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

  if (!summariesEnabled()) {
    console.error(
      "! ANTHROPIC_API_KEY not set — alerts will go out without summaries.",
    );
  }

  const d = await buildDigest();
  const mail = toMail(d);
  const n = d.alerts.length + d.urlAlerts.length;

  if (dry) {
    console.log(`SUBJECT: ${mail.subject}\n`);
    console.log(mail.text);
    console.error(
      `\n[dry-run] ${n} alert(s), ${d.skippedNonMaterial} routine suppressed, ${d.errors.length} error(s). Nothing sent.`,
    );
    return;
  }

  if (n === 0 && !force) {
    console.error(
      `Nothing material (${d.skippedNonMaterial} routine suppressed). No mail sent; use --force to send an empty digest.`,
    );
    return;
  }

  if (!mailConfigured()) {
    console.error(
      "! SMTP not configured (VERIS_SMTP_URL + VERIS_MAIL_FROM). Printing instead:\n",
    );
    console.log(`SUBJECT: ${mail.subject}\n`);
    console.log(mail.text);
    process.exitCode = 1;
    return;
  }

  const res = await sendMail(mail, to);
  if (res.delivered) {
    console.error(`Sent ${n} alert(s) to ${res.to.join(", ")} (${res.messageId})`);
  } else {
    console.error(`DELIVERY FAILED (${res.reason}). Digest below:\n`);
    console.log(mail.text);
    process.exitCode = 1;
  }
}
