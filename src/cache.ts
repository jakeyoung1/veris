// Cache layer behind an interface so the backend can swap without touching callers.
// v0: simple file backend (~/.veris/cache). Stage 3: this same store becomes the
// attribution LEDGER — every read recorded with hash + timestamp for payment settlement.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
