import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CapturedAudioFrame, PhraseEvent } from "./contracts";
import { FakeStreamingTranscriber } from "./fakeTranscriber";

function frame(sequence: number, sample = 0.2): CapturedAudioFrame {
  return {
    phraseId: "phrase-1",
    sequence,
    capturedAt: sequence,
    sampleRate: 48_000,
    samples: new Float32Array([sample, sample]),
  };
}

describe("FakeStreamingTranscriber", () => {
  it("emits ordered partial revisions and one deterministic final", async () => {
    const events: PhraseEvent[] = [];
    const transcriber = new FakeStreamingTranscriber(
      undefined,
      async () => undefined,
      () => 200,
    );
    const session = transcriber.start({
      phraseId: "phrase-1",
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });

    session.write(frame(0));
    session.write(frame(0));
    session.write(frame(1));
    await session.finish();
    await session.finish();

    assert.deepEqual(
      events
        .filter((event) => event.type === "partial_transcript")
        .map((event) => event.revision),
      [1, 2, 3],
    );
    const finals = events.filter((event) => event.type === "final_transcript");
    assert.equal(finals.length, 1);
    assert.equal(finals[0]?.text, "I need to check the order number 4821.");
  });

  it("returns an empty final for silent audio", async () => {
    const events: PhraseEvent[] = [];
    const session = new FakeStreamingTranscriber(
      undefined,
      async () => undefined,
      () => 100,
    ).start({
      phraseId: "phrase-1",
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });

    session.write(frame(0, 0));
    await session.finish();

    const final = events.find((event) => event.type === "final_transcript");
    assert.equal(final?.text, "");
  });

  it("drops all events after cancellation", async () => {
    const events: PhraseEvent[] = [];
    const session = new FakeStreamingTranscriber(
      undefined,
      async () => undefined,
    ).start({
      phraseId: "phrase-1",
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });

    session.cancel();
    session.write(frame(0));
    await session.finish();
    assert.deepEqual(events, []);
  });
});
