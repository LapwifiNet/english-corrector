import { ipcMain } from "electron";
import {
  CORRECTION_IPC,
  MAX_CORRECTION_TEXT_LENGTH,
  type CorrectionBridgeRequest,
  type CorrectionBridgeResponse,
} from "../shared/correction";
import {
  correctionProviderErrorCode,
  readCorrectionProviderStatus,
  readCorrectionRuntimeConfig,
  requestCorrection,
} from "./correctionClient";

const MAX_PHRASE_ID_LENGTH = 128;

function isRequest(value: unknown): value is CorrectionBridgeRequest {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<CorrectionBridgeRequest>;
  if (typeof candidate.phraseId !== "string") return false;
  if (typeof candidate.originalText !== "string") return false;
  if (candidate.phraseId.length === 0) return false;
  if (candidate.phraseId.length > MAX_PHRASE_ID_LENGTH) return false;
  if (candidate.originalText.length > MAX_CORRECTION_TEXT_LENGTH) return false;

  return true;
}

/**
 * The renderer never sees the API key, the endpoint or the provider payload.
 * Failures come back as a code, and nothing here logs phrase content.
 */
export function registerCorrectionIpc(): void {
  ipcMain.handle(CORRECTION_IPC.status, () => readCorrectionProviderStatus());

  ipcMain.handle(
    CORRECTION_IPC.correct,
    async (_event, payload: unknown): Promise<CorrectionBridgeResponse> => {
      if (!isRequest(payload)) {
        return {
          ok: false,
          code: "provider_request_error",
          providerLatencyMs: 0,
        };
      }

      const config = readCorrectionRuntimeConfig();
      if (!config) {
        return {
          ok: false,
          code: "provider_not_configured",
          providerLatencyMs: 0,
        };
      }

      const controller = new AbortController();
      const deadline = setTimeout(() => {
        controller.abort();
      }, config.timeoutMs);
      const startedAt = Date.now();

      try {
        const text = await requestCorrection({
          request: payload,
          config,
          signal: controller.signal,
        });

        return { ok: true, text, providerLatencyMs: Date.now() - startedAt };
      } catch (error) {
        const code = controller.signal.aborted
          ? "provider_timeout"
          : correctionProviderErrorCode(error);

        return { ok: false, code, providerLatencyMs: Date.now() - startedAt };
      } finally {
        clearTimeout(deadline);
      }
    },
  );
}
