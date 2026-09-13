import type {
  TtsBridgeEvent,
  TtsBridgeRequest,
  TtsProviderStatus,
} from "../shared/tts";

const DEFAULT_MODEL_ID = "eleven_flash_v2_5";
const OUTPUT_FORMAT = "pcm_24000" as const;
const MAX_TEXT_LENGTH = 280;

export type ElevenLabsRuntimeConfig = {
  apiKey: string;
  voiceId: string;
  modelId: string;
};

type ByteStreamReader = {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock?: () => void;
};

type FetchResponse = {
  ok: boolean;
  status: number;
  body: { getReader: () => ByteStreamReader } | null;
};

export type ElevenLabsFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<FetchResponse>;

export class ElevenLabsProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ElevenLabsProviderError";
  }
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function readElevenLabsProviderStatus(
  environment: NodeJS.ProcessEnv = process.env,
): TtsProviderStatus {
  const apiKey = clean(environment.ELEVENLABS_API_KEY);
  const voiceId = clean(environment.ELEVENLABS_VOICE_ID);
  const modelId = clean(environment.ELEVENLABS_MODEL_ID) || DEFAULT_MODEL_ID;
  const missing: TtsProviderStatus["missing"] = [];

  if (!apiKey) missing.push("ELEVENLABS_API_KEY");
  if (!voiceId) missing.push("ELEVENLABS_VOICE_ID");

  return {
    provider: "elevenlabs",
    configured: missing.length === 0,
    voiceId: voiceId || null,
    modelId,
    outputFormat: OUTPUT_FORMAT,
    missing,
  };
}

export function readElevenLabsRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ElevenLabsRuntimeConfig | null {
  const status = readElevenLabsProviderStatus(environment);
  const apiKey = clean(environment.ELEVENLABS_API_KEY);

  if (!status.configured || !status.voiceId || !apiKey) return null;

  return {
    apiKey,
    voiceId: status.voiceId,
    modelId: status.modelId,
  };
}

function providerCodeForStatus(status: number): string {
  if (status === 401 || status === 403) return "provider_auth_error";
  if (status === 429) return "provider_rate_limited";
  if (status === 400 || status === 404 || status === 422) {
    return "provider_request_error";
  }
  if (status >= 500) return "provider_unavailable";
  return "provider_http_error";
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

export function providerErrorCode(error: unknown): string {
  if (error instanceof ElevenLabsProviderError) return error.code;
  return "provider_unavailable";
}

export async function streamElevenLabsSpeech(options: {
  request: TtsBridgeRequest;
  config: ElevenLabsRuntimeConfig;
  signal: AbortSignal;
  emit: (event: TtsBridgeEvent) => void;
  fetchImpl?: ElevenLabsFetch;
}): Promise<void> {
  const text = options.request.text.trim();
  if (!text || text.length > MAX_TEXT_LENGTH) {
    throw new ElevenLabsProviderError(
      "provider_request_error",
      "Text must contain between 1 and 280 characters.",
    );
  }
  if (options.request.voiceId !== options.config.voiceId) {
    throw new ElevenLabsProviderError(
      "provider_voice_mismatch",
      "The requested voice does not match the configured voice.",
    );
  }
  if (options.signal.aborted) throw abortError();

  const fetchImpl =
    options.fetchImpl ?? (globalThis.fetch as unknown as ElevenLabsFetch);
  if (!fetchImpl) {
    throw new ElevenLabsProviderError(
      "provider_unavailable",
      "This runtime does not provide fetch.",
    );
  }

  const endpoint =
    `https://api.elevenlabs.io/v1/text-to-speech/` +
    `${encodeURIComponent(options.config.voiceId)}/stream?output_format=${OUTPUT_FORMAT}`;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Accept: "audio/pcm",
      "Content-Type": "application/json",
      "xi-api-key": options.config.apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: options.config.modelId,
      apply_text_normalization: "auto",
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new ElevenLabsProviderError(
      providerCodeForStatus(response.status),
      `ElevenLabs returned HTTP ${response.status}.`,
    );
  }
  if (!response.body) {
    throw new ElevenLabsProviderError(
      "provider_stream_error",
      "ElevenLabs returned no response stream.",
    );
  }

  options.emit({
    type: "started",
    utteranceId: options.request.utteranceId,
    format: {
      sampleRate: 24_000,
      channels: 1,
      encoding: "pcm_s16le",
    },
  });

  const reader = response.body.getReader();
  let sequence = 0;
  let audioBytes = 0;

  try {
    while (true) {
      if (options.signal.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const bytes = new Uint8Array(value);
      audioBytes += bytes.byteLength;
      options.emit({
        type: "chunk",
        utteranceId: options.request.utteranceId,
        sequence,
        bytes,
      });
      sequence += 1;
    }
  } finally {
    reader.releaseLock?.();
  }

  if (audioBytes === 0) {
    throw new ElevenLabsProviderError(
      "provider_empty_audio",
      "ElevenLabs returned an empty audio stream.",
    );
  }

  options.emit({
    type: "completed",
    utteranceId: options.request.utteranceId,
  });
}
