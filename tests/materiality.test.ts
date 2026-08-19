// The filter decides what a paying customer sees. A false negative means a
// missed 8-K (churn); a false positive means Form 4 noise (churn). Both are
// the product failing, so both are tested.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isMaterialForm,
  passesFilter,
  formLabel,
  ALL_FORMS,
} from "../dist/materiality.js";

test("material forms alert by default", () => {
  for (const f of [
    "8-K",
    "10-K",
    "10-Q",
    "20-F",
    "6-K",
    "SC 13D",
    "SC 13G",
    "DEFM14A",
    "S-4",
    "424B5",
    "NT 10-K",
    "25-NSE",
  ]) {
    assert.equal(isMaterialForm(f), true, `${f} should be material`);
  }
});

test("routine noise is suppressed by default", () => {
  for (const f of ["4", "3", "5", "13F-HR", "24F-2NT", "SD", "ARS", "CERT"]) {
    assert.equal(isMaterialForm(f), false, `${f} should NOT be material`);
  }
});

test("amendments inherit their base form's materiality", () => {
  assert.equal(isMaterialForm("10-K/A"), true);
  assert.equal(isMaterialForm("8-K/A"), true);
  assert.equal(isMaterialForm("SC 13D/A"), true);
});

test("form matching is case- and whitespace-insensitive", () => {
  assert.equal(isMaterialForm(" 8-k "), true);
  assert.equal(isMaterialForm("10-q"), true);
});

test("null filter uses the material default", () => {
  assert.equal(passesFilter("8-K", null), true);
  assert.equal(passesFilter("4", null), false);
});

test("ALL opts back in to every form", () => {
  assert.equal(passesFilter("4", ALL_FORMS), true);
  assert.equal(passesFilter("13F-HR", "ALL"), true);
});

test("explicit form filter matches that form and its amendments only", () => {
  assert.equal(passesFilter("8-K", "8-K"), true);
  assert.equal(passesFilter("8-K/A", "8-K"), true);
  assert.equal(passesFilter("10-K", "8-K"), false);
  // A watch explicitly asking for Form 4 gets Form 4, material or not.
  assert.equal(passesFilter("4", "4"), true);
});

test("explicit filter does not prefix-match unrelated forms", () => {
  // "10-K" must not swallow "10-KT" or similar as a bare prefix.
  assert.equal(passesFilter("10-KT", "10-K"), false);
  assert.equal(passesFilter("10-K/A", "10-K"), true);
});

test("labels are plain English, not form codes", () => {
  assert.equal(formLabel("8-K"), "material event");
  assert.equal(formLabel("10-Q"), "quarterly report");
  assert.equal(formLabel("SC 13D"), "activist stake");
  assert.equal(formLabel("NT 10-K"), "LATE FILING");
  // Unknown forms fall back to the raw code rather than inventing a label.
  assert.equal(formLabel("XYZ-9"), "XYZ-9");
});
