import { ipcMain, type IpcMainEvent } from "electron";
import {
  TTS_IPC,
  type TtsBridgeEvent,
  type TtsBridgeRequest,
  type TtsProviderStatus,
  type TtsVoiceCatalog,
} from "../shared/tts";
import {
  providerErrorCode as elevenLabsProviderErrorCode,
  streamElevenLabsSpeech,
} from "./elevenLabsClient";
import {
  PalabraStreamingClient,
  palabraProviderErrorCode,
  type PalabraRuntimeConfig,
} from "./palabraClient";
import { listPalabraVoices } from "./palabraVoices";
import {
  readPreferredTtsProviderStatus,
  readPreferredTtsRuntimeConfig,
} from "./ttsProvider";

const MAX_TEXT_LENGTH = 280;
const activeRequests = new Map<string, AbortController>();
let palabraClient: PalabraStreamingClient | null = null;

function requestKey(senderId: number, utteranceId: string): string {
  return `${senderId}:${utteranceId}`;
}

function configuredVoiceCatalog(status: TtsProviderStatus): TtsVoiceCatalog {
  return {
    provider: status.provider,
    voices: status.voiceId
      ? [
          {
            id: status.voiceId,
            name:
              status.provider === "palabra"
                ? "Configured Palabra voice"
                : `ElevenLabs · ${status.modelId}`,
            locale: status.language ?? "en-US",
            category:
              status.provider === "palabra" &&
              (status.voiceId === "default_low" ||
                status.voiceId === "default_high")
                ? "default"
                : "configured",
          },
        ]
      : [],
  };
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

function getPalabraClient(
  config: PalabraRuntimeConfig,
): PalabraStreamingClient {
  palabraClient ??= new PalabraStreamingClient(config);
  return palabraClient;
}

export function registerTtsIpc(): void {
  ipcMain.handle(TTS_IPC.status, () => readPreferredTtsProviderStatus());
  ipcMain.handle(TTS_IPC.voices, async () => {
    const status = readPreferredTtsProviderStatus();
    const runtime = readPreferredTtsRuntimeConfig();

    if (runtime?.provider === "palabra") {
      return listPalabraVoices({
        config: runtime.config,
        signal: AbortSignal.timeout(10_000),
      });
    }

    return configuredVoiceCatalog(status);
  });

  ipcMain.on(TTS_IPC.start, (event: IpcMainEvent, value: unknown) => {
    const fallbackUtteranceId =
      value &&
      typeof value === "object" &&
      typeof (value as { utteranceId?: unknown }).utteranceId === "string"
        ? (value as { utteranceId: string }).utteranceId
        : "invalid-utterance";
    const emit = (payload: TtsBridgeEvent) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(TTS_IPC.event, payload);
      }
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

    const runtime = readPreferredTtsRuntimeConfig();
    if (!runtime) {
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

    const streaming =
      runtime.provider === "palabra"
        ? getPalabraClient(runtime.config).streamSpeech({
            request,
            signal: controller.signal,
            emit,
          })
        : streamElevenLabsSpeech({
            request,
            config: runtime.config,
            signal: controller.signal,
            emit,
          });

    void streaming
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        emit({
          type: "failed",
          utteranceId: request.utteranceId,
          code:
            runtime.provider === "palabra"
              ? palabraProviderErrorCode(error)
              : elevenLabsProviderErrorCode(error),
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
