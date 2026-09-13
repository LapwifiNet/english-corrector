import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MicrophonePermissionStatus } from "../shared/audio";
import {
  restoreDeviceId,
  routingWarning,
  toDeviceChoices,
  type AudioDeviceChoice,
  type AudioDeviceDescriptor,
} from "./audio/deviceState";
import { createThreeToneWavBlob } from "./audio/testFixture";
import { StreamingWebAudioSink } from "./audio/webAudioSink";
import type {
  PipelineSnapshot,
  UtteranceMetrics,
  UtteranceStage,
} from "./tts/contracts";
import { createUtteranceId } from "./tts/contracts";
import { FakeTtsAdapter } from "./tts/fakeTtsAdapter";
import { runUtterance } from "./tts/runUtterance";

type TestState = "idle" | "playing" | "passed" | "failed";

type SinkSelectableAudio = HTMLAudioElement & {
  setSinkId?: (deviceId: string) => Promise<void>;
};

const INPUT_STORAGE_KEY = "english-corrector.input-device";
const OUTPUT_STORAGE_KEY = "english-corrector.output-device";
const DEFAULT_DIAGNOSTIC_TEXT =
  "Hello. This is the English Corrector streaming audio diagnostic.";
const PIPELINE_STAGES: UtteranceStage[] = [
  "synthesizing",
  "buffering",
  "playing",
  "completed",
];

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

function pipelineLabel(stage: UtteranceStage, outputReady: boolean): string {
  switch (stage) {
    case "synthesizing":
      return "Synthesizing diagnostic audio";
    case "buffering":
      return "Buffering ordered chunks";
    case "playing":
      return "Streaming to virtual output";
    case "completed":
      return "Last stream completed";
    case "cancelled":
      return "Last stream cancelled";
    case "failed":
      return "Last stream failed";
    default:
      return outputReady ? "Ready for text diagnostic" : "Setup required";
  }
}

function friendlyPipelineError(code?: string): string {
  switch (code) {
    case "invalid_text":
      return "Enter a sentence before starting synthesis.";
    case "output_device_required":
      return "Select a virtual output before starting.";
    case "output_device_error":
      return "The selected output could not play the stream.";
    case "buffer_overflow":
      return "The audio buffer reached its safety limit.";
    case "chunk_sequence_gap":
      return "A streaming audio chunk did not arrive.";
    case "unsupported_audio_format":
      return "The synthesizer returned an unsupported audio format.";
    default:
      return "The diagnostic stream failed safely. No automatic retry was made.";
  }
}

function elapsed(
  metrics: UtteranceMetrics | null,
  end: keyof UtteranceMetrics,
): string {
  if (!metrics) return "Pending";
  const endValue = metrics[end];
  if (typeof endValue !== "number") return "Pending";
  return `${Math.max(0, Math.round(endValue - metrics.requestStartedAt))} ms`;
}

function stageClass(current: UtteranceStage, item: UtteranceStage): string {
  if (current === item) return "pipeline-stage active";
  if (current === "completed") return "pipeline-stage done";

  const currentIndex = PIPELINE_STAGES.indexOf(current);
  const itemIndex = PIPELINE_STAGES.indexOf(item);
  if (currentIndex > itemIndex && itemIndex >= 0) return "pipeline-stage done";
  return "pipeline-stage";
}

function StatusDot({ ready }: { ready: boolean }) {
  return (
    <span className={ready ? "status-dot ready" : "status-dot"} aria-hidden />
  );
}

export function App() {
  const ttsAdapter = useMemo(() => new FakeTtsAdapter(), []);
  const voices = ttsAdapter.listVoices();
  const [permission, setPermission] =
    useState<MicrophonePermissionStatus>("unknown");
  const [inputs, setInputs] = useState<AudioDeviceChoice[]>([]);
  const [outputs, setOutputs] = useState<AudioDeviceChoice[]>([]);
  const [selectedInput, setSelectedInput] = useState("");
  const [selectedOutput, setSelectedOutput] = useState("");
  const [testState, setTestState] = useState<TestState>("idle");
  const [testMessage, setTestMessage] = useState(
    "Use the three-tone fixture for a quick routing check.",
  );
  const [diagnosticText, setDiagnosticText] = useState(DEFAULT_DIAGNOSTIC_TEXT);
  const [voiceId, setVoiceId] = useState(voices[0]?.id ?? "");
  const [pipelineStage, setPipelineStage] = useState<UtteranceStage>("idle");
  const [pipelineMetrics, setPipelineMetrics] =
    useState<UtteranceMetrics | null>(null);
  const [bufferedBytes, setBufferedBytes] = useState(0);
  const [pipelineMessage, setPipelineMessage] = useState(
    "Enter text to exercise the streaming contract with deterministic PCM.",
  );
  const activeFixture = useRef<{
    element: SinkSelectableAudio;
    objectUrl: string;
  } | null>(null);
  const utteranceController = useRef<AbortController | null>(null);
  const utteranceSink = useRef<StreamingWebAudioSink | null>(null);
  const utteranceOutput = useRef<string | null>(null);

  const pipelineBusy = ["synthesizing", "buffering", "playing"].includes(
    pipelineStage,
  );

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

    if (
      utteranceOutput.current &&
      !nextOutputs.some((device) => device.deviceId === utteranceOutput.current)
    ) {
      utteranceController.current?.abort();
      void utteranceSink.current?.stop();
      setPipelineMessage(
        "The active output disappeared. The stream was cancelled safely.",
      );
    }

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
      utteranceController.current?.abort();
      void utteranceSink.current?.stop();
      const fixture = activeFixture.current;
      fixture?.element.pause();
      if (fixture) URL.revokeObjectURL(fixture.objectUrl);
    };
  }, [loadDevices]);

  const requestMicrophone = async () => {
    try {
      const granted = window.desktopApi
        ? await window.desktopApi.microphone.request()
        : false;

      if (!granted) {
        setPermission("denied");
        setTestMessage(
          "Permission was not granted. Open macOS System Settings to try again.",
        );
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setPermission("granted");
      setTestMessage(
        "Permission granted. Select the physical mic and BlackHole output.",
      );
      await loadDevices();
    } catch {
      setPermission("denied");
      setTestMessage(
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
    setPipelineStage("idle");
    setPipelineMetrics(null);
    localStorage.setItem(OUTPUT_STORAGE_KEY, deviceId);
  };

  const input = inputs.find((device) => device.deviceId === selectedInput);
  const output = outputs.find((device) => device.deviceId === selectedOutput);
  const warning = routingWarning(input, output);
  const fixtureReady =
    permission === "granted" && Boolean(input && output) && !warning;
  const textOutputReady = permission === "granted" && Boolean(output);

  const stopFixture = useCallback(() => {
    const fixture = activeFixture.current;
    if (fixture) {
      fixture.element.pause();
      fixture.element.currentTime = 0;
      fixture.element.removeAttribute("src");
      fixture.element.load();
      URL.revokeObjectURL(fixture.objectUrl);
      activeFixture.current = null;
    }

    setTestState("idle");
    setTestMessage("Fixture stopped. No buffered fixture audio remains.");
  }, []);

  const playFixture = async () => {
    if (!fixtureReady || !selectedOutput || pipelineBusy) return;

    stopFixture();
    const objectUrl = URL.createObjectURL(createThreeToneWavBlob());
    const audio = new Audio(objectUrl) as SinkSelectableAudio;
    activeFixture.current = { element: audio, objectUrl };

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
          activeFixture.current = null;
          setTestState("passed");
          setTestMessage(
            "Fixture completed. Confirm that the call app received three tones.",
          );
        },
        { once: true },
      );

      setTestState("playing");
      setTestMessage("Playing three test tones into the selected output.");
      await audio.play();
    } catch (error) {
      audio.pause();
      URL.revokeObjectURL(objectUrl);
      activeFixture.current = null;
      setTestState("failed");
      setTestMessage(
        error instanceof Error ? error.message : "The routing test failed.",
      );
    }
  };

  const updatePipeline = (snapshot: PipelineSnapshot) => {
    setPipelineStage(snapshot.stage);
    setPipelineMetrics(snapshot.metrics);
    setBufferedBytes(snapshot.bufferedBytes);

    if (snapshot.stage === "synthesizing") {
      setPipelineMessage("Synthesizer request started.");
    } else if (snapshot.stage === "buffering") {
      setPipelineMessage("Ordering chunks and filling the startup buffer.");
    } else if (snapshot.stage === "playing") {
      setPipelineMessage(
        "Audio is streaming once into the selected virtual output.",
      );
    } else if (snapshot.stage === "failed") {
      setPipelineMessage(friendlyPipelineError(snapshot.errorCode));
    }
  };

  const startDiagnostic = async () => {
    if (pipelineBusy) return;
    if (!diagnosticText.trim()) {
      setPipelineStage("failed");
      setPipelineMessage("Enter a sentence before starting synthesis.");
      return;
    }
    if (!textOutputReady || !selectedOutput) {
      setPipelineStage("failed");
      setPipelineMessage("Select a virtual output before starting.");
      return;
    }

    stopFixture();
    const controller = new AbortController();
    const sink = new StreamingWebAudioSink();
    utteranceController.current = controller;
    utteranceSink.current = sink;
    utteranceOutput.current = selectedOutput;
    setPipelineMetrics(null);
    setBufferedBytes(0);
    setPipelineStage("synthesizing");
    setPipelineMessage("Starting deterministic streaming synthesis.");

    const result = await runUtterance({
      adapter: ttsAdapter,
      request: {
        utteranceId: createUtteranceId(),
        text: diagnosticText,
        voiceId,
      },
      sink,
      outputDeviceId: selectedOutput,
      signal: controller.signal,
      onSnapshot: updatePipeline,
    });

    if (utteranceController.current !== controller) return;
    utteranceController.current = null;
    utteranceSink.current = null;
    utteranceOutput.current = null;
    setPipelineMetrics(result.metrics);
    setBufferedBytes(0);
    setPipelineStage(result.stage);

    if (result.stage === "completed") {
      setPipelineMessage(
        "Diagnostic stream completed once. Confirm it arrived in the call app.",
      );
    } else if (result.stage === "cancelled") {
      setPipelineMessage("Request, buffer, and output were cancelled safely.");
    } else {
      setPipelineMessage(friendlyPipelineError(result.errorCode));
    }
  };

  const cancelDiagnostic = () => {
    if (!utteranceController.current) return;
    setPipelineMessage("Cancelling request, buffer, and output.");
    utteranceController.current.abort();
    void utteranceSink.current?.stop();
  };

  const permissionReady = permission === "granted";
  const controlsLocked = pipelineBusy || testState === "playing";

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">EPIC 1 · STREAMING TTS DIAGNOSTIC</p>
          <h1>Stream text into your virtual mic.</h1>
          <p className="hero-copy">
            Exercise an ordered, cancellable audio pipeline before connecting a
            production speech provider.
          </p>
        </div>
        <div className="platform-badge" aria-label="Target platform">
          <span className="apple-mark" aria-hidden>
            ⌘
          </span>
          <span>
            <strong>macOS Intel</strong>
            <small>Epic 0 verified</small>
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
          <StatusDot ready={pipelineStage === "completed" || textOutputReady} />
          <span>{pipelineLabel(pipelineStage, textOutputReady)}</span>
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
                  Permission discovers audio devices. Raw microphone audio is
                  not routed during this diagnostic.
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
                  disabled={controlsLocked}
                  onChange={(event) => selectInput(event.target.value)}
                >
                  <option value="">Select microphone</option>
                  {inputs.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.displayName}
                    </option>
                  ))}
                </select>
                <small>Reserved for the upcoming capture pipeline.</small>
              </label>

              <label>
                <span>Virtual output</span>
                <select
                  value={selectedOutput}
                  disabled={controlsLocked}
                  onChange={(event) => selectOutput(event.target.value)}
                >
                  <option value="">Select output</option>
                  {outputs.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.displayName}
                    </option>
                  ))}
                </select>
                <small>Select BlackHole 2ch for the streaming test.</small>
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
                TXT
              </span>
              <div>
                <strong>Diagnostic text</strong>
                <small>{diagnosticText.trim() || "No text entered"}</small>
              </div>
            </div>
            <div className="route-line">
              <span>Streamed PCM</span>
            </div>
            <div className="route-node app-node">
              <span className="node-icon" aria-hidden>
                EC
              </span>
              <div>
                <strong>Ordered audio pipeline</strong>
                <small>48 kHz stereo internal format</small>
              </div>
            </div>
            <div className="route-line">
              <span>One playback</span>
            </div>
            <div className="route-node">
              <span className="node-icon" aria-hidden>
                OUT
              </span>
              <div>
                <strong>Virtual microphone</strong>
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

      <section className="speech-lab" aria-labelledby="speech-heading">
        <div className="speech-editor">
          <div className="panel-heading">
            <div>
              <p className="section-label">03 · TEXT TO AUDIO</p>
              <h2 id="speech-heading">Streaming diagnostic</h2>
            </div>
            <span className="step-state diagnostic">Fake adapter</span>
          </div>

          <label className="text-field">
            <span>English sentence</span>
            <textarea
              value={diagnosticText}
              maxLength={280}
              disabled={pipelineBusy}
              onChange={(event) => setDiagnosticText(event.target.value)}
            />
            <small>{diagnosticText.length} / 280 characters</small>
          </label>

          <div className="speech-controls">
            <label>
              <span>Voice</span>
              <select
                value={voiceId}
                disabled={pipelineBusy}
                onChange={(event) => setVoiceId(event.target.value)}
              >
                {voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="button-group">
              <button
                className="primary-button"
                disabled={
                  pipelineBusy ||
                  testState === "playing" ||
                  !textOutputReady ||
                  !diagnosticText.trim()
                }
                onClick={() => void startDiagnostic()}
              >
                Send to virtual mic
              </button>
              <button
                className="cancel-button"
                disabled={!pipelineBusy}
                onClick={cancelDiagnostic}
              >
                Cancel
              </button>
            </div>
          </div>

          <div className="diagnostic-note">
            <strong>Diagnostic audio only.</strong> This adapter maps text to
            deterministic speech-like PCM tones. A natural voice provider is the
            next integration.
          </div>
        </div>

        <aside className="pipeline-monitor" aria-label="Streaming status">
          <div className="monitor-heading">
            <div>
              <p className="section-label">LIVE PIPELINE</p>
              <h2>Stream monitor</h2>
            </div>
            <span className={`live-indicator ${pipelineBusy ? "on" : ""}`}>
              {pipelineBusy ? "Live" : "Idle"}
            </span>
          </div>

          <div className="pipeline-stages">
            {PIPELINE_STAGES.map((item, index) => (
              <div className={stageClass(pipelineStage, item)} key={item}>
                <span>{index + 1}</span>
                <strong>{item}</strong>
              </div>
            ))}
          </div>

          <p className="pipeline-message" aria-live="polite">
            {pipelineMessage}
          </p>

          <div className="metric-grid">
            <div>
              <small>First chunk</small>
              <strong>{elapsed(pipelineMetrics, "firstChunkAt")}</strong>
            </div>
            <div>
              <small>First audio</small>
              <strong>{elapsed(pipelineMetrics, "playbackStartedAt")}</strong>
            </div>
            <div>
              <small>Total</small>
              <strong>{elapsed(pipelineMetrics, "playbackCompletedAt")}</strong>
            </div>
          </div>

          <div className="buffer-line">
            <span>Buffered</span>
            <strong>{(bufferedBytes / 1_024).toFixed(1)} KB</strong>
          </div>
        </aside>
      </section>

      <section className="test-console" aria-labelledby="test-heading">
        <div>
          <p className="section-label">04 · ROUTE CHECK</p>
          <h2 id="test-heading">Keep the known-good fixture</h2>
          <p aria-live="polite">{testMessage}</p>
        </div>
        <div className="test-actions">
          {testState === "playing" ? (
            <button className="stop-button" onClick={stopFixture}>
              Stop fixture
            </button>
          ) : (
            <button
              className="secondary-button"
              disabled={!fixtureReady || pipelineBusy}
              onClick={() => void playFixture()}
            >
              Play three tones
            </button>
          )}
        </div>
      </section>

      <footer>
        <span>Raw microphone passthrough is off.</span>
        <span>No text or audio leaves this Mac in diagnostic mode.</span>
      </footer>
    </main>
  );
}
