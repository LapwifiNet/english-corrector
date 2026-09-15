import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  AUDIO_IPC,
  type DesktopApi,
  type MicrophonePermissionStatus,
} from "../shared/audio";
import {
  CORRECTION_IPC,
  type CorrectionBridgeResponse,
  type CorrectionProviderStatus,
} from "../shared/correction";
import {
  DIAGNOSTIC_IPC,
  type DiagnosticPreviewResponse,
  type DiagnosticSaveResponse,
} from "../shared/diagnostics";
import {
  STT_IPC,
  type SttBridgeEvent,
  type SttProviderStatus,
} from "../shared/stt";
import {
  TTS_IPC,
  type TtsBridgeEvent,
  type TtsProviderStatus,
  type TtsVoiceCatalog,
} from "../shared/tts";

const desktopApi: DesktopApi = {
  microphone: {
    getStatus: () =>
      ipcRenderer.invoke(
        AUDIO_IPC.microphoneStatus,
      ) as Promise<MicrophonePermissionStatus>,
    request: () =>
      ipcRenderer.invoke(AUDIO_IPC.requestMicrophone) as Promise<boolean>,
    openSettings: () =>
      ipcRenderer.invoke(AUDIO_IPC.openMicrophoneSettings) as Promise<boolean>,
  },
  stt: {
    getStatus: () =>
      ipcRenderer.invoke(STT_IPC.status) as Promise<SttProviderStatus>,
    start: (request) => ipcRenderer.send(STT_IPC.start, request),
    sendAudio: (chunk) => ipcRenderer.send(STT_IPC.audio, chunk),
    finish: (phraseId) => ipcRenderer.send(STT_IPC.finish, phraseId),
    cancel: (phraseId) => ipcRenderer.send(STT_IPC.cancel, phraseId),
    onEvent: (listener) => {
      const handleEvent = (_event: IpcRendererEvent, event: SttBridgeEvent) =>
        listener(event);
      ipcRenderer.on(STT_IPC.event, handleEvent);
      return () => ipcRenderer.removeListener(STT_IPC.event, handleEvent);
    },
  },
  tts: {
    getStatus: () =>
      ipcRenderer.invoke(TTS_IPC.status) as Promise<TtsProviderStatus>,
    getVoices: () =>
      ipcRenderer.invoke(TTS_IPC.voices) as Promise<TtsVoiceCatalog>,
    start: (request) => ipcRenderer.send(TTS_IPC.start, request),
    cancel: (utteranceId) => ipcRenderer.send(TTS_IPC.cancel, utteranceId),
    onEvent: (listener) => {
      const handleEvent = (_event: IpcRendererEvent, event: TtsBridgeEvent) =>
        listener(event);
      ipcRenderer.on(TTS_IPC.event, handleEvent);
      return () => ipcRenderer.removeListener(TTS_IPC.event, handleEvent);
    },
  },
  correction: {
    getStatus: () =>
      ipcRenderer.invoke(
        CORRECTION_IPC.status,
      ) as Promise<CorrectionProviderStatus>,
    correct: (request) =>
      ipcRenderer.invoke(
        CORRECTION_IPC.correct,
        request,
      ) as Promise<CorrectionBridgeResponse>,
  },
  diagnostics: {
    preview: (request) =>
      ipcRenderer.invoke(
        DIAGNOSTIC_IPC.preview,
        request,
      ) as Promise<DiagnosticPreviewResponse>,
    save: (previewId) =>
      ipcRenderer.invoke(
        DIAGNOSTIC_IPC.save,
        previewId,
      ) as Promise<DiagnosticSaveResponse>,
  },
};

contextBridge.exposeInMainWorld("desktopApi", desktopApi);
