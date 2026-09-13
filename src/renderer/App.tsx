import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MicrophonePermissionStatus } from "../shared/audio";
import { createThreeToneWavBlob } from "./audio/testFixture";
import {
  restoreDeviceId,
  routingWarning,
  toDeviceChoices,
  type AudioDeviceChoice,
  type AudioDeviceDescriptor,
} from "./audio/deviceState";

type TestState = "idle" | "playing" | "passed" | "failed";

type SinkSelectableAudio = HTMLAudioElement & {
  setSinkId?: (deviceId: string) => Promise<void>;
};

const INPUT_STORAGE_KEY = "english-corrector.input-device";
const OUTPUT_STORAGE_KEY = "english-corrector.output-device";

function permissionLabel(status: MicrophonePermissionStatus): string {
  switch (status) {
    case "granted":
      return "Microphone access granted";
    case "denied":
      return "Microphone access denied";
    case "restricted":
      return "Microphone access restricted";
    case "unsupported":
      return "Open this screen in the desktop app";
    case "not-determined":
      return "Microphone permission required";
    default:
      return "Checking microphone permission";
  }
}

function StatusDot({ ready }: { ready: boolean }) {
  return (
    <span className={ready ? "status-dot ready" : "status-dot"} aria-hidden />
  );
}

export function App() {
  const [permission, setPermission] =
    useState<MicrophonePermissionStatus>("unknown");
  const [inputs, setInputs] = useState<AudioDeviceChoice[]>([]);
  const [outputs, setOutputs] = useState<AudioDeviceChoice[]>([]);
  const [selectedInput, setSelectedInput] = useState("");
  const [selectedOutput, setSelectedOutput] = useState("");
  const [testState, setTestState] = useState<TestState>("idle");
  const [message, setMessage] = useState(
    "Choose devices to begin the routing test.",
  );
  const activeAudio = useRef<{
    element: SinkSelectableAudio;
    objectUrl: string;
  } | null>(null);

  const loadDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;

    const mediaDevices = await navigator.mediaDevices.enumerateDevices();
    const descriptors: AudioDeviceDescriptor[] = mediaDevices.map((device) => ({
      deviceId: device.deviceId,
      groupId: device.groupId,
      kind: device.kind,
      label: device.label,
    }));
    const nextInputs = toDeviceChoices(descriptors, "audioinput");
    const nextOutputs = toDeviceChoices(descriptors, "audiooutput");

    setInputs(nextInputs);
    setOutputs(nextOutputs);
    setSelectedInput((current) =>
      restoreDeviceId(
        nextInputs,
        current || localStorage.getItem(INPUT_STORAGE_KEY),
      ),
    );
    setSelectedOutput((current) =>
      restoreDeviceId(
        nextOutputs,
        current || localStorage.getItem(OUTPUT_STORAGE_KEY),
      ),
    );
  }, []);

  useEffect(() => {
    let mounted = true;

    async function initialize() {
      const status = window.desktopApi
        ? await window.desktopApi.microphone.getStatus()
        : "unsupported";

      if (!mounted) return;
      setPermission(status);
      if (status === "granted") await loadDevices();
    }

    void initialize();
    return () => {
      mounted = false;
    };
  }, [loadDevices]);

  useEffect(() => {
    const handleDeviceChange = () => void loadDevices();
    navigator.mediaDevices?.addEventListener(
      "devicechange",
      handleDeviceChange,
    );

    return () => {
      navigator.mediaDevices?.removeEventListener(
        "devicechange",
        handleDeviceChange,
      );
      const active = activeAudio.current;
      active?.element.pause();
      if (active) URL.revokeObjectURL(active.objectUrl);
    };
  }, [loadDevices]);

  const requestMicrophone = async () => {
    try {
      const granted = window.desktopApi
        ? await window.desktopApi.microphone.request()
        : false;

      if (!granted) {
        setPermission("denied");
        setMessage(
          "Permission was not granted. Open macOS System Settings to try again.",
        );
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setPermission("granted");
      setMessage(
        "Permission granted. Select the physical mic and BlackHole output.",
      );
      await loadDevices();
    } catch {
      setPermission("denied");
      setMessage(
        "The microphone could not be opened. Check macOS privacy settings.",
      );
    }
  };

  const selectInput = (deviceId: string) => {
    setSelectedInput(deviceId);
    setTestState("idle");
    localStorage.setItem(INPUT_STORAGE_KEY, deviceId);
  };

  const selectOutput = (deviceId: string) => {
    setSelectedOutput(deviceId);
    setTestState("idle");
    localStorage.setItem(OUTPUT_STORAGE_KEY, deviceId);
  };

  const input = inputs.find((device) => device.deviceId === selectedInput);
  const output = outputs.find((device) => device.deviceId === selectedOutput);
  const warning = routingWarning(input, output);
  const routingReady =
    permission === "granted" && Boolean(input && output) && !warning;

  const stopTest = useCallback(() => {
    const active = activeAudio.current;
    if (active) {
      active.element.pause();
      active.element.currentTime = 0;
      active.element.removeAttribute("src");
      active.element.load();
      URL.revokeObjectURL(active.objectUrl);
      activeAudio.current = null;
    }

    setTestState("idle");
    setMessage("Test stopped. No buffered fixture audio remains.");
  }, []);

  const playTest = async () => {
    if (!routingReady || !selectedOutput) return;

    stopTest();
    const objectUrl = URL.createObjectURL(createThreeToneWavBlob());
    const audio = new Audio(objectUrl) as SinkSelectableAudio;
    activeAudio.current = { element: audio, objectUrl };

    try {
      if (!audio.setSinkId) {
        throw new Error(
          "Selected output routing is not supported by this runtime.",
        );
      }

      await audio.setSinkId(selectedOutput);
      audio.addEventListener(
        "ended",
        () => {
          URL.revokeObjectURL(objectUrl);
          activeAudio.current = null;
          setTestState("passed");
          setMessage(
            "Fixture completed. Confirm that the call app received three tones.",
          );
        },
        { once: true },
      );

      setTestState("playing");
      setMessage("Playing three test tones into the selected virtual output.");
      await audio.play();
    } catch (error) {
      audio.pause();
      URL.revokeObjectURL(objectUrl);
      activeAudio.current = null;
      setTestState("failed");
      setMessage(
        error instanceof Error ? error.message : "The routing test failed.",
      );
    }
  };

  const permissionReady = permission === "granted";
  const testStatus = useMemo(() => {
    if (testState === "playing") return "Test playing";
    if (testState === "passed") return "Playback completed";
    if (testState === "failed") return "Test failed";
    return routingReady ? "Ready to test" : "Setup required";
  }, [routingReady, testState]);

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">EPIC 0 · AUDIO ROUTING</p>
          <h1>Route audio with confidence.</h1>
          <p className="hero-copy">
            Select a physical microphone, send a deterministic fixture to
            BlackHole, then confirm that your meeting app receives it.
          </p>
        </div>
        <div className="platform-badge" aria-label="Target platform">
          <span className="apple-mark" aria-hidden>
            ⌘
          </span>
          <span>
            <strong>macOS Intel</strong>
            <small>First target</small>
          </span>
        </div>
      </header>

      <section className="status-strip" aria-label="System status">
        <div>
          <StatusDot ready={permissionReady} />
          <span>{permissionLabel(permission)}</span>
        </div>
        <div>
          <StatusDot ready={Boolean(output)} />
          <span>{output?.displayName || "Virtual output not selected"}</span>
        </div>
        <div>
          <StatusDot ready={routingReady} />
          <span>{testStatus}</span>
        </div>
      </section>

      <div className="workspace-grid">
        <section className="panel setup-panel" aria-labelledby="setup-heading">
          <div className="panel-heading">
            <div>
              <p className="section-label">01 · DEVICES</p>
              <h2 id="setup-heading">Audio setup</h2>
            </div>
            <span className="step-state">Local only</span>
          </div>

          {permission !== "granted" ? (
            <div className="permission-card">
              <div className="permission-icon" aria-hidden>
                🎙
              </div>
              <div>
                <h3>Allow microphone access</h3>
                <p>
                  Permission is used to discover audio devices. Raw microphone
                  audio is not routed during this test.
                </p>
              </div>
              <button className="primary-button" onClick={requestMicrophone}>
                Grant access
              </button>
            </div>
          ) : (
            <div className="device-form">
              <label>
                <span>Physical microphone</span>
                <select
                  value={selectedInput}
                  onChange={(event) => selectInput(event.target.value)}
                >
                  <option value="">Select microphone</option>
                  {inputs.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.displayName}
                    </option>
                  ))}
                </select>
                <small>
                  Captured by English Corrector, never sent directly to the
                  call.
                </small>
              </label>

              <label>
                <span>Virtual output</span>
                <select
                  value={selectedOutput}
                  onChange={(event) => selectOutput(event.target.value)}
                >
                  <option value="">Select output</option>
                  {outputs.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.displayName}
                    </option>
                  ))}
                </select>
                <small>Select BlackHole 2ch for the routing spike.</small>
              </label>
            </div>
          )}

          {warning && (
            <div className="warning-box" role="alert">
              {warning}
            </div>
          )}
        </section>

        <section className="panel route-panel" aria-labelledby="route-heading">
          <div className="panel-heading">
            <div>
              <p className="section-label">02 · SIGNAL PATH</p>
              <h2 id="route-heading">Routing preview</h2>
            </div>
          </div>

          <div className="route-map" aria-label="Audio route">
            <div className="route-node">
              <span className="node-icon" aria-hidden>
                ◉
              </span>
              <div>
                <strong>Physical mic</strong>
                <small>{input?.displayName || "Not selected"}</small>
              </div>
            </div>
            <div className="route-line">
              <span>Input</span>
            </div>
            <div className="route-node app-node">
              <span className="node-icon" aria-hidden>
                EC
              </span>
              <div>
                <strong>English Corrector</strong>
                <small>Fixture player</small>
              </div>
            </div>
            <div className="route-line">
              <span>Processed</span>
            </div>
            <div className="route-node">
              <span className="node-icon" aria-hidden>
                ◎
              </span>
              <div>
                <strong>Virtual mic</strong>
                <small>{output?.displayName || "Not selected"}</small>
              </div>
            </div>
          </div>

          <div className="call-targets" aria-label="Supported test targets">
            <span>Zoom</span>
            <span>Google Meet</span>
            <span>Discord</span>
          </div>
        </section>
      </div>

      <section className="test-console" aria-labelledby="test-heading">
        <div>
          <p className="section-label">03 · VERIFY</p>
          <h2 id="test-heading">Play a deterministic fixture</h2>
          <p aria-live="polite">{message}</p>
        </div>
        <div className="test-actions">
          {testState === "playing" ? (
            <button className="stop-button" onClick={stopTest}>
              Stop test
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={!routingReady}
              onClick={() => void playTest()}
            >
              Play three tones
            </button>
          )}
        </div>
      </section>

      <footer>
        <span>Raw microphone passthrough is off.</span>
        <span>Fixture audio stays on this Mac.</span>
      </footer>
    </main>
  );
}
