import {
  MAX_CORRECTION_TEXT_LENGTH,
  type CorrectionBridgeErrorCode,
  type CorrectionBridgeRequest,
  type CorrectionProviderStatus,
} from "../shared/correction";
import {
  buildUserTurn,
  CORRECTION_SYSTEM_INSTRUCTION,
  DEFAULT_PROMPT_CONFIG,
} from "../shared/correctionPrompt";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL_ID = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 1_500;
const MIN_TIMEOUT_MS = 300;
const MAX_TIMEOUT_MS = 5_000;

export type CorrectionRuntimeConfig = {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  timeoutMs: number;
};

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type CorrectionFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<FetchResponse>;

type ChatCompletion = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

export class CorrectionProviderError extends Error {
  constructor(
    readonly code: CorrectionBridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CorrectionProviderError";
  }
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function readTimeoutMs(value: string | undefined): number {
  const parsed = Number.parseInt(clean(value), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, parsed));
}

function readBaseUrl(value: string | undefined): string {
  return clean(value).replace(/\/+$/, "") || DEFAULT_BASE_URL;
}

export function readCorrectionProviderStatus(
  environment: NodeJS.ProcessEnv = process.env,
): CorrectionProviderStatus {
  const apiKey = clean(environment.CORRECTION_API_KEY);
  const modelId = clean(environment.CORRECTION_MODEL_ID) || DEFAULT_MODEL_ID;
  const missing: CorrectionProviderStatus["missing"] = [];

  if (!apiKey) missing.push("CORRECTION_API_KEY");

  return {
    provider: "openai-compatible",
    configured: missing.length === 0,
    modelId,
    timeoutMs: readTimeoutMs(environment.CORRECTION_TIMEOUT_MS),
    missing,
  };
}

export function readCorrectionRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CorrectionRuntimeConfig | null {
  const status = readCorrectionProviderStatus(environment);
  const apiKey = clean(environment.CORRECTION_API_KEY);
  if (!status.configured || !apiKey) return null;

  return {
    apiKey,
    baseUrl: readBaseUrl(environment.CORRECTION_BASE_URL),
    modelId: status.modelId,
    timeoutMs: status.timeoutMs,
  };
}

function providerCodeForStatus(status: number): CorrectionBridgeErrorCode {
  if (status === 401 || status === 403) return "provider_auth_error";
  if (status === 429) return "provider_rate_limited";
  if (status >= 400 && status < 500) return "provider_request_error";
  return "provider_unavailable";
}

export function correctionProviderErrorCode(
  error: unknown,
): CorrectionBridgeErrorCode {
  if (error instanceof CorrectionProviderError) return error.code;
  if (error instanceof Error && error.name === "AbortError") {
    return "provider_timeout";
  }
  return "provider_unavailable";
}

function readMessageContent(payload: unknown): string {
  const completion = payload as ChatCompletion | null;
  const content = completion?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

/**
 * One deterministic call per phrase. The caller owns the deadline, so this
 * never retries, and it never logs phrase content.
 */
export async function requestCorrection(options: {
  request: CorrectionBridgeRequest;
  config: CorrectionRuntimeConfig;
  signal: AbortSignal;
  fetchImpl?: CorrectionFetch;
}): Promise<string> {
  const text = options.request.originalText.trim();
  if (!text || text.length > MAX_CORRECTION_TEXT_LENGTH) {
    throw new CorrectionProviderError(
      "provider_request_error",
      "Text must contain between 1 and 280 characters.",
    );
  }

  const fetchImpl =
    options.fetchImpl ?? (globalThis.fetch as unknown as CorrectionFetch);
  if (!fetchImpl) {
    throw new CorrectionProviderError(
      "provider_unavailable",
      "This runtime does not provide fetch.",
    );
  }

  const response = await fetchImpl(
    `${options.config.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.config.apiKey}`,
      },
      body: JSON.stringify({
        model: options.config.modelId,
        temperature: DEFAULT_PROMPT_CONFIG.temperature,
        top_p: 1,
        n: 1,
        max_tokens: DEFAULT_PROMPT_CONFIG.maxOutputTokens,
        messages: [
          { role: "system", content: CORRECTION_SYSTEM_INSTRUCTION },
          { role: "user", content: buildUserTurn(text) },
        ],
      }),
      signal: options.signal,
    },
  );

  if (!response.ok) {
    throw new CorrectionProviderError(
      providerCodeForStatus(response.status),
      `Correction provider returned HTTP ${response.status}.`,
    );
  }

  const corrected = readMessageContent(await response.json());
  if (!corrected) {
    throw new CorrectionProviderError(
      "provider_empty_output",
      "Correction provider returned no text.",
    );
  }

  return corrected;
}
