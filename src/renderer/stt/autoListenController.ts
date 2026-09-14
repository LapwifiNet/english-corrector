import {
  createPhraseId,
  type CapturedAudioFrame,
  type PhraseId,
  type StreamingTranscriber,
  type TranscriptionSession,
} from "./contracts";
import {
  createVoiceActivityDetector,
  type VoiceActivityOptions,
} from "./voiceActivity";

/** A session held open over silence still bills, so an idle one is closed. */
export const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
/** Playback leaking into the microphone must not be transcribed back. */
export const DEFAULT_PLAYBACK_TAIL_MS = 300;
/** Frames kept while waiting, so the first word survives the voice check. */
export const PREROLL_FRAMES = 12;

export type AutoListenState =
  "off" | "waiting" | "listening" | "playback" | "failed";

export type AutoListenUtterance = {
  phraseId: PhraseId;
  text: string;
  receivedAt: number;
  confidence?: number;
};

export type AutoListenDeps = {
  transcriber: StreamingTranscriber;
  onUtterance: (utterance: AutoListenUtterance) => void;
  onPartial?: (text: string) => void;
  onState?: (state: AutoListenState) => void;
  onError?: (code: string) => void;
  idleTimeoutMs?: number;
  playbackTailMs?: number;
  voiceActivity?: VoiceActivityOptions;
  now?: () => number;
};

export type AutoListenController = {
  start: () => void;
  stop: () => void;
  write: (frame: CapturedAudioFrame) => void;
  setPlayback: (playing: boolean, at?: number) => void;
  state: () => AutoListenState;
};

/**
 * Hands-free listening. One streaming session stays open and the provider
 * decides where each sentence ends, so no socket is opened per sentence.
 * Local voice activity has two jobs only: keeping our own playback out of the
 * stream, and letting an unused session go instead of paying for silence.
 */
export function createAutoListenController(
  deps: AutoListenDeps,
): AutoListenController {
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const playbackTailMs = deps.playbackTailMs ?? DEFAULT_PLAYBACK_TAIL_MS;
  const now = deps.now ?? (() => Date.now());
  const voice = createVoiceActivityDetector(deps.voiceActivity);
  const preroll: CapturedAudioFrame[] = [];

  let state: AutoListenState = "off";
  let session: TranscriptionSession | null = null;
  let sessionId: PhraseId | null = null;
  let running = false;
  let playing = false;
  let playbackEndedAt: number | null = null;
  let activeAt: number | null = null;

  function setState(next: AutoListenState): void {
    if (state === next) return;

    state = next;
    deps.onState?.(next);
  }

  function closeSession(reason: "finish" | "cancel"): void {
    const current = session;
    session = null;
    sessionId = null;
    voice.reset();
    preroll.length = 0;
    if (!current) return;

    if (reason === "finish") void current.finish();
    else current.cancel();
  }

  function openSession(at: number): void {
    if (session) return;

    const id = createPhraseId();
    const controller = new AbortController();
    const started = deps.transcriber.start({
      phraseId: id,
      mode: "continuous",
      signal: controller.signal,
      onEvent: (event) => {
        if (event.phraseId !== id) return;

        if (event.type === "partial_transcript") {
          deps.onPartial?.(event.text);
          return;
        }

        if (event.type === "final_transcript") {
          const text = event.text.trim();
          if (text.length === 0) return;

          deps.onUtterance({
            phraseId: `${id}:${event.utterance ?? 0}`,
            text,
            receivedAt: event.receivedAt,
            confidence: event.confidence,
          });
          return;
        }

        if (event.type === "failed") {
          closeSession("cancel");
          setState("failed");
          deps.onError?.(event.code);
        }
      },
    });

    session = started;
    sessionId = id;
    activeAt = at;
    setState("listening");

    for (const buffered of preroll.splice(0, preroll.length)) {
      started.write({ ...buffered, phraseId: id });
    }
  }

  function write(frame: CapturedAudioFrame): void {
    if (!running || state === "failed") return;

    const at = frame.capturedAt;
    const inPlaybackTail =
      playbackEndedAt !== null && at - playbackEndedAt < playbackTailMs;

    // The corrected sentence is spoken out loud. If the microphone hears it,
    // the corrector would keep correcting its own voice.
    if (playing || inPlaybackTail) {
      voice.reset();
      activeAt = at;
      return;
    }

    const status = voice.push(frame.samples, at);
    if (status.speaking) activeAt = at;

    if (!session) {
      preroll.push(frame);
      if (preroll.length > PREROLL_FRAMES) preroll.shift();
      if (status.speaking) openSession(at);
      return;
    }

    session.write({ ...frame, phraseId: sessionId ?? frame.phraseId });

    // Silence still has to reach the provider, otherwise it cannot close the
    // turn. Only a long absence of voice ends the session.
    if (activeAt !== null && at - activeAt >= idleTimeoutMs) {
      closeSession("finish");
      setState("waiting");
    }
  }

  function setPlayback(nextPlaying: boolean, at: number = now()): void {
    playing = nextPlaying;

    if (nextPlaying) {
      playbackEndedAt = null;
      voice.reset();
      activeAt = at;
      if (running) setState("playback");
      return;
    }

    playbackEndedAt = at;
    activeAt = at;
    if (running) setState(session ? "listening" : "waiting");
  }

  return {
    start: () => {
      if (running) return;

      running = true;
      playing = false;
      playbackEndedAt = null;
      voice.reset();
      preroll.length = 0;
      setState("waiting");
      openSession(now());
    },
    stop: () => {
      if (!running) return;

      running = false;
      playing = false;
      playbackEndedAt = null;
      closeSession("finish");
      setState("off");
    },
    write,
    setPlayback,
    state: () => state,
  };
}
