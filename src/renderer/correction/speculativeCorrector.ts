import type { CorrectionResult, PhraseId } from "./contracts";
import type {
  CancelTimer,
  CorrectionEngine,
  ScheduleTimeout,
} from "./correctionEngine";

/** How long a partial must hold still before it is worth a model call. */
export const DEFAULT_PARTIAL_STABILITY_MS = 150;
/** Below this, a partial is too thin to guess a sentence from. */
export const DEFAULT_MIN_SPECULATION_WORDS = 3;

export type SpeculationOutcome = "hit" | "stale" | "cold";

export type SpeculativeCorrectorDeps = {
  engine: CorrectionEngine;
  stabilityMs?: number;
  minWords?: number;
  scheduleTimeout?: ScheduleTimeout;
  onOutcome?: (outcome: SpeculationOutcome) => void;
};

export type SpeculativeCorrector = {
  /** Reports the newest partial transcript for the open phrase. */
  observe: (phraseId: PhraseId, partialText: string) => void;
  /**
   * Claims the guess for a finished sentence. Returns null when no usable
   * guess exists, which means the caller owns the model call.
   */
  take: (
    phraseId: PhraseId,
    finalText: string,
  ) => Promise<CorrectionResult> | null;
  discard: (phraseId?: PhraseId) => void;
};

type Attempt = {
  phraseId: PhraseId;
  normalized: string;
  promise: Promise<CorrectionResult>;
  controller: AbortController;
};

const defaultScheduleTimeout: ScheduleTimeout = (ms, fn) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

/**
 * Punctuation and casing are exactly what the provider adds late, so they
 * must not decide whether a guess still matches the finished sentence.
 */
export function normalizeForSpeculation(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(normalized: string): number {
  if (normalized.length === 0) return 0;
  return normalized.split(" ").length;
}

/**
 * The corrector is the slowest stage, and it only starts once the provider
 * closes a turn. That wait is dead time the speaker already paid for, so the
 * same call is started from the last partial instead. When the finished
 * sentence says the same thing, the answer is already on its way and the
 * voice starts almost as soon as the speaker stops.
 *
 * A guess is never spoken on its own: only a sentence the provider finished
 * can claim one, and a guess that no longer matches is thrown away.
 */
export function createSpeculativeCorrector(
  deps: SpeculativeCorrectorDeps,
): SpeculativeCorrector {
  const stabilityMs = deps.stabilityMs ?? DEFAULT_PARTIAL_STABILITY_MS;
  const minWords = deps.minWords ?? DEFAULT_MIN_SPECULATION_WORDS;
  const schedule = deps.scheduleTimeout ?? defaultScheduleTimeout;

  let attempt: Attempt | null = null;
  let pendingNormalized = "";
  let cancelTimer: CancelTimer | null = null;

  function clearTimer(): void {
    cancelTimer?.();
    cancelTimer = null;
    pendingNormalized = "";
  }

  function abortAttempt(): void {
    const active = attempt;
    attempt = null;
    active?.controller.abort();
  }

  function start(
    phraseId: PhraseId,
    originalText: string,
    normalized: string,
  ): void {
    abortAttempt();
    const controller = new AbortController();
    const promise = deps.engine.correct(
      { phraseId, originalText, locale: "en" },
      { signal: controller.signal },
    );
    // A superseded guess rejects on abort and nobody is waiting for it.
    promise.catch(() => {});
    attempt = { phraseId, normalized, promise, controller };
  }

  return {
    observe: (phraseId, partialText) => {
      const originalText = partialText.trim();
      const normalized = normalizeForSpeculation(originalText);
      if (wordCount(normalized) < minWords) return;
      if (normalized === pendingNormalized) return;
      if (attempt?.phraseId === phraseId && attempt.normalized === normalized) {
        return;
      }

      cancelTimer?.();
      pendingNormalized = normalized;
      cancelTimer = schedule(stabilityMs, () => {
        cancelTimer = null;
        pendingNormalized = "";
        start(phraseId, originalText, normalized);
      });
    },
    take: (phraseId, finalText) => {
      clearTimer();
      const active = attempt;
      const normalized = normalizeForSpeculation(finalText);
      const usable =
        active !== null &&
        active.phraseId === phraseId &&
        active.normalized === normalized;

      if (!usable) {
        abortAttempt();
        deps.onOutcome?.(active ? "stale" : "cold");
        return null;
      }

      attempt = null;
      deps.onOutcome?.("hit");
      const originalText = finalText.trim();
      return active.promise.then((result) => ({
        ...result,
        phraseId,
        originalText,
      }));
    },
    discard: (phraseId) => {
      if (phraseId !== undefined && attempt && attempt.phraseId !== phraseId) {
        return;
      }
      clearTimer();
      abortAttempt();
    },
  };
}
