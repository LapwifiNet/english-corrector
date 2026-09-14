import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CorrectionWarning } from "./contracts";
import {
  containsToken,
  countNegations,
  isQuestion,
  validateCorrection,
} from "./invariantValidators";
import { extractProtectedTokens } from "./protectedTokens";

function warningsFor(original: string, corrected: string): CorrectionWarning[] {
  return validateCorrection(
    original,
    corrected,
    extractProtectedTokens(original),
  );
}

describe("countNegations", () => {
  it("expands contractions and cannot before counting", () => {
    assert.equal(countNegations("I can't go and I cannot stay"), 2);
    assert.equal(countNegations("I can go"), 0);
  });
});

describe("isQuestion", () => {
  it("detects question marks and leading wh or auxiliary words", () => {
    assert.equal(isQuestion("Did you send the file"), true);
    assert.equal(isQuestion("You sent the file?"), true);
    assert.equal(isQuestion("You sent the file."), false);
  });
});

describe("containsToken", () => {
  it("matches whole words case insensitively", () => {
    assert.equal(containsToken("Please ping Notion support", "notion"), true);
    assert.equal(
      containsToken("Please ping Notional support", "notion"),
      false,
    );
  });
});

describe("validateCorrection", () => {
  it("accepts a grammar fix that preserves meaning", () => {
    assert.deepEqual(
      warningsFor(
        "he go to the office every Monday",
        "He goes to the office every Monday.",
      ),
      [],
    );
  });

  it("flags a dropped name", () => {
    assert.deepEqual(
      warningsFor("Maria will join the call", "She will join the call."),
      ["name_changed"],
    );
  });

  it("flags a changed number", () => {
    assert.deepEqual(
      warningsFor("the order number is 4821", "The order number is 4812."),
      ["number_changed"],
    );
  });

  it("flags a dropped negation", () => {
    assert.deepEqual(warningsFor("I don't have the file", "I have the file."), [
      "negation_changed",
    ]);
  });

  it("flags a question turned into a statement", () => {
    assert.deepEqual(
      warningsFor("can you send the file", "You can send the file."),
      ["question_changed"],
    );
  });

  it("flags a rewrite that adds content the speaker never said", () => {
    assert.deepEqual(
      warningsFor(
        "send it",
        "Please send it to me whenever you get a chance this afternoon, thanks.",
      ),
      ["invalid_output"],
    );
  });

  it("flags a translation as invalid output", () => {
    assert.deepEqual(warningsFor("I need the report", "Tôi cần báo cáo."), [
      "invalid_output",
    ]);
  });
});
