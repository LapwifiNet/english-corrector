import type {
  CapturedAudioFrame,
  PhraseEvent,
  StartTranscriptionRequest,
  StreamingTranscriber,
  TranscriptionSession,
} from "./contracts";

export type FakeTranscriptScript = {
  partials: readonly string[];
  final: string;
  confidence: number;
};

type Delay = (milliseconds: number, signal: AbortSignal) => Promise<void>;
type Clock = () => number;

export const DEFAULT_FAKE_TRANSCRIPT: FakeTranscriptScript = {
  partials: [
    "I need",
    "I need to check",
    "I need to check the order number 4821",
  ],
  final: "I need to check the order number 4821.",
  confidence: 0.96,
};

/**
 * Silence that closes a sentence inside a continuous session. The real
 * provider does this with its own turn detection; the fake only has to land
 * a final while the key is still held, so a diagnostic build without an API
 * key still speaks before release.
 */
export const FAKE_CONTINUOUS_SILENCE_MS = 400;

function abortError(): Error {
  const error = new Error("The transcription was cancelled.");
  error.name = "AbortError";
  return error;
}

export function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

export function frameRms(frame: CapturedAudioFrame): number {
  if (!frame.samples.length) return 0;
  let squared = 0;
  for (const sample of frame.samples) squared += sample * sample;
  return Math.sqrt(squared / frame.samples.length);
}

export class FakeStreamingTranscriber implements StreamingTranscriber {
  constructor(
    private readonly script: FakeTranscriptScript = DEFAULT_FAKE_TRANSCRIPT,
    private readonly delay: Delay = abortableDelay,
    private readonly clock: Clock = () => Date.now(),
  ) {}

  start(request: StartTranscriptionRequest): TranscriptionSession {
    const { phraseId, signal, onEvent } = request;
    const continuous = request.mode === "continuous";
    let closed = false;
    let finishing: Promise<void> | null = null;
    let lastSequence = -1;
    let voicedFrames = 0;
    let nextPartial = 0;
    let utterance = 0;
    let lastVoiceAt: number | null = null;

    const emit = (event: PhraseEvent) => {
      if (!closed && !signal.aborted) onEvent(event);
    };

    const emitAvailablePartial = () => {
      const text = this.script.partials[nextPartial];
      if (!text || voicedFrames < nextPartial + 1) return;
      nextPartial += 1;
      emit({
        type: "partial_transcript",
        phraseId,
        revision: nextPartial,
        text,
      });
    };

    const flushPartials = () => {
      while (nextPartial < this.script.partials.length) {
        voicedFrames = Math.max(voicedFrames, nextPartial + 1);
        emitAvailablePartial();
      }
    };

    const emitFinal = (receivedAt: number) => {
      const spoke = voicedFrames > 0;
      emit({
        type: "final_transcript",
        phraseId,
        text: spoke ? this.script.final : "",
        confidence: spoke ? this.script.confidence : undefined,
        receivedAt,
        utterance: continuous ? utterance : undefined,
      });
    };

    /**
     * One sentence per breath. The words repeat because the script holds a
     * single sentence; what matters is that the final arrives mid hold.
     */
    const closeSentenceOnSilence = (at: number) => {
      if (voicedFrames === 0 || lastVoiceAt === null) return;
      if (at - lastVoiceAt < FAKE_CONTINUOUS_SILENCE_MS) return;

      flushPartials();
      emitFinal(at);
      utterance += 1;
      voicedFrames = 0;
      nextPartial = 0;
      lastVoiceAt = null;
    };

    return {
      write: (frame) => {
        if (closed || signal.aborted || frame.phraseId !== phraseId) return;
        if (frame.sequence <= lastSequence) return;
        lastSequence = frame.sequence;
        if (frameRms(frame) < 0.01) {
          if (continuous) closeSentenceOnSilence(frame.capturedAt);
          return;
        }
        lastVoiceAt = frame.capturedAt;
        voicedFrames += 1;
        emitAvailablePartial();
      },
      finish: () => {
        if (finishing) return finishing;
        finishing = (async () => {
          if (closed || signal.aborted) return;

          // A continuous session that already reported every sentence has
          // nothing left to flush, so it must not add an empty turn.
          if (continuous && voicedFrames === 0 && utterance > 0) {
            closed = true;
            return;
          }

          if (voicedFrames > 0) flushPartials();

          try {
            await this.delay(80, signal);
          } catch (error) {
            if ((error as Error).name === "AbortError") return;
            throw error;
          }
          if (closed || signal.aborted) return;

          emitFinal(this.clock());
          closed = true;
        })();
        return finishing;
      },
      cancel: () => {
        closed = true;
      },
    };
  }
}
