import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPhraseEndpointer } from "./phraseEndpointer";

const SENTENCE = "i can join the call at three";

describe("createPhraseEndpointer", () => {
  it("closes a phrase on silence while the key is still held", () => {
    const endpointer = createPhraseEndpointer();
    endpointer.open(0);

    assert.deepEqual(endpointer.push({ speaking: true, at: 0, text: "" }), {
      endpoint: false,
      heldBack: "still_speaking",
    });
    endpointer.push({ speaking: true, at: 900, text: SENTENCE });

    assert.deepEqual(
      endpointer.push({ speaking: false, at: 1100, text: SENTENCE }),
      { endpoint: false, heldBack: "silence_too_short" },
    );
    assert.deepEqual(
      endpointer.push({ speaking: false, at: 1450, text: SENTENCE }),
      {
        endpoint: true,
        reason: "silence",
        at: 1450,
        durationMs: 1450,
        words: 7,
      },
    );
  });

  it("ignores silence before the speaker has said anything", () => {
    const endpointer = createPhraseEndpointer();
    endpointer.open(0);

    assert.deepEqual(endpointer.push({ speaking: false, at: 4000, text: "" }), {
      endpoint: false,
      heldBack: "no_speech_yet",
    });
  });

  it("holds a short breath open so it merges into the next phrase", () => {
    const endpointer = createPhraseEndpointer();
    endpointer.open(0);
    endpointer.push({ speaking: true, at: 0, text: "" });

    assert.deepEqual(
      endpointer.push({ speaking: false, at: 550, text: "okay" }),
      { endpoint: false, heldBack: "phrase_too_short" },
    );
    assert.deepEqual(
      endpointer.push({ speaking: false, at: 900, text: "okay" }),
      { endpoint: false, heldBack: "too_few_words" },
    );
  });

  it("holds the phrase open when the transcript ends mid-thought", () => {
    const endpointer = createPhraseEndpointer();
    endpointer.open(0);
    endpointer.push({
      speaking: true,
      at: 400,
      text: "i can join the call and",
    });

    assert.deepEqual(
      endpointer.push({
        speaking: false,
        at: 1200,
        text: "i can join the call and",
      }),
      { endpoint: false, heldBack: "continuation_token" },
    );
  });

  it("trusts provider punctuation over the continuation word list", () => {
    const endpointer = createPhraseEndpointer();
    endpointer.open(0);
    endpointer.push({ speaking: true, at: 400, text: "she said it was." });

    const decision = endpointer.push({
      speaking: false,
      at: 1200,
      text: "she said it was.",
    });
    assert.equal(decision.endpoint, true);
    assert.equal(decision.endpoint && decision.reason, "silence");
  });

  it("force closes a phrase that runs past the max duration", () => {
    const endpointer = createPhraseEndpointer();
    endpointer.open(0);
    endpointer.push({ speaking: true, at: 0, text: "" });

    const decision = endpointer.push({
      speaking: true,
      at: 10_000,
      text: "i kept talking without a pause and",
    });
    assert.equal(decision.endpoint, true);
    assert.equal(decision.endpoint && decision.reason, "max_duration");
  });

  it("flushes the open phrase on release without quality gates", () => {
    const endpointer = createPhraseEndpointer();
    endpointer.open(0);
    endpointer.push({ speaking: true, at: 200, text: "okay" });

    assert.deepEqual(endpointer.release(400, "okay"), {
      endpoint: true,
      reason: "release",
      at: 400,
      durationMs: 400,
      words: 1,
    });
  });

  it("emits nothing when the key is released without speech", () => {
    const endpointer = createPhraseEndpointer();
    endpointer.open(0);
    endpointer.push({ speaking: false, at: 100, text: "" });

    assert.deepEqual(endpointer.release(200, ""), {
      endpoint: false,
      heldBack: "no_speech_yet",
    });
    assert.equal(endpointer.snapshot().open, false);
  });

  it("delays the endpoint while backpressure raises the silence bar", () => {
    const endpointer = createPhraseEndpointer();
    endpointer.setSilenceBonus(400);
    endpointer.open(0);
    endpointer.push({ speaking: true, at: 900, text: SENTENCE });

    assert.deepEqual(
      endpointer.push({ speaking: false, at: 1450, text: SENTENCE }),
      { endpoint: false, heldBack: "silence_too_short" },
    );
    assert.equal(
      endpointer.push({ speaking: false, at: 1900, text: SENTENCE }).endpoint,
      true,
    );
  });
});
