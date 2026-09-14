import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  restoreDeviceId,
  toDeviceChoices,
  type AudioDeviceChoice,
  type AudioDeviceDescriptor,
} from "../audio/deviceState";
import type { PhraseEvent, TranscriptionSession } from "./contracts";
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

  const mountedRef = useRef(true);
  const controllerRef = useRef(new PushToTalkController());
  const transcriberRef = useRef(new FakeStreamingTranscriber());
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
    if (!selectedDeviceId) {
      setDeviceMessage("Select a physical microphone first.");
      return;
    }

    const started = controllerRef.current.press();
    if (!started) return;
    applyPhraseEvent(started);

    const abortController = new AbortController();
    const active: ActivePhrase = {
      phraseId: started.phraseId,
      abortController,
      transcription: transcriberRef.current.start({
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
  }, [applyPhraseEvent, finishResources, selectedDeviceId]);

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
    if (!cancelled) return;
    applyPhraseEvent(cancelled);

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
  const selectedDevice = useMemo(
    () => devices.find((device) => device.deviceId === selectedDeviceId),
    [devices, selectedDeviceId],
  );

  return (
    <section className="stt-shell" aria-labelledby="stt-heading">
      <div className="stt-panel">
        <header className="stt-heading">
          <div>
            <small>05 · EPIC 2 DIAGNOSTIC</small>
            <h2 id="stt-heading">Microphone to streaming transcript</h2>
            <p>
              Local microphone capture with deterministic fake STT. No audio or
              transcript leaves this Mac in this diagnostic slice.
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
              disabled={isCapturing || isFinalizing}
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
            disabled={isCapturing || isFinalizing}
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

        {transcript.stage === "failed" && (
          <p className="stt-error">
            {friendlyCaptureError(transcript.errorCode)}
          </p>
        )}

        <div className="stt-actions">
          <button
            type="button"
            className={`stt-talk-button ${isCapturing ? "is-active" : ""}`}
            disabled={!selectedDeviceId || isFinalizing}
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
            disabled={!isCapturing && !isFinalizing}
            onClick={cancelPhrase}
          >
            Cancel phrase
          </button>
        </div>
      </div>
    </section>
  );
}
