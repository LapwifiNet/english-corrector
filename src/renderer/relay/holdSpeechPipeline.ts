import {
  createPhraseId,
  type CapturedAudioFrame,
  type PhraseEvent,
  type PhraseId,
  type StreamingTranscriber,
  type TranscriptionSession,
} from "../stt/contracts";
import {
  createOrderedPlaybackQueue,
  type OrderedPlaybackSnapshot,
} from "./orderedPlaybackQueue";

/**
 * One hold of the talk key opens one streaming session and produces as many
 * phrases as the speaker finishes while still holding. The provider decides
 * where each sentence ends, so correction and speech start before the key
 * comes back up.
 *
 * Two existing behaviours shape this file. Correction supersedes whatever it
 * was working on, so phrases are prepared strictly one at a time. The relay
 * also aborts its active run when a new one starts, so playback goes through
 * the ordered queue instead of straight into the relay.
 *
 * Events come back out in the shape the transcript reducer already accepts,
 * so the panel keeps rendering one phrase at a time without knowing that a
 * hold now carries several.
 */

export type HoldPhrase = {
  phraseId: PhraseId;
  /** Position inside the hold, counted from zero. */
  phraseIndex: number;
  text: string;
  receivedAt: number;
  confidence?: number;
};

export type HoldSpeechPipelineDeps<TPrepared> = {
  transcriber: StreamingTranscriber;
  /** Correction. Null means this phrase is not worth speaking. */
  prepare: (phrase: HoldPhrase) => Promise<TPrepared | null>;
  play: (
    prepared: TPrepared,
    phrase: HoldPhrase,
    signal: AbortSignal,
  ) => Promise<void>;
  onEvent?: (event: PhraseEvent) => void;
  onCongestion?: (congested: boolean) => void;
  onError?: (phraseId: PhraseId, error: unknown) => void;
  createSessionId?: () => PhraseId;
  maxPending?: number;
  now?: () => number;
};

export type HoldSpeechSnapshot = {
  holding: boolean;
  sessionId: PhraseId | null;
  openPhraseId: PhraseId | null;
  spokenPhrases: number;
  playback: OrderedPlaybackSnapshot;
};

export type HoldSpeechPipeline = {
  /** Opens the session and returns the id audio frames must carry. */
  press: () => PhraseId | null;
  write: (frame: CapturedAudioFrame) => void;
  /** Flushes the provider, then waits for the last phrase to be spoken. */
  release: () => Promise<void>;
  cancel: () => void;
  settled: () => Promise<void>;
  snapshot: () => HoldSpeechSnapshot;
};

export function createHoldSpeechPipeline<TPrepared>(
  deps: HoldSpeechPipelineDeps<TPrepared>,
): HoldSpeechPipeline {
  const newSessionId = deps.createSessionId ?? createPhraseId;
  const now = deps.now ?? (() => Date.now());
  const queue = createOrderedPlaybackQueue({
    maxPending: deps.maxPending,
    onCongestion: deps.onCongestion,
    onError: (phraseId, error) => deps.onError?.(phraseId, error),
  });

  let session: TranscriptionSession | null = null;
  let controller: AbortController | null = null;
  let sessionId: PhraseId | null = null;
  let openPhraseId: PhraseId | null = null;
  let openIndex = 0;
  let revision = 0;
  let spoken = 0;
  let holding = false;
  // Bumped by press and cancel, so a late provider event or a queued
  // preparation from an abandoned hold cannot touch the current one.
  let generation = 0;
  let work: Promise<void> = Promise.resolve();

  function emit(event: PhraseEvent): void {
    deps.onEvent?.(event);
  }

  /**
   * A phrase is opened when the speaker starts one, not when the previous one
   * ends. Opening eagerly would leave an empty phrase behind on release and
   * the panel would report no speech for a hold that spoke fine.
   */
  function ensureOpenPhrase(): void {
    if (openPhraseId || !sessionId) return;

    openPhraseId = `${sessionId}:${openIndex}`;
    revision = 0;
    emit({
      type: "capture_started",
      phraseId: openPhraseId,
      startedAt: now(),
    });
  }

  function schedule(phrase: HoldPhrase, run: number): void {
    work = work
      .then(async () => {
        if (run !== generation) return;

        const prepared = await deps.prepare(phrase);
        if (run !== generation) return;
        if (prepared === null) {
          queue.discard(phrase.phraseIndex);
          return;
        }

        queue.enqueue({
          phraseId: phrase.phraseId,
          phraseIndex: phrase.phraseIndex,
          play: (signal) => deps.play(prepared, phrase, signal),
        });
      })
      .catch((error: unknown) => {
        deps.onError?.(phrase.phraseId, error);
        // A phrase that failed to prepare must not hold the queue back.
        queue.discard(phrase.phraseIndex);
      });
  }

  function closeOpenPhrase(
    text: string,
    receivedAt: number,
    confidence: number | undefined,
    run: number,
  ): void {
    const phraseId = openPhraseId;
    if (!phraseId) return;

    const phraseIndex = openIndex;
    openPhraseId = null;
    openIndex += 1;

    emit({ type: "capture_ended", phraseId, endedAt: receivedAt });
    emit({ type: "final_transcript", phraseId, text, receivedAt, confidence });

    if (text.length === 0) {
      queue.discard(phraseIndex);
      return;
    }

    spoken += 1;
    schedule({ phraseId, phraseIndex, text, receivedAt, confidence }, run);
  }

  function disposeSession(abort: boolean): void {
    const current = session;
    const currentController = controller;
    session = null;
    controller = null;
    sessionId = null;
    openPhraseId = null;
    if (!abort) return;

    currentController?.abort();
    current?.cancel();
  }

  function handleEvent(event: PhraseEvent, run: number): void {
    if (run !== generation || event.phraseId !== sessionId) return;

    if (event.type === "partial_transcript") {
      ensureOpenPhrase();
      if (!openPhraseId) return;

      revision += 1;
      emit({
        type: "partial_transcript",
        phraseId: openPhraseId,
        revision,
        text: event.text,
      });
      return;
    }

    if (event.type === "final_transcript") {
      const text = event.text.trim();
      // A turn that closes without words after the last sentence of a hold
      // is not a phrase of its own, so it must not reopen one on release.
      if (!openPhraseId && text.length === 0) return;

      // A provider can close a turn without ever sending a partial.
      ensureOpenPhrase();
      closeOpenPhrase(text, event.receivedAt, event.confidence, run);
      return;
    }

    if (event.type === "failed") {
      const phraseId = openPhraseId;
      holding = false;
      if (phraseId) emit({ type: "failed", phraseId, code: event.code });
      disposeSession(true);
    }
  }

  return {
    press: () => {
      if (holding) return null;

      generation += 1;
      holding = true;
      spoken = 0;
      openIndex = 0;
      revision = 0;
      work = Promise.resolve();
      queue.reset(0);

      const run = generation;
      const id = newSessionId();
      const abort = new AbortController();
      sessionId = id;
      controller = abort;
      session = deps.transcriber.start({
        phraseId: id,
        mode: "continuous",
        signal: abort.signal,
        onEvent: (event) => handleEvent(event, run),
      });
      ensureOpenPhrase();
      return id;
    },

    write: (frame) => {
      const current = session;
      if (!current || !sessionId) return;

      current.write(
        frame.phraseId === sessionId
          ? frame
          : { ...frame, phraseId: sessionId },
      );
    },

    release: async () => {
      if (!holding) return;

      holding = false;
      const run = generation;
      const current = session;
      if (openPhraseId) {
        emit({ type: "capture_ended", phraseId: openPhraseId, endedAt: now() });
      }

      await current?.finish();
      if (run !== generation) return;

      // Nothing was left to flush, so the phrase that was open ends empty.
      if (openPhraseId) closeOpenPhrase("", now(), undefined, run);
      disposeSession(false);

      await work;
      await queue.settled();
    },

    cancel: () => {
      generation += 1;
      holding = false;
      if (openPhraseId) {
        emit({ type: "cancelled", phraseId: openPhraseId });
      }

      disposeSession(true);
      work = Promise.resolve();
      queue.panicMute();
      queue.reset(0);
    },

    settled: async () => {
      await work;
      await queue.settled();
    },

    snapshot: () => ({
      holding,
      sessionId,
      openPhraseId,
      spokenPhrases: spoken,
      playback: queue.snapshot(),
    }),
  };
}
