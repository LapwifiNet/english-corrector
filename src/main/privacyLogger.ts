import { randomUUID } from "node:crypto";

export const PRIVACY_LOG_SCHEMA_VERSION = 1 as const;

export const PRIVACY_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export const PRIVACY_LOG_EVENTS = [
  "app_lifecycle",
  "permission_check",
  "permission_request",
  "settings_open",
  "window_load",
  "device_scan",
  "provider_request",
  "pipeline",
  "playback",
  "diagnostic_export",
  "invalid_event",
] as const;

export const PRIVACY_LOG_COMPONENTS = [
  "app",
  "audio",
  "stt",
  "correction",
  "tts",
  "relay",
  "diagnostics",
  "release",
  "unknown",
] as const;

export const PRIVACY_LOG_OUTCOMES = [
  "started",
  "ready",
  "completed",
  "failed",
  "cancelled",
  "blocked",
  "granted",
  "denied",
  "restricted",
  "unsupported",
  "missing",
  "unknown",
] as const;

export const PRIVACY_LOG_PROVIDERS = [
  "palabra",
  "elevenlabs",
  "assemblyai",
  "correction",
  "diagnostic",
] as const;

export const PRIVACY_LOG_CODES = [
  "app_ready",
  "window_load_failed",
  "settings_open_failed",
  "permission_denied",
  "permission_restricted",
  "permission_unsupported",
  "device_missing",
  "device_renamed",
  "provider_not_configured",
  "provider_auth_error",
  "provider_rate_limited",
  "provider_timeout",
  "provider_request_error",
  "provider_unavailable",
  "provider_empty_output",
  "pipeline_cancelled",
  "playback_failed",
  "diagnostic_export_failed",
  "unrecognized_error",
] as const;

export type PrivacyLogLevel = (typeof PRIVACY_LOG_LEVELS)[number];
export type PrivacyLogEvent = (typeof PRIVACY_LOG_EVENTS)[number];
export type PrivacyLogComponent = (typeof PRIVACY_LOG_COMPONENTS)[number];
export type PrivacyLogOutcome = (typeof PRIVACY_LOG_OUTCOMES)[number];
export type PrivacyLogProvider = (typeof PRIVACY_LOG_PROVIDERS)[number];
export type PrivacyLogCode = (typeof PRIVACY_LOG_CODES)[number];

export type PrivacyCorrelationId = string & {
  readonly __privacyCorrelationId: unique symbol;
};

export type PrivacyLogFields = Readonly<
  {
    level?: unknown;
    event?: unknown;
    component?: unknown;
    outcome?: unknown;
    provider?: unknown;
    code?: unknown;
    correlationId?: unknown;
    durationMs?: unknown;
    itemCount?: unknown;
    byteCount?: unknown;
    attempt?: unknown;
    retryable?: unknown;
  } & Record<string, unknown>
>;

export type PrivacyLogRecord = Readonly<{
  schemaVersion: typeof PRIVACY_LOG_SCHEMA_VERSION;
  timestamp: string;
  level: PrivacyLogLevel;
  event: PrivacyLogEvent;
  component?: PrivacyLogComponent;
  outcome?: PrivacyLogOutcome;
  provider?: PrivacyLogProvider;
  code?: PrivacyLogCode;
  correlationId?: PrivacyCorrelationId;
  durationMs?: number;
  itemCount?: number;
  byteCount?: number;
  attempt?: number;
  retryable?: boolean;
}>;

export type PrivacyLogSink = (line: string) => void;

export type PrivacyLoggerOptions = Readonly<{
  now?: () => Date;
  uuid?: () => string;
  sink?: PrivacyLogSink;
}>;

export type PrivacyLogger = Readonly<{
  createCorrelationId: () => PrivacyCorrelationId;
  log: (fields?: PrivacyLogFields) => PrivacyLogRecord;
}>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVALID_UUID_MESSAGE = "privacy_logger_invalid_uuid";
const SAFE_TIMESTAMP = "1970-01-01T00:00:00.000Z";

const levelValues = new Set<string>(PRIVACY_LOG_LEVELS);
const eventValues = new Set<string>(PRIVACY_LOG_EVENTS);
const componentValues = new Set<string>(PRIVACY_LOG_COMPONENTS);
const outcomeValues = new Set<string>(PRIVACY_LOG_OUTCOMES);
const providerValues = new Set<string>(PRIVACY_LOG_PROVIDERS);
const codeValues = new Set<string>(PRIVACY_LOG_CODES);

function defaultSink(line: string): void {
  process.stdout.write(line);
}

function readField(fields: PrivacyLogFields, key: string): unknown {
  try {
    return fields[key];
  } catch {
    return undefined;
  }
}

function allowedValue<T extends string>(
  value: unknown,
  values: ReadonlySet<string>,
): T | undefined {
  return typeof value === "string" && values.has(value)
    ? (value as T)
    : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function safeTimestamp(now: () => Date): string {
  try {
    const value = now();
    return value instanceof Date && Number.isFinite(value.getTime())
      ? value.toISOString()
      : SAFE_TIMESTAMP;
  } catch {
    return SAFE_TIMESTAMP;
  }
}

export function createPrivacyLogger(
  options: PrivacyLoggerOptions = {},
): PrivacyLogger {
  const now = options.now ?? (() => new Date());
  const uuid = options.uuid ?? randomUUID;
  const sink = options.sink ?? defaultSink;
  const issuedCorrelationIds = new Set<PrivacyCorrelationId>();

  function createCorrelationId(): PrivacyCorrelationId {
    let value: string;

    try {
      value = uuid();
    } catch {
      throw new Error(INVALID_UUID_MESSAGE);
    }

    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      throw new Error(INVALID_UUID_MESSAGE);
    }

    const correlationId = `ec-${value.toLowerCase()}` as PrivacyCorrelationId;
    issuedCorrelationIds.add(correlationId);
    return correlationId;
  }

  function log(fields: PrivacyLogFields = {}): PrivacyLogRecord {
    const rawLevel = readField(fields, "level");
    const rawEvent = readField(fields, "event");
    const rawComponent = readField(fields, "component");
    const rawOutcome = readField(fields, "outcome");
    const rawProvider = readField(fields, "provider");
    const rawCode = readField(fields, "code");
    const rawCorrelationId = readField(fields, "correlationId");
    const rawDurationMs = readField(fields, "durationMs");
    const rawItemCount = readField(fields, "itemCount");
    const rawByteCount = readField(fields, "byteCount");
    const rawAttempt = readField(fields, "attempt");
    const rawRetryable = readField(fields, "retryable");

    const record: {
      schemaVersion: typeof PRIVACY_LOG_SCHEMA_VERSION;
      timestamp: string;
      level: PrivacyLogLevel;
      event: PrivacyLogEvent;
      component?: PrivacyLogComponent;
      outcome?: PrivacyLogOutcome;
      provider?: PrivacyLogProvider;
      code?: PrivacyLogCode;
      correlationId?: PrivacyCorrelationId;
      durationMs?: number;
      itemCount?: number;
      byteCount?: number;
      attempt?: number;
      retryable?: boolean;
    } = {
      schemaVersion: PRIVACY_LOG_SCHEMA_VERSION,
      timestamp: safeTimestamp(now),
      level: allowedValue<PrivacyLogLevel>(rawLevel, levelValues) ?? "info",
      event:
        allowedValue<PrivacyLogEvent>(rawEvent, eventValues) ?? "invalid_event",
    };

    if (rawComponent !== undefined) {
      record.component =
        allowedValue<PrivacyLogComponent>(rawComponent, componentValues) ??
        "unknown";
    }

    if (rawOutcome !== undefined) {
      record.outcome =
        allowedValue<PrivacyLogOutcome>(rawOutcome, outcomeValues) ?? "unknown";
    }

    const provider = allowedValue<PrivacyLogProvider>(
      rawProvider,
      providerValues,
    );
    if (provider !== undefined) {
      record.provider = provider;
    }

    if (rawCode !== undefined) {
      record.code =
        allowedValue<PrivacyLogCode>(rawCode, codeValues) ??
        "unrecognized_error";
    }

    if (
      typeof rawCorrelationId === "string" &&
      issuedCorrelationIds.has(rawCorrelationId as PrivacyCorrelationId)
    ) {
      record.correlationId = rawCorrelationId as PrivacyCorrelationId;
    }

    const durationMs = safeInteger(rawDurationMs);
    if (durationMs !== undefined) {
      record.durationMs = durationMs;
    }

    const itemCount = safeInteger(rawItemCount);
    if (itemCount !== undefined) {
      record.itemCount = itemCount;
    }

    const byteCount = safeInteger(rawByteCount);
    if (byteCount !== undefined) {
      record.byteCount = byteCount;
    }

    const attempt = safeInteger(rawAttempt);
    if (attempt !== undefined) {
      record.attempt = attempt;
    }

    if (typeof rawRetryable === "boolean") {
      record.retryable = rawRetryable;
    }

    const safeRecord = Object.freeze(record) as PrivacyLogRecord;

    try {
      sink(`${JSON.stringify(safeRecord)}\n`);
    } catch {
      // Logging must never interrupt the audio pipeline.
    }

    return safeRecord;
  }

  return Object.freeze({ createCorrelationId, log });
}
