import {
  DIAGNOSTIC_ERROR_CODES,
  DIAGNOSTIC_LATENCY_STAGES,
  DIAGNOSTIC_SCHEMA_VERSION,
  type DiagnosticBundle,
  type DiagnosticErrorCode,
  type DiagnosticLatencyStage,
  type DiagnosticLatencySummary,
} from "../shared/diagnostics";

export type DiagnosticEnvironment = Readonly<{
  appVersion: unknown;
  platform: unknown;
  architecture: unknown;
  osRelease: unknown;
  now?: () => Date;
}>;

const SAFE_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const MAX_DEVICE_COUNT = 10_000;
const MAX_ERROR_COUNT = 1_000_000;
const MAX_ERROR_CODE_INPUTS = 100;
const MAX_LATENCY_SAMPLE_COUNT = 1_000_000;
const MAX_LATENCY_MS = 3_600_000;
const appVersionPattern = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const osReleasePattern = /^\d{1,5}(?:\.\d{1,5}){1,4}$/;
const errorCodeValues = new Set<string>(DIAGNOSTIC_ERROR_CODES);

function readField(value: unknown, key: string): unknown {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return undefined;
  }

  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeInteger(
  value: unknown,
  maximum: number,
  minimum = 0,
): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function safeAppVersion(value: unknown): string {
  return typeof value === "string" && appVersionPattern.test(value)
    ? value
    : "unknown";
}

function safeOsRelease(value: unknown): string {
  return typeof value === "string" && osReleasePattern.test(value)
    ? value
    : "unknown";
}

function safeTimestamp(now: (() => Date) | undefined): string {
  try {
    const value = (now ?? (() => new Date()))();
    return value instanceof Date && Number.isFinite(value.getTime())
      ? value.toISOString()
      : SAFE_TIMESTAMP;
  } catch {
    return SAFE_TIMESTAMP;
  }
}

function safePlatform(
  value: unknown,
): "darwin" | "linux" | "win32" | "unknown" {
  return value === "darwin" || value === "linux" || value === "win32"
    ? value
    : "unknown";
}

function safeArchitecture(
  value: unknown,
): "x64" | "arm64" | "ia32" | "unknown" {
  return value === "x64" || value === "arm64" || value === "ia32"
    ? value
    : "unknown";
}

function safeErrorCodes(value: unknown): readonly DiagnosticErrorCode[] {
  let length = 0;

  try {
    if (!Array.isArray(value)) return Object.freeze([]);
    length = Math.min(value.length, MAX_ERROR_CODE_INPUTS);
  } catch {
    return Object.freeze([]);
  }

  const seen = new Set<DiagnosticErrorCode>();
  for (let index = 0; index < length; index += 1) {
    let candidate: unknown;
    try {
      candidate = value[index];
    } catch {
      continue;
    }

    if (typeof candidate === "string" && errorCodeValues.has(candidate)) {
      seen.add(candidate as DiagnosticErrorCode);
    }
  }

  return Object.freeze(DIAGNOSTIC_ERROR_CODES.filter((code) => seen.has(code)));
}

function safeLatencySummary(value: unknown): DiagnosticLatencySummary | null {
  const sampleCount = safeInteger(
    readField(value, "sampleCount"),
    MAX_LATENCY_SAMPLE_COUNT,
    1,
  );
  const medianMs = safeInteger(readField(value, "medianMs"), MAX_LATENCY_MS);
  const p95Ms = safeInteger(readField(value, "p95Ms"), MAX_LATENCY_MS);
  const maxMs = safeInteger(readField(value, "maxMs"), MAX_LATENCY_MS);

  if (
    sampleCount === undefined ||
    medianMs === undefined ||
    p95Ms === undefined ||
    maxMs === undefined ||
    medianMs > p95Ms ||
    p95Ms > maxMs
  ) {
    return null;
  }

  return Object.freeze({ sampleCount, medianMs, p95Ms, maxMs });
}

function safeLatencies(
  value: unknown,
): Readonly<Record<DiagnosticLatencyStage, DiagnosticLatencySummary | null>> {
  const result = {} as Record<
    DiagnosticLatencyStage,
    DiagnosticLatencySummary | null
  >;

  for (const stage of DIAGNOSTIC_LATENCY_STAGES) {
    result[stage] = safeLatencySummary(readField(value, stage));
  }

  return Object.freeze(result);
}

export function buildDiagnosticBundle(
  input: unknown,
  environment: DiagnosticEnvironment,
): DiagnosticBundle {
  const codes = safeErrorCodes(readField(input, "errorCodes"));
  const requestedErrorCount = safeInteger(
    readField(input, "totalErrorCount"),
    MAX_ERROR_COUNT,
  );
  const totalCount = Math.max(
    requestedErrorCount ?? codes.length,
    codes.length,
  );

  return Object.freeze({
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    createdAt: safeTimestamp(environment.now),
    app: Object.freeze({
      version: safeAppVersion(environment.appVersion),
      platform: safePlatform(environment.platform),
      architecture: safeArchitecture(environment.architecture),
      osRelease: safeOsRelease(environment.osRelease),
    }),
    audio: Object.freeze({
      inputDeviceCount:
        safeInteger(readField(input, "inputDeviceCount"), MAX_DEVICE_COUNT) ??
        0,
      outputDeviceCount:
        safeInteger(readField(input, "outputDeviceCount"), MAX_DEVICE_COUNT) ??
        0,
      blackHoleOutputDetected:
        readField(input, "blackHoleOutputDetected") === true,
    }),
    errors: Object.freeze({ totalCount, codes }),
    latencyMs: safeLatencies(readField(input, "latencyMs")),
  });
}

export function serializeDiagnosticBundle(bundle: DiagnosticBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function diagnosticFileName(createdAt: string): string {
  const compactTimestamp = createdAt
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
  return `english-corrector-diagnostic-${compactTimestamp}.json`;
}
