import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  averageWordConfidence,
  createPcmChunker,
  readSttProviderStatus,
  readSttRuntimeConfig,
  requestStreamingToken,
  startAssemblyAiSession,
  streamingUrl,
  tokenUrl,
  type AssemblyAiConfig,
  type FetchLike,
  type SttSocketEvent,
  type SttWebSocket,
} from "./assemblyAiClient";

const CONFIG: AssemblyAiConfig = {
  apiKey: "test-key",
  host: "streaming.example.test",
  sampleRate: 16_000,
  formatTurns: true,
  finalizeTimeoutMs: 20,
};

class FakeSocket implements SttWebSocket {
  readonly sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  closed = false;
  private readonly listeners = new Map<
    string,
    Array<(event: SttSocketEvent) => void>
  >();

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: SttSocketEvent) => void,
  ): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  emit(
    type: "open" | "message" | "close" | "error",
    event: SttSocketEvent = {},
  ) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  emitTurn(turn: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify({ type: "Turn", ...turn }) });
  }

  get textMessages(): string[] {
    return this.sent.filter((item): item is string => typeof item === "string");
  }

  get binaryMessages(): ArrayBuffer[] {
    return this.sent.filter(
      (item): item is ArrayBuffer => item instanceof ArrayBuffer,
    );
  }
}

function tokenFetch(token = "temp-token"): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ token }),
  });
}

function failingFetch(status: number): FetchLike {
  return async () => ({
    ok: false,
    status,
    json: async () => ({}),
  });
}

type Collected = {
  partials: string[];
  finals: Array<{ text: string; confidence?: number }>;
  errors: string[];
};

function collector(): {
  collected: Collected;
  events: Parameters<typeof startAssemblyAiSession>[0]["events"];
} {
  const collected: Collected = { partials: [], finals: [], errors: [] };

  return {
    collected,
    events: {
      onPartial: (text) => collected.partials.push(text),
      onFinal: (text, confidence) =>
        collected.finals.push({ text, confidence }),
      onError: (code) => collected.errors.push(code),
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("readSttProviderStatus", () => {
  it("reports the missing key when the provider is not configured", () => {
    const status = readSttProviderStatus({});

    assert.equal(status.configured, false);
    assert.equal(status.provider, null);
    assert.deepEqual(status.missing, ["ASSEMBLYAI_API_KEY"]);
  });

  it("reports assemblyai when a key is present", () => {
    const status = readSttProviderStatus({ ASSEMBLYAI_API_KEY: " key " });

    assert.equal(status.configured, true);
    assert.equal(status.provider, "assemblyai");
    assert.deepEqual(status.missing, []);
  });
});

describe("readSttRuntimeConfig", () => {
  it("returns null without a key", () => {
    assert.equal(readSttRuntimeConfig({ ASSEMBLYAI_API_KEY: "  " }), null);
  });

  it("defaults to the global host with formatted turns", () => {
    const config = readSttRuntimeConfig({ ASSEMBLYAI_API_KEY: "key" });

    assert.equal(config?.host, "streaming.assemblyai.com");
    assert.equal(config?.sampleRate, 16_000);
    assert.equal(config?.formatTurns, true);
  });

  it("allows turning formatting off", () => {
    const config = readSttRuntimeConfig({
      ASSEMBLYAI_API_KEY: "key",
      ASSEMBLYAI_FORMAT_TURNS: "false",
    });

    assert.equal(config?.formatTurns, false);
  });
});

describe("requestStreamingToken", () => {
  it("sends the key as an Authorization header and never in the URL", async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const token = await requestStreamingToken({
      config: CONFIG,
      fetchImpl: async (url, init) => {
        calls.push({ url, headers: init?.headers });
        return { ok: true, status: 200, json: async () => ({ token: "abc" }) };
      },
    });

    assert.equal(token, "abc");
    assert.equal(calls[0]?.url, tokenUrl(CONFIG));
    assert.equal(calls[0]?.headers?.Authorization, "test-key");
    assert.equal(calls[0]?.url.includes("test-key"), false);
  });

  it("maps provider status codes to stable error codes", async () => {
    const cases: Array<[number, string]> = [
      [401, "provider_auth_error"],
      [429, "provider_rate_limited"],
      [500, "provider_unavailable"],
    ];

    for (const [status, code] of cases) {
      await assert.rejects(
        requestStreamingToken({
          config: CONFIG,
          fetchImpl: failingFetch(status),
        }),
        (error: Error & { code?: string }) => error.code === code,
      );
    }
  });
});

describe("streamingUrl", () => {
  it("asks for raw 16 kHz PCM and carries the temporary token", () => {
    const url = new URL(streamingUrl(CONFIG, "temp-token"));

    assert.equal(url.protocol, "wss:");
    assert.equal(url.pathname, "/v3/ws");
    assert.equal(url.searchParams.get("encoding"), "pcm_s16le");
    assert.equal(url.searchParams.get("sample_rate"), "16000");
    assert.equal(url.searchParams.get("format_turns"), "true");
    assert.equal(url.searchParams.get("token"), "temp-token");
  });
});

describe("averageWordConfidence", () => {
  it("averages word confidence and ignores missing values", () => {
    assert.equal(
      averageWordConfidence({
        words: [{ confidence: 0.8 }, { confidence: 0.6 }],
      }),
      0.7,
    );
    assert.equal(averageWordConfidence({ words: [] }), undefined);
  });
});

describe("startAssemblyAiSession", () => {
  it("queues audio until the socket opens, then flushes it", async () => {
    const socket = new FakeSocket();
    const { collected, events } = collector();
    const session = startAssemblyAiSession({
      config: CONFIG,
      events,
      fetchImpl: tokenFetch(),
      socketFactory: () => socket,
    });

    session.write(new ArrayBuffer(1_600));
    await flush();
    assert.equal(socket.sent.length, 0);

    socket.emit("open");
    session.write(new ArrayBuffer(1_600));

    assert.equal(socket.sent.length, 2);
    assert.deepEqual(collected.errors, []);
  });

  it("emits partials and one formatted final for a finished phrase", async () => {
    const socket = new FakeSocket();
    const { collected, events } = collector();
    const session = startAssemblyAiSession({
      config: CONFIG,
      events,
      fetchImpl: tokenFetch(),
      socketFactory: () => socket,
    });

    await flush();
    socket.emit("open");
    socket.emitTurn({ turn_order: 0, transcript: "he go", end_of_turn: false });
    session.finish();
    socket.emitTurn({
      turn_order: 0,
      transcript: "he go to work",
      end_of_turn: true,
      turn_is_formatted: false,
    });
    socket.emitTurn({
      turn_order: 0,
      transcript: "He go to work.",
      end_of_turn: true,
      turn_is_formatted: true,
      words: [{ confidence: 0.9 }, { confidence: 0.7 }],
    });

    assert.deepEqual(collected.partials, ["he go"]);
    assert.equal(collected.finals.length, 1);
    assert.equal(collected.finals[0]?.text, "He go to work.");
    assert.equal(collected.finals[0]?.confidence, 0.8);
    assert.equal(
      socket.textMessages[0],
      JSON.stringify({ type: "ForceEndpoint" }),
    );
    assert.equal(socket.closed, true);
  });

  it("joins several turns when the speaker pauses inside one phrase", async () => {
    const socket = new FakeSocket();
    const { collected, events } = collector();
    const session = startAssemblyAiSession({
      config: CONFIG,
      events,
      fetchImpl: tokenFetch(),
      socketFactory: () => socket,
    });

    await flush();
    socket.emit("open");
    socket.emitTurn({
      turn_order: 0,
      transcript: "He go to work.",
      end_of_turn: true,
      turn_is_formatted: true,
    });
    session.finish();
    socket.emitTurn({
      turn_order: 1,
      transcript: "Every Monday.",
      end_of_turn: true,
      turn_is_formatted: true,
    });

    assert.equal(collected.finals[0]?.text, "He go to work. Every Monday.");
  });

  it("finalizes with what it has when the provider goes quiet", async () => {
    const socket = new FakeSocket();
    const { collected, events } = collector();
    const session = startAssemblyAiSession({
      config: CONFIG,
      events,
      fetchImpl: tokenFetch(),
      socketFactory: () => socket,
    });

    await flush();
    socket.emit("open");
    socket.emitTurn({
      turn_order: 0,
      transcript: "He go to work.",
      end_of_turn: true,
      turn_is_formatted: true,
    });
    session.finish();

    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(collected.finals.length, 1);
    assert.equal(collected.finals[0]?.text, "He go to work.");
  });

  it("reports the token error code and never opens a socket", async () => {
    let created = 0;
    const { collected, events } = collector();
    startAssemblyAiSession({
      config: CONFIG,
      events,
      fetchImpl: failingFetch(401),
      socketFactory: () => {
        created += 1;
        return new FakeSocket();
      },
    });

    await flush();

    assert.deepEqual(collected.errors, ["provider_auth_error"]);
    assert.equal(created, 0);
  });

  it("treats an unexpected close as a provider failure", async () => {
    const socket = new FakeSocket();
    const { collected, events } = collector();
    startAssemblyAiSession({
      config: CONFIG,
      events,
      fetchImpl: tokenFetch(),
      socketFactory: () => socket,
    });

    await flush();
    socket.emit("open");
    socket.emit("close", { code: 1006 });

    assert.deepEqual(collected.errors, ["provider_unavailable"]);
    assert.equal(collected.finals.length, 0);
  });

  it("stays silent after cancel", async () => {
    const socket = new FakeSocket();
    const { collected, events } = collector();
    const session = startAssemblyAiSession({
      config: CONFIG,
      events,
      fetchImpl: tokenFetch(),
      socketFactory: () => socket,
    });

    await flush();
    socket.emit("open");
    session.cancel();
    socket.emitTurn({
      turn_order: 0,
      transcript: "He go to work.",
      end_of_turn: true,
      turn_is_formatted: true,
    });

    assert.equal(socket.closed, true);
    assert.deepEqual(collected.finals, []);
    assert.deepEqual(collected.errors, []);
  });

  it("sends audio only in chunks the provider accepts", async () => {
    const socket = new FakeSocket();
    const { events } = collector();
    const session = startAssemblyAiSession({
      config: CONFIG,
      events,
      fetchImpl: tokenFetch(),
      socketFactory: () => socket,
    });

    await flush();
    socket.emit("open");
    for (let index = 0; index < 4; index += 1) {
      session.write(new ArrayBuffer(1_364));
    }

    assert.equal(socket.binaryMessages.length, 3);
    for (const chunk of socket.binaryMessages) {
      assert.equal(chunk.byteLength, 1_600);
    }

    session.cancel();
  });

  it("pads and flushes the trailing audio before ending the turn", async () => {
    const socket = new FakeSocket();
    const { events } = collector();
    const session = startAssemblyAiSession({
      config: CONFIG,
      events,
      fetchImpl: tokenFetch(),
      socketFactory: () => socket,
    });

    await flush();
    socket.emit("open");
    session.write(new ArrayBuffer(1_364));
    session.finish();

    assert.equal(socket.binaryMessages.length, 1);
    assert.equal(socket.binaryMessages[0]?.byteLength, 1_600);
    assert.equal(
      socket.textMessages[0],
      JSON.stringify({ type: "ForceEndpoint" }),
    );

    session.cancel();
  });
});

describe("createPcmChunker", () => {
  it("regroups short frames into provider sized chunks", () => {
    const chunker = createPcmChunker({ sampleRate: 16_000 });
    const frame = new ArrayBuffer(1_364);

    assert.deepEqual(chunker.push(frame), []);
    const ready = chunker.push(frame);

    assert.equal(ready.length, 1);
    assert.equal(ready[0]?.byteLength, 1_600);
  });

  it("never emits a chunk longer than the provider maximum", () => {
    const chunker = createPcmChunker({ sampleRate: 16_000, chunkMs: 4_000 });
    const ready = chunker.push(new ArrayBuffer(64_000));

    assert.equal(ready.length, 2);
    for (const chunk of ready) assert.equal(chunk.byteLength, 32_000);
  });

  it("pads the remaining tail with silence", () => {
    const chunker = createPcmChunker({ sampleRate: 16_000 });
    chunker.push(new ArrayBuffer(200));

    assert.equal(chunker.flush()?.byteLength, 1_600);
    assert.equal(chunker.flush(), null);
  });
});
