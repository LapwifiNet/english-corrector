import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CorrectionCancelled, type CorrectionRequest } from "./contracts";
import { createCorrectionEngine } from "./correctionEngine";
import { CORRECTION_PROMPT_VERSION } from "./correctionPrompt";
import { createFakeCorrector, createManualTimer } from "./fakeCorrector";

function request(originalText: string): CorrectionRequest {
  return { phraseId: "phrase-1", originalText, locale: "en" };
}

describe("createCorrectionEngine", () => {
  it("returns the corrected sentence with the prompt version", async () => {
    const adapter = createFakeCorrector({
      type: "fixed",
      output: "He goes to the office every Monday.",
    });
    const engine = createCorrectionEngine({ adapter, now: () => 0 });

    const result = await engine.correct(
      request("he go to the office every Monday"),
    );

    assert.equal(result.outcome, "changed");
    assert.equal(result.correctedText, "He goes to the office every Monday.");
    assert.deepEqual(result.warnings, []);
    assert.equal(result.promptVersion, CORRECTION_PROMPT_VERSION);
  });

  it("reports unchanged when the sentence is already correct", async () => {
    const engine = createCorrectionEngine({
      adapter: createFakeCorrector({ type: "echo" }),
    });

    const result = await engine.correct(request("The report is ready."));

    assert.equal(result.outcome, "unchanged");
    assert.equal(result.correctedText, "The report is ready.");
  });

  it("never calls the provider for empty input", async () => {
    const adapter = createFakeCorrector();
    const engine = createCorrectionEngine({ adapter });

    const result = await engine.correct(request("   "));

    assert.equal(result.outcome, "fallback");
    assert.equal(result.errorCode, "empty_input");
    assert.equal(adapter.callCount, 0);
  });

  it("falls back to the original text on timeout and does not retry", async () => {
    const timer = createManualTimer();
    const adapter = createFakeCorrector({ type: "never" });
    const engine = createCorrectionEngine({
      adapter,
      scheduleTimeout: timer.schedule,
      now: () => 0,
    });

    const pending = engine.correct(request("he go to the office"));
    timer.fireAll();
    const result = await pending;

    assert.equal(result.outcome, "fallback");
    assert.equal(result.errorCode, "timeout");
    assert.equal(result.correctedText, "he go to the office");
    assert.equal(adapter.callCount, 1);
  });

  it("falls back when the provider fails", async () => {
    const engine = createCorrectionEngine({
      adapter: createFakeCorrector({ type: "error" }),
      now: () => 0,
    });

    const result = await engine.correct(request("he go to the office"));

    assert.equal(result.outcome, "fallback");
    assert.equal(result.errorCode, "provider_error");
  });

  it("falls back when the provider explains instead of correcting", async () => {
    const engine = createCorrectionEngine({
      adapter: createFakeCorrector({
        type: "fixed",
        output: "Corrected: He goes to the office.",
      }),
    });

    const result = await engine.correct(request("he go to the office"));

    assert.equal(result.errorCode, "invalid_output");
    assert.deepEqual(result.warnings, ["invalid_output"]);
  });

  it("falls back when the correction breaks an invariant", async () => {
    const engine = createCorrectionEngine({
      adapter: createFakeCorrector({
        type: "fixed",
        output: "She will join the call.",
      }),
    });

    const result = await engine.correct(request("Maria will join the call"));

    assert.equal(result.errorCode, "unsafe_output");
    assert.deepEqual(result.warnings, ["name_changed"]);
    assert.equal(result.correctedText, "Maria will join the call");
  });

  it("throws when the caller cancels the phrase", async () => {
    const engine = createCorrectionEngine({
      adapter: createFakeCorrector({ type: "never" }),
    });
    const controller = new AbortController();

    const pending = engine.correct(request("he go to the office"), {
      signal: controller.signal,
    });
    controller.abort();

    await assert.rejects(pending, CorrectionCancelled);
  });
});
