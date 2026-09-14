import type { CorrectionBridge } from "./correction";
import type { TtsBridge } from "./tts";

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
  };
  tts: TtsBridge;
  correction: CorrectionBridge;
};
