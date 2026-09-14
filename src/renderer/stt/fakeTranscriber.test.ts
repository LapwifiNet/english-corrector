import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CapturedAudioFrame, PhraseEvent } from "./contracts";
import {
  FAKE_CONTINUOUS_SILENCE_MS,
  FakeStreamingTranscriber,
} from "./fakeTranscriber";

function frame(sequence: number, sample = 0.2): CapturedAudioFrame {
  return {
    phraseId: "phrase-1",
    sequence,
    capturedAt: sequence,
    sampleRate: 48_000,
    samples: new Float32Array([sample, sample]),
  };
}

function timedFrame(
  sequence: number,
  capturedAt: number,
  sample: number,
): CapturedAudioFrame {
  return {
    phraseId: "hold-1",
    sequence,
    capturedAt,
    sampleRate: 48_000,
    samples: new Float32Array([sample, sample]),
  };
}

function finals(events: PhraseEvent[]) {
  return events.filter((event) => event.type === "final_transcript");
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
    const closed = finals(events);
    assert.equal(closed.length, 1);
    assert.equal(closed[0]?.text, "I need to check the order number 4821.");
    assert.equal(closed[0]?.utterance, undefined);
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
    assert.equal(events.length, 0);
  });
});

describe("FakeStreamingTranscriber in continuous mode", () => {
  function continuousSession(events: PhraseEvent[]) {
    return new FakeStreamingTranscriber(
      undefined,
      async () => undefined,
      () => 9_000,
    ).start({
      phraseId: "hold-1",
      mode: "continuous",
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });
  }

  it("closes a sentence on silence and keeps the session open", async () => {
    const events: PhraseEvent[] = [];
    const session = continuousSession(events);

    session.write(timedFrame(0, 0, 0.2));
    session.write(timedFrame(1, 20, 0.2));
    session.write(timedFrame(2, 40, 0.2));
    // A short gap is part of the same sentence.
    session.write(timedFrame(3, 60, 0));
    assert.equal(finals(events).length, 0);

    session.write(timedFrame(4, 40 + FAKE_CONTINUOUS_SILENCE_MS, 0));
    assert.equal(finals(events).length, 1);
    assert.equal(finals(events)[0]?.utterance, 0);
    assert.equal(
      finals(events)[0]?.text,
      "I need to check the order number 4821.",
    );

    // The next breath becomes its own sentence on the same session.
    session.write(timedFrame(5, 1_000, 0.2));
    session.write(timedFrame(6, 1_020, 0.2));
    session.write(timedFrame(7, 1_020 + FAKE_CONTINUOUS_SILENCE_MS, 0));

    assert.equal(finals(events).length, 2);
    assert.equal(finals(events)[1]?.utterance, 1);

    await session.finish();
    assert.equal(finals(events).length, 2);
  });

  it("flushes a sentence that was still open on finish", async () => {
    const events: PhraseEvent[] = [];
    const session = continuousSession(events);

    session.write(timedFrame(0, 0, 0.2));
    session.write(timedFrame(1, 20, 0.2));
    await session.finish();

    const closed = finals(events);
    assert.equal(closed.length, 1);
    assert.equal(closed[0]?.utterance, 0);
    assert.equal(closed[0]?.receivedAt, 9_000);
    assert.equal(closed[0]?.text, "I need to check the order number 4821.");
  });

  it("reports an empty final when the hold carried no speech", async () => {
    const events: PhraseEvent[] = [];
    const session = continuousSession(events);

    session.write(timedFrame(0, 0, 0));
    await session.finish();

    assert.equal(finals(events)[0]?.text, "");
  });
});
