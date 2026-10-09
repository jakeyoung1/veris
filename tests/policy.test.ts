// The policy layer decides what an agent may read and what it costs. A wrong
// "allowed" ignores a publisher's wishes; an invented price is a lie in a
// provenance product. Both are pinned here against fixed inputs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRobots, robotsAllows, parseRsl, requiresPayment, formatPriceHint } from "../dist/policy.js";

const ROBOTS = `
User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.pdf$

User-agent: VerisBot
User-agent: OtherBot
Disallow: /no-veris

License: https://example.com/license.xml
`;

test("robots: our own group overrides the * group", () => {
  const { groups, licenseUrls } = parseRobots(ROBOTS);
  assert.deepEqual(licenseUrls, ["https://example.com/license.xml"]);
  // VerisBot group only disallows /no-veris, so /private is allowed for us.
  assert.equal(robotsAllows(groups, "/private/x").allowed, true);
  const v = robotsAllows(groups, "/no-veris/page");
  assert.equal(v.allowed, false);
  assert.equal(v.rule, "Disallow: /no-veris");
});

test("robots: * group, longest match, allow wins ties, wildcards", () => {
  const { groups } = parseRobots(ROBOTS);
  const star = (p: string) => robotsAllows(groups, p, "SomeOtherBot");
  assert.equal(star("/private/secret").allowed, false);
  assert.equal(star("/private/public/page").allowed, true);
  assert.equal(star("/docs/a.pdf").allowed, false);
  assert.equal(star("/docs/a.pdf?x=1").allowed, true); // $ anchors the end
  assert.equal(star("/anything").allowed, true);
  assert.equal(star("/anything").rule, null);
});

test("robots: token must match exactly, not as a substring", () => {
  const { groups } = parseRobots("User-agent: Veris\nDisallow: /\n");
  assert.equal(robotsAllows(groups, "/x").allowed, true);
});

// Real document served at https://rslcollective.org/royalty.xml (2026-10-08).
const COLLECTIVE = `<rsl xmlns="https://rslstandard.org/rsl">
  <content url="/" server="https://api.rslcollective.org">
    <license>
      <permits type="usage">ai-all</permits>
      <payment type="use">
        <standard>https://rslcollective.org/license</standard>
      </payment>
    </license>
  </content>
</rsl>`;

test("rsl: paid license with no <amount> → price stays null", () => {
  const t = parseRsl(COLLECTIVE, "https://site.example/article", "https://rslcollective.org/royalty.xml");
  assert.equal(t.matched, true);
  assert.equal(t.paymentType, "use");
  assert.equal(t.price, null);
  assert.equal(formatPriceHint(t.price), null);
  assert.equal(t.terms, "https://rslcollective.org/license");
  assert.equal(t.server, "https://api.rslcollective.org");
  assert.equal(requiresPayment(t), true);
});

const PRICED = `<?xml version="1.0"?>
<rsl xmlns="https://rslstandard.org/rsl">
  <content url="/news/*">
    <license>
      <permits type="usage">ai-train</permits>
      <payment type="training"><amount currency="usd">5.00</amount></payment>
    </license>
    <license>
      <permits type="usage">ai-input search</permits>
      <payment type="crawl"><amount currency="USD">0.0025</amount></payment>
    </license>
  </content>
  <content url="/free/">
    <license><payment type="free"/></license>
  </content>
</rsl>`;

test("rsl: picks the ai-input license and keeps the amount verbatim", () => {
  const t = parseRsl(PRICED, "https://pub.example/news/story-1", "https://pub.example/license.xml");
  assert.equal(t.paymentType, "crawl");
  assert.deepEqual(t.price, {
    amount: "0.0025",
    currency: "USD",
    paymentType: "crawl",
    source: "https://pub.example/license.xml",
  });
  assert.equal(formatPriceHint(t.price), "0.0025 USD (crawl)");
  assert.equal(requiresPayment(t), true);
});

test("rsl: free scope and uncovered paths do not require payment", () => {
  const free = parseRsl(PRICED, "https://pub.example/free/x", "https://pub.example/license.xml");
  assert.equal(free.paymentType, "free");
  assert.equal(requiresPayment(free), false);
  const other = parseRsl(PRICED, "https://pub.example/about", "https://pub.example/license.xml");
  assert.equal(other.matched, false);
  assert.equal(requiresPayment(other), false);
});

test("rsl: prohibited usage yields no license, malformed XML yields nothing", () => {
  const xml = `<rsl xmlns="https://rslstandard.org/rsl"><content url="/"><license>
    <prohibits type="usage">ai-input</prohibits><payment type="crawl"><amount currency="USD">1</amount></payment>
  </license></content></rsl>`;
  const t = parseRsl(xml, "https://a.example/", "https://a.example/l.xml");
  assert.equal(t.matched, true);
  assert.equal(t.price, null);
  assert.equal(parseRsl("<rsl><oops", "https://a.example/", "x").matched, false);
});

test("rsl: non-numeric amount is ignored, not guessed", () => {
  const xml = `<rsl xmlns="https://rslstandard.org/rsl"><content url="/"><license>
    <payment type="crawl"><amount currency="USD">call us</amount></payment></license></content></rsl>`;
  const t = parseRsl(xml, "https://a.example/x", "https://a.example/l.xml");
  assert.equal(t.paymentType, "crawl");
  assert.equal(t.price, null);
});
