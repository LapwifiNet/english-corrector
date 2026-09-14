import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  CapturedAudioFrame,
  PhraseEvent,
  StreamingTranscriber,
} from "../stt/contracts";
import {
  INITIAL_TRANSCRIPT_STATE,
  reduceTranscript,
  type TranscriptState,
} from "../stt/transcriptReducer";
import {
  createHoldSpeechPipeline,
  type HoldPhrase,
} from "./holdSpeechPipeline";

type FakeSession = {
  mode: string | undefined;
  frames: CapturedAudioFrame[];
  finished: boolean;
  cancelled: boolean;
  emit: (event: PhraseEvent) => void;
  onFinish: (() => void) | null;
};

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function ticks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function frame(sequence: number, phraseId = "mic"): CapturedAudioFrame {
  return {
    phraseId,
    sequence,
    capturedAt: sequence * 20,
    sampleRate: 16_000,
    samples: new Float32Array([0.2, 0.2]),
  };
}

function partial(text: string, revision = 1): PhraseEvent {
  return { type: "partial_transcript", phraseId: "hold-1", revision, text };
}

function sentence(text: string, receivedAt = 10): PhraseEvent {
  return {
    type: "final_transcript",
    phraseId: "hold-1",
    text,
    receivedAt,
  };
}

function fold(events: PhraseEvent[]): TranscriptState {
  return events.reduce(reduceTranscript, INITIAL_TRANSCRIPT_STATE);
}

function setup(
  options: {
    prepare?: (phrase: HoldPhrase) => Promise<string | null>;
    gate?: (text: string) => Promise<void> | undefined;
  } = {},
) {
  const sessions: FakeSession[] = [];
  const transcriber: StreamingTranscriber = {
    start: (request) => {
      const session: FakeSession = {
        mode: request.mode,
        frames: [],
        finished: false,
        cancelled: false,
        emit: request.onEvent,
        onFinish: null,
      };
      sessions.push(session);
      return {
        write: (audio) => {
          session.frames.push(audio);
        },
        finish: async () => {
          session.finished = true;
          session.onFinish?.();
        },
        cancel: () => {
          session.cancelled = true;
        },
      };
    },
  };

  const events: PhraseEvent[] = [];
  const started: string[] = [];
  const played: string[] = [];
  const aborted: string[] = [];

  const pipeline = createHoldSpeechPipeline<string>({
    transcriber,
    createSessionId: () => "hold-1",
    now: () => 0,
    prepare: options.prepare ?? (async (phrase) => phrase.text),
    play: async (prepared, _phrase, signal) => {
      started.push(prepared);
      signal.addEventListener(
        "abort",
        () => {
          aborted.push(prepared);
        },
        { once: true },
      );
      await options.gate?.(prepared);
      played.push(prepared);
    },
    onEvent: (event) => events.push(event),
  });

  return { pipeline, sessions, events, started, played, aborted };
}

describe("createHoldSpeechPipeline", () => {
  it("opens one continuous session and retags the audio", () => {
    const { pipeline, sessions } = setup();

    const sessionId = pipeline.press();
    pipeline.write(frame(0));
    pipeline.write(frame(1, "hold-1"));

    assert.equal(sessionId, "hold-1");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.mode, "continuous");
    assert.deepEqual(
      sessions[0]?.frames.map((audio) => audio.phraseId),
      ["hold-1", "hold-1"],
    );
    assert.equal(pipeline.press(), null);
  });

  it("speaks a finished sentence while the key is still held", async () => {
    const { pipeline, sessions, played } = setup();

    pipeline.press();
    sessions[0]?.emit(partial("i can join"));
    sessions[0]?.emit(sentence("I can join the call at three."));
    await pipeline.settled();

    assert.deepEqual(played, ["I can join the call at three."]);
    assert.equal(pipeline.snapshot().holding, true);
    assert.equal(pipeline.snapshot().spokenPhrases, 1);
    assert.equal(sessions.length, 1);
  });

  it("plays phrases in the spoken order when a later one is ready", async () => {
    const slow = new Map([
      ["one", 4],
      ["two", 0],
    ]);
    const { pipeline, sessions, started } = setup({
      prepare: async (phrase) => {
        await ticks(slow.get(phrase.text) ?? 0);
        return phrase.text;
      },
    });

    pipeline.press();
    sessions[0]?.emit(sentence("one"));
    sessions[0]?.emit(sentence("two"));
    await pipeline.settled();

    assert.deepEqual(started, ["one", "two"]);
  });

  it("drops an empty sentence without stalling the next one", async () => {
    const { pipeline, sessions, played } = setup();

    pipeline.press();
    sessions[0]?.emit(sentence("   "));
    sessions[0]?.emit(sentence("Second sentence."));
    await pipeline.settled();

    assert.deepEqual(played, ["Second sentence."]);
  });

  it("keeps going when correction refuses a phrase", async () => {
    const { pipeline, sessions, played } = setup({
      prepare: async (phrase) =>
        phrase.text.startsWith("skip") ? null : phrase.text,
    });

    pipeline.press();
    sessions[0]?.emit(sentence("skip this one"));
    sessions[0]?.emit(sentence("speak this one"));
    await pipeline.settled();

    assert.deepEqual(played, ["speak this one"]);
  });

  it("flushes the last sentence on release", async () => {
    const { pipeline, sessions, played, events } = setup();

    pipeline.press();
    const session = sessions[0];
    assert.ok(session);
    session.onFinish = () => {
      session.emit(sentence("Last sentence."));
    };
    session.emit(partial("last"));
    await pipeline.release();

    assert.equal(session.finished, true);
    assert.deepEqual(played, ["Last sentence."]);
    assert.equal(pipeline.snapshot().holding, false);
    assert.equal(fold(events).stage, "final");
  });

  it("reports an empty phrase when the hold carried no speech", async () => {
    const { pipeline, events, played } = setup();

    pipeline.press();
    await pipeline.release();

    assert.equal(fold(events).stage, "empty");
    assert.equal(played.length, 0);
  });

  it("ignores a trailing empty turn after the last sentence", async () => {
    const { pipeline, sessions, events } = setup();

    pipeline.press();
    const session = sessions[0];
    assert.ok(session);
    session.onFinish = () => {
      session.emit(sentence("", 20));
    };
    session.emit(partial("only"));
    session.emit(sentence("Only sentence."));
    await pipeline.release();

    const state = fold(events);
    assert.equal(state.stage, "final");
    assert.equal(state.finalText, "Only sentence.");
  });

  it("emits events the transcript reducer follows across phrases", () => {
    const { pipeline, sessions, events } = setup();

    pipeline.press();
    sessions[0]?.emit(partial("first"));
    sessions[0]?.emit(sentence("First sentence."));

    const afterFirst = fold(events);
    assert.equal(afterFirst.stage, "final");
    assert.equal(afterFirst.phraseId, "hold-1:0");
    assert.equal(afterFirst.finalText, "First sentence.");

    sessions[0]?.emit(partial("second"));
    sessions[0]?.emit(sentence("Second sentence."));

    const afterSecond = fold(events);
    assert.equal(afterSecond.stage, "final");
    assert.equal(afterSecond.phraseId, "hold-1:1");
    assert.equal(afterSecond.finalText, "Second sentence.");
    assert.equal(afterSecond.partialText, "");
  });

  it("stops the voice and drops the backlog on cancel", async () => {
    const gate = deferred();
    const { pipeline, sessions, started, played, aborted } = setup({
      gate: (text) => (text === "First." ? gate.promise : undefined),
    });

    pipeline.press();
    sessions[0]?.emit(sentence("First."));
    sessions[0]?.emit(sentence("Second."));
    await ticks(8);

    assert.deepEqual(started, ["First."]);

    pipeline.cancel();
    gate.resolve();
    await ticks(8);

    assert.equal(sessions[0]?.cancelled, true);
    assert.deepEqual(aborted, ["First."]);
    assert.equal(played.includes("Second."), false);
    assert.equal(pipeline.snapshot().holding, false);
  });

  it("ends the hold on the open phrase when the provider fails", () => {
    const { pipeline, sessions, events } = setup();

    pipeline.press();
    sessions[0]?.emit(partial("hello"));
    sessions[0]?.emit({
      type: "failed",
      phraseId: "hold-1",
      code: "stt_stream_failed",
    });

    const state = fold(events);
    assert.equal(state.stage, "failed");
    assert.equal(state.errorCode, "stt_stream_failed");
    assert.equal(sessions[0]?.cancelled, true);
    assert.equal(pipeline.snapshot().holding, false);
  });
});
