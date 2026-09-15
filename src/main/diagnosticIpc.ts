import { app, dialog, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import { release } from "node:os";
import {
  DIAGNOSTIC_IPC,
  type DiagnosticPreviewResponse,
  type DiagnosticSaveResponse,
} from "../shared/diagnostics";
import { createDiagnosticExportService } from "./diagnosticExport";
import type { PrivacyLogger } from "./privacyLogger";

export function registerDiagnosticIpc(privacyLogger: PrivacyLogger): void {
  const service = createDiagnosticExportService({
    systemInfo: () => ({
      appVersion: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
      osRelease: release(),
    }),
    showSaveDialog: async (options) =>
      dialog.showSaveDialog({
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters.map((filter) => ({
          name: filter.name,
          extensions: Array.from(filter.extensions),
        })),
      }),
    writeFile: async (filePath, contents, encoding) => {
      await writeFile(filePath, contents, encoding);
    },
  });

  ipcMain.handle(
    DIAGNOSTIC_IPC.preview,
    (_event, input: unknown): DiagnosticPreviewResponse => {
      const correlationId = privacyLogger.createCorrelationId();
      const startedAt = Date.now();
      privacyLogger.log({
        event: "diagnostic_export",
        component: "diagnostics",
        outcome: "started",
        correlationId,
      });

      try {
        const preview = service.preview(input);
        privacyLogger.log({
          event: "diagnostic_export",
          component: "diagnostics",
          outcome: "ready",
          correlationId,
          durationMs: Date.now() - startedAt,
        });
        return preview;
      } catch {
        privacyLogger.log({
          level: "error",
          event: "diagnostic_export",
          component: "diagnostics",
          outcome: "failed",
          code: "diagnostic_export_failed",
          correlationId,
          durationMs: Date.now() - startedAt,
          retryable: true,
        });
        throw new Error("diagnostic_preview_failed");
      }
    },
  );

  ipcMain.handle(
    DIAGNOSTIC_IPC.save,
    async (_event, previewId: unknown): Promise<DiagnosticSaveResponse> => {
      const correlationId = privacyLogger.createCorrelationId();
      const startedAt = Date.now();
      privacyLogger.log({
        event: "diagnostic_export",
        component: "diagnostics",
        outcome: "started",
        correlationId,
      });

      let result: DiagnosticSaveResponse;
      try {
        result = await service.save(previewId);
      } catch {
        result = { status: "failed" };
      }

      if (result.status === "saved") {
        privacyLogger.log({
          event: "diagnostic_export",
          component: "diagnostics",
          outcome: "completed",
          correlationId,
          durationMs: Date.now() - startedAt,
        });
      } else if (result.status === "cancelled") {
        privacyLogger.log({
          event: "diagnostic_export",
          component: "diagnostics",
          outcome: "cancelled",
          correlationId,
          durationMs: Date.now() - startedAt,
        });
      } else if (result.status === "expired") {
        privacyLogger.log({
          event: "diagnostic_export",
          component: "diagnostics",
          outcome: "blocked",
          correlationId,
          durationMs: Date.now() - startedAt,
        });
      } else {
        privacyLogger.log({
          level: "error",
          event: "diagnostic_export",
          component: "diagnostics",
          outcome: "failed",
          code: "diagnostic_export_failed",
          correlationId,
          durationMs: Date.now() - startedAt,
          retryable: true,
        });
      }

      return result;
    },
  );
}
