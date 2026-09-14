import type {
  TtsVoiceCatalog,
  TtsVoiceCategory,
  TtsVoiceSummary,
} from "../shared/tts";
import type { PalabraRuntimeConfig } from "./palabraClient";

const PALABRA_API_ORIGIN = "https://api.palabra.ai";
const MAX_VOICES_PER_GROUP = 100;

export type PalabraVoiceFetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type PalabraVoiceFetch = (
  url: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<PalabraVoiceFetchResponse>;

export class PalabraVoiceCatalogError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PalabraVoiceCatalogError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function providerCodeForStatus(status: number): string {
  if (status === 401 || status === 403) return "provider_auth_error";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "provider_request_error";
}

function errorCode(error: unknown): string {
  return error instanceof PalabraVoiceCatalogError
    ? error.code
    : "provider_unavailable";
}

function defaultVoices(language: string): TtsVoiceSummary[] {
  return [
    {
      id: "default_low",
      name: "Default low timbre",
      locale: language,
      category: "default",
      description: "Palabra default voice with a lower timbre.",
    },
    {
      id: "default_high",
      name: "Default high timbre",
      locale: language,
      category: "default",
      description: "Palabra default voice with a higher timbre.",
    },
  ];
}

function voiceLanguage(
  item: Record<string, unknown>,
  fallbackLanguage: string,
): string {
  const ttsSample = asRecord(item.tts_sample);
  const sampleText = asRecord(ttsSample?.text);
  return (
    asString(sampleText?.lang) ?? asString(item.lang_code) ?? fallbackLanguage
  );
}

function parseVoice(
  value: unknown,
  category: TtsVoiceCategory,
  fallbackLanguage: string,
): TtsVoiceSummary | null {
  const item = asRecord(value);
  if (!item) return null;

  const id = asString(item.voice_id);
  if (!id || id.length > 128) return null;

  return {
    id,
    name: asString(item.name) ?? id,
    locale: voiceLanguage(item, fallbackLanguage),
    category,
    ...(asString(item.description)
      ? { description: asString(item.description)! }
      : {}),
  };
}

function extractItems(payload: unknown): unknown[] {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(root?.items)) return root.items;
  return [];
}

async function requestVoices(options: {
  path: "/saas/voice" | "/saas/voice/builtin";
  category: "custom" | "builtin";
  config: PalabraRuntimeConfig;
  fetchImpl: PalabraVoiceFetch;
  signal?: AbortSignal;
}): Promise<TtsVoiceSummary[]> {
  const url = new URL(options.path, PALABRA_API_ORIGIN);
  url.searchParams.set("provider", "palabra");
  url.searchParams.set("page_size", String(MAX_VOICES_PER_GROUP));
  if (options.category === "builtin") {
    url.searchParams.set("lang", options.config.language.split("-")[0] ?? "en");
  }

  const response = await options.fetchImpl(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${options.config.apiKey}`,
    },
    signal: options.signal,
  });

  if (!response.ok) {
    throw new PalabraVoiceCatalogError(
      providerCodeForStatus(response.status),
      `Palabra voice catalog returned HTTP ${response.status}.`,
    );
  }

  const payload = await response.json();
  return extractItems(payload)
    .map((item) => parseVoice(item, options.category, options.config.language))
    .filter((voice): voice is TtsVoiceSummary => Boolean(voice))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function listPalabraVoices(options: {
  config: PalabraRuntimeConfig;
  fetchImpl?: PalabraVoiceFetch;
  signal?: AbortSignal;
}): Promise<TtsVoiceCatalog> {
  const fetchImpl =
    options.fetchImpl ?? (globalThis.fetch as unknown as PalabraVoiceFetch);
  const voices = defaultVoices(options.config.language);

  if (!fetchImpl) {
    return {
      provider: "palabra",
      voices,
      warningCode: "provider_unavailable",
    };
  }

  const [customResult, builtinResult] = await Promise.allSettled([
    requestVoices({
      path: "/saas/voice",
      category: "custom",
      config: options.config,
      fetchImpl,
      signal: options.signal,
    }),
    requestVoices({
      path: "/saas/voice/builtin",
      category: "builtin",
      config: options.config,
      fetchImpl,
      signal: options.signal,
    }),
  ]);

  const warning =
    customResult.status === "rejected"
      ? errorCode(customResult.reason)
      : builtinResult.status === "rejected"
        ? errorCode(builtinResult.reason)
        : undefined;
  const candidates = [
    ...(customResult.status === "fulfilled" ? customResult.value : []),
    ...(builtinResult.status === "fulfilled" ? builtinResult.value : []),
  ];
  const deduplicated = new Map(voices.map((voice) => [voice.id, voice]));

  for (const voice of candidates) {
    if (!deduplicated.has(voice.id)) deduplicated.set(voice.id, voice);
  }

  if (!deduplicated.has(options.config.voiceId)) {
    deduplicated.set(options.config.voiceId, {
      id: options.config.voiceId,
      name: "Configured voice",
      locale: options.config.language,
      category: "configured",
    });
  }

  return {
    provider: "palabra",
    voices: [...deduplicated.values()],
    ...(warning ? { warningCode: warning } : {}),
  };
}
