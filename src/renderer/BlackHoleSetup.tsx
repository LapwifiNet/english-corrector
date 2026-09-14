import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  BLACKHOLE_OUTPUT_STORAGE_KEY,
  createBrowserVirtualOutputDetector,
  detectBlackHoleAvailability,
  rememberBlackHoleOutput,
  restoreRememberedBlackHoleOutput,
  serializeRememberedBlackHoleOutput,
  type BlackHoleAvailability,
  type VirtualOutputDetector,
} from "./audio/blackHoleAvailability";

type BlackHoleSetupProps = {
  children: ReactNode;
  detector?: VirtualOutputDetector;
};

type SetupState = { status: "checking" } | BlackHoleAvailability;

function loadRememberedOutput() {
  try {
    return restoreRememberedBlackHoleOutput(
      window.localStorage.getItem(BLACKHOLE_OUTPUT_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

function unavailableCopy(
  state: Extract<BlackHoleAvailability, { status: "unavailable" }>,
): { title: string; body: string } {
  switch (state.reason) {
    case "enumeration_unavailable":
      return {
        title: "Audio output discovery is unavailable",
        body: "This runtime cannot list audio outputs. Open the macOS desktop build and check again.",
      };
    case "enumeration_failed":
      return {
        title: "Audio outputs could not be checked",
        body: "macOS did not return the current output list. No device setting was changed.",
      };
    case "remembered_device_missing":
      return {
        title: "Previously detected BlackHole is unavailable",
        body: "The known BlackHole device is no longer in the macOS output list. Reconnect or reinstall it, then check again.",
      };
    case "candidate_unusable":
      return {
        title: "BlackHole cannot be selected yet",
        body: "A BlackHole label was found, but macOS did not provide a usable output identifier.",
      };
  }
}

function SetupProgress() {
  return (
    <ol className="onboarding-progress" aria-label="Setup progress">
      <li className="is-complete">
        <span>✓</span>
        Privacy
      </li>
      <li className="is-complete">
        <span>✓</span>
        Microphone
      </li>
      <li className="is-active" aria-current="step">
        <span>3</span>
        Virtual output
      </li>
    </ol>
  );
}

function DesktopBlackHoleSetup({
  children,
  detector,
}: Required<BlackHoleSetupProps>) {
  const rememberedRef = useRef(loadRememberedOutput());
  const scanSequence = useRef(0);
  const [state, setState] = useState<SetupState>({ status: "checking" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    const sequence = ++scanSequence.current;
    setBusy(true);
    const next = detectBlackHoleAvailability(
      await detector.scan(),
      rememberedRef.current,
    );
    if (sequence !== scanSequence.current) return;

    if (next.status === "available") {
      const remembered = rememberBlackHoleOutput(next.output);
      rememberedRef.current = remembered;
      try {
        window.localStorage.setItem(
          BLACKHOLE_OUTPUT_STORAGE_KEY,
          serializeRememberedBlackHoleOutput(remembered),
        );
        setMessage("");
      } catch {
        setMessage(
          "BlackHole was detected, but its local device identifier could not be remembered.",
        );
      }
    }

    setState(next);
    setBusy(false);
  }, [detector]);

  useEffect(() => {
    void refresh();
    const unsubscribe = detector.subscribe(() => void refresh());
    const handleFocus = () => void refresh();
    window.addEventListener("focus", handleFocus);

    return () => {
      scanSequence.current += 1;
      unsubscribe();
      window.removeEventListener("focus", handleFocus);
    };
  }, [detector, refresh]);

  if (state.status === "available" || state.status === "renamed") {
    const renamed = state.status === "renamed";
    return (
      <>
        <section
          className={`blackhole-readiness ${renamed ? "renamed" : "available"}`}
          data-blackhole-status={state.status}
          aria-label="Virtual output status"
        >
          <span className="blackhole-readiness-icon" aria-hidden>
            {renamed ? "R" : "✓"}
          </span>
          <div>
            <small>Virtual output {renamed ? "recognized" : "ready"}</small>
            <strong>{state.output.label}</strong>
            <p>
              {renamed
                ? "Recognized from the locally remembered device ID. Review the selected output before relay."
                : "Detected without changing your selected audio device."}
            </p>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {busy ? "Checking" : "Refresh outputs"}
          </button>
        </section>
        {message && (
          <p className="blackhole-storage-message" role="status">
            {message}
          </p>
        )}
        {children}
      </>
    );
  }

  const copy =
    state.status === "unavailable"
      ? unavailableCopy(state)
      : state.status === "missing"
        ? {
            title: "Install or reconnect BlackHole",
            body: "No recognized BlackHole audio output is available. Relay stays off until a virtual output is detected.",
          }
        : {
            title: "Checking virtual audio output",
            body: "Reading the current macOS output list without changing device settings.",
          };

  return (
    <main className="onboarding-shell">
      <section
        className="onboarding-card"
        data-blackhole-status={state.status}
        aria-labelledby="blackhole-heading"
        aria-busy={busy || state.status === "checking"}
      >
        <div className="onboarding-brand">
          <span aria-hidden>EC</span>
          <div>
            <strong>English Corrector</strong>
            <small>Private macOS setup</small>
          </div>
        </div>
        <SetupProgress />
        <div className="onboarding-body">
          <span
            className={`onboarding-icon ${state.status === "checking" ? "" : "warning"}`}
            aria-hidden
          >
            {state.status === "checking" ? "…" : "BH"}
          </span>
          <p className="onboarding-kicker">Step 3 of 3</p>
          <h1 id="blackhole-heading">{copy.title}</h1>
          <p>{copy.body}</p>
          {state.status !== "checking" && (
            <ol className="blackhole-checklist">
              <li>Install or reconnect BlackHole 2ch in macOS.</li>
              <li>Confirm it appears as an output in Audio MIDI Setup.</li>
              <li>Restart the call app, then refresh this check.</li>
            </ol>
          )}
          <div className="onboarding-note">
            This check never changes the macOS default output and never selects
            a replacement device automatically.
          </div>
          <div className="onboarding-actions">
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {busy ? "Checking audio outputs" : "Check audio outputs"}
            </button>
          </div>
        </div>
        {message && (
          <p className="onboarding-message" role="status" aria-live="polite">
            {message}
          </p>
        )}
      </section>
    </main>
  );
}

export function BlackHoleSetup({
  children,
  detector: providedDetector,
}: BlackHoleSetupProps) {
  const browserDetector = useMemo(
    () =>
      createBrowserVirtualOutputDetector(
        typeof navigator === "undefined" ? undefined : navigator.mediaDevices,
      ),
    [],
  );

  if (!window.desktopApi && !providedDetector) return <>{children}</>;

  return (
    <DesktopBlackHoleSetup detector={providedDetector ?? browserDetector}>
      {children}
    </DesktopBlackHoleSetup>
  );
}
