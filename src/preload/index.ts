import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, MicrophonePermissionStatus } from "../shared/audio";

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
};

contextBridge.exposeInMainWorld("desktopApi", desktopApi);
