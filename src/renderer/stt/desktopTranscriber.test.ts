import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  SttAudioChunk,
  SttBridge,
  SttBridgeEvent,
  SttProviderStatus,
  SttStartRequest,
} from "../../shared/stt";
import type {
  StartTranscriptionRequest,
  StreamingTranscriber,
  TranscriptionSession,
} from "./contracts";
import { createDesktopTranscriber } from "./desktopTranscriber";

class CountingTranscriber implements StreamingTranscriber {
  starts = 0;

  start(_request: StartTranscriptionRequest): TranscriptionSession {
    this.starts += 1;
    return {
      write: () => {},
      finish: async () => {},
      cancel: () => {},
    };
  }
}

class StubBridge implements SttBridge {
  readonly started: SttStartRequest[] = [];

  constructor(private readonly status: SttProviderStatus) {}

  async getStatus(): Promise<SttProviderStatus> {
    return this.status;
  }

  start(request: SttStartRequest): void {
    this.started.push(request);
  }

  sendAudio(_chunk: SttAudioChunk): void {}

  finish(_phraseId: string): void {}

  cancel(_phraseId: string): void {}

  onEvent(_listener: (event: SttBridgeEvent) => void): () => void {
    return () => {};
  }
}

const CONFIGURED: SttProviderStatus = {
  configured: true,
  provider: "assemblyai",
  missing: [],
};

const NOT_CONFIGURED: SttProviderStatus = {
  configured: false,
  provider: null,
  missing: ["ASSEMBLYAI_API_KEY"],
};

function startPhrase(transcriber: StreamingTranscriber): void {
  transcriber.start({
    phraseId: "phrase-1",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createDesktopTranscriber", () => {
  it("uses the fallback when there is no bridge", () => {
    const fallback = new CountingTranscriber();

    startPhrase(createDesktopTranscriber({ fallback }));

    assert.equal(fallback.starts, 1);
  });

  it("uses the provider when a key is configured", async () => {
    const fallback = new CountingTranscriber();
    const bridge = new StubBridge(CONFIGURED);
    const transcriber = createDesktopTranscriber({ bridge, fallback });

    await settle();
    startPhrase(transcriber);

    assert.equal(fallback.starts, 0);
    assert.equal(bridge.started.length, 1);
  });

  it("falls back to the fake when no key is configured", async () => {
    const fallback = new CountingTranscriber();
    const bridge = new StubBridge(NOT_CONFIGURED);
    const transcriber = createDesktopTranscriber({ bridge, fallback });

    await settle();
    startPhrase(transcriber);

    assert.equal(fallback.starts, 1);
    assert.equal(bridge.started.length, 0);
  });

  it("prefers the provider while the status answer is still pending", () => {
    const fallback = new CountingTranscriber();
    const bridge = new StubBridge(NOT_CONFIGURED);

    startPhrase(createDesktopTranscriber({ bridge, fallback }));

    assert.equal(fallback.starts, 0);
    assert.equal(bridge.started.length, 1);
  });
});
