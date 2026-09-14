import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CorrectionSnapshot } from "../correction/correctionPipeline";
import type {
  NormalizedAudioFrame,
  StreamingAudioSink,
  UtteranceMetrics,
  UtteranceResult,
} from "../tts/contracts";
import { FakeTtsAdapter } from "../tts/fakeTtsAdapter";
import type { RunUtteranceOptions } from "../tts/runUtterance";
import {
  CorrectedSpeechRelay,
  RelayRouteError,
  isRelayPlaybackBusy,
  type RelayPlaybackSnapshot,
  type RelayRoute,
} from "./correctedSpeechRelay";

class RecordingSink implements StreamingAudioSink {
  readonly outputs: string[] = [];
  readonly frames: NormalizedAudioFrame[] = [];
  stops = 0;

  async start(outputDeviceId: string): Promise<void> {
    this.outputs.push(outputDeviceId);
  }

  async write(frame: NormalizedAudioFrame): Promise<void> {
    this.frames.push(frame);
  }

  async drain(): Promise<void> {}

  async stop(): Promise<void> {
    this.stops += 1;
  }
}

const adapter = new FakeTtsAdapter({ chunkDelayMs: 0, chunkBytes: 4_096 });

function route(overrides: Partial<RelayRoute> = {}): RelayRoute {
  return {
    adapter,
    voiceId: "voice-1",
    voiceLabel: "Relay voice",
    outputDeviceId: "blackhole-2ch",
    outputLabel: "BlackHole 2ch",
    ...overrides,
  };
}

function correction(
  phraseId: string,
  spokenText: string,
  phase: CorrectionSnapshot["phase"] = "done",
): CorrectionSnapshot {
  return {
    phase,
    phraseId,
    originalText: spokenText,
    spokenText,
    result: null,
  };
}

function metrics(): UtteranceMetrics {
  return {
    requestStartedAt: 10,
    firstChunkAt: 20,
    playbackStartedAt: 30,
    playbackCompletedAt: 40,
    duplicateChunks: 0,
    outOfOrderChunks: 0,
  };
}

function completed(): UtteranceResult {
  return { stage: "completed", metrics: metrics() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("CorrectedSpeechRelay", () => {
  it("streams the safe spoken text once into the selected output", async () => {
    const sink = new RecordingSink();
    const snapshots: RelayPlaybackSnapshot[] = [];
    const relay = new CorrectedSpeechRelay({
      resolveRoute: async () => route(),
      createSink: () => sink,
      createUtteranceId: () => "utterance-phrase-1",
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });

    const result = await relay.submit(
      correction("phrase-1", "I need to check order 4821."),
    );

    assert.equal(result.phase, "completed");
    assert.equal(result.spokenText, "I need to check order 4821.");
    assert.equal(result.provider, "diagnostic-fake");
    assert.equal(result.voiceLabel, "Relay voice");
    assert.equal(result.outputLabel, "BlackHole 2ch");
    assert.deepEqual(sink.outputs, ["blackhole-2ch"]);
    assert.ok(sink.frames.length > 0);
    assert.ok(snapshots.some((snapshot) => snapshot.phase === "playing"));
    assert.equal(isRelayPlaybackBusy(result), false);
  });

  it("deduplicates repeated correction snapshots before TTS", async () => {
    let runs = 0;
    const relay = new CorrectedSpeechRelay({
      resolveRoute: async () => route(),
      createSink: () => new RecordingSink(),
      run: async () => {
        runs += 1;
        return completed();
      },
    });
    const snapshot = correction("phrase-2", "This sentence is spoken once.");

    await relay.submit(snapshot);
    await relay.submit(snapshot);

    assert.equal(runs, 1);
  });

  it("uses a fallback spoken sentence exactly once", async () => {
    const spoken: string[] = [];
    const relay = new CorrectedSpeechRelay({
      resolveRoute: async () => route(),
      createSink: () => new RecordingSink(),
      run: async (options) => {
        spoken.push(options.request.text);
        return completed();
      },
    });
    const fallback = correction(
      "phrase-fallback",
      "I has not received order 4821.",
    );
    fallback.originalText = "I has not received order 4821.";

    await relay.submit(fallback);
    await relay.submit(fallback);

    assert.deepEqual(spoken, ["I has not received order 4821."]);
  });

  it("ignores a correction that is not speakable", async () => {
    let routeCalls = 0;
    const relay = new CorrectedSpeechRelay({
      resolveRoute: async () => {
        routeCalls += 1;
        return route();
      },
      createSink: () => new RecordingSink(),
    });

    const result = await relay.submit(
      correction("phrase-3", "Do not speak this.", "cancelled"),
    );

    assert.equal(result.phase, "idle");
    assert.equal(routeCalls, 0);
  });

  it("publishes a stable setup failure without calling TTS", async () => {
    let runs = 0;
    const relay = new CorrectedSpeechRelay({
      resolveRoute: async () => {
        throw new RelayRouteError("output_device_required");
      },
      createSink: () => new RecordingSink(),
      run: async () => {
        runs += 1;
        return completed();
      },
    });

    const result = await relay.submit(
      correction("phrase-4", "Keep this phrase visible."),
    );

    assert.equal(result.phase, "failed");
    assert.equal(result.errorCode, "output_device_required");
    assert.equal(runs, 0);
  });

  it("cancels while the route is resolving before creating audio", async () => {
    const resolvingRoute = deferred<RelayRoute>();
    let sinkCreations = 0;
    let runs = 0;
    const relay = new CorrectedSpeechRelay({
      resolveRoute: () => resolvingRoute.promise,
      createSink: () => {
        sinkCreations += 1;
        return new RecordingSink();
      },
      run: async () => {
        runs += 1;
        return completed();
      },
    });

    const pending = relay.submit(
      correction("phrase-route-cancel", "Cancel before route resolution."),
    );
    assert.equal(relay.snapshot().phase, "preparing");
    relay.cancel("phrase-route-cancel");
    resolvingRoute.resolve(route());
    await pending;

    assert.equal(relay.snapshot().phase, "cancelled");
    assert.equal(sinkCreations, 0);
    assert.equal(runs, 0);
  });

  it("cancels playback and ignores its late completion", async () => {
    const runStarted = deferred<void>();
    const lateResult = deferred<UtteranceResult>();
    const relay = new CorrectedSpeechRelay({
      resolveRoute: async () => route(),
      createSink: () => new RecordingSink(),
      run: async (_options: RunUtteranceOptions) => {
        runStarted.resolve();
        return lateResult.promise;
      },
    });

    const pending = relay.submit(
      correction("phrase-5", "Cancel this spoken sentence."),
    );
    await runStarted.promise;
    assert.equal(isRelayPlaybackBusy(relay.snapshot()), true);

    relay.cancel("phrase-5");
    assert.equal(relay.snapshot().phase, "cancelled");
    lateResult.resolve(completed());
    await pending;

    assert.equal(relay.snapshot().phase, "cancelled");
  });

  it("does not cancel a different phrase", async () => {
    const runStarted = deferred<void>();
    const result = deferred<UtteranceResult>();
    const relay = new CorrectedSpeechRelay({
      resolveRoute: async () => route(),
      createSink: () => new RecordingSink(),
      run: async () => {
        runStarted.resolve();
        return result.promise;
      },
    });

    const pending = relay.submit(correction("phrase-6", "Keep playing."));
    await runStarted.promise;
    relay.cancel("another-phrase");

    assert.equal(isRelayPlaybackBusy(relay.snapshot()), true);
    result.resolve(completed());
    await pending;
    assert.equal(relay.snapshot().phase, "completed");
  });

  it("lets a newer phrase supersede an older late result", async () => {
    const firstStarted = deferred<void>();
    const firstResult = deferred<UtteranceResult>();
    let runs = 0;
    const relay = new CorrectedSpeechRelay({
      resolveRoute: async () => route(),
      createSink: () => new RecordingSink(),
      run: async (options) => {
        runs += 1;
        if (options.request.text === "Older phrase.") {
          firstStarted.resolve();
          return firstResult.promise;
        }
        return completed();
      },
    });

    const older = relay.submit(correction("phrase-7", "Older phrase."));
    await firstStarted.promise;
    const newer = await relay.submit(correction("phrase-8", "Newer phrase."));
    firstResult.resolve(completed());
    await older;

    assert.equal(runs, 2);
    assert.equal(newer.phase, "completed");
    assert.equal(relay.snapshot().phraseId, "phrase-8");
    assert.equal(relay.snapshot().spokenText, "Newer phrase.");
  });
});
