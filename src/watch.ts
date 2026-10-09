// Watch & change-detection — the alert primitive.
// A watch baselines a target (a company's SEC filings, or any URL's content
// hash) when added; watch_check then reports only what's NEW and rolls the
// baseline forward. Run on a schedule and veris becomes an alert feed:
// "NVDA just filed an 8-K, here's the document."
//
// State lives in ~/.veris/watches.json (single-tenant: per-user when
// self-hosted, per-instance when hosted). Override with VERIS_WATCH_FILE.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getFilings, type FilingRef } from "./edgar.js";
import { createGate, describeWithheld } from "./gate.js";
import type { CacheStore } from "./cache.js";

export interface WatchBase {
  id: string;
  target: string;
  addedAt: string;
  lastCheckedAt: string | null;
}
export interface FilingsWatch extends WatchBase {
  type: "filings";
  formType: string | null;
  company: string;
  seenAccessions: string[];
}
export interface UrlWatch extends WatchBase {
  type: "url";
  contentHash: string;
  title: string | null;
}
export type Watch = FilingsWatch | UrlWatch;

const FILE =
  process.env.VERIS_WATCH_FILE ?? join(homedir(), ".veris", "watches.json");

async function load(): Promise<Watch[]> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as Watch[];
  } catch {
    return [];
  }
}

async function save(ws: Watch[]): Promise<void> {
  if (!existsSync(dirname(FILE))) await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(ws, null, 2), "utf8");
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export async function addWatch(
  target: string,
  formType: string | undefined,
  cache: CacheStore,
): Promise<{ watch: Watch; note: string }> {
  const ws = await load();
  let watch: Watch;
  if (/^https?:\/\//i.test(target)) {
    // Gated like every other read. A watch we may not read is refused up front.
    const o = await createGate(cache)(target, "watch_manage", { fresh: true });
    if (o.status !== "ok") throw new Error(`Cannot watch ${target}: ${describeWithheld(o)}`);
    const r = o.result;
    watch = {
      id: `url-${slug(target)}`,
      type: "url",
      target,
      contentHash: r.provenance.contentHash,
      title: r.provenance.title,
      addedAt: new Date().toISOString(),
      lastCheckedAt: null,
    };
  } else {
    const res = await getFilings(target, { formType, limit: 10 }, cache);
    watch = {
      id: `fil-${slug(target)}${formType ? `-${slug(formType)}` : ""}`,
      type: "filings",
      target,
      formType: formType ?? null,
      company: res.company.name,
      seenAccessions: res.filings.map((f) => f.accession),
      addedAt: new Date().toISOString(),
      lastCheckedAt: null,
    };
  }
  const idx = ws.findIndex((w) => w.id === watch.id);
  const note = idx >= 0 ? "replaced (baseline refreshed)" : "added";
  if (idx >= 0) ws[idx] = watch;
  else ws.push(watch);
  await save(ws);
  return { watch, note };
}

export async function removeWatch(target: string): Promise<Watch | null> {
  const ws = await load();
  const t = target.toLowerCase();
  const idx = ws.findIndex(
    (w) => w.id === t || w.target.toLowerCase() === t,
  );
  if (idx < 0) return null;
  const [gone] = ws.splice(idx, 1);
  await save(ws);
  return gone;
}

export async function listWatches(): Promise<Watch[]> {
  return load();
}

export interface CheckResult {
  watch: Watch;
  // withheld = policy gate refused the read (robots / paid license); baseline kept.
  status: "new_filings" | "changed" | "unchanged" | "withheld" | "error";
  newFilings?: FilingRef[];
  detail?: string;
}

export async function checkWatches(
  cache: CacheStore,
): Promise<{ checkedAt: string; results: CheckResult[] }> {
  const ws = await load();
  const results: CheckResult[] = [];
  const gate = createGate(cache);
  for (const w of ws) {
    try {
      if (w.type === "filings") {
        const res = await getFilings(
          w.target,
          { formType: w.formType ?? undefined, limit: 10 },
          cache,
        );
        const fresh = res.filings.filter(
          (f) => !w.seenAccessions.includes(f.accession),
        );
        if (fresh.length) {
          w.seenAccessions = [
            ...fresh.map((f) => f.accession),
            ...w.seenAccessions,
          ].slice(0, 50);
          results.push({ watch: w, status: "new_filings", newFilings: fresh });
        } else {
          results.push({ watch: w, status: "unchanged" });
        }
      } else {
        // fresh: always refetch, never compare against the read cache
        const o = await gate(w.target, "watch_check", { fresh: true });
        if (o.status !== "ok") {
          results.push({ watch: w, status: "withheld", detail: describeWithheld(o) });
          w.lastCheckedAt = new Date().toISOString();
          continue;
        }
        const r = o.result;
        if (r.provenance.contentHash !== w.contentHash) {
          const detail =
            `content hash ${w.contentHash.slice(0, 12)} → ${r.provenance.contentHash.slice(0, 12)}` +
            (r.provenance.modifiedAt ? `; modified ${r.provenance.modifiedAt}` : "");
          w.contentHash = r.provenance.contentHash;
          results.push({ watch: w, status: "changed", detail });
        } else {
          results.push({ watch: w, status: "unchanged" });
        }
      }
    } catch (e) {
      results.push({
        watch: w,
        status: "error",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
    w.lastCheckedAt = new Date().toISOString();
  }
  await save(ws);
  return { checkedAt: new Date().toISOString(), results };
}
