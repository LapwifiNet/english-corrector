import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TtsBridgeEvent } from "../shared/tts";
import {
  ElevenLabsProviderError,
  readElevenLabsProviderStatus,
  streamElevenLabsSpeech,
  type ElevenLabsFetch,
} from "./elevenLabsClient";

const request = {
  utteranceId: "utterance-1",
  text: "Hello world",
  voiceId: "voice-1",
};
const config = {
  apiKey: "test-api-key",
  voiceId: "voice-1",
  modelId: "eleven_flash_v2_5",
};

function streamResponse(chunks: Uint8Array[], status = 200) {
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length
            ? { done: false, value: chunks[index++] }
            : { done: true },
      }),
    },
  };
}

describe("ElevenLabs client", () => {
  it("reports configuration without exposing the API key", () => {
    const status = readElevenLabsProviderStatus({
      ELEVENLABS_API_KEY: "private-key",
      ELEVENLABS_VOICE_ID: "voice-1",
    });

    assert.equal(status.configured, true);
    assert.equal(status.voiceId, "voice-1");
    assert.equal(JSON.stringify(status).includes("private-key"), false);
  });

  it("reports every missing environment value", () => {
    const status = readElevenLabsProviderStatus({});

    assert.equal(status.configured, false);
    assert.deepEqual(status.missing, [
      "ELEVENLABS_API_KEY",
      "ELEVENLABS_VOICE_ID",
    ]);
  });

  it("streams ordered PCM events with the expected request", async () => {
    const events: TtsBridgeEvent[] = [];
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";
    const fetchImpl: ElevenLabsFetch = async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      capturedBody = init.body;
      return streamResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    };

    await streamElevenLabsSpeech({
      request,
      config,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      fetchImpl,
    });

    assert.match(capturedUrl, /voice-1\/stream\?output_format=pcm_24000$/);
    assert.equal(capturedHeaders["xi-api-key"], "test-api-key");
    assert.deepEqual(JSON.parse(capturedBody), {
      text: "Hello world",
      model_id: "eleven_flash_v2_5",
      apply_text_normalization: "auto",
    });
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

  it("maps authentication failures to a stable error code", async () => {
    const fetchImpl: ElevenLabsFetch = async () => streamResponse([], 401);

    await assert.rejects(
      streamElevenLabsSpeech({
        request,
        config,
        signal: new AbortController().signal,
        emit: () => undefined,
        fetchImpl,
      }),
      (error: unknown) =>
        error instanceof ElevenLabsProviderError &&
        error.code === "provider_auth_error",
    );
  });

  it("rejects an empty successful audio stream", async () => {
    const fetchImpl: ElevenLabsFetch = async () => streamResponse([]);

    await assert.rejects(
      streamElevenLabsSpeech({
        request,
        config,
        signal: new AbortController().signal,
        emit: () => undefined,
        fetchImpl,
      }),
      (error: unknown) =>
        error instanceof ElevenLabsProviderError &&
        error.code === "provider_empty_audio",
    );
  });
});
