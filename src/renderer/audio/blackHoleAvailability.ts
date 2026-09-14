export const BLACKHOLE_OUTPUT_STORAGE_KEY =
  "english-corrector.blackhole-output-v1";

export type VirtualOutputDescriptor = {
  deviceId: string;
  kind: string;
  label: string;
  available?: boolean;
};

export type VirtualOutputScan =
  | { ok: true; devices: VirtualOutputDescriptor[] }
  | {
      ok: false;
      reason: "enumeration_unavailable" | "enumeration_failed";
    };

export type RememberedBlackHoleOutput = {
  version: 1;
  deviceId: string;
};

export type BlackHoleOutput = {
  deviceId: string;
  label: string;
};

export type BlackHoleAvailability =
  | { status: "available"; output: BlackHoleOutput }
  | { status: "renamed"; output: BlackHoleOutput }
  | { status: "missing" }
  | {
      status: "unavailable";
      reason:
        | "enumeration_unavailable"
        | "enumeration_failed"
        | "remembered_device_missing"
        | "candidate_unusable";
      output?: BlackHoleOutput;
    };

export interface VirtualOutputDetector {
  scan: () => Promise<VirtualOutputScan>;
  subscribe: (listener: () => void) => () => void;
}

export function isBlackHoleLabel(label: string): boolean {
  return /black[\s_-]*hole/i.test(label.trim());
}

function isUsable(device: VirtualOutputDescriptor): boolean {
  return device.available !== false && device.deviceId.trim().length > 0;
}

function outputOf(device: VirtualOutputDescriptor): BlackHoleOutput {
  return {
    deviceId: device.deviceId,
    label: device.label.trim() || "BlackHole output",
  };
}

function channelPriority(label: string): number {
  if (/\b2\s*ch\b/i.test(label)) return 0;
  if (/\b16\s*ch\b/i.test(label)) return 1;
  if (/\b64\s*ch\b/i.test(label)) return 2;
  return 3;
}

export function detectBlackHoleAvailability(
  scan: VirtualOutputScan,
  remembered: RememberedBlackHoleOutput | null = null,
): BlackHoleAvailability {
  if (!scan.ok) {
    return { status: "unavailable", reason: scan.reason };
  }

  const outputs = scan.devices.filter(
    (device) => device.kind === "audiooutput",
  );
  const recognized = outputs
    .filter((device) => isBlackHoleLabel(device.label))
    .sort(
      (left, right) =>
        channelPriority(left.label) - channelPriority(right.label),
    );
  const candidate = recognized.find(isUsable);

  if (candidate) {
    return { status: "available", output: outputOf(candidate) };
  }

  if (remembered) {
    const savedDevice = outputs.find(
      (device) => device.deviceId === remembered.deviceId,
    );

    if (!savedDevice) {
      return { status: "unavailable", reason: "remembered_device_missing" };
    }

    if (!isUsable(savedDevice)) {
      return {
        status: "unavailable",
        reason: "candidate_unusable",
        output: outputOf(savedDevice),
      };
    }

    return { status: "renamed", output: outputOf(savedDevice) };
  }

  if (recognized.length > 0) {
    return {
      status: "unavailable",
      reason: "candidate_unusable",
      output: outputOf(recognized[0]),
    };
  }

  return { status: "missing" };
}

export function rememberBlackHoleOutput(
  output: BlackHoleOutput,
): RememberedBlackHoleOutput {
  return { version: 1, deviceId: output.deviceId };
}

export function serializeRememberedBlackHoleOutput(
  remembered: RememberedBlackHoleOutput,
): string {
  return JSON.stringify(remembered);
}

export function restoreRememberedBlackHoleOutput(
  raw: string | null,
): RememberedBlackHoleOutput | null {
  if (!raw) return null;

  try {
    const value = JSON.parse(raw) as Partial<RememberedBlackHoleOutput>;
    if (
      value.version !== 1 ||
      typeof value.deviceId !== "string" ||
      value.deviceId.trim().length === 0
    ) {
      return null;
    }

    return { version: 1, deviceId: value.deviceId };
  } catch {
    return null;
  }
}

export function createBrowserVirtualOutputDetector(
  mediaDevices: MediaDevices | undefined,
): VirtualOutputDetector {
  return {
    async scan() {
      if (!mediaDevices?.enumerateDevices) {
        return { ok: false, reason: "enumeration_unavailable" };
      }

      try {
        const devices = await mediaDevices.enumerateDevices();
        return {
          ok: true,
          devices: devices.map((device) => ({
            deviceId: device.deviceId,
            kind: device.kind,
            label: device.label,
            available: device.deviceId.trim().length > 0,
          })),
        };
      } catch {
        return { ok: false, reason: "enumeration_failed" };
      }
    },
    subscribe(listener) {
      if (!mediaDevices?.addEventListener) return () => undefined;

      const handleChange = () => listener();
      mediaDevices.addEventListener("devicechange", handleChange);
      return () =>
        mediaDevices.removeEventListener("devicechange", handleChange);
    },
  };
}
