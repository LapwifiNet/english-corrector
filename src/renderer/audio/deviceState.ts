export type AudioDeviceDescriptor = {
  deviceId: string;
  groupId: string;
  kind: MediaDeviceKind;
  label: string;
};

export type AudioDeviceChoice = AudioDeviceDescriptor & {
  displayName: string;
};

export function toDeviceChoices(
  devices: AudioDeviceDescriptor[],
  kind: "audioinput" | "audiooutput",
): AudioDeviceChoice[] {
  return devices
    .filter((device) => device.kind === kind)
    .map((device, index) => ({
      ...device,
      displayName:
        device.label.trim() ||
        (kind === "audioinput"
          ? `Microphone ${index + 1}`
          : `Audio output ${index + 1}`),
    }));
}

export function restoreDeviceId(
  devices: AudioDeviceChoice[],
  preferredId: string | null,
): string {
  if (
    preferredId &&
    devices.some((device) => device.deviceId === preferredId)
  ) {
    return preferredId;
  }

  return "";
}

export function routingWarning(
  input: AudioDeviceChoice | undefined,
  output: AudioDeviceChoice | undefined,
): string | null {
  if (!input || !output || !input.groupId || !output.groupId) return null;

  if (input.groupId === output.groupId) {
    return "Input and output belong to the same audio device. This may create a feedback loop.";
  }

  return null;
}
