import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { DesktopApi, MicrophonePermissionStatus } from "../shared/audio";
import {
  PERMISSION_ONBOARDING_STORAGE_KEY,
  acknowledgePermissionPrivacy,
  canRequestMicrophonePermission,
  permissionOnboardingStep,
  restorePermissionOnboardingProgress,
  serializePermissionOnboardingProgress,
} from "./audio/permissionOnboarding";

type PermissionBridge = DesktopApi["microphone"];

type PermissionOnboardingProps = {
  children: ReactNode;
};

function progressIndex(
  step: ReturnType<typeof permissionOnboardingStep>,
): number {
  if (step === "privacy" || step === "checking") return 0;
  if (step === "ready") return 2;
  return 1;
}

function loadStoredProgress() {
  try {
    return restorePermissionOnboardingProgress(
      window.localStorage.getItem(PERMISSION_ONBOARDING_STORAGE_KEY),
    );
  } catch {
    return restorePermissionOnboardingProgress(null);
  }
}

function DesktopPermissionOnboarding({
  bridge,
  children,
}: PermissionOnboardingProps & { bridge: PermissionBridge }) {
  const [progress, setProgress] = useState(loadStoredProgress);
  const [permission, setPermission] =
    useState<MicrophonePermissionStatus>("unknown");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const step = permissionOnboardingStep(permission, progress);

  const refreshStatus = useCallback(async () => {
    setBusy(true);
    try {
      setPermission(await bridge.getStatus());
      setMessage("");
    } catch {
      setPermission("unknown");
      setMessage("Microphone permission status could not be checked.");
    } finally {
      setBusy(false);
    }
  }, [bridge]);

  useEffect(() => {
    void refreshStatus();
    const handleFocus = () => void refreshStatus();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refreshStatus]);

  const acknowledgePrivacy = () => {
    const next = acknowledgePermissionPrivacy(progress);
    setProgress(next);
    try {
      window.localStorage.setItem(
        PERMISSION_ONBOARDING_STORAGE_KEY,
        serializePermissionOnboardingProgress(next),
      );
    } catch {
      setMessage(
        "Privacy acknowledgement could not be saved. This step may appear again after restart.",
      );
    }
  };

  const requestMicrophone = async () => {
    if (!canRequestMicrophonePermission(step)) return;
    setBusy(true);
    setMessage("");
    try {
      const granted = await bridge.request();
      let latest: MicrophonePermissionStatus;
      try {
        latest = await bridge.getStatus();
      } catch {
        latest = granted ? "granted" : "denied";
      }
      setPermission(latest);
      if (latest !== "granted") {
        setMessage(
          "Access was not granted. English Corrector will not request it again automatically.",
        );
      }
    } catch {
      setMessage(
        "macOS could not complete the permission request. No automatic retry was made.",
      );
    } finally {
      setBusy(false);
    }
  };

  const openSettings = async () => {
    setBusy(true);
    try {
      const opened = await bridge.openSettings();
      setMessage(
        opened
          ? "System Settings opened. Enable Microphone access, then return here."
          : "System Settings could not be opened automatically.",
      );
    } catch {
      setMessage("System Settings could not be opened automatically.");
    } finally {
      setBusy(false);
    }
  };

  if (step === "ready") return <>{children}</>;

  const activeProgress = progressIndex(step);

  return (
    <main className="onboarding-shell">
      <section className="onboarding-card" aria-labelledby="onboarding-heading">
        <div className="onboarding-brand">
          <span aria-hidden>EC</span>
          <div>
            <strong>English Corrector</strong>
            <small>Private macOS setup</small>
          </div>
        </div>

        <ol className="onboarding-progress" aria-label="Setup progress">
          {["Privacy", "Microphone", "Ready"].map((label, index) => (
            <li
              key={label}
              className={
                index < activeProgress
                  ? "is-complete"
                  : index === activeProgress
                    ? "is-active"
                    : ""
              }
              aria-current={index === activeProgress ? "step" : undefined}
            >
              <span>{index < activeProgress ? "✓" : index + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        {step === "checking" && (
          <div className="onboarding-body" aria-busy="true">
            <span className="onboarding-icon" aria-hidden>
              …
            </span>
            <p className="onboarding-kicker">Checking macOS</p>
            <h1 id="onboarding-heading">Reading microphone permission</h1>
            <p>No permission prompt is shown during this check.</p>
          </div>
        )}

        {step === "privacy" && (
          <div className="onboarding-body">
            <span className="onboarding-icon" aria-hidden>
              ◉
            </span>
            <p className="onboarding-kicker">Step 1 of 2</p>
            <h1 id="onboarding-heading">Understand the audio path first</h1>
            <p>
              When you hold to talk, microphone audio may be sent to the
              configured speech provider. Final text may then be sent to the
              correction and voice providers.
            </p>
            <ul className="onboarding-privacy-list">
              <li>
                Raw microphone audio stays in memory and is not saved to disk.
              </li>
              <li>
                Transcript and corrected text stay in the current session.
              </li>
              <li>Provider credentials stay outside the renderer.</li>
            </ul>
            <div className="onboarding-actions">
              <button
                type="button"
                className="primary-button"
                onClick={acknowledgePrivacy}
              >
                I understand, continue
              </button>
            </div>
          </div>
        )}

        {step === "microphone" && (
          <div className="onboarding-body">
            <span className="onboarding-icon" aria-hidden>
              🎙
            </span>
            <p className="onboarding-kicker">Step 2 of 2</p>
            <h1 id="onboarding-heading">Allow microphone access</h1>
            <p>
              macOS will show one system prompt. Access is used to list your
              physical microphones and capture audio only while you hold to
              talk.
            </p>
            <div className="onboarding-note">
              If you deny access, this app will not open the permission prompt
              repeatedly. You can change the decision in System Settings.
            </div>
            <div className="onboarding-actions">
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void requestMicrophone()}
              >
                {busy ? "Waiting for macOS" : "Request microphone access"}
              </button>
            </div>
          </div>
        )}

        {step === "denied" && (
          <div className="onboarding-body">
            <span className="onboarding-icon warning" aria-hidden>
              !
            </span>
            <p className="onboarding-kicker">Action required</p>
            <h1 id="onboarding-heading">Microphone access is off</h1>
            <p>
              English Corrector will not ask again automatically. Enable access
              in Privacy and Security, then return and check the status.
            </p>
            <div className="onboarding-actions split">
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void openSettings()}
              >
                Open System Settings
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void refreshStatus()}
              >
                Check again
              </button>
            </div>
          </div>
        )}

        {step === "restricted" && (
          <div className="onboarding-body">
            <span className="onboarding-icon warning" aria-hidden>
              !
            </span>
            <p className="onboarding-kicker">Managed permission</p>
            <h1 id="onboarding-heading">Microphone access is restricted</h1>
            <p>
              A macOS policy or device manager is preventing access. No new
              permission request will be made from this screen.
            </p>
            <div className="onboarding-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void refreshStatus()}
              >
                Check again
              </button>
            </div>
          </div>
        )}

        {step === "unsupported" && (
          <div className="onboarding-body">
            <span className="onboarding-icon warning" aria-hidden>
              !
            </span>
            <p className="onboarding-kicker">Unsupported environment</p>
            <h1 id="onboarding-heading">Open the macOS desktop build</h1>
            <p>The release onboarding requires the macOS permission bridge.</p>
          </div>
        )}

        {message && (
          <p className="onboarding-message" role="status" aria-live="polite">
            {message}
          </p>
        )}
      </section>
    </main>
  );
}

export function PermissionOnboarding({ children }: PermissionOnboardingProps) {
  const bridge = window.desktopApi?.microphone;
  if (!bridge) return <>{children}</>;

  return (
    <DesktopPermissionOnboarding bridge={bridge}>
      {children}
    </DesktopPermissionOnboarding>
  );
}
