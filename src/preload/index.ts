import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DesktopApi, MicrophonePermissionStatus } from "../shared/audio";
import {
  TTS_IPC,
  type TtsBridgeEvent,
  type TtsProviderStatus,
} from "../shared/tts";

const desktopApi: DesktopApi = {
  microphone: {
    getStatus: () =>
      ipcRenderer.invoke(
        "audio:get-microphone-permission",
      ) as Promise<MicrophonePermissionStatus>,
    request: () =>
      ipcRenderer.invoke(
        "audio:request-microphone-permission",
      ) as Promise<boolean>,
  },
  tts: {
    getStatus: () =>
      ipcRenderer.invoke(TTS_IPC.status) as Promise<TtsProviderStatus>,
    start: (request) => ipcRenderer.send(TTS_IPC.start, request),
    cancel: (utteranceId) => ipcRenderer.send(TTS_IPC.cancel, utteranceId),
    onEvent: (listener) => {
      const handleEvent = (_event: IpcRendererEvent, event: TtsBridgeEvent) =>
        listener(event);
      ipcRenderer.on(TTS_IPC.event, handleEvent);
      return () => ipcRenderer.removeListener(TTS_IPC.event, handleEvent);
    },
  },
};

contextBridge.exposeInMainWorld("desktopApi", desktopApi);
