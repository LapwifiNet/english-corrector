import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  NormalizedAudioFrame,
  StreamingAudioSink,
  TtsAdapter,
  TtsVoice,
} from "./contracts";
import { FakeTtsAdapter } from "./fakeTtsAdapter";
import { runUtterance } from "./runUtterance";

function s16(sample: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setInt16(0, sample, true);
  return bytes;
}

class RecordingSink implements StreamingAudioSink {
  starts = 0;
  stops = 0;
  drains = 0;
  frames: NormalizedAudioFrame[] = [];
  startedBeforeProviderCompleted = false;

  constructor(private readonly providerCompleted?: () => boolean) {}

  async start(): Promise<void> {
    this.starts += 1;
    this.startedBeforeProviderCompleted = !(this.providerCompleted?.() ?? true);
  }

  async write(frame: NormalizedAudioFrame): Promise<void> {
    this.frames.push(frame);
  }

  async drain(): Promise<void> {
    this.drains += 1;
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }
}

class BlockingDrainSink extends RecordingSink {
  readonly drainStarted: Promise<void>;
  private markDrainStarted!: () => void;
  private releaseDrain: (() => void) | null = null;

  constructor() {
    super();
    this.drainStarted = new Promise<void>((resolve) => {
      this.markDrainStarted = resolve;
    });
  }

  override async drain(): Promise<void> {
    this.drains += 1;
    this.markDrainStarted();
    await new Promise<void>((resolve) => {
      this.releaseDrain = resolve;
    });
  }

  override async stop(): Promise<void> {
    this.stops += 1;
    this.releaseDrain?.();
    this.releaseDrain = null;
  }
}

const voice: TtsVoice = {
  id: "test",
  name: "Test",
  locale: "en-US",
};

const request = {
  utteranceId: "utterance-1",
  text: "Hello",
  voiceId: voice.id,
};

describe("runUtterance", () => {
  it("reorders, deduplicates, and starts before synthesis completes", async () => {
    let providerCompleted = false;
    const adapter: TtsAdapter = {
      provider: "test",
      listVoices: () => [voice],
      async *synthesize(currentRequest) {
        yield {
          type: "started",
          utteranceId: currentRequest.utteranceId,
          format: {
            sampleRate: 48_000,
            channels: 1,
            encoding: "pcm_s16le",
          },
        } as const;
        yield {
          type: "chunk",
          utteranceId: currentRequest.utteranceId,
          sequence: 1,
          bytes: s16(2_000),
        } as const;
        yield {
          type: "chunk",
          utteranceId: currentRequest.utteranceId,
          sequence: 0,
          bytes: s16(1_000),
        } as const;
        yield {
          type: "chunk",
          utteranceId: currentRequest.utteranceId,
          sequence: 0,
          bytes: s16(1_000),
        } as const;
        providerCompleted = true;
        yield {
          type: "completed",
          utteranceId: currentRequest.utteranceId,
        } as const;
      },
    };
    const sink = new RecordingSink(() => providerCompleted);

    const result = await runUtterance({
      adapter,
      request,
      sink,
      outputDeviceId: "blackhole",
      signal: new AbortController().signal,
      prebufferBytes: 2,
      highWaterBytes: 32,
    });

    assert.equal(result.stage, "completed");
    assert.equal(result.metrics.outOfOrderChunks, 1);
    assert.equal(result.metrics.duplicateChunks, 1);
    assert.equal(sink.starts, 1);
    assert.equal(sink.frames.length, 2);
    assert.equal(sink.drains, 1);
    assert.equal(sink.startedBeforeProviderCompleted, true);
  });

  it("rejects empty text before calling the provider", async () => {
    let providerCalled = false;
    const adapter: TtsAdapter = {
      provider: "test",
      listVoices: () => [voice],
      async *synthesize() {
        providerCalled = true;
        yield* [];
      },
    };

    const result = await runUtterance({
      adapter,
      request: { ...request, text: "   " },
      sink: new RecordingSink(),
      outputDeviceId: "blackhole",
      signal: new AbortController().signal,
    });

    assert.equal(result.stage, "failed");
    assert.equal(result.errorCode, "invalid_text");
    assert.equal(providerCalled, false);
  });

  it("returns a stable provider failure code", async () => {
    const adapter = new FakeTtsAdapter({
      chunkDelayMs: 0,
      failAtSequence: 0,
    });
    const result = await runUtterance({
      adapter,
      request,
      sink: new RecordingSink(),
      outputDeviceId: "blackhole",
      signal: new AbortController().signal,
    });

    assert.equal(result.stage, "failed");
    assert.equal(result.errorCode, "diagnostic_failure");
  });

  it("cancels the provider and stops the sink", async () => {
    const controller = new AbortController();
    const sink = new RecordingSink();
    const resultPromise = runUtterance({
      adapter: new FakeTtsAdapter({ chunkDelayMs: 50, chunkBytes: 128 }),
      request,
      sink,
      outputDeviceId: "blackhole",
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 5);
    const result = await resultPromise;

    assert.equal(result.stage, "cancelled");
    assert.equal(sink.stops, 1);
  });

  it("cancels active playback while the sink is draining", async () => {
    const controller = new AbortController();
    const sink = new BlockingDrainSink();
    const resultPromise = runUtterance({
      adapter: new FakeTtsAdapter({ chunkDelayMs: 0, chunkBytes: 256 }),
      request,
      sink,
      outputDeviceId: "blackhole",
      signal: controller.signal,
      prebufferBytes: 256,
    });

    await sink.drainStarted;
    controller.abort();
    const result = await resultPromise;

    assert.equal(result.stage, "cancelled");
    assert.ok(sink.frames.length > 0);
    assert.equal(sink.stops, 1);
  });
});
