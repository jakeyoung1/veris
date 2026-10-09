// The ledger is the settlement record. If an entry can be edited or dropped
// without detection, it is not a ledger.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const file = join(mkdtempSync(join(tmpdir(), "veris-ledger-")), "ledger.jsonl");
process.env.VERIS_LEDGER_FILE = file;
const { recordLedger, listLedger, verifyLedger } = await import("../dist/cache.js");

const base = {
  finalUrl: null,
  contentHash: null,
  fromCache: null,
  tool: "test",
  license: null,
  reason: null,
  intent: null,
};

test("records, chains, filters, and detects tampering", async () => {
  await Promise.all([
    recordLedger({ ...base, kind: "read", url: "https://a.example/1", contentHash: "aa" }),
    recordLedger({ ...base, kind: "blocked", url: "https://b.example/", reason: "robots" }),
    recordLedger({ ...base, kind: "read", url: "https://a.example/2", contentHash: "bb" }),
  ]);
  const all = await listLedger();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((e) => e.seq), [0, 1, 2]);
  assert.equal(all[0].prevHash, "0".repeat(64));
  assert.equal(all[1].prevHash, all[0].entryHash);
  assert.equal((await listLedger({ kind: "read" })).length, 2);
  assert.equal((await listLedger({ url: "https://b.example/" }))[0].kind, "blocked");
  assert.equal((await listLedger({ limit: 1 }))[0].seq, 2);
  assert.deepEqual(await verifyLedger(), { ok: true, entries: 3, brokenAt: null });

  const lines = readFileSync(file, "utf8").trim().split("\n");
  lines[1] = lines[1].replace('"robots"', '"edited"');
  writeFileSync(file, lines.join("\n") + "\n");
  const v = await verifyLedger();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);
});
