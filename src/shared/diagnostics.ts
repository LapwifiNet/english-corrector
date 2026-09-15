export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;

export const DIAGNOSTIC_IPC = Object.freeze({
  preview: "diagnostics:preview",
  save: "diagnostics:save",
} as const);

export const DIAGNOSTIC_ERROR_CODES = [
  "permission_check_failed",
  "permission_request_failed",
  "settings_open_failed",
  "window_load_failed",
  "device_missing",
  "device_renamed",
  "provider_not_configured",
  "provider_auth_error",
  "provider_rate_limited",
  "provider_timeout",
  "provider_request_error",
  "provider_unavailable",
  "provider_empty_output",
  "provider_http_error",
  "provider_stream_error",
  "provider_empty_audio",
  "provider_voice_mismatch",
  "invalid_text",
  "output_device_required",
  "output_device_error",
  "buffer_overflow",
  "chunk_sequence_gap",
  "unsupported_audio_format",
  "pipeline_cancelled",
  "playback_failed",
  "diagnostic_export_failed",
] as const;

export const DIAGNOSTIC_LATENCY_STAGES = [
  "stt",
  "correction",
  "tts",
  "relay",
  "endToEnd",
] as const;

export type DiagnosticErrorCode = (typeof DIAGNOSTIC_ERROR_CODES)[number];
export type DiagnosticLatencyStage = (typeof DIAGNOSTIC_LATENCY_STAGES)[number];

export type DiagnosticLatencySummary = Readonly<{
  sampleCount: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}>;

export type DiagnosticBundle = Readonly<{
  schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
  createdAt: string;
  app: Readonly<{
    version: string;
    platform: "darwin" | "linux" | "win32" | "unknown";
    architecture: "x64" | "arm64" | "ia32" | "unknown";
    osRelease: string;
  }>;
  audio: Readonly<{
    inputDeviceCount: number;
    outputDeviceCount: number;
    blackHoleOutputDetected: boolean;
  }>;
  errors: Readonly<{
    totalCount: number;
    codes: readonly DiagnosticErrorCode[];
  }>;
  latencyMs: Readonly<
    Record<DiagnosticLatencyStage, DiagnosticLatencySummary | null>
  >;
}>;

export type DiagnosticPreviewRequest = Readonly<{
  inputDeviceCount?: number;
  outputDeviceCount?: number;
  blackHoleOutputDetected?: boolean;
  totalErrorCount?: number;
  errorCodes?: readonly string[];
  latencyMs?: Partial<Record<DiagnosticLatencyStage, DiagnosticLatencySummary>>;
}>;

export type DiagnosticPreviewResponse = Readonly<{
  previewId: string;
  fileName: string;
  json: string;
}>;

export type DiagnosticSaveStatus = "saved" | "cancelled" | "expired" | "failed";

export type DiagnosticSaveResponse = Readonly<{
  status: DiagnosticSaveStatus;
}>;

export type DiagnosticBridge = Readonly<{
  preview: (
    request: DiagnosticPreviewRequest,
  ) => Promise<DiagnosticPreviewResponse>;
  save: (previewId: string) => Promise<DiagnosticSaveResponse>;
}>;
