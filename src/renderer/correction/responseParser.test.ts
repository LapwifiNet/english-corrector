import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseCorrectionOutput,
  type ParseFailureReason,
} from "./responseParser";

describe("parseCorrectionOutput", () => {
  it("accepts a single plain sentence and trims it", () => {
    const result = parseCorrectionOutput("  He goes to the office.  ");

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.text, "He goes to the office.");
  });

  const rejected: Array<{ raw: string; reason: ParseFailureReason }> = [
    { raw: "   ", reason: "empty" },
    { raw: "He goes.\nShe stays.", reason: "multiline" },
    { raw: "Corrected: He goes to the office.", reason: "label_prefix" },
    { raw: "Here is the corrected sentence.", reason: "label_prefix" },
    { raw: "- He goes to the office.", reason: "markdown" },
    { raw: '"He goes to the office."', reason: "quoted" },
    {
      raw: "Option 1: He goes. Option 2: He went.",
      reason: "multiple_options",
    },
    { raw: "a".repeat(1001), reason: "too_long" },
  ];

  for (const { raw, reason } of rejected) {
    it(`rejects ${reason} output instead of cleaning it up`, () => {
      const result = parseCorrectionOutput(raw);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, reason);
    });
  }
});
