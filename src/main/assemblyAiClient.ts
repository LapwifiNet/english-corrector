import {
  STT_SAMPLE_RATE,
  type SttBridgeErrorCode,
  type SttEnvVariableName,
  type SttProviderStatus,
  type SttSessionMode,
} from "../shared/stt";

export const DEFAULT_STREAMING_HOST = "streaming.assemblyai.com";
export const TOKEN_TTL_SECONDS = 60;
export const DEFAULT_FINALIZE_TIMEOUT_MS = 2_000;
export const MAX_QUEUED_CHUNKS = 200;
/** The provider rejects binary frames outside 50 ms to 1000 ms of audio. */
export const MIN_CHUNK_MS = 50;
export const MAX_CHUNK_MS = 1_000;
export const CHUNK_MS = 50;

/** The provider clamps turn detection silence to 50 ms to 10000 ms. */
export const MIN_TURN_SILENCE_MS = 50;
export const MAX_TURN_SILENCE_MS = 10_000;

/**
 * The provider defaults to 400 ms and 1280 ms, which the speaker hears as
 * dead air at the end of every sentence. Shorter windows close a turn while
 * the speaker is drawing breath, and the corrector still receives a whole
 * sentence because a turn only closes on silence.
 */
export const DEFAULT_MIN_TURN_SILENCE_MS = 240;
export const DEFAULT_MAX_TURN_SILENCE_MS = 700;

export type AssemblyAiConfig = {
  apiKey: string;
  host: string;
  sampleRate: number;
  formatTurns: boolean;
  finalizeTimeoutMs: number;
  /** Silence before the end-of-turn check. Provider default is 400 ms. */
  minTurnSilenceMs?: number;
  /** Silence that forces a turn to end. Provider default is 1280 ms. */
  maxTurnSilenceMs?: number;
};

export class SttProviderError extends Error {
  constructor(
    readonly code: SttBridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SttProviderError";
  }
}

export function sttProviderErrorCode(error: unknown): SttBridgeErrorCode {
  if (error instanceof SttProviderError) return error.code;
  return "provider_unavailable";
}

function trimmed(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Hands-free mode lives or dies by turn detection, so both silence windows are
 * tunable without a rebuild. Out-of-range values are clamped instead of
 * rejected, because the provider closes the session over an invalid value.
 */
function turnSilenceMs(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(trimmed(value), 10);
  if (!Number.isFinite(parsed)) return undefined;

  return Math.min(MAX_TURN_SILENCE_MS, Math.max(MIN_TURN_SILENCE_MS, parsed));
}

export function readSttProviderStatus(
  env: Record<string, string | undefined> = process.env,
): SttProviderStatus {
  const missing: SttEnvVariableName[] = [];
  if (!trimmed(env.ASSEMBLYAI_API_KEY)) missing.push("ASSEMBLYAI_API_KEY");

  return {
    configured: missing.length === 0,
    provider: missing.length === 0 ? "assemblyai" : null,
    missing,
  };
}

export function readSttRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): AssemblyAiConfig | null {
  const apiKey = trimmed(env.ASSEMBLYAI_API_KEY);
  if (!apiKey) return null;

  return {
    apiKey,
    host: trimmed(env.ASSEMBLYAI_STREAMING_HOST) || DEFAULT_STREAMING_HOST,
    sampleRate: STT_SAMPLE_RATE,
    formatTurns: trimmed(env.ASSEMBLYAI_FORMAT_TURNS) !== "false",
    finalizeTimeoutMs: DEFAULT_FINALIZE_TIMEOUT_MS,
    minTurnSilenceMs:
      turnSilenceMs(env.ASSEMBLYAI_MIN_TURN_SILENCE_MS) ??
      DEFAULT_MIN_TURN_SILENCE_MS,
    maxTurnSilenceMs:
      turnSilenceMs(env.ASSEMBLYAI_MAX_TURN_SILENCE_MS) ??
      DEFAULT_MAX_TURN_SILENCE_MS,
  };
}

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<FetchResponse>;

function statusToCode(status: number): SttBridgeErrorCode {
  if (status === 401 || status === 403) return "provider_auth_error";
  if (status === 429) return "provider_rate_limited";
  if (status === 400 || status === 422) return "provider_request_error";
  return "provider_unavailable";
}

export function tokenUrl(config: AssemblyAiConfig): string {
  return `https://${config.host}/v3/token?expires_in_seconds=${TOKEN_TTL_SECONDS}`;
}

/**
 * The socket URL carries a short-lived token because a WebSocket client
 * cannot set an Authorization header. The permanent key never leaves here.
 */
export async function requestStreamingToken(args: {
  config: AssemblyAiConfig;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<string> {
  const fetchImpl =
    args.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) {
    throw new SttProviderError(
      "provider_unavailable",
      "This runtime does not provide fetch.",
    );
  }

  let response: FetchResponse;
  try {
    response = await fetchImpl(tokenUrl(args.config), {
      method: "GET",
      headers: { Authorization: args.config.apiKey },
      signal: args.signal,
    });
  } catch {
    throw new SttProviderError(
      "provider_unavailable",
      "The token request could not be sent.",
    );
  }

  if (!response.ok) {
    throw new SttProviderError(
      statusToCode(response.status),
      `The token request returned status ${response.status}.`,
    );
  }

  const payload = (await response.json()) as { token?: unknown } | null;
  const token = typeof payload?.token === "string" ? payload.token : "";
  if (!token) {
    throw new SttProviderError(
      "provider_unavailable",
      "The token response contained no token.",
    );
  }

  return token;
}

export type SttSocketEvent = {
  data?: unknown;
  code?: number;
  reason?: string;
};

export interface SttWebSocket {
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: SttSocketEvent) => void,
  ): void;
}

export type SttSocketFactory = (url: string) => SttWebSocket;

function resolveSocketFactory(): SttSocketFactory {
  const runtime = globalThis as unknown as {
    WebSocket?: new (socketUrl: string) => SttWebSocket;
  };
  const SocketConstructor = runtime.WebSocket;
  if (!SocketConstructor) {
    throw new SttProviderError(
      "provider_unavailable",
      "This runtime does not provide WebSocket.",
    );
  }

  return (url) => new SocketConstructor(url);
}

export function streamingUrl(config: AssemblyAiConfig, token: string): string {
  const params = new URLSearchParams({
    encoding: "pcm_s16le",
    sample_rate: String(config.sampleRate),
    format_turns: config.formatTurns ? "true" : "false",
    token,
  });

  if (config.minTurnSilenceMs !== undefined) {
    params.set("min_turn_silence", String(config.minTurnSilenceMs));
  }

  if (config.maxTurnSilenceMs !== undefined) {
    params.set("max_turn_silence", String(config.maxTurnSilenceMs));
  }

  return `wss://${config.host}/v3/ws?${params.toString()}`;
}

export type StreamingTurn = {
  turn_order?: number;
  end_of_turn?: boolean;
  turn_is_formatted?: boolean;
  transcript?: string;
  words?: Array<{ confidence?: number }>;
};

export function averageWordConfidence(turn: StreamingTurn): number | undefined {
  const values = (turn.words ?? [])
    .map((word) => word.confidence)
    .filter((value): value is number => typeof value === "number");
  if (values.length === 0) return undefined;

  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

export function pcmByteLength(sampleRate: number, durationMs: number): number {
  const bytes = Math.round((sampleRate * 2 * durationMs) / 1_000);
  return bytes % 2 === 0 ? bytes : bytes + 1;
}

export type PcmChunker = {
  push: (pcm: ArrayBuffer) => ArrayBuffer[];
  flush: () => ArrayBuffer | null;
};

/**
 * The microphone hands over frames sized by the audio graph, which is below
 * the provider minimum at 48 kHz. Audio is regrouped here so every binary
 * frame carries an accepted duration, and the tail of a phrase is padded with
 * silence instead of being dropped.
 */
export function createPcmChunker(args: {
  sampleRate: number;
  chunkMs?: number;
}): PcmChunker {
  const minBytes = pcmByteLength(args.sampleRate, MIN_CHUNK_MS);
  const requestedMs = Math.min(args.chunkMs ?? CHUNK_MS, MAX_CHUNK_MS);
  const chunkBytes = Math.max(
    minBytes,
    pcmByteLength(args.sampleRate, requestedMs),
  );
  let pending = new Uint8Array(0);

  return {
    push: (pcm) => {
      if (pcm.byteLength === 0) return [];

      const incoming = new Uint8Array(pcm);
      const merged = new Uint8Array(pending.byteLength + incoming.byteLength);
      merged.set(pending, 0);
      merged.set(incoming, pending.byteLength);

      const ready: ArrayBuffer[] = [];
      let offset = 0;
      while (merged.byteLength - offset >= chunkBytes) {
        ready.push(merged.slice(offset, offset + chunkBytes).buffer);
        offset += chunkBytes;
      }

      pending = merged.slice(offset);
      return ready;
    },
    flush: () => {
      if (pending.byteLength === 0) return null;

      const tail = new Uint8Array(Math.max(pending.byteLength, minBytes));
      tail.set(pending, 0);
      pending = new Uint8Array(0);
      return tail.buffer;
    },
  };
}

export type SttSessionEvents = {
  onPartial: (text: string) => void;
  onFinal: (text: string, confidence?: number) => void;
  onError: (code: SttBridgeErrorCode) => void;
};

export type SttSession = {
  write: (pcm: ArrayBuffer) => void;
  finish: () => void;
  cancel: () => void;
};

type FinalTurn = {
  text: string;
  formatted: boolean;
  confidence?: number;
};

/**
 * One push-to-talk phrase is one streaming session. A phrase can contain
 * several provider turns when the speaker pauses, so finished turns are kept
 * in turn order and joined into a single transcript.
 *
 * Hands-free mode passes mode "continuous" instead. The socket then stays open
 * and every turn the provider closes is reported on its own, so each sentence
 * reaches the corrector without paying for a new session and a new handshake.
 */
export function startAssemblyAiSession(args: {
  config: AssemblyAiConfig;
  events: SttSessionEvents;
  mode?: SttSessionMode;
  fetchImpl?: FetchLike;
  socketFactory?: SttSocketFactory;
}): SttSession {
  const { events } = args;
  const continuous = args.mode === "continuous";
  // Formatting arrives as a second copy of a turn, and waiting for it adds
  // the provider's formatting latency to every sentence a continuous session
  // speaks. The corrector rewrites punctuation anyway, so raw turns are
  // enough and the sentence is handed over as soon as the turn closes.
  const config: AssemblyAiConfig = continuous
    ? { ...args.config, formatTurns: false }
    : args.config;
  const finals = new Map<number, FinalTurn>();
  const emittedTurns = new Set<number>();
  const queue: ArrayBuffer[] = [];
  const chunker = createPcmChunker({ sampleRate: config.sampleRate });

  let socket: SttWebSocket | null = null;
  let isOpen = false;
  let settled = false;
  let finishing = false;
  let cancelled = false;
  let finalizeTimer: ReturnType<typeof setTimeout> | null = null;

  function clearFinalizeTimer(): void {
    if (!finalizeTimer) return;
    clearTimeout(finalizeTimer);
    finalizeTimer = null;
  }

  function joinedText(): string {
    return [...finals.keys()]
      .sort((left, right) => left - right)
      .map((order) => finals.get(order)?.text ?? "")
      .filter((text) => text.length > 0)
      .join(" ")
      .trim();
  }

  function meanConfidence(): number | undefined {
    const values = [...finals.values()]
      .map((turn) => turn.confidence)
      .filter((value): value is number => typeof value === "number");
    if (values.length === 0) return undefined;

    const total = values.reduce((sum, value) => sum + value, 0);
    return total / values.length;
  }

  function closeSocket(): void {
    const active = socket;
    socket = null;
    isOpen = false;
    if (!active) return;

    try {
      active.send(JSON.stringify({ type: "Terminate" }));
    } catch {
      // The socket is already gone.
    }

    try {
      active.close(1000);
    } catch {
      // Closing twice is not an error worth surfacing.
    }
  }

  function settleFinal(): void {
    if (settled || cancelled) return;
    settled = true;
    clearFinalizeTimer();
    const text = joinedText();
    const confidence = meanConfidence();
    closeSocket();
    // A continuous session already reported every completed turn, so it ends
    // quietly unless one last turn is still pending.
    if (continuous && text.length === 0) return;
    events.onFinal(text, confidence);
  }

  function emitTurn(order: number): void {
    if (settled || cancelled) return;
    // A turn is spoken once even if the provider sends a second copy of it.
    if (emittedTurns.has(order)) return;

    const entry = finals.get(order);
    finals.delete(order);
    const text = entry?.text ?? "";
    if (text.length === 0) return;

    emittedTurns.add(order);
    events.onFinal(text, entry?.confidence);
  }

  function settleError(code: SttBridgeErrorCode): void {
    if (settled || cancelled) return;
    settled = true;
    clearFinalizeTimer();
    closeSocket();
    events.onError(code);
  }

  function handleTurn(turn: StreamingTurn): void {
    const order = typeof turn.turn_order === "number" ? turn.turn_order : 0;
    const text =
      typeof turn.transcript === "string" ? turn.transcript.trim() : "";
    const formatted = turn.turn_is_formatted === true;

    if (turn.end_of_turn !== true) {
      // A continuous session hands over each sentence as it completes, so a
      // partial carries only the turn being spoken right now.
      const combined = continuous
        ? text
        : [joinedText(), text].filter((part) => part.length > 0).join(" ");
      if (combined.length > 0) events.onPartial(combined);
      return;
    }

    const existing = finals.get(order);
    if (!existing || formatted) {
      finals.set(order, {
        text,
        formatted,
        confidence: averageWordConfidence(turn) ?? existing?.confidence,
      });
    }

    // With format_turns the same turn arrives twice. Only the formatted copy
    // ends the phrase, otherwise every turn would be handled two times.
    const isComplete = !config.formatTurns || formatted;
    if (!isComplete) return;

    if (continuous) {
      emitTurn(order);
      return;
    }

    if (finishing) settleFinal();
  }

  function handleMessage(data: unknown): void {
    if (typeof data !== "string") return;

    let payload: { type?: unknown };
    try {
      payload = JSON.parse(data) as { type?: unknown };
    } catch {
      return;
    }

    if (payload.type === "Turn") {
      handleTurn(payload as StreamingTurn);
      return;
    }

    if (payload.type === "Termination") {
      if (finishing) settleFinal();
      else settleError("provider_unavailable");
      return;
    }

    if (payload.type === "Error") {
      const detail = (payload as { error?: unknown }).error;
      if (typeof detail === "string") {
        console.error(`[stt] provider rejected the stream: ${detail}`);
      }
      settleError("provider_request_error");
    }
  }

  function sendAudio(chunk: ArrayBuffer): void {
    if (settled || cancelled) return;

    if (socket && isOpen) {
      try {
        socket.send(chunk);
      } catch {
        settleError("provider_unavailable");
      }
      return;
    }

    if (queue.length >= MAX_QUEUED_CHUNKS) queue.shift();
    queue.push(chunk);
  }

  function sendForceEndpoint(): void {
    if (!socket || !isOpen) return;
    try {
      socket.send(JSON.stringify({ type: "ForceEndpoint" }));
    } catch {
      settleError("provider_unavailable");
    }
  }

  void (async () => {
    let token: string;
    try {
      token = await requestStreamingToken({
        config,
        fetchImpl: args.fetchImpl,
      });
    } catch (error) {
      settleError(sttProviderErrorCode(error));
      return;
    }

    if (cancelled || settled) return;

    let created: SttWebSocket;
    try {
      const factory = args.socketFactory ?? resolveSocketFactory();
      created = factory(streamingUrl(config, token));
    } catch (error) {
      settleError(sttProviderErrorCode(error));
      return;
    }

    socket = created;

    created.addEventListener("open", () => {
      if (cancelled || settled) {
        closeSocket();
        return;
      }

      isOpen = true;
      for (const chunk of queue.splice(0, queue.length)) {
        try {
          created.send(chunk);
        } catch {
          settleError("provider_unavailable");
          return;
        }
      }

      if (finishing) sendForceEndpoint();
    });

    created.addEventListener("message", (event) => handleMessage(event.data));

    created.addEventListener("close", (event) => {
      isOpen = false;
      const code = typeof event.code === "number" ? event.code : undefined;
      if (code !== undefined && code !== 1_000) {
        console.error(`[stt] streaming socket closed with code ${code}`);
      }
      if (finishing) settleFinal();
      else settleError("provider_unavailable");
    });

    created.addEventListener("error", () =>
      settleError("provider_unavailable"),
    );
  })();

  return {
    write: (pcm) => {
      if (settled || cancelled) return;
      for (const chunk of chunker.push(pcm)) sendAudio(chunk);
    },
    finish: () => {
      if (settled || cancelled || finishing) return;
      finishing = true;
      const tail = chunker.flush();
      if (tail) sendAudio(tail);
      sendForceEndpoint();
      finalizeTimer = setTimeout(settleFinal, config.finalizeTimeoutMs);
    },
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      clearFinalizeTimer();
      closeSocket();
    },
  };
}
