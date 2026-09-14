import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  SttAudioChunk,
  SttBridge,
  SttBridgeEvent,
  SttProviderStatus,
  SttStartRequest,
} from "../../shared/stt";
import type { CapturedAudioFrame, PhraseEvent } from "./contracts";
import { createIpcTranscriber } from "./ipcTranscriber";

class FakeBridge implements SttBridge {
  readonly started: SttStartRequest[] = [];
  readonly chunks: SttAudioChunk[] = [];
  readonly finished: string[] = [];
  readonly cancelled: string[] = [];

  private listeners: Array<(event: SttBridgeEvent) => void> = [];

  async getStatus(): Promise<SttProviderStatus> {
    return { configured: true, provider: "assemblyai", missing: [] };
  }

  start(request: SttStartRequest): void {
    this.started.push(request);
  }

  sendAudio(chunk: SttAudioChunk): void {
    this.chunks.push(chunk);
  }

  finish(phraseId: string): void {
    this.finished.push(phraseId);
  }

  cancel(phraseId: string): void {
    this.cancelled.push(phraseId);
  }

  onEvent(listener: (event: SttBridgeEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  emit(event: SttBridgeEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

function frame(
  phraseId: string,
  sequence: number,
  length = 480,
): CapturedAudioFrame {
  return {
    phraseId,
    sequence,
    capturedAt: 0,
    sampleRate: 48_000,
    samples: new Float32Array(length),
  };
}

function startSession(bridge: FakeBridge, phraseId = "phrase-1") {
  const events: PhraseEvent[] = [];
  const controller = new AbortController();
  const session = createIpcTranscriber(bridge).start({
    phraseId,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  });

  return { events, controller, session };
}

describe("createIpcTranscriber", () => {
  it("opens a session at the provider sample rate", () => {
    const bridge = new FakeBridge();
    startSession(bridge);

    assert.deepEqual(bridge.started, [
      { phraseId: "phrase-1", sampleRate: 16_000 },
    ]);
  });

  it("sends downsampled PCM16 for each captured frame", () => {
    const bridge = new FakeBridge();
    const { session } = startSession(bridge);

    session.write(frame("phrase-1", 0));

    assert.equal(bridge.chunks.length, 1);
    assert.equal(bridge.chunks[0]?.sequence, 0);
    assert.equal(bridge.chunks[0]?.pcm.byteLength, 320);
  });

  it("ignores frames that belong to another phrase", () => {
    const bridge = new FakeBridge();
    const { session } = startSession(bridge);

    session.write(frame("phrase-2", 0));

    assert.equal(bridge.chunks.length, 0);
  });

  it("maps partial and final provider events onto phrase events", async () => {
    const bridge = new FakeBridge();
    const { events, session } = startSession(bridge);

    bridge.emit({
      type: "partial",
      phraseId: "phrase-1",
      revision: 1,
      text: "he go",
    });

    const finished = session.finish();
    bridge.emit({
      type: "final",
      phraseId: "phrase-1",
      text: "He go to work.",
      receivedAt: 1_234,
      confidence: 0.9,
    });
    await finished;

    assert.deepEqual(events, [
      {
        type: "partial_transcript",
        phraseId: "phrase-1",
        revision: 1,
        text: "he go",
      },
      {
        type: "final_transcript",
        phraseId: "phrase-1",
        text: "He go to work.",
        receivedAt: 1_234,
        confidence: 0.9,
      },
    ]);
    assert.deepEqual(bridge.finished, ["phrase-1"]);
    assert.equal(bridge.listenerCount, 0);
  });

  it("passes a provider failure through as a failed phrase", async () => {
    const bridge = new FakeBridge();
    const { events, session } = startSession(bridge);

    const finished = session.finish();
    bridge.emit({
      type: "failed",
      phraseId: "phrase-1",
      code: "provider_not_configured",
    });
    await finished;

    assert.deepEqual(events, [
      {
        type: "failed",
        phraseId: "phrase-1",
        code: "provider_not_configured",
      },
    ]);
    assert.equal(bridge.listenerCount, 0);
  });

  it("cancels the provider session and stops listening", () => {
    const bridge = new FakeBridge();
    const { events, session } = startSession(bridge);

    session.cancel();
    bridge.emit({
      type: "final",
      phraseId: "phrase-1",
      text: "He go to work.",
      receivedAt: 1,
    });

    assert.deepEqual(bridge.cancelled, ["phrase-1"]);
    assert.deepEqual(events, []);
    assert.equal(bridge.listenerCount, 0);
  });

  it("cancels when the caller aborts", () => {
    const bridge = new FakeBridge();
    const { controller } = startSession(bridge);

    controller.abort();

    assert.deepEqual(bridge.cancelled, ["phrase-1"]);
    assert.equal(bridge.listenerCount, 0);
  });
});
