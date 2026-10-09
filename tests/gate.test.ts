// End-to-end policy gate against a local site: robots disallow, robots-level
// paid RSL (must not fetch the page), page-level paid RSL (fetched, withheld),
// and a normal read. Every outcome must land in the ledger.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "veris-gate-"));
process.env.VERIS_LEDGER_FILE = join(dir, "ledger.jsonl");
const { FileCacheStore, listLedger, verifyLedger } = await import("../dist/cache.js");
const { createGate } = await import("../dist/gate.js");

const ARTICLE = (extraHead = "") =>
  `<!doctype html><html><head><title>Story</title>${extraHead}</head><body><article>` +
  "<h1>Story</h1>" +
  "<p>Plenty of words in this paragraph so readability keeps it as the article body. </p>".repeat(8) +
  "</article></body></html>";

const SITE: Record<string, [string, string]> = {
  "/robots.txt": [
    "text/plain",
    "User-agent: *\nDisallow: /blocked\nLicense: /license.xml\n",
  ],
  "/license.xml": [
    "application/rsl+xml",
    `<rsl xmlns="https://rslstandard.org/rsl">
      <content url="/paid/"><license><payment type="crawl"><amount currency="USD">0.01</amount>
        <standard>https://example.com/terms</standard></payment></license></content>
      <content url="/"><license><payment type="free"/></license></content>
    </rsl>`,
  ],
  "/page-license.xml": [
    "application/rsl+xml",
    `<rsl xmlns="https://rslstandard.org/rsl"><content url="/page-rsl"><license>
      <payment type="use"><amount currency="EUR">0.50</amount></payment></license></content></rsl>`,
  ],
  "/ok": ["text/html", ARTICLE()],
  "/paid/x": ["text/html", ARTICLE()],
  "/blocked/x": ["text/html", ARTICLE()],
  "/page-rsl": [
    "text/html",
    ARTICLE('<link rel="license" type="application/rsl+xml" href="/page-license.xml">'),
  ],
};

const hits: string[] = [];
const server = createServer((req, res) => {
  hits.push(req.url!);
  const page = SITE[req.url!];
  if (!page) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": page[0] }).end(page[1]);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address() as { port: number };
const base = `http://127.0.0.1:${port}`;
after(() => server.close());

const gate = createGate(new FileCacheStore(join(dir, "cache")), 60_000);

test("robots disallow → blocked, page never requested", async () => {
  const o = await gate(`${base}/blocked/x`, "test");
  assert.equal(o.status, "blocked");
  assert.equal(o.status === "blocked" && o.robotsRule, "Disallow: /blocked");
  assert.equal(hits.includes("/blocked/x"), false);
});

test("robots-declared price → terms + price, page never requested", async () => {
  const o = await gate(`${base}/paid/x`, "test");
  assert.equal(o.status, "payment_required");
  if (o.status !== "payment_required") return;
  assert.equal(o.priceHint, "0.01 USD (crawl)");
  assert.equal(o.terms, "https://example.com/terms");
  assert.equal(o.rslUrl, `${base}/license.xml`);
  assert.equal(o.contentFetched, false);
  assert.equal(hits.includes("/paid/x"), false);
  const intents = await listLedger({ kind: "payment_intent" });
  const intent = intents.find((e) => e.id === o.ledgerIntentId);
  assert.equal(intent?.intent?.provider, "none");
  assert.equal(intent?.intent?.status, "recorded");
  assert.equal(intent?.intent?.price?.amount, "0.01");
});

test("page-declared price → content withheld", async () => {
  const o = await gate(`${base}/page-rsl`, "test");
  assert.equal(o.status, "payment_required");
  if (o.status !== "payment_required") return;
  assert.equal(o.priceHint, "0.50 EUR (use)");
  assert.equal(o.contentFetched, true);
  assert.equal("result" in o, false);
});

test("free read → content, license provenance, ledger read entry", async () => {
  const o = await gate(`${base}/ok`, "test");
  assert.equal(o.status, "ok");
  if (o.status !== "ok") return;
  const lic = o.result.provenance.license;
  assert.equal(lic.robotsAllowed, true);
  assert.equal(lic.robotsUrl, `${base}/robots.txt`);
  assert.equal(lic.paymentType, "free");
  assert.equal(lic.priceHint, null);
  const again = await gate(`${base}/ok`, "test");
  assert.equal(again.status === "ok" && again.fromCache, true);

  const reads = await listLedger({ kind: "read", url: `${base}/ok` });
  assert.equal(reads.length, 2);
  assert.equal(reads[0].contentHash, o.result.provenance.contentHash);
  assert.deepEqual(
    (await listLedger()).map((e) => e.kind),
    ["blocked", "payment_required", "payment_intent", "payment_required", "payment_intent", "read", "read"],
  );
  assert.equal((await verifyLedger()).ok, true);
});
