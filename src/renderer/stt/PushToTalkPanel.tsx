import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  restoreDeviceId,
  toDeviceChoices,
  type AudioDeviceChoice,
  type AudioDeviceDescriptor,
} from "../audio/deviceState";
import { StreamingWebAudioSink } from "../audio/webAudioSink";
import type { CorrectionProviderStatus } from "../../shared/correction";
import {
  createCorrectionPipeline,
  INITIAL_CORRECTION_SNAPSHOT,
  type CorrectionPipeline,
  type CorrectionSnapshot,
} from "../correction/correctionPipeline";
import { createCorrectionEngine } from "../correction/correctionEngine";
import { createFakeCorrector } from "../correction/fakeCorrector";
import { createIpcCorrectionAdapter } from "../correction/ipcCorrectionAdapter";
import {
  createCorrectedSpeechRelay,
  INITIAL_RELAY_PLAYBACK_SNAPSHOT,
  isRelayPlaybackBusy,
  type CorrectedSpeechRelay,
  type RelayPlaybackSnapshot,
} from "../relay/correctedSpeechRelay";
import {
  createRelayRouteResolver,
  DiagnosticRelaySink,
} from "../relay/relayRoute";
import type {
  PhraseEvent,
  StreamingTranscriber,
  TranscriptionSession,
} from "./contracts";
import { createDesktopTranscriber } from "./desktopTranscriber";
import { FakeStreamingTranscriber } from "./fakeTranscriber";
import {
  BrowserMicrophoneCapture,
  MicrophoneCaptureError,
  type MicrophoneCaptureSession,
} from "./microphoneCapture";
import { PushToTalkController } from "./phraseController";
import {
  INITIAL_TRANSCRIPT_STATE,
  reduceTranscript,
  speechEndToFinalMs,
  type TranscriptState,
} from "./transcriptReducer";

const INPUT_STORAGE_KEY = "english-corrector.input-device";

type ActivePhrase = {
  phraseId: string;
  abortController: AbortController;
  transcription: TranscriptionSession;
  capture: MicrophoneCaptureSession | null;
  pendingFinish: boolean;
  finishing: boolean;
};

/**
 * The desktop build streams audio to the configured provider. A browser
 * diagnostic, or a desktop build without a key, keeps the deterministic fake.
 */
function createTranscriber(): StreamingTranscriber {
  return createDesktopTranscriber({
    bridge: window.desktopApi?.stt,
    fallback: new FakeStreamingTranscriber(),
  });
}

function correctionStageLabel(snapshot: CorrectionSnapshot): string {
  switch (snapshot.phase) {
    case "correcting":
      return "Correcting";
    case "done":
      return snapshot.result?.outcome ?? "Safe fallback";
    case "skipped":
      return "Bypassed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Waiting for final";
  }
}

function correctionText(snapshot: CorrectionSnapshot): string {
  switch (snapshot.phase) {
    case "correcting":
      return "Checking grammar and semantic invariants.";
    case "done":
    case "skipped":
      return snapshot.spokenText;
    case "cancelled":
      return "Correction was cancelled before completion.";
    default:
      return "A final transcript will appear here after correction.";
  }
}

function relayStageLabel(snapshot: RelayPlaybackSnapshot): string {
  switch (snapshot.phase) {
    case "preparing":
      return "Preparing route";
    case "synthesizing":
      return "Synthesizing";
    case "buffering":
      return "Buffering";
    case "playing":
      return "Playing";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Relay failed";
    default:
      return "Waiting for correction";
  }
}

function relayStatusText(snapshot: RelayPlaybackSnapshot): string {
  switch (snapshot.phase) {
    case "preparing":
      return "Resolving the saved voice and virtual output.";
    case "synthesizing":
      return "Generating speech from the safe sentence.";
    case "buffering":
      return "Ordering audio chunks before playback.";
    case "playing":
      return "Streaming corrected speech once into the virtual output.";
    case "completed":
      return "Corrected speech completed without an automatic retry.";
    case "cancelled":
      return "TTS, buffer, and output were cancelled.";
    case "failed":
      if (snapshot.errorCode === "output_device_required") {
        return "Select BlackHole as the virtual output in Audio setup first.";
      }
      if (snapshot.errorCode === "provider_not_configured") {
        return "Configure Palabra or ElevenLabs, then restart the desktop app.";
      }
      if (snapshot.errorCode === "tts_voice_required") {
        return "Select a TTS voice before speaking.";
      }
      return "The relay failed safely and did not retry playback.";
    default:
      return "The next safe sentence will stream automatically after correction.";
  }
}

function relayElapsed(
  snapshot: RelayPlaybackSnapshot,
  end: "firstChunkAt" | "playbackStartedAt" | "playbackCompletedAt",
): string {
  const metrics = snapshot.metrics;
  const endValue = metrics?.[end];
  if (!metrics || typeof endValue !== "number") return "Pending";
  return `${Math.max(0, Math.round(endValue - metrics.requestStartedAt))} ms`;
}

function stageLabel(stage: TranscriptState["stage"]): string {
  switch (stage) {
    case "capturing":
      return "Listening";
    case "finalizing":
      return "Finalizing transcript";
    case "final":
      return "Final transcript ready";
    case "empty":
      return "No speech detected";
    case "cancelled":
      return "Phrase cancelled";
    case "failed":
      return "Capture failed";
    default:
      return "Ready for push-to-talk";
  }
}

function friendlyCaptureError(code?: string): string {
  switch (code) {
    case "microphone_permission_denied":
      return "Microphone permission was denied. Enable it in macOS System Settings.";
    case "microphone_not_found":
      return "The selected microphone is no longer available.";
    case "microphone_busy":
      return "The selected microphone is busy in another application.";
    case "microphone_unsupported":
      return "Microphone capture is unavailable in this environment.";
    case "provider_not_configured":
      return "Set ASSEMBLYAI_API_KEY to transcribe with the real provider.";
    case "provider_auth_error":
      return "The speech provider rejected the configured API key.";
    case "provider_rate_limited":
      return "The speech provider is rate limiting this account.";
    case "provider_request_error":
      return "The speech provider rejected the audio stream.";
    case "provider_timeout":
      return "The speech provider did not return a final transcript in time.";
    case "provider_unavailable":
      return "The speech provider could not be reached.";
    default:
      return "The microphone could not be opened safely.";
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName)
  );
}

export function PushToTalkPanel() {
  const [devices, setDevices] = useState<AudioDeviceChoice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [deviceMessage, setDeviceMessage] = useState(
    "Checking available microphones.",
  );
  const [transcript, setTranscript] = useState(INITIAL_TRANSCRIPT_STATE);
  const [level, setLevel] = useState(0);
  const [correctionEnabled, setCorrectionEnabled] = useState(true);
  const [correction, setCorrection] = useState<CorrectionSnapshot>(
    INITIAL_CORRECTION_SNAPSHOT,
  );
  const [providerStatus, setProviderStatus] =
    useState<CorrectionProviderStatus | null>(null);
  const [providerStatusFailed, setProviderStatusFailed] = useState(false);
  const [relay, setRelay] = useState<RelayPlaybackSnapshot>(
    INITIAL_RELAY_PLAYBACK_SNAPSHOT,
  );

  const mountedRef = useRef(true);
  const correctionPipelineRef = useRef<CorrectionPipeline | null>(null);
  if (!correctionPipelineRef.current) {
    const bridge = window.desktopApi?.correction;
    const adapter = bridge
      ? createIpcCorrectionAdapter(bridge)
      : createFakeCorrector({ type: "echo" });
    const engine = createCorrectionEngine({ adapter });
    correctionPipelineRef.current = createCorrectionPipeline({
      engine,
      onSnapshot: (snapshot) => {
        if (mountedRef.current) setCorrection(snapshot);
      },
    });
  }
  const relayRef = useRef<CorrectedSpeechRelay | null>(null);
  if (!relayRef.current) {
    const ttsBridge = window.desktopApi?.tts ?? null;
    relayRef.current = createCorrectedSpeechRelay({
      resolveRoute: createRelayRouteResolver({
        bridge: ttsBridge,
        storage: window.localStorage,
        enumerateDevices: async () =>
          navigator.mediaDevices?.enumerateDevices
            ? navigator.mediaDevices.enumerateDevices()
            : [],
      }),
      createSink: () =>
        ttsBridge ? new StreamingWebAudioSink() : new DiagnosticRelaySink(),
      onSnapshot: (snapshot) => {
        if (mountedRef.current) setRelay(snapshot);
      },
    });
  }
  const controllerRef = useRef(new PushToTalkController());
  const transcriberRef = useRef<StreamingTranscriber | null>(null);
  const captureFactoryRef = useRef(new BrowserMicrophoneCapture());
  const activeRef = useRef<ActivePhrase | null>(null);

  const applyPhraseEvent = useCallback((event: PhraseEvent) => {
    if (!mountedRef.current) return;
    setTranscript((current) => reduceTranscript(current, event));
    if (
      event.type === "final_transcript" ||
      event.type === "failed" ||
      event.type === "cancelled"
    ) {
      controllerRef.current.complete(event.phraseId);
    }
  }, []);

  const loadDevices = useCallback(async (requestPermission: boolean) => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDeviceMessage("Microphone enumeration is not available.");
      return;
    }

    setDeviceMessage(
      requestPermission
        ? "Requesting microphone permission."
        : "Refreshing microphones.",
    );

    try {
      if (requestPermission) {
        const desktopPermission = await window.desktopApi?.microphone.request();
        if (desktopPermission === false) {
          setDeviceMessage("Microphone permission was denied by macOS.");
          return;
        }
        const probe = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        for (const track of probe.getTracks()) track.stop();
      }

      const rawDevices = await navigator.mediaDevices.enumerateDevices();
      const descriptors: AudioDeviceDescriptor[] = rawDevices.map((device) => ({
        deviceId: device.deviceId,
        groupId: device.groupId,
        kind: device.kind,
        label: device.label,
      }));
      const nextDevices = toDeviceChoices(descriptors, "audioinput");
      setDevices(nextDevices);
      setSelectedDeviceId((current) => {
        const saved = localStorage.getItem(INPUT_STORAGE_KEY);
        return (
          restoreDeviceId(nextDevices, current || saved) ||
          nextDevices[0]?.deviceId ||
          ""
        );
      });
      setDeviceMessage(
        nextDevices.length
          ? `${nextDevices.length} microphone input${nextDevices.length === 1 ? "" : "s"} available.`
          : "No physical microphone was found.",
      );
    } catch (error) {
      const code =
        error instanceof MicrophoneCaptureError
          ? error.code
          : error instanceof Error && error.name === "NotAllowedError"
            ? "microphone_permission_denied"
            : "microphone_capture_failed";
      setDeviceMessage(friendlyCaptureError(code));
    }
  }, []);

  const finishResources = useCallback(
    async (active: ActivePhrase) => {
      if (active.finishing) return;
      active.finishing = true;
      try {
        await active.capture?.stop();
        setLevel(0);
        await active.transcription.finish();
      } catch (error) {
        if (
          !active.abortController.signal.aborted &&
          activeRef.current === active
        ) {
          applyPhraseEvent({
            type: "failed",
            phraseId: active.phraseId,
            code:
              error instanceof MicrophoneCaptureError
                ? error.code
                : "transcription_finalize_failed",
          });
        }
      } finally {
        if (activeRef.current === active) activeRef.current = null;
      }
    },
    [applyPhraseEvent],
  );

  const startPhrase = useCallback(async () => {
    if (
      correction.phase === "correcting" ||
      isRelayPlaybackBusy(relayRef.current?.snapshot() ?? relay)
    ) {
      return;
    }
    if (!selectedDeviceId) {
      setDeviceMessage("Select a physical microphone first.");
      return;
    }

    const started = controllerRef.current.press();
    if (!started) return;
    correctionPipelineRef.current?.cancel();
    relayRef.current?.cancel();
    setCorrection(INITIAL_CORRECTION_SNAPSHOT);
    setRelay(INITIAL_RELAY_PLAYBACK_SNAPSHOT);
    applyPhraseEvent(started);

    const transcriber = transcriberRef.current ?? createTranscriber();
    transcriberRef.current = transcriber;

    const abortController = new AbortController();
    const active: ActivePhrase = {
      phraseId: started.phraseId,
      abortController,
      transcription: transcriber.start({
        phraseId: started.phraseId,
        signal: abortController.signal,
        onEvent: applyPhraseEvent,
      }),
      capture: null,
      pendingFinish: false,
      finishing: false,
    };
    activeRef.current = active;

    try {
      const capture = await captureFactoryRef.current.start({
        phraseId: active.phraseId,
        deviceId: selectedDeviceId,
        onFrame: (frame) => active.transcription.write(frame),
        onLevel: (nextLevel) => {
          if (mountedRef.current && activeRef.current === active) {
            setLevel(nextLevel);
          }
        },
        onError: (error) => {
          if (activeRef.current !== active) return;
          applyPhraseEvent({
            type: "failed",
            phraseId: active.phraseId,
            code: error.code,
          });
          abortController.abort();
          active.transcription.cancel();
          activeRef.current = null;
          void active.capture?.stop();
          setLevel(0);
        },
      });

      if (activeRef.current !== active || abortController.signal.aborted) {
        await capture.stop();
        return;
      }

      active.capture = capture;
      if (active.pendingFinish) await finishResources(active);
    } catch (error) {
      if (activeRef.current !== active || abortController.signal.aborted)
        return;
      applyPhraseEvent({
        type: "failed",
        phraseId: active.phraseId,
        code:
          error instanceof MicrophoneCaptureError
            ? error.code
            : "microphone_capture_failed",
      });
      active.transcription.cancel();
      abortController.abort();
      activeRef.current = null;
      setLevel(0);
    }
  }, [
    applyPhraseEvent,
    correction.phase,
    finishResources,
    relay,
    selectedDeviceId,
  ]);

  const finishPhrase = useCallback(async () => {
    const ended = controllerRef.current.release();
    if (!ended) return;
    applyPhraseEvent(ended);

    const active = activeRef.current;
    if (!active || active.phraseId !== ended.phraseId) return;
    if (!active.capture) {
      active.pendingFinish = true;
      return;
    }
    await finishResources(active);
  }, [applyPhraseEvent, finishResources]);

  const cancelPhrase = useCallback(() => {
    const cancelled = controllerRef.current.cancel();
    const correctionWasActive =
      correctionPipelineRef.current?.snapshot().phase === "correcting";
    const relayWasActive = isRelayPlaybackBusy(
      relayRef.current?.snapshot() ?? relay,
    );
    correctionPipelineRef.current?.cancel();
    relayRef.current?.cancel();
    if (!cancelled && !correctionWasActive && !relayWasActive) return;
    if (cancelled) applyPhraseEvent(cancelled);

    const active = activeRef.current;
    activeRef.current = null;
    if (active) {
      active.abortController.abort();
      active.transcription.cancel();
      void active.capture?.stop();
    }
    setLevel(0);
  }, [applyPhraseEvent]);

  useEffect(() => {
    const bridge = window.desktopApi?.correction;
    if (!bridge) return;

    let active = true;
    void bridge
      .getStatus()
      .then((status) => {
        if (active) setProviderStatus(status);
      })
      .catch(() => {
        if (active) setProviderStatusFailed(true);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadDevices(false);

    const onDeviceChange = () => void loadDevices(false);
    navigator.mediaDevices?.addEventListener("devicechange", onDeviceChange);
    return () => {
      mountedRef.current = false;
      navigator.mediaDevices?.removeEventListener(
        "devicechange",
        onDeviceChange,
      );
      const active = activeRef.current;
      activeRef.current = null;
      active?.abortController.abort();
      active?.transcription.cancel();
      void active?.capture?.stop();
      correctionPipelineRef.current?.cancel();
      relayRef.current?.cancel();
    };
  }, [loadDevices]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.code !== "Space" ||
        event.repeat ||
        isEditableTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      void startPhrase();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space" || isEditableTarget(event.target)) return;
      event.preventDefault();
      void finishPhrase();
    };
    const onBlur = () => void finishPhrase();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [finishPhrase, startPhrase]);

  useEffect(() => {
    if (
      activeRef.current &&
      selectedDeviceId &&
      !devices.some((device) => device.deviceId === selectedDeviceId)
    ) {
      cancelPhrase();
      setDeviceMessage("The active microphone disappeared. Phrase cancelled.");
    }
  }, [cancelPhrase, devices, selectedDeviceId]);

  useEffect(() => {
    if (
      transcript.stage !== "final" ||
      !transcript.phraseId ||
      !transcript.finalText
    ) {
      return;
    }

    void correctionPipelineRef.current?.submit(
      transcript.phraseId,
      transcript.finalText,
    );
  }, [transcript.finalText, transcript.phraseId, transcript.stage]);

  useEffect(() => {
    void relayRef.current?.submit(correction);
  }, [correction]);

  const selectDevice = (deviceId: string) => {
    setSelectedDeviceId(deviceId);
    localStorage.setItem(INPUT_STORAGE_KEY, deviceId);
  };

  const latency = speechEndToFinalMs(transcript);
  const activeText =
    transcript.stage === "final"
      ? transcript.finalText
      : transcript.partialText ||
        (transcript.stage === "empty"
          ? "No speech was detected in this phrase."
          : "Hold Space or the button, then speak.");
  const isCapturing = transcript.stage === "capturing";
  const isFinalizing = transcript.stage === "finalizing";
  const isCorrecting = correction.phase === "correcting";
  const isRelaying = isRelayPlaybackBusy(relay);
  const correctionResult = correction.result;
  const correctionProviderMessage = providerStatusFailed
    ? "Correction provider status is unavailable. Unsafe output still falls back to the original."
    : providerStatus
      ? providerStatus.configured
        ? `${providerStatus.modelId} ready with a ${providerStatus.timeoutMs} ms deadline.`
        : `Provider is not configured. Missing: ${providerStatus.missing.join(", ")}.`
      : window.desktopApi?.correction
        ? "Checking the correction provider."
        : "Browser diagnostic uses the deterministic fake corrector.";
  const selectedDevice = useMemo(
    () => devices.find((device) => device.deviceId === selectedDeviceId),
    [devices, selectedDeviceId],
  );

  return (
    <section className="stt-shell" aria-labelledby="stt-heading">
      <div className="stt-panel">
        <header className="stt-heading">
          <div>
            <small>05 · EPIC 2 + 3 + 4 RELAY</small>
            <h2 id="stt-heading">Microphone to corrected speech</h2>
            <p>
              Audio capture stays local. Final text may go to the correction
              provider, then safe speech streams to the saved virtual output.
            </p>
          </div>
          <span className={`stt-stage stt-stage-${transcript.stage}`}>
            {stageLabel(transcript.stage)}
          </span>
        </header>

        <div className="stt-device-row">
          <label>
            <span>Physical microphone</span>
            <select
              value={selectedDeviceId}
              disabled={
                isCapturing || isFinalizing || isCorrecting || isRelaying
              }
              onChange={(event) => selectDevice(event.target.value)}
            >
              <option value="">Select microphone</option>
              {devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.displayName}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="stt-secondary-button"
            disabled={isCapturing || isFinalizing || isCorrecting || isRelaying}
            onClick={() => void loadDevices(true)}
          >
            Grant access and refresh
          </button>
        </div>
        <p className="stt-device-message">
          {selectedDevice
            ? `${selectedDevice.displayName} selected. ${deviceMessage}`
            : deviceMessage}
        </p>

        <div className="stt-meter" aria-label="Microphone level">
          <span style={{ width: `${Math.round(level * 100)}%` }} />
        </div>

        <div className="stt-transcript" aria-live="polite">
          <span>
            {transcript.stage === "final"
              ? "Final transcript"
              : "Live transcript"}
          </span>
          <p className={transcript.stage === "capturing" ? "is-partial" : ""}>
            {activeText}
          </p>
          <div className="stt-meta">
            <span>Phrase: {transcript.phraseId ?? "Pending"}</span>
            <span>Revision: {transcript.partialRevision}</span>
            <span>
              Confidence: {transcript.confidence?.toFixed(2) ?? "Pending"}
            </span>
            <span>
              Speech end to final:{" "}
              {latency === null ? "Pending" : `${latency} ms`}
            </span>
          </div>
        </div>

        <div className="stt-correction" aria-live="polite">
          <div className="stt-correction-heading">
            <div>
              <span>English correction</span>
              <p>Grammar and natural wording with semantic safety checks.</p>
            </div>
            <span
              className={`stt-correction-stage stt-correction-stage-${correction.phase}`}
            >
              {correctionStageLabel(correction)}
            </span>
          </div>

          <label className="stt-correction-toggle">
            <input
              type="checkbox"
              checked={correctionEnabled}
              disabled={
                isCapturing || isFinalizing || isCorrecting || isRelaying
              }
              onChange={(event) => {
                correctionPipelineRef.current?.setEnabled(event.target.checked);
                setCorrectionEnabled(event.target.checked);
              }}
            />
            <span>Correct grammar and natural wording</span>
          </label>
          <p className="stt-correction-provider">{correctionProviderMessage}</p>

          <div className="stt-correction-output">
            <span>Corrected sentence</span>
            <p>{correctionText(correction)}</p>
          </div>

          <div className="stt-correction-meta">
            <span>
              Outcome:{" "}
              {correctionResult?.outcome ??
                (correction.phase === "skipped" ? "bypassed" : "Pending")}
            </span>
            <span>
              Provider latency:{" "}
              {correctionResult?.providerLatencyMs === undefined
                ? "Pending"
                : `${correctionResult.providerLatencyMs} ms`}
            </span>
            <span>
              Prompt: {correctionResult?.promptVersion ?? "correction-v1"}
            </span>
            <span>
              Warnings:{" "}
              {correctionResult?.warnings.length
                ? correctionResult.warnings.join(", ")
                : "None"}
            </span>
          </div>

          <div className="stt-relay">
            <div className="stt-relay-heading">
              <div>
                <span>Corrected speech relay</span>
                <p>Automatic TTS handoff with one immutable output route.</p>
              </div>
              <span
                className={`stt-relay-stage stt-relay-stage-${relay.phase}`}
              >
                {relayStageLabel(relay)}
              </span>
            </div>
            <p className="stt-relay-message">{relayStatusText(relay)}</p>
            <div className="stt-relay-meta">
              <span>
                Provider:{" "}
                {relay.provider ??
                  (window.desktopApi?.tts ? "Pending" : "Diagnostic fake")}
              </span>
              <span>Voice: {relay.voiceLabel ?? "Pending"}</span>
              <span>Output: {relay.outputLabel ?? "Pending"}</span>
              <span>
                First audio: {relayElapsed(relay, "playbackStartedAt")}
              </span>
              <span>Total: {relayElapsed(relay, "playbackCompletedAt")}</span>
            </div>
          </div>
        </div>

        {transcript.stage === "failed" && (
          <p className="stt-error">
            {friendlyCaptureError(transcript.errorCode)}
          </p>
        )}

        <div className="stt-actions">
          <button
            type="button"
            className={`stt-talk-button ${isCapturing ? "is-active" : ""}`}
            disabled={
              !selectedDeviceId || isFinalizing || isCorrecting || isRelaying
            }
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              void startPhrase();
            }}
            onPointerUp={(event) => {
              event.preventDefault();
              void finishPhrase();
            }}
            onPointerCancel={cancelPhrase}
          >
            {isCapturing ? "Release to finalize" : "Hold to talk"}
            <small>Space</small>
          </button>
          <button
            type="button"
            className="stt-cancel-button"
            disabled={
              !isCapturing && !isFinalizing && !isCorrecting && !isRelaying
            }
            onClick={cancelPhrase}
          >
            Cancel phrase
          </button>
        </div>
      </div>
    </section>
  );
}
