import {
  STT_SAMPLE_RATE,
  type SttBridgeErrorCode,
  type SttEnvVariableName,
  type SttProviderStatus,
} from "../shared/stt";

export const DEFAULT_STREAMING_HOST = "streaming.assemblyai.com";
export const TOKEN_TTL_SECONDS = 60;
export const DEFAULT_FINALIZE_TIMEOUT_MS = 2_000;
export const MAX_QUEUED_CHUNKS = 200;

export type AssemblyAiConfig = {
  apiKey: string;
  host: string;
  sampleRate: number;
  formatTurns: boolean;
  finalizeTimeoutMs: number;
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
 */
export function startAssemblyAiSession(args: {
  config: AssemblyAiConfig;
  events: SttSessionEvents;
  fetchImpl?: FetchLike;
  socketFactory?: SttSocketFactory;
}): SttSession {
  const { config, events } = args;
  const finals = new Map<number, FinalTurn>();
  const queue: ArrayBuffer[] = [];

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
    events.onFinal(text, confidence);
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
      const combined = [joinedText(), text]
        .filter((part) => part.length > 0)
        .join(" ");
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
    if (finishing && isComplete) settleFinal();
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

    if (payload.type === "Error") settleError("provider_request_error");
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

    created.addEventListener("close", () => {
      isOpen = false;
      if (finishing) settleFinal();
      else settleError("provider_unavailable");
    });

    created.addEventListener("error", () =>
      settleError("provider_unavailable"),
    );
  })();

  return {
    write: (pcm) => {
      if (settled || cancelled || pcm.byteLength === 0) return;

      if (socket && isOpen) {
        try {
          socket.send(pcm);
        } catch {
          settleError("provider_unavailable");
        }
        return;
      }

      if (queue.length >= MAX_QUEUED_CHUNKS) queue.shift();
      queue.push(pcm);
    },
    finish: () => {
      if (settled || cancelled || finishing) return;
      finishing = true;
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
