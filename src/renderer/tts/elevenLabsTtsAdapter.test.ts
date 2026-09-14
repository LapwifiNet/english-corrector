import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  TtsBridge,
  TtsBridgeEvent,
  TtsBridgeRequest,
  TtsProviderStatus,
} from "../../shared/tts";
import type { TtsEvent } from "./contracts";
import { RemoteTtsAdapter } from "./elevenLabsTtsAdapter";

const status: TtsProviderStatus = {
  provider: "palabra",
  configured: true,
  voiceId: "default_low",
  modelId: "auto",
  outputFormat: "pcm_24000",
  missing: [],
  language: "en-us",
  region: "us",
};
const request = {
  utteranceId: "utterance-1",
  text: "Hello world",
  voiceId: "default_low",
};

class FakeBridge implements TtsBridge {
  cancelled: string[] = [];
  request: TtsBridgeRequest | null = null;
  private listener: ((event: TtsBridgeEvent) => void) | null = null;

  async getStatus(): Promise<TtsProviderStatus> {
    return status;
  }

  start(requestValue: TtsBridgeRequest): void {
    this.request = requestValue;
  }

  cancel(utteranceId: string): void {
    this.cancelled.push(utteranceId);
  }

  onEvent(listener: (event: TtsBridgeEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emit(event: TtsBridgeEvent): void {
    this.listener?.(event);
  }
}

describe("RemoteTtsAdapter", () => {
  it("maps bridge events into the provider-neutral contract", async () => {
    const bridge = new FakeBridge();
    const adapter = new RemoteTtsAdapter(bridge, status);
    const events: TtsEvent[] = [];

    const consume = (async () => {
      for await (const event of adapter.synthesize(
        request,
        new AbortController().signal,
      )) {
        events.push(event);
      }
    })();
    await Promise.resolve();

    bridge.emit({
      type: "started",
      utteranceId: request.utteranceId,
      format: {
        sampleRate: 24_000,
        channels: 1,
        encoding: "pcm_s16le",
      },
    });
    bridge.emit({
      type: "chunk",
      utteranceId: request.utteranceId,
      sequence: 0,
      bytes: new Uint8Array([1, 2]),
    });
    bridge.emit({ type: "completed", utteranceId: request.utteranceId });
    await consume;

    assert.deepEqual(bridge.request, request);
    assert.equal(adapter.provider, "palabra");
    assert.equal(adapter.listVoices()[0]?.name, "Palabra · auto");
    assert.deepEqual(
      events.map((event) => event.type),
      ["started", "chunk", "completed"],
    );
  });

  it("ignores events for another utterance", async () => {
    const bridge = new FakeBridge();
    const adapter = new RemoteTtsAdapter(bridge, status);
    const events: TtsEvent[] = [];

    const consume = (async () => {
      for await (const event of adapter.synthesize(
        request,
        new AbortController().signal,
      )) {
        events.push(event);
      }
    })();
    await Promise.resolve();
    bridge.emit({ type: "completed", utteranceId: "another-utterance" });
    bridge.emit({ type: "completed", utteranceId: request.utteranceId });
    await consume;

    assert.equal(events.length, 1);
    assert.equal(events[0]?.utteranceId, request.utteranceId);
  });

  it("cancels the main-process request when aborted", async () => {
    const bridge = new FakeBridge();
    const adapter = new RemoteTtsAdapter(bridge, status);
    const controller = new AbortController();

    const consume = (async () => {
      for await (const _event of adapter.synthesize(
        request,
        controller.signal,
      )) {
        // Iteration itself is the behavior under test.
      }
    })();
    await Promise.resolve();
    controller.abort();

    await assert.rejects(consume, { name: "AbortError" });
    assert.deepEqual(bridge.cancelled, [request.utteranceId]);
  });
});
