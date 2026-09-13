import { ipcMain, type IpcMainEvent } from "electron";
import {
  TTS_IPC,
  type TtsBridgeEvent,
  type TtsBridgeRequest,
} from "../shared/tts";
import {
  providerErrorCode,
  readElevenLabsProviderStatus,
  readElevenLabsRuntimeConfig,
  streamElevenLabsSpeech,
} from "./elevenLabsClient";

const MAX_TEXT_LENGTH = 280;
const activeRequests = new Map<string, AbortController>();

function requestKey(senderId: number, utteranceId: string): string {
  return `${senderId}:${utteranceId}`;
}

function isRequest(value: unknown): value is TtsBridgeRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<TtsBridgeRequest>;

  return (
    typeof request.utteranceId === "string" &&
    request.utteranceId.length > 0 &&
    request.utteranceId.length <= 128 &&
    typeof request.text === "string" &&
    request.text.trim().length > 0 &&
    request.text.length <= MAX_TEXT_LENGTH &&
    typeof request.voiceId === "string" &&
    request.voiceId.length > 0 &&
    request.voiceId.length <= 128
  );
}

export function registerTtsIpc(): void {
  ipcMain.handle(TTS_IPC.status, () => readElevenLabsProviderStatus());

  ipcMain.on(TTS_IPC.start, (event: IpcMainEvent, value: unknown) => {
    const fallbackUtteranceId =
      value &&
      typeof value === "object" &&
      typeof (value as { utteranceId?: unknown }).utteranceId === "string"
        ? (value as { utteranceId: string }).utteranceId
        : "invalid-utterance";
    const emit = (payload: TtsBridgeEvent) => {
      if (!event.sender.isDestroyed())
        event.sender.send(TTS_IPC.event, payload);
    };

    if (!isRequest(value)) {
      emit({
        type: "failed",
        utteranceId: fallbackUtteranceId,
        code: "provider_request_error",
      });
      return;
    }

    const request = value;
    const key = requestKey(event.sender.id, request.utteranceId);
    if (activeRequests.has(key)) {
      emit({
        type: "failed",
        utteranceId: request.utteranceId,
        code: "utterance_already_active",
      });
      return;
    }

    const config = readElevenLabsRuntimeConfig();
    if (!config) {
      emit({
        type: "failed",
        utteranceId: request.utteranceId,
        code: "provider_not_configured",
      });
      return;
    }

    const controller = new AbortController();
    activeRequests.set(key, controller);
    const handleDestroyed = () => controller.abort();
    event.sender.once("destroyed", handleDestroyed);

    void streamElevenLabsSpeech({
      request,
      config,
      signal: controller.signal,
      emit,
    })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        emit({
          type: "failed",
          utteranceId: request.utteranceId,
          code: providerErrorCode(error),
        });
      })
      .finally(() => {
        activeRequests.delete(key);
        event.sender.removeListener("destroyed", handleDestroyed);
      });
  });

  ipcMain.on(TTS_IPC.cancel, (event: IpcMainEvent, utteranceId: unknown) => {
    if (typeof utteranceId !== "string") return;
    activeRequests.get(requestKey(event.sender.id, utteranceId))?.abort();
  });
}
