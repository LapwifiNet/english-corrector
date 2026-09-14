import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INITIAL_TRANSCRIPT_STATE,
  reduceTranscript,
  speechEndToFinalMs,
} from "./transcriptReducer";

describe("transcript reducer", () => {
  it("keeps the newest partial revision and one final transcript", () => {
    let state = reduceTranscript(INITIAL_TRANSCRIPT_STATE, {
      type: "capture_started",
      phraseId: "phrase-1",
      startedAt: 10,
    });
    state = reduceTranscript(state, {
      type: "partial_transcript",
      phraseId: "phrase-1",
      revision: 2,
      text: "new hypothesis",
    });
    const newest = state;
    state = reduceTranscript(state, {
      type: "partial_transcript",
      phraseId: "phrase-1",
      revision: 1,
      text: "old hypothesis",
    });
    assert.equal(state, newest);

    state = reduceTranscript(state, {
      type: "capture_ended",
      phraseId: "phrase-1",
      endedAt: 100,
    });
    state = reduceTranscript(state, {
      type: "final_transcript",
      phraseId: "phrase-1",
      text: "Final sentence.",
      confidence: 0.92,
      receivedAt: 160,
    });
    const final = state;
    state = reduceTranscript(state, {
      type: "final_transcript",
      phraseId: "phrase-1",
      text: "Duplicate final.",
      receivedAt: 180,
    });

    assert.equal(state, final);
    assert.equal(state.stage, "final");
    assert.equal(state.finalText, "Final sentence.");
    assert.equal(state.confidence, 0.92);
    assert.equal(speechEndToFinalMs(state), 60);
  });

  it("ignores events from another phrase and events after cancel", () => {
    let state = reduceTranscript(INITIAL_TRANSCRIPT_STATE, {
      type: "capture_started",
      phraseId: "phrase-1",
      startedAt: 10,
    });
    const active = state;
    state = reduceTranscript(state, {
      type: "partial_transcript",
      phraseId: "phrase-2",
      revision: 1,
      text: "wrong phrase",
    });
    assert.equal(state, active);

    state = reduceTranscript(state, {
      type: "cancelled",
      phraseId: "phrase-1",
    });
    const cancelled = state;
    state = reduceTranscript(state, {
      type: "partial_transcript",
      phraseId: "phrase-1",
      revision: 2,
      text: "late result",
    });
    assert.equal(state, cancelled);
  });

  it("marks a silent phrase as empty", () => {
    let state = reduceTranscript(INITIAL_TRANSCRIPT_STATE, {
      type: "capture_started",
      phraseId: "phrase-1",
      startedAt: 10,
    });
    state = reduceTranscript(state, {
      type: "capture_ended",
      phraseId: "phrase-1",
      endedAt: 20,
    });
    state = reduceTranscript(state, {
      type: "final_transcript",
      phraseId: "phrase-1",
      text: "   ",
      receivedAt: 30,
    });

    assert.equal(state.stage, "empty");
    assert.equal(state.finalText, "");
  });
});
