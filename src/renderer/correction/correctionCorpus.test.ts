import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CORRECTION_CORPUS } from "./correctionCorpus";
import { createCorrectionEngine } from "./correctionEngine";
import { createFakeCorrector } from "./fakeCorrector";

describe("correction corpus", () => {
  it("keeps at least 50 fixtures with unique ids", () => {
    assert.ok(
      CORRECTION_CORPUS.length >= 50,
      `only ${CORRECTION_CORPUS.length} fixtures`,
    );
    assert.equal(
      new Set(CORRECTION_CORPUS.map((fixture) => fixture.id)).size,
      CORRECTION_CORPUS.length,
    );
  });

  for (const fixture of CORRECTION_CORPUS) {
    it(`${fixture.id} (${fixture.category}): ${fixture.reason}`, async () => {
      const engine = createCorrectionEngine({
        adapter: createFakeCorrector({
          type: "fixed",
          output: fixture.modelOutput,
        }),
        now: () => 0,
      });

      const result = await engine.correct({
        phraseId: fixture.id,
        originalText: fixture.input,
        locale: "en",
      });

      assert.equal(result.outcome, fixture.expectedOutcome);
      assert.deepEqual(
        [...result.warnings].sort(),
        [...(fixture.expectedWarnings ?? [])].sort(),
      );
      if (result.outcome === "fallback") {
        assert.equal(result.correctedText, fixture.input.trim());
      }
    });
  }
});
