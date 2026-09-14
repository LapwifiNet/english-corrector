import {
  CorrectionCancelled,
  type CorrectionResult,
  type PhraseId,
} from "./contracts";
import type { CorrectionEngine } from "./correctionEngine";
import type { SpeculativeCorrector } from "./speculativeCorrector";

export type CorrectionPhase =
  "idle" | "correcting" | "done" | "skipped" | "cancelled";

export type CorrectionSnapshot = {
  phase: CorrectionPhase;
  phraseId: PhraseId | null;
  originalText: string;
  /** Text the audio stage should speak. Empty means speak nothing. */
  spokenText: string;
  result: CorrectionResult | null;
};

export const INITIAL_CORRECTION_SNAPSHOT: CorrectionSnapshot = {
  phase: "idle",
  phraseId: null,
  originalText: "",
  spokenText: "",
  result: null,
};

export type CorrectionPipelineDeps = {
  engine: CorrectionEngine;
  /** FR3.9: diagnostic mode speaks the original sentence. */
  enabled?: boolean;
  /** Optional head start built from partial transcripts. */
  speculator?: SpeculativeCorrector;
  onSnapshot?: (snapshot: CorrectionSnapshot) => void;
};

export function isSpeakable(snapshot: CorrectionSnapshot): boolean {
  return (
    (snapshot.phase === "done" || snapshot.phase === "skipped") &&
    snapshot.spokenText.length > 0
  );
}

/**
 * Turns one final transcript into the sentence the audio pipeline speaks.
 * One phrase is corrected at a time, a newer phrase supersedes the previous
 * one, and a cancelled phrase is never spoken. The snapshot keeps both texts
 * so the UI can show original next to corrected.
 */
export class CorrectionPipeline {
  private current: CorrectionSnapshot = INITIAL_CORRECTION_SNAPSHOT;
  private activePhraseId: PhraseId | null = null;
  private activeController: AbortController | null = null;
  private readonly submittedPhraseIds = new Set<PhraseId>();
  private enabled: boolean;

  constructor(private readonly deps: CorrectionPipelineDeps) {
    this.enabled = deps.enabled ?? true;
  }

  snapshot(): CorrectionSnapshot {
    return this.current;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Turning correction off drops the phrase that is still in flight. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) return;
    this.deps.speculator?.discard();
    this.cancel();
  }

  /**
   * Hands the newest partial transcript to the speculator so the model call
   * can start while the speaker is still talking. The guess is only ever
   * used by a sentence the provider finished.
   */
  prewarm(phraseId: PhraseId, partialText: string): void {
    if (!this.enabled) return;
    if (this.submittedPhraseIds.has(phraseId)) return;
    this.deps.speculator?.observe(phraseId, partialText);
  }

  async submit(
    phraseId: PhraseId,
    finalText: string,
  ): Promise<CorrectionSnapshot> {
    const originalText = finalText.trim();
    if (this.submittedPhraseIds.has(phraseId)) return this.current;
    this.remember(phraseId);
    if (originalText.length === 0) {
      this.deps.speculator?.discard(phraseId);
      return this.publish({
        phase: "skipped",
        phraseId,
        originalText: "",
        spokenText: "",
        result: null,
      });
    }

    if (!this.enabled) {
      return this.publish({
        phase: "skipped",
        phraseId,
        originalText,
        spokenText: originalText,
        result: null,
      });
    }

    this.activeController?.abort();
    const controller = new AbortController();
    this.activePhraseId = phraseId;
    this.activeController = controller;
    this.publish({
      phase: "correcting",
      phraseId,
      originalText,
      spokenText: "",
      result: null,
    });

    try {
      // A guess started from the last partial usually says the same thing,
      // and then the answer is already on its way.
      const pending =
        this.deps.speculator?.take(phraseId, originalText) ??
        this.deps.engine.correct(
          { phraseId, originalText, locale: "en" },
          { signal: controller.signal },
        );
      const result = await pending;
      if (this.activeController !== controller) return this.current;
      this.clearActive();

      return this.publish({
        phase: "done",
        phraseId,
        originalText,
        spokenText: result.correctedText,
        result,
      });
    } catch (error) {
      if (this.activeController !== controller) return this.current;
      this.clearActive();

      if (error instanceof CorrectionCancelled) {
        return this.publish({
          phase: "cancelled",
          phraseId,
          originalText,
          spokenText: "",
          result: null,
        });
      }

      // The engine already maps provider failures to a fallback result, so
      // this branch means an unexpected defect. Speaking the original
      // sentence stays safer than dropping the phrase.
      return this.publish({
        phase: "done",
        phraseId,
        originalText,
        spokenText: originalText,
        result: null,
      });
    }
  }

  /** Drops the phrase so a late correction never reaches the speaker. */
  cancel(phraseId?: PhraseId): void {
    const active = this.activePhraseId;
    if (!active) {
      this.deps.speculator?.discard(phraseId);
      return;
    }
    if (phraseId !== undefined && phraseId !== active) return;

    const controller = this.activeController;
    const originalText = this.current.originalText;
    this.clearActive();
    controller?.abort();
    this.deps.speculator?.discard(active);

    this.publish({
      phase: "cancelled",
      phraseId: active,
      originalText,
      spokenText: "",
      result: null,
    });
  }

  private clearActive(): void {
    this.activePhraseId = null;
    this.activeController = null;
  }

  private remember(phraseId: PhraseId): void {
    this.submittedPhraseIds.add(phraseId);
    if (this.submittedPhraseIds.size <= 128) return;
    const oldest = this.submittedPhraseIds.values().next().value;
    if (oldest) this.submittedPhraseIds.delete(oldest);
  }

  private publish(snapshot: CorrectionSnapshot): CorrectionSnapshot {
    this.current = snapshot;
    this.deps.onSnapshot?.(snapshot);
    return snapshot;
  }
}

export function createCorrectionPipeline(
  deps: CorrectionPipelineDeps,
): CorrectionPipeline {
  return new CorrectionPipeline(deps);
}
