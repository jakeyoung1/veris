// Cache layer behind an interface so the backend can swap without touching callers.
// File backend (~/.veris/cache) for get/set, plus the Stage 3 attribution LEDGER:
// an append-only JSONL log of every read, block, and payment intent. Entries are
// hash-chained (each carries the previous entry's hash), so any edit or deletion
// is detectable with verifyLedger().

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { LicenseInfo, PriceDeclaration } from "./types.js";

export interface CacheEntry<T> {
  storedAt: string;
  ttlMs: number;
  value: T;
}

export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
}

const keyHash = (key: string): string =>
  createHash("sha256").update(key).digest("hex").slice(0, 32);

export class FileCacheStore implements CacheStore {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? join(homedir(), ".veris", "cache");
  }

  private async ensure(): Promise<void> {
    if (!existsSync(this.dir)) await mkdir(this.dir, { recursive: true });
  }

  private path(key: string): string {
    return join(this.dir, keyHash(key) + ".json");
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await readFile(this.path(key), "utf8");
      const entry = JSON.parse(raw) as CacheEntry<T>;
      const age = Date.now() - new Date(entry.storedAt).getTime();
      if (age > entry.ttlMs) return null;
      return entry.value;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    await this.ensure();
    const entry: CacheEntry<T> = {
      storedAt: new Date().toISOString(),
      ttlMs,
      value,
    };
    await writeFile(this.path(key), JSON.stringify(entry), "utf8");
  }
}

// ---------------------------------------------------------------------------
// Attribution ledger

export type LedgerKind = "read" | "blocked" | "payment_required" | "payment_intent";

export interface LedgerEntry {
  id: string;
  seq: number; // 0-based position in the chain
  kind: LedgerKind;
  timestamp: string; // ISO time the event was recorded
  url: string; // URL the agent asked for
  finalUrl: string | null; // after redirects (reads only)
  contentHash: string | null; // sha256 of extracted text; null when nothing was fetched
  fromCache: boolean | null; // reads: served from the local cache?
  tool: string; // MCP tool / entrypoint that caused the event
  license: LicenseInfo | null;
  reason: string | null; // blocked / payment_required: why
  intent: PaymentIntentRecord | null; // payment_intent only
  prevHash: string; // entryHash of seq-1 ("0"*64 for the first entry)
  entryHash: string; // sha256 over this entry minus entryHash
}

export interface PaymentIntentRecord {
  price: PriceDeclaration | null; // as declared by the publisher, or null if undeclared
  terms: string | null;
  licenseServer: string | null;
  provider: string; // payment provider that handled it ("none" = stub)
  status: "recorded" | "authorized" | "failed";
  providerRef: string | null;
}

export type LedgerInput = Omit<LedgerEntry, "id" | "seq" | "timestamp" | "prevHash" | "entryHash">;

export interface LedgerQuery {
  url?: string;
  kind?: LedgerKind;
  since?: string; // ISO timestamp, inclusive
  limit?: number; // newest N (default all)
}

const GENESIS = "0".repeat(64);

export const ledgerPath = (): string =>
  process.env.VERIS_LEDGER_FILE || join(homedir(), ".veris", "ledger.jsonl");

const hashEntry = (e: Omit<LedgerEntry, "entryHash">): string =>
  createHash("sha256").update(JSON.stringify(e)).digest("hex");

async function readAll(): Promise<LedgerEntry[]> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath(), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LedgerEntry);
}

// Serialize appends inside this process so the chain never forks.
let tail: Promise<unknown> = Promise.resolve();

export function recordLedger(input: LedgerInput): Promise<LedgerEntry> {
  const run = tail.then(async () => {
    const all = await readAll();
    const last = all[all.length - 1];
    const body: Omit<LedgerEntry, "entryHash"> = {
      id: randomUUID(),
      seq: all.length,
      timestamp: new Date().toISOString(),
      ...input,
      prevHash: last?.entryHash ?? GENESIS,
    };
    const entry: LedgerEntry = { ...body, entryHash: hashEntry(body) };
    const file = ledgerPath();
    if (!existsSync(dirname(file))) await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
    return entry;
  });
  tail = run.catch(() => undefined);
  return run;
}

export async function listLedger(q: LedgerQuery = {}): Promise<LedgerEntry[]> {
  let rows = await readAll();
  if (q.url) rows = rows.filter((r) => r.url === q.url || r.finalUrl === q.url);
  if (q.kind) rows = rows.filter((r) => r.kind === q.kind);
  if (q.since) {
    const since = Date.parse(q.since);
    rows = rows.filter((r) => Date.parse(r.timestamp) >= since);
  }
  if (q.limit !== undefined) rows = rows.slice(-q.limit);
  return rows;
}

// Recompute the chain. Returns the first broken seq, or null if intact.
export async function verifyLedger(): Promise<{ ok: boolean; entries: number; brokenAt: number | null }> {
  const rows = await readAll();
  let prev = GENESIS;
  for (let i = 0; i < rows.length; i++) {
    const { entryHash, ...body } = rows[i];
    if (body.seq !== i || body.prevHash !== prev || hashEntry(body) !== entryHash) {
      return { ok: false, entries: rows.length, brokenAt: i };
    }
    prev = entryHash;
  }
  return { ok: true, entries: rows.length, brokenAt: null };
}
