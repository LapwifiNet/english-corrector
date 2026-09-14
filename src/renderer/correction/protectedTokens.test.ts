import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractProtectedTokens,
  nameLikeTokens,
  normalizeNumber,
} from "./protectedTokens";

describe("extractProtectedTokens", () => {
  it("pulls out emails, urls and order codes", () => {
    const tokens = extractProtectedTokens(
      "send the invoice to ana@acme.io and open www.acme.io/orders for INV-4821",
    );

    assert.deepEqual(tokens.emails, ["ana@acme.io"]);
    assert.deepEqual(tokens.urls, ["www.acme.io/orders"]);
    assert.deepEqual(tokens.codes, ["INV-4821"]);
  });

  it("collects dates, times and numbers without double counting digits", () => {
    const tokens = extractProtectedTokens(
      "the demo is on 2026-09-14 at 10:30 am for 1,200 users",
    );

    assert.deepEqual(tokens.dates, ["2026-09-14"]);
    assert.deepEqual(tokens.times, ["10:30 am"]);
    assert.deepEqual(tokens.numbers, ["1200"]);
  });

  it("treats capitalized words as names but ignores contractions", () => {
    const tokens = extractProtectedTokens(
      "Isn't Maria joining the Notion call?",
    );

    assert.deepEqual(tokens.names, ["Maria", "Notion"]);
  });
});

describe("normalizeNumber", () => {
  it("drops thousand separators so 1,200 and 1200 compare equal", () => {
    assert.equal(normalizeNumber("1,200"), "1200");
  });
});

describe("nameLikeTokens", () => {
  it("lowercases every token that must survive a correction", () => {
    const tokens = extractProtectedTokens(
      "Maria will send INV-4821 to ana@acme.io",
    );

    assert.deepEqual(nameLikeTokens(tokens).sort(), [
      "ana@acme.io",
      "inv-4821",
      "maria",
    ]);
  });
});
