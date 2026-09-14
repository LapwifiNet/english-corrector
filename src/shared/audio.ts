import type { CorrectionBridge } from "./correction";
import type { SttBridge } from "./stt";
import type { TtsBridge } from "./tts";

export const AUDIO_IPC = Object.freeze({
  microphoneStatus: "audio:get-microphone-permission",
  requestMicrophone: "audio:request-microphone-permission",
  openMicrophoneSettings: "audio:open-microphone-settings",
} as const);

export type MicrophonePermissionStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unsupported"
  | "unknown";

export type DesktopApi = {
  microphone: {
    getStatus: () => Promise<MicrophonePermissionStatus>;
    request: () => Promise<boolean>;
    openSettings: () => Promise<boolean>;
  };
  stt: SttBridge;
  tts: TtsBridge;
  correction: CorrectionBridge;
};
