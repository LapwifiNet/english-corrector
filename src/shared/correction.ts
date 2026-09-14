export const CORRECTION_IPC = {
  status: "correction:get-provider-status",
  correct: "correction:correct",
} as const;

/** Corrected text is spoken, so it shares the TTS text budget. */
export const MAX_CORRECTION_TEXT_LENGTH = 280;

export type CorrectionProviderName = "openai-compatible";

export type CorrectionProviderEnvironmentVariable =
  | "CORRECTION_API_KEY"
  | "CORRECTION_BASE_URL"
  | "CORRECTION_MODEL_ID"
  | "CORRECTION_TIMEOUT_MS";

export type CorrectionProviderStatus = {
  provider: CorrectionProviderName;
  configured: boolean;
  modelId: string;
  timeoutMs: number;
  missing: CorrectionProviderEnvironmentVariable[];
};

export type CorrectionBridgeErrorCode =
  | "provider_not_configured"
  | "provider_request_error"
  | "provider_auth_error"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_empty_output";

export type CorrectionBridgeRequest = {
  phraseId: string;
  originalText: string;
};

/**
 * The bridge carries plain text only. The API key, the endpoint and the raw
 * provider payload never reach the renderer.
 */
export type CorrectionBridgeResponse =
  | { ok: true; text: string; providerLatencyMs: number }
  | { ok: false; code: CorrectionBridgeErrorCode; providerLatencyMs: number };

export type CorrectionBridge = {
  getStatus: () => Promise<CorrectionProviderStatus>;
  correct: (
    request: CorrectionBridgeRequest,
  ) => Promise<CorrectionBridgeResponse>;
};
