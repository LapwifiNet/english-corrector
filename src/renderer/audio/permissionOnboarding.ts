import type { MicrophonePermissionStatus } from "../../shared/audio";

export const PERMISSION_ONBOARDING_STORAGE_KEY =
  "english-corrector.permission-onboarding-v1";

const ONBOARDING_VERSION = 1 as const;

export type PermissionOnboardingProgress = {
  version: typeof ONBOARDING_VERSION;
  privacyAcknowledged: boolean;
};

export type PermissionOnboardingStep =
  | "checking"
  | "privacy"
  | "microphone"
  | "denied"
  | "restricted"
  | "ready"
  | "unsupported";

export const INITIAL_PERMISSION_ONBOARDING_PROGRESS: PermissionOnboardingProgress =
  Object.freeze({
    version: ONBOARDING_VERSION,
    privacyAcknowledged: false,
  });

export function restorePermissionOnboardingProgress(
  raw: string | null | undefined,
): PermissionOnboardingProgress {
  if (!raw) return INITIAL_PERMISSION_ONBOARDING_PROGRESS;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      parsed.version === ONBOARDING_VERSION &&
      "privacyAcknowledged" in parsed &&
      typeof parsed.privacyAcknowledged === "boolean"
    ) {
      return {
        version: ONBOARDING_VERSION,
        privacyAcknowledged: parsed.privacyAcknowledged,
      };
    }
  } catch {
    // Invalid local data must restart onboarding instead of blocking the app.
  }

  return INITIAL_PERMISSION_ONBOARDING_PROGRESS;
}

export function serializePermissionOnboardingProgress(
  progress: PermissionOnboardingProgress,
): string {
  return JSON.stringify({
    version: ONBOARDING_VERSION,
    privacyAcknowledged: progress.privacyAcknowledged === true,
  });
}

export function acknowledgePermissionPrivacy(
  progress: PermissionOnboardingProgress,
): PermissionOnboardingProgress {
  if (progress.privacyAcknowledged) return progress;

  return {
    version: ONBOARDING_VERSION,
    privacyAcknowledged: true,
  };
}

export function permissionOnboardingStep(
  permission: MicrophonePermissionStatus,
  progress: PermissionOnboardingProgress,
): PermissionOnboardingStep {
  if (!progress.privacyAcknowledged) return "privacy";

  switch (permission) {
    case "granted":
      return "ready";
    case "not-determined":
      return "microphone";
    case "denied":
      return "denied";
    case "restricted":
      return "restricted";
    case "unsupported":
      return "unsupported";
    case "unknown":
      return "checking";
  }
}

export function canRequestMicrophonePermission(
  step: PermissionOnboardingStep,
): boolean {
  return step === "microphone";
}
