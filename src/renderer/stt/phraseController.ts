import { createPhraseId, type PhraseEvent, type PhraseId } from "./contracts";

export type PushToTalkStage = "ready" | "capturing" | "finalizing";

export type PushToTalkSnapshot = {
  stage: PushToTalkStage;
  phraseId: PhraseId | null;
};

type IdFactory = () => PhraseId;
type Clock = () => number;

export class PushToTalkController {
  private stage: PushToTalkStage = "ready";
  private phraseId: PhraseId | null = null;

  constructor(
    private readonly idFactory: IdFactory = createPhraseId,
    private readonly clock: Clock = () => Date.now(),
  ) {}

  snapshot(): PushToTalkSnapshot {
    return { stage: this.stage, phraseId: this.phraseId };
  }

  press(): Extract<PhraseEvent, { type: "capture_started" }> | null {
    if (this.stage !== "ready") return null;

    this.phraseId = this.idFactory();
    this.stage = "capturing";
    return {
      type: "capture_started",
      phraseId: this.phraseId,
      startedAt: this.clock(),
    };
  }

  release(): Extract<PhraseEvent, { type: "capture_ended" }> | null {
    if (this.stage !== "capturing" || !this.phraseId) return null;

    this.stage = "finalizing";
    return {
      type: "capture_ended",
      phraseId: this.phraseId,
      endedAt: this.clock(),
    };
  }

  cancel(): Extract<PhraseEvent, { type: "cancelled" }> | null {
    if (this.stage === "ready" || !this.phraseId) return null;

    const event: Extract<PhraseEvent, { type: "cancelled" }> = {
      type: "cancelled",
      phraseId: this.phraseId,
    };
    this.reset();
    return event;
  }

  complete(phraseId: PhraseId): boolean {
    if (this.stage === "ready" || this.phraseId !== phraseId) return false;
    this.reset();
    return true;
  }

  private reset(): void {
    this.stage = "ready";
    this.phraseId = null;
  }
}
