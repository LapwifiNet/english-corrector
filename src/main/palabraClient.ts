import { Buffer } from "node:buffer";
import type {
  TtsBridgeEvent,
  TtsBridgeRequest,
  TtsProviderStatus,
} from "../shared/tts";

const DEFAULT_LANGUAGE = "en-us";
const DEFAULT_MODEL_ID = "auto";
const DEFAULT_REGION = "us" as const;
const DEFAULT_VOICE_ID = "default_low";
const MAX_TEXT_LENGTH = 280;

const ENDPOINTS = {
  eu: "wss://stream.palabra.ai/tts-api/v1/text-to-speech/stream",
  us: "wss://stream.us.palabra.ai/tts-api/v1/text-to-speech/stream",
} as const;

export type PalabraRegion = keyof typeof ENDPOINTS;

export type PalabraRuntimeConfig = {
  apiKey: string;
  voiceId: string;
  modelId: string;
  language: string;
  region: PalabraRegion;
};

export type PalabraSocketEvent = {
  data?: unknown;
  code?: number;
  reason?: string;
};

export type PalabraSocketEventType = "open" | "message" | "error" | "close";

export type PalabraWebSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: PalabraSocketEventType,
    listener: (event: PalabraSocketEvent) => void,
  ): void;
  removeEventListener(
    type: PalabraSocketEventType,
    listener: (event: PalabraSocketEvent) => void,
  ): void;
};

export type PalabraWebSocketFactory = (url: string) => PalabraWebSocket;

type ActiveGeneration = {
  request: TtsBridgeRequest;
  generationId: string;
  sequence: number;
  audioBytes: number;
  emit: (event: TtsBridgeEvent) => void;
  signal: AbortSignal;
  onAbort: () => void;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class PalabraProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PalabraProviderError";
  }
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function readRegion(value: string | undefined): PalabraRegion {
  return clean(value).toLowerCase() === "eu" ? "eu" : DEFAULT_REGION;
}

export function readPalabraProviderStatus(
  environment: NodeJS.ProcessEnv = process.env,
): TtsProviderStatus {
  const apiKey = clean(environment.PALABRA_API_KEY);
  const voiceId = clean(environment.PALABRA_VOICE_ID) || DEFAULT_VOICE_ID;
  const modelId = clean(environment.PALABRA_MODEL_ID) || DEFAULT_MODEL_ID;
  const language = clean(environment.PALABRA_LANGUAGE) || DEFAULT_LANGUAGE;
  const region = readRegion(environment.PALABRA_REGION);
  const missing: TtsProviderStatus["missing"] = [];

  if (!apiKey) missing.push("PALABRA_API_KEY");

  return {
    provider: "palabra",
    configured: missing.length === 0,
    voiceId,
    modelId,
    outputFormat: "pcm_24000",
    missing,
    language,
    region,
  };
}

export function readPalabraRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PalabraRuntimeConfig | null {
  const status = readPalabraProviderStatus(environment);
  const apiKey = clean(environment.PALABRA_API_KEY);

  if (!status.configured || !status.voiceId || !apiKey) return null;

  return {
    apiKey,
    voiceId: status.voiceId,
    modelId: status.modelId,
    language: status.language ?? DEFAULT_LANGUAGE,
    region: status.region ?? DEFAULT_REGION,
  };
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function nativeWebSocketFactory(url: string): PalabraWebSocket {
  const Constructor = (
    globalThis as unknown as {
      WebSocket?: new (socketUrl: string) => PalabraWebSocket;
    }
  ).WebSocket;

  if (!Constructor) {
    throw new PalabraProviderError(
      "provider_unavailable",
      "This runtime does not provide WebSocket.",
    );
  }

  return new Constructor(url);
}

function textFromSocketData(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  return null;
}

function errorCodeForMessage(code: string): string {
  if (code === "UNAUTHORIZED") return "provider_auth_error";
  if (code === "RATE_LIMIT_EXCEEDED") return "provider_rate_limited";
  if (
    code === "BAD_REQUEST" ||
    code === "VALIDATION_ERROR" ||
    code === "CONFLICT" ||
    code === "SESSION_NOT_FOUND"
  ) {
    return "provider_request_error";
  }
  if (code === "SERVICE_UNAVAILABLE") return "provider_unavailable";
  return "provider_stream_error";
}

export function palabraProviderErrorCode(error: unknown): string {
  if (error instanceof PalabraProviderError) return error.code;
  return "provider_unavailable";
}

export class PalabraStreamingClient {
  private socket: PalabraWebSocket | null = null;
  private connectionPromise: Promise<void> | null = null;
  private active: ActiveGeneration | null = null;

  constructor(
    private readonly config: PalabraRuntimeConfig,
    private readonly createSocket: PalabraWebSocketFactory = nativeWebSocketFactory,
  ) {}

  async streamSpeech(options: {
    request: TtsBridgeRequest;
    signal: AbortSignal;
    emit: (event: TtsBridgeEvent) => void;
  }): Promise<void> {
    const text = options.request.text.trim();
    if (!text || text.length > MAX_TEXT_LENGTH) {
      throw new PalabraProviderError(
        "provider_request_error",
        "Text must contain between 1 and 280 characters.",
      );
    }
    if (options.request.voiceId !== this.config.voiceId) {
      throw new PalabraProviderError(
        "provider_voice_mismatch",
        "The requested voice does not match the configured voice.",
      );
    }
    if (this.active) {
      throw new PalabraProviderError(
        "utterance_already_active",
        "Another Palabra generation is active.",
      );
    }
    if (options.signal.aborted) throw abortError();

    await this.ensureConnected();
    if (options.signal.aborted) throw abortError();
    if (!this.socket || this.socket.readyState !== 1) {
      throw new PalabraProviderError(
        "provider_unavailable",
        "The Palabra WebSocket is not open.",
      );
    }

    const generationId =
      options.request.utteranceId.length >= 4
        ? options.request.utteranceId
        : `utt-${options.request.utteranceId}`;

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        if (this.active?.generationId !== generationId) return;
        try {
          if (this.socket?.readyState === 1) {
            this.socket.send(JSON.stringify({ type: "cancel" }));
          }
        } finally {
          this.rejectActive(abortError());
        }
      };

      this.active = {
        request: options.request,
        generationId,
        sequence: 0,
        audioBytes: 0,
        emit: options.emit,
        signal: options.signal,
        onAbort,
        resolve,
        reject,
      };
      options.signal.addEventListener("abort", onAbort, { once: true });

      options.emit({
        type: "started",
        utteranceId: options.request.utteranceId,
        format: {
          sampleRate: 24_000,
          channels: 1,
          encoding: "pcm_s16le",
        },
      });

      try {
        this.socket!.send(
          JSON.stringify({
            type: "text",
            text,
            generation_id: generationId,
            is_eos: true,
          }),
        );
      } catch (error) {
        this.rejectActive(
          new PalabraProviderError(
            "provider_stream_error",
            error instanceof Error ? error.message : "WebSocket send failed.",
          ),
        );
      }
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket?.readyState === 1) return;
    if (this.connectionPromise) return this.connectionPromise;

    const endpoint = ENDPOINTS[this.config.region];
    const socketUrl = new URL(endpoint);
    socketUrl.searchParams.set("token", this.config.apiKey);
    const socket = this.createSocket(socketUrl.toString());

    const connectionPromise = new Promise<void>((resolve, reject) => {
      let opened = false;

      const onOpen = () => {
        try {
          socket.send(
            JSON.stringify({
              type: "init",
              language: this.config.language,
              model: this.config.modelId,
              voice_options: {
                voice_id: this.config.voiceId,
                speed: 1,
                deaccent_strength: 1,
              },
              output: {
                format: "pcm",
                sample_rate: 24_000,
              },
            }),
          );
          opened = true;
          this.socket = socket;
          socket.removeEventListener("open", onOpen);
          resolve();
        } catch (error) {
          reject(
            new PalabraProviderError(
              "provider_stream_error",
              error instanceof Error ? error.message : "WebSocket init failed.",
            ),
          );
          socket.close();
        }
      };

      const onMessage = (event: PalabraSocketEvent) => {
        this.handleMessage(event.data);
      };

      const onError = () => {
        const error = new PalabraProviderError(
          "provider_unavailable",
          "The Palabra WebSocket reported an error.",
        );
        if (!opened) reject(error);
        else this.rejectActive(error);
      };

      const onClose = (event: PalabraSocketEvent) => {
        if (this.socket === socket) this.socket = null;
        if (this.connectionPromise === connectionPromise) {
          this.connectionPromise = null;
        }

        const rateLimited =
          event.code === 1008 &&
          event.reason?.toLowerCase().includes("rate limit");
        const error = new PalabraProviderError(
          rateLimited ? "provider_rate_limited" : "provider_stream_error",
          event.reason || "The Palabra WebSocket closed.",
        );
        if (!opened) reject(error);
        else this.rejectActive(error);
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
    });

    this.connectionPromise = connectionPromise;
    try {
      await connectionPromise;
    } catch (error) {
      if (this.connectionPromise === connectionPromise) {
        this.connectionPromise = null;
      }
      throw error;
    }
  }

  private handleMessage(rawData: unknown): void {
    const text = textFromSocketData(rawData);
    if (!text || !this.active) return;

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.rejectActive(
        new PalabraProviderError(
          "provider_stream_error",
          "Palabra returned invalid JSON.",
        ),
      );
      return;
    }

    if (message.message_type === "error") {
      const data =
        message.data && typeof message.data === "object"
          ? (message.data as Record<string, unknown>)
          : {};
      const code = typeof data.code === "string" ? data.code : "UNKNOWN_ERROR";
      const description =
        typeof data.desc === "string" ? data.desc : "Palabra synthesis failed.";
      this.rejectActive(
        new PalabraProviderError(errorCodeForMessage(code), description),
      );
      return;
    }

    if (message.message_type !== "audio_chunk") return;
    const data =
      message.data && typeof message.data === "object"
        ? (message.data as Record<string, unknown>)
        : null;
    if (!data) return;

    const active = this.active;
    const generationId =
      typeof data.generation_id === "string" ? data.generation_id : null;
    if (generationId && generationId !== active.generationId) return;

    if (typeof data.audio === "string" && data.audio.length > 0) {
      const decoded = Buffer.from(data.audio, "base64");
      if (decoded.byteLength > 0) {
        const bytes = new Uint8Array(
          decoded.buffer,
          decoded.byteOffset,
          decoded.byteLength,
        );
        active.audioBytes += bytes.byteLength;
        active.emit({
          type: "chunk",
          utteranceId: active.request.utteranceId,
          sequence: active.sequence,
          bytes,
        });
        active.sequence += 1;
      }
    }

    if (data.last_chunk === true) {
      if (active.audioBytes === 0) {
        this.rejectActive(
          new PalabraProviderError(
            "provider_empty_audio",
            "Palabra returned an empty audio stream.",
          ),
        );
        return;
      }

      active.emit({
        type: "completed",
        utteranceId: active.request.utteranceId,
      });
      this.resolveActive();
    }
  }

  private resolveActive(): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    active.signal.removeEventListener("abort", active.onAbort);
    active.resolve();
  }

  private rejectActive(error: unknown): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    active.signal.removeEventListener("abort", active.onAbort);
    active.reject(error);
  }
}
