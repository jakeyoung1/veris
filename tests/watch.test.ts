// Watches and the digest read pages on a schedule, unattended. They must obey
// the same policy gate as interactive reads: a disallowed or paid page is never
// returned, the baseline is left alone, and the refusal is in the ledger.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "veris-watch-"));
process.env.VERIS_LEDGER_FILE = join(dir, "ledger.jsonl");
process.env.VERIS_WATCH_FILE = join(dir, "watches.json");
const { FileCacheStore, listLedger } = await import("../dist/cache.js");
const { addWatch, checkWatches } = await import("../dist/watch.js");
const { buildDigest } = await import("../dist/digest.js");

let version = 1;
const article = () =>
  `<!doctype html><html><head><title>Page</title></head><body><article><h1>Page v${version}</h1>` +
  `<p>Version ${version}. Enough words here for readability to keep this as the body text. </p>`.repeat(8) +
  "</article></body></html>";

const hits: string[] = [];
const server = createServer((req, res) => {
  hits.push(req.url!);
  if (req.url === "/robots.txt") {
    return res
      .writeHead(200, { "content-type": "text/plain" })
      .end("User-agent: *\nDisallow: /private\nLicense: /license.xml\n");
  }
  if (req.url === "/license.xml") {
    return res.writeHead(200, { "content-type": "application/rsl+xml" }).end(
      `<rsl xmlns="https://rslstandard.org/rsl"><content url="/paid"><license>
        <payment type="crawl"><amount currency="USD">0.02</amount></payment></license></content></rsl>`,
    );
  }
  res.writeHead(200, { "content-type": "text/html" }).end(article());
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address() as { port: number };
const base = `http://127.0.0.1:${port}`;
after(() => server.close());

const cache = new FileCacheStore(join(dir, "cache"));

test("addWatch refuses blocked and paid URLs without fetching them", async () => {
  await assert.rejects(addWatch(`${base}/private/a`, undefined, cache), /robots\.txt disallows/);
  await assert.rejects(addWatch(`${base}/paid/a`, undefined, cache), /payment required \(0\.02 USD \(crawl\)\)/);
  assert.equal(hits.includes("/private/a") || hits.includes("/paid/a"), false);
  const kinds = (await listLedger()).map((e) => `${e.tool}:${e.kind}`);
  assert.ok(kinds.includes("watch_manage:blocked"));
  assert.ok(kinds.includes("watch_manage:payment_required"));
});

test("checkWatches detects change through the gate and withholds blocked targets", async () => {
  const { watch } = await addWatch(`${base}/open`, undefined, cache);
  // A watch that predates the robots rule (e.g. added before the site changed it).
  const existing = JSON.parse(
    (await import("node:fs")).readFileSync(process.env.VERIS_WATCH_FILE!, "utf8"),
  );
  existing.push({
    id: "url-legacy",
    type: "url",
    target: `${base}/private/legacy`,
    contentHash: "old-hash",
    title: null,
    addedAt: new Date().toISOString(),
    lastCheckedAt: null,
  });
  writeFileSync(process.env.VERIS_WATCH_FILE!, JSON.stringify(existing));

  version = 2;
  const report = await checkWatches(cache);
  const byTarget = Object.fromEntries(report.results.map((r) => [r.watch.target, r]));
  assert.equal(byTarget[`${base}/open`].status, "changed");
  assert.notEqual((byTarget[`${base}/open`].watch as any).contentHash, (watch as any).contentHash);
  const legacy = byTarget[`${base}/private/legacy`];
  assert.equal(legacy.status, "withheld");
  assert.match(legacy.detail!, /Disallow: \/private/);
  assert.equal((legacy.watch as any).contentHash, "old-hash"); // baseline untouched
  assert.equal(hits.includes("/private/legacy"), false);

  const reads = await listLedger({ kind: "read", url: `${base}/open` });
  assert.deepEqual(reads.map((e) => e.tool), ["watch_manage", "watch_check"]);
  assert.equal(reads.every((e) => e.fromCache === false), true);
});

test("digest reports a withheld watch instead of reading it", async () => {
  const d = await buildDigest();
  assert.ok(d.errors.some((e) => e.includes("/private/legacy: not read, robots.txt disallows")));
  assert.equal(hits.filter((h) => h === "/private/legacy").length, 0);
});
