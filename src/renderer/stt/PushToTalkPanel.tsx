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
  isSpeakable,
  type CorrectionPipeline,
  type CorrectionSnapshot,
} from "../correction/correctionPipeline";
import { createCorrectionEngine } from "../correction/correctionEngine";
import { createSpeculativeCorrector } from "../correction/speculativeCorrector";
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
  createHoldSpeechPipeline,
  type HoldSpeechPipeline,
} from "../relay/holdSpeechPipeline";
import {
  createRelayRouteResolver,
  DiagnosticRelaySink,
} from "../relay/relayRoute";
import { runUtterance } from "../tts/runUtterance";
import type { PhraseEvent, StreamingTranscriber } from "./contracts";
import { createDesktopTranscriber } from "./desktopTranscriber";
import { FakeStreamingTranscriber } from "./fakeTranscriber";
import {
  BrowserMicrophoneCapture,
  MicrophoneCaptureError,
  type MicrophoneCaptureSession,
} from "./microphoneCapture";
import {
  INITIAL_TRANSCRIPT_STATE,
  reduceTranscript,
  speechEndToFinalMs,
  type TranscriptState,
} from "./transcriptReducer";

const INPUT_STORAGE_KEY = "english-corrector.input-device";

/**
 * About 85 ms of 24 kHz PCM. Enough to absorb stream jitter, short enough
 * that playback starts almost as soon as the first chunk lands.
 */
const PREBUFFER_BYTES = 4_096;

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

/**
 * A hold now carries several phrases, so a finished phrase no longer means
 * the key came up. While the key is down, a settled phrase reads as progress.
 */
function holdStageLabel(state: TranscriptState, holding: boolean): string {
  if (holding && (state.stage === "final" || state.stage === "empty")) {
    return "Listening for the next sentence";
  }
  return stageLabel(state.stage);
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
  const [holding, setHolding] = useState(false);
  const [spokenPhrases, setSpokenPhrases] = useState(0);
  const [congested, setCongested] = useState(false);
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
  const transcriberRef = useRef<StreamingTranscriber | null>(null);
  const captureFactoryRef = useRef(new BrowserMicrophoneCapture());
  const captureRef = useRef<MicrophoneCaptureSession | null>(null);
  const pendingStopRef = useRef(false);
  const correctionPipelineRef = useRef<CorrectionPipeline | null>(null);
  if (!correctionPipelineRef.current) {
    const bridge = window.desktopApi?.correction;
    const adapter = bridge
      ? createIpcCorrectionAdapter(bridge)
      : createFakeCorrector({ type: "echo" });
    const engine = createCorrectionEngine({ adapter });
    correctionPipelineRef.current = createCorrectionPipeline({
      engine,
      // The guess starts while the speaker is still talking, so the answer
      // is usually already on its way when the sentence closes.
      speculator: createSpeculativeCorrector({ engine }),
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
      run: (options) =>
        runUtterance({ ...options, prebufferBytes: PREBUFFER_BYTES }),
      onSnapshot: (snapshot) => {
        if (mountedRef.current) setRelay(snapshot);
      },
    });
  }

  /**
   * One hold, one provider session, and as many phrases as the speaker
   * finishes while holding. Correction and playback run per phrase through
   * the ordered queue, so speech starts before the key comes up.
   */
  const holdPipelineRef = useRef<HoldSpeechPipeline | null>(null);
  if (!holdPipelineRef.current) {
    holdPipelineRef.current = createHoldSpeechPipeline<CorrectionSnapshot>({
      // Still built on the first hold, so a browser diagnostic never
      // reaches for the desktop bridge before it is needed.
      transcriber: {
        start: (request) => {
          const transcriber = transcriberRef.current ?? createTranscriber();
          transcriberRef.current = transcriber;
          return transcriber.start(request);
        },
      },
      prepare: async (phrase) => {
        const snapshot = await correctionPipelineRef.current?.submit(
          phrase.phraseId,
          phrase.text,
        );
        if (!snapshot || snapshot.phraseId !== phrase.phraseId) return null;
        return isSpeakable(snapshot) ? snapshot : null;
      },
      play: async (snapshot, _phrase, signal) => {
        const relayPipeline = relayRef.current;
        if (!relayPipeline || signal.aborted) return;

        const stopVoice = () =>
          relayPipeline.cancel(snapshot.phraseId ?? undefined);
        signal.addEventListener("abort", stopVoice, { once: true });
        if (mountedRef.current) setSpokenPhrases((count) => count + 1);
        try {
          await relayPipeline.submit(snapshot);
        } finally {
          signal.removeEventListener("abort", stopVoice);
        }
      },
      onEvent: (event) => {
        if (!mountedRef.current) return;
        setTranscript((current) => reduceTranscript(current, event));
        if (event.type === "partial_transcript") {
          correctionPipelineRef.current?.prewarm(event.phraseId, event.text);
        }
        // The pipeline ends the hold itself when the provider fails.
        if (event.type === "failed") setHolding(false);
      },
      onCongestion: (value) => {
        if (mountedRef.current) setCongested(value);
      },
    });
  }

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

  const beginHold = useCallback(async () => {
    const pipeline = holdPipelineRef.current;
    if (!pipeline || pipeline.snapshot().holding) return;
    if (!selectedDeviceId) {
      setDeviceMessage("Select a physical microphone first.");
      return;
    }

    // A new hold supersedes whatever the previous one was still speaking.
    pipeline.cancel();
    correctionPipelineRef.current?.cancel();
    relayRef.current?.cancel();
    setCorrection(INITIAL_CORRECTION_SNAPSHOT);
    setRelay(INITIAL_RELAY_PLAYBACK_SNAPSHOT);
    setSpokenPhrases(0);
    setCongested(false);

    const sessionId = pipeline.press();
    if (!sessionId) return;
    pendingStopRef.current = false;
    setHolding(true);

    const isCurrent = () => pipeline.snapshot().sessionId === sessionId;
    const failHold = (failure: PhraseEvent) => {
      setTranscript((current) => reduceTranscript(current, failure));
      pipeline.cancel();
      setHolding(false);
      setLevel(0);
    };

    try {
      const capture = await captureFactoryRef.current.start({
        phraseId: sessionId,
        deviceId: selectedDeviceId,
        onFrame: (frame) => pipeline.write(frame),
        onLevel: (nextLevel) => {
          if (mountedRef.current && isCurrent()) setLevel(nextLevel);
        },
        onError: (error) => {
          if (!isCurrent()) return;
          const active = captureRef.current;
          captureRef.current = null;
          void active?.stop();
          failHold({
            type: "failed",
            phraseId: pipeline.snapshot().openPhraseId ?? sessionId,
            code: error.code,
          });
        },
      });

      if (!isCurrent()) {
        await capture.stop();
        return;
      }

      captureRef.current = capture;
      // The key came back up while the microphone was still opening.
      if (pendingStopRef.current) {
        pendingStopRef.current = false;
        captureRef.current = null;
        await capture.stop();
        setLevel(0);
      }
    } catch (error) {
      if (!isCurrent()) return;
      failHold({
        type: "failed",
        phraseId: pipeline.snapshot().openPhraseId ?? sessionId,
        code:
          error instanceof MicrophoneCaptureError
            ? error.code
            : "microphone_capture_failed",
      });
    }
  }, [selectedDeviceId]);

  const endHold = useCallback(async () => {
    const pipeline = holdPipelineRef.current;
    if (!pipeline || !pipeline.snapshot().holding) return;

    const capture = captureRef.current;
    captureRef.current = null;
    if (capture) {
      await capture.stop();
    } else {
      pendingStopRef.current = true;
    }
    setLevel(0);
    setHolding(false);
    // Flushes the provider, then waits for the last phrase to be spoken.
    await pipeline.release();
  }, []);

  const cancelHold = useCallback(() => {
    const capture = captureRef.current;
    captureRef.current = null;
    pendingStopRef.current = true;
    void capture?.stop();
    holdPipelineRef.current?.cancel();
    correctionPipelineRef.current?.cancel();
    relayRef.current?.cancel();
    setHolding(false);
    setLevel(0);
  }, []);

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
      const capture = captureRef.current;
      captureRef.current = null;
      void capture?.stop();
      holdPipelineRef.current?.cancel();
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
      void beginHold();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space" || isEditableTarget(event.target)) return;
      event.preventDefault();
      void endHold();
    };
    const onBlur = () => void endHold();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [beginHold, endHold]);

  useEffect(() => {
    if (
      holdPipelineRef.current?.snapshot().holding &&
      selectedDeviceId &&
      !devices.some((device) => device.deviceId === selectedDeviceId)
    ) {
      cancelHold();
      setDeviceMessage("The active microphone disappeared. Hold cancelled.");
    }
  }, [cancelHold, devices, selectedDeviceId]);

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
          : "Hold Space or the button, then keep talking.");
  const isFinalizing = transcript.stage === "finalizing";
  const isCorrecting = correction.phase === "correcting";
  const isRelaying = isRelayPlaybackBusy(relay);
  const isBusy = holding || isFinalizing || isCorrecting || isRelaying;
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
              Audio capture stays local. Every sentence you finish while holding
              is corrected and spoken, so the voice starts before the key is up.
            </p>
          </div>
          <span className={`stt-stage stt-stage-${transcript.stage}`}>
            {holdStageLabel(transcript, holding)}
          </span>
        </header>

        <div className="stt-device-row">
          <label>
            <span>Physical microphone</span>
            <select
              value={selectedDeviceId}
              disabled={isBusy}
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
            disabled={isBusy}
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
            <span>Spoken this hold: {spokenPhrases}</span>
            <span>Queue: {congested ? "Behind" : "Keeping up"}</span>
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
              disabled={isBusy}
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
            className={`stt-talk-button ${holding ? "is-active" : ""}`}
            disabled={!selectedDeviceId}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              void beginHold();
            }}
            onPointerUp={(event) => {
              event.preventDefault();
              void endHold();
            }}
            onPointerCancel={cancelHold}
          >
            {holding ? "Keep talking, release when done" : "Hold to talk"}
            <small>Space</small>
          </button>
          <button
            type="button"
            className="stt-cancel-button"
            disabled={!isBusy}
            onClick={cancelHold}
          >
            Cancel phrase
          </button>
        </div>
      </div>
    </section>
  );
}
