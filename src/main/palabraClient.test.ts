import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TtsBridgeEvent } from "../shared/tts";
import {
  PalabraProviderError,
  PalabraStreamingClient,
  readPalabraProviderStatus,
  type PalabraRuntimeConfig,
  type PalabraSocketEvent,
  type PalabraSocketEventType,
  type PalabraWebSocket,
} from "./palabraClient";

const config: PalabraRuntimeConfig = {
  apiKey: "test-api-key",
  voiceId: "default_low",
  modelId: "auto",
  language: "en-us",
  region: "us",
};
const request = {
  utteranceId: "utterance-1",
  text: "Hello world",
  voiceId: "default_low",
};

class FakeSocket implements PalabraWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<
    PalabraSocketEventType,
    Set<(event: PalabraSocketEvent) => void>
  >();

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  addEventListener(
    type: PalabraSocketEventType,
    listener: (event: PalabraSocketEvent) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: PalabraSocketEventType,
    listener: (event: PalabraSocketEvent) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  private emit(type: PalabraSocketEventType, event: PalabraSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("Palabra client", () => {
  it("reports safe defaults without exposing the API key", () => {
    const status = readPalabraProviderStatus({
      PALABRA_API_KEY: "private-key",
    });

    assert.equal(status.provider, "palabra");
    assert.equal(status.configured, true);
    assert.equal(status.voiceId, "default_low");
    assert.equal(status.modelId, "auto");
    assert.equal(status.language, "en-us");
    assert.equal(status.region, "us");
    assert.equal(JSON.stringify(status).includes("private-key"), false);
  });

  it("reports the required missing environment value", () => {
    const status = readPalabraProviderStatus({});

    assert.equal(status.configured, false);
    assert.deepEqual(status.missing, ["PALABRA_API_KEY"]);
  });

  it("opens the US session and streams ordered PCM events", async () => {
    const socket = new FakeSocket();
    const events: TtsBridgeEvent[] = [];
    let capturedUrl = "";
    const client = new PalabraStreamingClient(config, (url) => {
      capturedUrl = url;
      return socket;
    });

    const streaming = client.streamSpeech({
      request,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });
    socket.open();
    await nextTurn();

    const init = JSON.parse(socket.sent[0] ?? "null");
    const text = JSON.parse(socket.sent[1] ?? "null");
    assert.match(capturedUrl, /^wss:\/\/stream\.us\.palabra\.ai\//);
    assert.match(capturedUrl, /token=test-api-key/);
    assert.deepEqual(init, {
      type: "init",
      language: "en-us",
      model: "auto",
      voice_options: {
        voice_id: "default_low",
        speed: 1,
        deaccent_strength: 1,
      },
      output: { format: "pcm", sample_rate: 24_000 },
    });
    assert.deepEqual(text, {
      type: "text",
      text: "Hello world",
      generation_id: "utterance-1",
      is_eos: true,
      voice_options: { voice_id: "default_low" },
    });

    socket.message({
      message_type: "audio_chunk",
      data: {
        audio: Buffer.from([1, 2]).toString("base64"),
        generation_id: "utterance-1",
        last_chunk: false,
      },
    });
    socket.message({
      message_type: "audio_chunk",
      data: {
        audio: Buffer.from([3, 4]).toString("base64"),
        generation_id: "utterance-1",
        last_chunk: true,
      },
    });
    await streaming;

    assert.deepEqual(
      events.map((event) => event.type),
      ["started", "chunk", "chunk", "completed"],
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === "chunk")
        .map((event) => event.sequence),
      [0, 1],
    );
  });

  it("sends cancel and rejects with AbortError", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const client = new PalabraStreamingClient(config, () => socket);

    const streaming = client.streamSpeech({
      request,
      signal: controller.signal,
      emit: () => undefined,
    });
    socket.open();
    await nextTurn();
    controller.abort();

    await assert.rejects(streaming, { name: "AbortError" });
    assert.deepEqual(JSON.parse(socket.sent.at(-1) ?? "null"), {
      type: "cancel",
    });
  });

  it("maps Palabra errors to stable provider codes", async () => {
    const socket = new FakeSocket();
    const client = new PalabraStreamingClient(config, () => socket);

    const streaming = client.streamSpeech({
      request,
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    socket.open();
    await nextTurn();
    socket.message({
      message_type: "error",
      data: { code: "UNAUTHORIZED", desc: "Invalid token" },
    });

    await assert.rejects(
      streaming,
      (error: unknown) =>
        error instanceof PalabraProviderError &&
        error.code === "provider_auth_error",
    );
  });

  it("reuses one initialized WebSocket for later utterances", async () => {
    const socket = new FakeSocket();
    let connections = 0;
    const client = new PalabraStreamingClient(config, () => {
      connections += 1;
      return socket;
    });

    const first = client.streamSpeech({
      request,
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    socket.open();
    await nextTurn();
    socket.message({
      message_type: "audio_chunk",
      data: {
        audio: Buffer.from([1, 2]).toString("base64"),
        generation_id: "utterance-1",
        last_chunk: true,
      },
    });
    await first;

    const secondRequest = {
      ...request,
      utteranceId: "utterance-2",
      voiceId: "custom-voice-1",
    };
    const second = client.streamSpeech({
      request: secondRequest,
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    await nextTurn();
    socket.message({
      message_type: "audio_chunk",
      data: {
        audio: Buffer.from([3, 4]).toString("base64"),
        generation_id: "utterance-2",
        last_chunk: true,
      },
    });
    await second;

    assert.equal(connections, 1);
    assert.equal(
      socket.sent.filter((message) => JSON.parse(message).type === "init")
        .length,
      1,
    );
    assert.deepEqual(JSON.parse(socket.sent.at(-1) ?? "null").voice_options, {
      voice_id: "custom-voice-1",
    });
  });
});
