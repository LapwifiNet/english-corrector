import assert from "node:assert/strict";
import test from "node:test";
import {
  INITIAL_PERMISSION_ONBOARDING_PROGRESS,
  acknowledgePermissionPrivacy,
  canRequestMicrophonePermission,
  permissionOnboardingStep,
  restorePermissionOnboardingProgress,
  serializePermissionOnboardingProgress,
  type PermissionOnboardingStep,
} from "./permissionOnboarding";

const acknowledged = acknowledgePermissionPrivacy(
  INITIAL_PERMISSION_ONBOARDING_PROGRESS,
);

test("permission onboarding", async (suite) => {
  await suite.test("starts with the privacy explanation", () => {
    assert.equal(
      permissionOnboardingStep(
        "not-determined",
        INITIAL_PERMISSION_ONBOARDING_PROGRESS,
      ),
      "privacy",
    );
  });

  await suite.test(
    "shows privacy before entering an already granted app",
    () => {
      assert.equal(
        permissionOnboardingStep(
          "granted",
          INITIAL_PERMISSION_ONBOARDING_PROGRESS,
        ),
        "privacy",
      );
    },
  );

  await suite.test(
    "resumes at the microphone request after privacy acknowledgement",
    () => {
      assert.equal(
        permissionOnboardingStep("not-determined", acknowledged),
        "microphone",
      );
    },
  );

  await suite.test("enters the product when permission is granted", () => {
    assert.equal(permissionOnboardingStep("granted", acknowledged), "ready");
  });

  await suite.test("detects permission revoked after onboarding", () => {
    assert.equal(permissionOnboardingStep("denied", acknowledged), "denied");
  });

  await suite.test("separates denied and restricted states", () => {
    assert.equal(permissionOnboardingStep("denied", acknowledged), "denied");
    assert.equal(
      permissionOnboardingStep("restricted", acknowledged),
      "restricted",
    );
  });

  await suite.test("does not request again from terminal states", () => {
    const terminalSteps: PermissionOnboardingStep[] = [
      "privacy",
      "denied",
      "restricted",
      "ready",
      "unsupported",
      "checking",
    ];

    assert.equal(canRequestMicrophonePermission("microphone"), true);
    for (const step of terminalSteps) {
      assert.equal(canRequestMicrophonePermission(step), false);
    }
  });

  await suite.test(
    "keeps unknown and unsupported environments explicit",
    () => {
      assert.equal(
        permissionOnboardingStep("unknown", acknowledged),
        "checking",
      );
      assert.equal(
        permissionOnboardingStep("unsupported", acknowledged),
        "unsupported",
      );
    },
  );

  await suite.test("round trips only the versioned acknowledgement", () => {
    const raw = serializePermissionOnboardingProgress(acknowledged);
    assert.equal(raw, '{"version":1,"privacyAcknowledged":true}');
    assert.deepEqual(restorePermissionOnboardingProgress(raw), acknowledged);
  });

  await suite.test(
    "falls back safely for malformed or stale local data",
    () => {
      assert.equal(
        restorePermissionOnboardingProgress("not-json"),
        INITIAL_PERMISSION_ONBOARDING_PROGRESS,
      );
      assert.equal(
        restorePermissionOnboardingProgress(
          '{"version":0,"privacyAcknowledged":true}',
        ),
        INITIAL_PERMISSION_ONBOARDING_PROGRESS,
      );
      assert.equal(
        restorePermissionOnboardingProgress(
          '{"version":1,"privacyAcknowledged":"yes"}',
        ),
        INITIAL_PERMISSION_ONBOARDING_PROGRESS,
      );
    },
  );
});
