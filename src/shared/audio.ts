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
};
