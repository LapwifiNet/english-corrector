import { createPhraseId as defaultPhraseId, type PhraseId } from "./contracts";
import {
  createPhraseEndpointer,
  type EndpointReason,
  type PhraseEndpointDecision,
  type PhraseEndpointerOptions,
  type PhraseEndpointSample,
} from "./phraseEndpointer";

/**
 * One press of push-to-talk is one hold. A hold used to mean one phrase, which
 * forced the speaker to release the key before anything could be corrected.
 *
 * Here the key only controls the microphone. Phrases are closed by the
 * endpointer while the key stays down, so a long hold ships several phrases and
 * the relay follows the speaker instead of waiting for the release.
 *
 * Playback order is the reason phrases carry an index: a later phrase can
 * finish synthesis first, and the listener must still hear them in order.
 */

export type HoldId = string;

export type PhraseHandle = {
  holdId: HoldId;
  phraseId: PhraseId;
  /** Position inside the hold, starting at zero. Playback follows it. */
  phraseIndex: number;
};

export type HoldEndReason = "release" | "cancel";

export type HoldEvent =
  | { type: "hold_started"; holdId: HoldId; startedAt: number }
  | ({ type: "phrase_opened"; startedAt: number } & PhraseHandle)
  | ({
      type: "phrase_closed";
      endedAt: number;
      reason: EndpointReason;
      durationMs: number;
      words: number;
    } & PhraseHandle)
  | ({ type: "phrase_cancelled" } & PhraseHandle)
  | {
      type: "hold_ended";
      holdId: HoldId;
      endedAt: number;
      phrases: number;
      reason: HoldEndReason;
    };

export type HoldStage = "idle" | "capturing";

export type HoldSnapshot = {
  stage: HoldStage;
  holdId: HoldId | null;
  phrase: PhraseHandle | null;
  /** Phrases closed so far in this hold. */
  closedPhrases: number;
};

export type HoldControllerDeps = {
  onEvent: (event: HoldEvent) => void;
  endpointer?: PhraseEndpointerOptions;
  createHoldId?: () => HoldId;
  createPhraseId?: () => PhraseId;
};

export type HoldController = {
  press: (at: number) => HoldId | null;
  /** Feed voice activity and the latest transcript for the open phrase. */
  observe: (sample: PhraseEndpointSample) => PhraseEndpointDecision;
  release: (at: number, text: string) => void;
  /** Drop the open phrase and start a fresh one, key still held. */
  cancelPhrase: (at: number) => void;
  cancelHold: (at: number) => void;
  snapshot: () => HoldSnapshot;
  setSilenceBonus: (ms: number) => void;
};

export function createHoldController(deps: HoldControllerDeps): HoldController {
  const newHoldId = deps.createHoldId ?? (() => `hold-${defaultPhraseId()}`);
  const newPhraseId = deps.createPhraseId ?? defaultPhraseId;
  const endpointer = createPhraseEndpointer(deps.endpointer);

  let stage: HoldStage = "idle";
  let holdId: HoldId | null = null;
  let phrase: PhraseHandle | null = null;
  let nextIndex = 0;
  let closedPhrases = 0;

  function openPhrase(at: number): void {
    if (holdId === null) return;

    phrase = {
      holdId,
      phraseId: newPhraseId(),
      phraseIndex: nextIndex,
    };
    nextIndex += 1;
    endpointer.open(at);
    deps.onEvent({ type: "phrase_opened", ...phrase, startedAt: at });
  }

  function cancelOpenPhrase(): void {
    if (!phrase) return;

    // The index is announced as cancelled so playback does not wait forever
    // for a phrase that will never arrive.
    deps.onEvent({ type: "phrase_cancelled", ...phrase });
    phrase = null;
    endpointer.reset();
  }

  function endHold(at: number, reason: HoldEndReason): void {
    if (holdId === null) return;

    deps.onEvent({
      type: "hold_ended",
      holdId,
      endedAt: at,
      phrases: closedPhrases,
      reason,
    });
    stage = "idle";
    holdId = null;
    phrase = null;
    nextIndex = 0;
    closedPhrases = 0;
    endpointer.reset();
  }

  return {
    press: (at) => {
      if (stage !== "idle") return null;

      holdId = newHoldId();
      stage = "capturing";
      nextIndex = 0;
      closedPhrases = 0;
      deps.onEvent({ type: "hold_started", holdId, startedAt: at });
      openPhrase(at);
      return holdId;
    },

    observe: (sample) => {
      if (stage !== "capturing" || !phrase) {
        return { endpoint: false, heldBack: "not_open" };
      }

      const decision = endpointer.push(sample);
      if (!decision.endpoint) return decision;

      deps.onEvent({
        type: "phrase_closed",
        ...phrase,
        endedAt: decision.at,
        reason: decision.reason,
        durationMs: decision.durationMs,
        words: decision.words,
      });
      closedPhrases += 1;
      phrase = null;

      // The microphone never closed, so the next phrase starts on this frame.
      openPhrase(sample.at);
      return decision;
    },

    release: (at, text) => {
      if (stage !== "capturing") return;

      const decision = endpointer.release(at, text);
      if (decision.endpoint && phrase) {
        deps.onEvent({
          type: "phrase_closed",
          ...phrase,
          endedAt: decision.at,
          reason: decision.reason,
          durationMs: decision.durationMs,
          words: decision.words,
        });
        closedPhrases += 1;
        phrase = null;
      } else {
        // A phrase was opened for audio that turned out to be silence.
        cancelOpenPhrase();
      }

      endHold(at, "release");
    },

    cancelPhrase: (at) => {
      if (stage !== "capturing") return;

      cancelOpenPhrase();
      openPhrase(at);
    },

    cancelHold: (at) => {
      if (stage !== "capturing") return;

      cancelOpenPhrase();
      endHold(at, "cancel");
    },

    snapshot: () => ({ stage, holdId, phrase, closedPhrases }),

    setSilenceBonus: endpointer.setSilenceBonus,
  };
}
