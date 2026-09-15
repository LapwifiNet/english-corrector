import { randomUUID } from "node:crypto";
import type {
  DiagnosticPreviewResponse,
  DiagnosticSaveResponse,
} from "../shared/diagnostics";
import {
  buildDiagnosticBundle,
  diagnosticFileName,
  serializeDiagnosticBundle,
} from "./diagnosticBundle";

export type DiagnosticSystemInfo = Readonly<{
  appVersion: unknown;
  platform: unknown;
  architecture: unknown;
  osRelease: unknown;
}>;

export type DiagnosticSaveDialogOptions = Readonly<{
  title: string;
  defaultPath: string;
  filters: readonly Readonly<{
    name: string;
    extensions: readonly string[];
  }>[];
}>;

export type DiagnosticSaveDialogResult = Readonly<{
  canceled: boolean;
  filePath?: string;
}>;

export type DiagnosticExportOptions = Readonly<{
  systemInfo: () => DiagnosticSystemInfo;
  showSaveDialog: (
    options: DiagnosticSaveDialogOptions,
  ) => Promise<DiagnosticSaveDialogResult>;
  writeFile: (
    filePath: string,
    contents: string,
    encoding: "utf8",
  ) => Promise<void>;
  now?: () => Date;
  uuid?: () => string;
}>;

export type DiagnosticExportService = Readonly<{
  preview: (input: unknown) => DiagnosticPreviewResponse;
  save: (previewId: unknown) => Promise<DiagnosticSaveResponse>;
}>;

type StoredPreview = Readonly<{
  fileName: string;
  json: string;
  createdAtMs: number;
}>;

const PREVIEW_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVALID_PREVIEW_ID_MESSAGE = "diagnostic_preview_id_invalid";
const PREVIEW_ID_PREFIX = "dp-";
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_STORED_PREVIEWS = 5;
const SAFE_DATE = new Date(0);

function safeDate(now: () => Date): Date {
  try {
    const value = now();
    return value instanceof Date && Number.isFinite(value.getTime())
      ? new Date(value.getTime())
      : new Date(SAFE_DATE.getTime());
  } catch {
    return new Date(SAFE_DATE.getTime());
  }
}

function safeSystemInfo(
  source: () => DiagnosticSystemInfo,
): DiagnosticSystemInfo {
  try {
    const value = source();
    return {
      appVersion: value.appVersion,
      platform: value.platform,
      architecture: value.architecture,
      osRelease: value.osRelease,
    };
  } catch {
    return {
      appVersion: "unknown",
      platform: "unknown",
      architecture: "unknown",
      osRelease: "unknown",
    };
  }
}

export function createDiagnosticExportService(
  options: DiagnosticExportOptions,
): DiagnosticExportService {
  const now = options.now ?? (() => new Date());
  const uuid = options.uuid ?? randomUUID;
  const previews = new Map<string, StoredPreview>();

  function createPreviewId(): string {
    let value: string;
    try {
      value = uuid();
    } catch {
      throw new Error(INVALID_PREVIEW_ID_MESSAGE);
    }

    if (typeof value !== "string" || !PREVIEW_ID_PATTERN.test(value)) {
      throw new Error(INVALID_PREVIEW_ID_MESSAGE);
    }

    return `${PREVIEW_ID_PREFIX}${value.toLowerCase()}`;
  }

  function removeExpired(currentTimeMs: number): void {
    for (const [previewId, preview] of previews) {
      if (currentTimeMs - preview.createdAtMs > PREVIEW_TTL_MS) {
        previews.delete(previewId);
      }
    }
  }

  function enforcePreviewLimit(): void {
    while (previews.size > MAX_STORED_PREVIEWS) {
      const oldestPreviewId = previews.keys().next().value as
        string | undefined;
      if (!oldestPreviewId) return;
      previews.delete(oldestPreviewId);
    }
  }

  function preview(input: unknown): DiagnosticPreviewResponse {
    const createdAt = safeDate(now);
    const info = safeSystemInfo(options.systemInfo);
    const bundle = buildDiagnosticBundle(input, {
      appVersion: info.appVersion,
      platform: info.platform,
      architecture: info.architecture,
      osRelease: info.osRelease,
      now: () => createdAt,
    });
    const json = serializeDiagnosticBundle(bundle);
    const fileName = diagnosticFileName(bundle.createdAt);
    const previewId = createPreviewId();

    removeExpired(createdAt.getTime());
    previews.set(
      previewId,
      Object.freeze({
        fileName,
        json,
        createdAtMs: createdAt.getTime(),
      }),
    );
    enforcePreviewLimit();

    return Object.freeze({ previewId, fileName, json });
  }

  async function save(previewId: unknown): Promise<DiagnosticSaveResponse> {
    const currentTimeMs = safeDate(now).getTime();
    removeExpired(currentTimeMs);

    if (typeof previewId !== "string") {
      return Object.freeze({ status: "expired" });
    }

    const stored = previews.get(previewId);
    if (!stored) {
      return Object.freeze({ status: "expired" });
    }

    let selection: DiagnosticSaveDialogResult;
    try {
      selection = await options.showSaveDialog({
        title: "Save redacted diagnostic report",
        defaultPath: stored.fileName,
        filters: [{ name: "JSON report", extensions: ["json"] }],
      });
    } catch {
      return Object.freeze({ status: "failed" });
    }

    if (selection.canceled) {
      return Object.freeze({ status: "cancelled" });
    }

    if (typeof selection.filePath !== "string" || !selection.filePath) {
      return Object.freeze({ status: "failed" });
    }

    try {
      await options.writeFile(selection.filePath, stored.json, "utf8");
      previews.delete(previewId);
      return Object.freeze({ status: "saved" });
    } catch {
      return Object.freeze({ status: "failed" });
    }
  }

  return Object.freeze({ preview, save });
}
