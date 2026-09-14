/**
 * Auto endpoint puts several phrases in flight at once, so a short later phrase
 * can finish synthesis before a long earlier one. The person on the call must
 * still hear them in the order they were spoken, and never two at a time.
 *
 * The queue plays strictly by phrase index. A phrase that arrives early waits,
 * and a phrase that will never arrive has to be discarded by hand, otherwise
 * the gap would hold the whole hold back.
 */

export type PlaybackJob = (signal: AbortSignal) => Promise<void>;

export type QueuedPhrase = {
  phraseId: string;
  /** Position inside the hold. Playback waits for the missing indexes. */
  phraseIndex: number;
  play: PlaybackJob;
};

export type OrderedPlaybackSnapshot = {
  playing: string | null;
  pending: number;
  nextIndex: number;
  congested: boolean;
  muted: boolean;
};

export type OrderedPlaybackQueueDeps = {
  /** Phrases allowed to wait before backpressure is reported. */
  maxPending?: number;
  onSnapshot?: (snapshot: OrderedPlaybackSnapshot) => void;
  /** Raised when playback falls behind, so capture can slow down. */
  onCongestion?: (congested: boolean) => void;
  onError?: (phraseId: string, error: unknown) => void;
};

export const DEFAULT_MAX_PENDING = 2;
const REMEMBERED_PHRASE_IDS = 128;

export type OrderedPlaybackQueue = {
  /** Returns false when the phrase was a duplicate, late, or muted away. */
  enqueue: (phrase: QueuedPhrase) => boolean;
  /** Mark an index as never coming, so the queue does not stall on it. */
  discard: (phraseIndex: number) => void;
  /** Stop the voice immediately and drop everything waiting. */
  panicMute: () => void;
  /** Clear state for a new hold and accept phrases again. */
  reset: (nextIndex?: number) => void;
  snapshot: () => OrderedPlaybackSnapshot;
  /** Resolves when the current drain pass has finished. For tests. */
  settled: () => Promise<void>;
};

export function createOrderedPlaybackQueue(
  deps: OrderedPlaybackQueueDeps = {},
): OrderedPlaybackQueue {
  const maxPending = deps.maxPending ?? DEFAULT_MAX_PENDING;
  const pending = new Map<number, QueuedPhrase>();
  const skipped = new Set<number>();
  const seen = new Set<string>();

  let nextIndex = 0;
  let playing: string | null = null;
  let muted = false;
  let congested = false;

  // One pass plays one phrase at a time. Work that arrives while a pass is
  // running raises a wake flag instead of starting a second pass, so a phrase
  // queued just as the loop breaks cannot be left waiting forever.
  let passActive = false;
  let wake = false;
  let settledPass: Promise<void> = Promise.resolve();

  function snapshot(): OrderedPlaybackSnapshot {
    return {
      playing,
      pending: pending.size,
      nextIndex,
      congested,
      muted,
    };
  }

  function publish(): void {
    const next = pending.size >= maxPending && !muted;
    if (next !== congested) {
      congested = next;
      deps.onCongestion?.(next);
    }
    deps.onSnapshot?.(snapshot());
  }

  function remember(phraseId: string): void {
    seen.add(phraseId);
    if (seen.size <= REMEMBERED_PHRASE_IDS) return;

    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }

  let activeController: AbortController | null = null;

  async function drain(): Promise<void> {
    while (!muted) {
      if (skipped.has(nextIndex)) {
        skipped.delete(nextIndex);
        nextIndex += 1;
        continue;
      }

      const phrase = pending.get(nextIndex);
      if (!phrase) break;

      pending.delete(nextIndex);
      const controller = new AbortController();
      activeController = controller;
      playing = phrase.phraseId;
      publish();

      try {
        await phrase.play(controller.signal);
      } catch (error) {
        deps.onError?.(phrase.phraseId, error);
      } finally {
        activeController = null;
        playing = null;
      }

      // A panic mute during playback keeps the index, because reset decides
      // where the next hold starts.
      if (muted) break;

      nextIndex += 1;
      publish();
    }

    publish();
  }

  function schedule(): void {
    if (passActive) {
      wake = true;
      return;
    }

    passActive = true;
    settledPass = (async () => {
      for (;;) {
        wake = false;
        await drain();

        // Nothing awaits between the flag check and the exit, so a phrase
        // queued during the pass is always picked up by another round.
        if (!wake) {
          passActive = false;
          return;
        }
      }
    })();
  }

  return {
    enqueue: (phrase) => {
      if (muted) return false;
      if (seen.has(phrase.phraseId)) return false;
      if (phrase.phraseIndex < nextIndex) return false;
      if (pending.has(phrase.phraseIndex)) return false;

      remember(phrase.phraseId);
      pending.set(phrase.phraseIndex, phrase);
      publish();
      schedule();
      return true;
    },

    discard: (phraseIndex) => {
      if (phraseIndex < nextIndex) return;

      pending.delete(phraseIndex);
      skipped.add(phraseIndex);
      publish();
      schedule();
    },

    panicMute: () => {
      muted = true;
      pending.clear();
      skipped.clear();
      activeController?.abort();
      publish();
    },

    reset: (startIndex = 0) => {
      muted = false;
      pending.clear();
      skipped.clear();
      nextIndex = startIndex;
      publish();
    },

    snapshot,

    settled: () => settledPass,
  };
}
