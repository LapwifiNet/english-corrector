import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAutoListenController,
  type AutoListenState,
  type AutoListenUtterance,
} from "./autoListenController";
import type {
  CapturedAudioFrame,
  PhraseEvent,
  StartTranscriptionRequest,
  StreamingTranscriber,
} from "./contracts";

type FakeSession = {
  phraseId: string;
  mode?: string;
  emit: (event: PhraseEvent) => void;
  frames: CapturedAudioFrame[];
  finished: number;
  cancelled: number;
};

function fakeTranscriber(): {
  transcriber: StreamingTranscriber;
  sessions: FakeSession[];
} {
  const sessions: FakeSession[] = [];

  return {
    sessions,
    transcriber: {
      start(request: StartTranscriptionRequest) {
        const record: FakeSession = {
          phraseId: request.phraseId,
          mode: request.mode,
          emit: request.onEvent,
          frames: [],
          finished: 0,
          cancelled: 0,
        };
        sessions.push(record);

        return {
          write: (frame: CapturedAudioFrame) => {
            record.frames.push(frame);
          },
          finish: async () => {
            record.finished += 1;
          },
          cancel: () => {
            record.cancelled += 1;
          },
        };
      },
    },
  };
}

function frame(level: number, at: number, sequence = 0): CapturedAudioFrame {
  return {
    phraseId: "microphone",
    sequence,
    capturedAt: at,
    sampleRate: 48_000,
    samples: Float32Array.from({ length: 256 }, () => level),
  };
}

function setup(options: { playbackTailMs?: number } = {}) {
  const { transcriber, sessions } = fakeTranscriber();
  const utterances: AutoListenUtterance[] = [];
  const states: AutoListenState[] = [];
  const partials: string[] = [];
  const errors: string[] = [];

  const controller = createAutoListenController({
    transcriber,
    onUtterance: (utterance) => utterances.push(utterance),
    onPartial: (text) => partials.push(text),
    onState: (state) => states.push(state),
    onError: (code) => errors.push(code),
    idleTimeoutMs: 500,
    playbackTailMs: options.playbackTailMs ?? 300,
    voiceActivity: { minSpeechMs: 100, hangoverMs: 200 },
    now: () => 1_000,
  });

  return { controller, sessions, utterances, states, partials, errors };
}

describe("createAutoListenController", () => {
  it("opens one continuous session and stamps audio with its id", () => {
    const { controller, sessions } = setup();

    controller.start();
    controller.write(frame(0.2, 1_050, 1));

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.mode, "continuous");
    assert.equal(sessions[0]?.frames.length, 1);
    assert.equal(sessions[0]?.frames[0]?.phraseId, sessions[0]?.phraseId);
    assert.equal(controller.state(), "listening");
  });

  it("reports one utterance per provider final", () => {
    const { controller, sessions, utterances, partials } = setup();

    controller.start();
    const session = sessions[0];
    session?.emit({
      type: "partial_transcript",
      phraseId: session.phraseId,
      revision: 1,
      text: "he go",
    });
    session?.emit({
      type: "final_transcript",
      phraseId: session.phraseId,
      text: " He go to work. ",
      receivedAt: 2_000,
      utterance: 0,
    });
    session?.emit({
      type: "final_transcript",
      phraseId: session.phraseId,
      text: "   ",
      receivedAt: 2_100,
      utterance: 1,
    });
    session?.emit({
      type: "final_transcript",
      phraseId: session.phraseId,
      text: "She like it.",
      receivedAt: 2_200,
      utterance: 2,
    });

    assert.deepEqual(partials, ["he go"]);
    assert.deepEqual(
      utterances.map((item) => item.text),
      ["He go to work.", "She like it."],
    );
    assert.equal(new Set(utterances.map((item) => item.phraseId)).size, 2);
  });

  it("keeps our own playback out of the stream", () => {
    const { controller, sessions, states } = setup({ playbackTailMs: 300 });

    controller.start();
    const session = sessions[0];

    controller.setPlayback(true, 1_100);
    controller.write(frame(0.3, 1_150, 1));
    controller.write(frame(0.3, 1_200, 2));

    assert.equal(session?.frames.length, 0);
    assert.equal(controller.state(), "playback");

    controller.setPlayback(false, 1_250);
    controller.write(frame(0.3, 1_300, 3));
    assert.equal(session?.frames.length, 0);

    controller.write(frame(0.3, 1_600, 4));
    assert.equal(session?.frames.length, 1);
    assert.equal(states.includes("playback"), true);
  });

  it("lets an idle session go and reopens it on the next voice", () => {
    const { controller, sessions } = setup();

    controller.start();
    controller.write(frame(0.001, 1_400, 1));
    controller.write(frame(0.001, 1_600, 2));

    assert.equal(sessions[0]?.finished, 1);
    assert.equal(controller.state(), "waiting");

    controller.write(frame(0.3, 1_700, 3));
    controller.write(frame(0.3, 1_750, 4));
    controller.write(frame(0.3, 1_800, 5));

    assert.equal(sessions.length, 2);
    // The frames spent proving it was speech are not thrown away.
    assert.equal(sessions[1]?.frames.length, 3);
    assert.equal(controller.state(), "listening");
  });

  it("stops listening after a provider failure", () => {
    const { controller, sessions, errors } = setup();

    controller.start();
    const session = sessions[0];
    session?.emit({
      type: "failed",
      phraseId: session.phraseId,
      code: "provider_rate_limited",
    });

    controller.write(frame(0.3, 1_500, 1));

    assert.deepEqual(errors, ["provider_rate_limited"]);
    assert.equal(controller.state(), "failed");
    assert.equal(session?.cancelled, 1);
    assert.equal(session?.frames.length, 0);
    assert.equal(sessions.length, 1);
  });

  it("finishes the open session when hands-free mode is switched off", () => {
    const { controller, sessions } = setup();

    controller.start();
    controller.stop();

    assert.equal(sessions[0]?.finished, 1);
    assert.equal(controller.state(), "off");

    controller.write(frame(0.3, 1_500, 1));
    assert.equal(sessions[0]?.frames.length, 0);
    assert.equal(sessions.length, 1);
  });
});
