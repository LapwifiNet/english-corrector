import type { PhraseEvent, PhraseId, PhraseStage } from "./contracts";

export type TranscriptState = {
  stage: PhraseStage;
  phraseId: PhraseId | null;
  partialText: string;
  partialRevision: number;
  finalText: string;
  confidence?: number;
  errorCode?: string;
  captureStartedAt?: number;
  captureEndedAt?: number;
  finalReceivedAt?: number;
};

export const INITIAL_TRANSCRIPT_STATE: TranscriptState = {
  stage: "ready",
  phraseId: null,
  partialText: "",
  partialRevision: 0,
  finalText: "",
};

const TERMINAL_STAGES = new Set<PhraseStage>([
  "final",
  "empty",
  "cancelled",
  "failed",
]);

function isActive(state: TranscriptState, phraseId: PhraseId): boolean {
  return (
    state.phraseId === phraseId &&
    (state.stage === "capturing" || state.stage === "finalizing")
  );
}

export function reduceTranscript(
  state: TranscriptState,
  event: PhraseEvent,
): TranscriptState {
  switch (event.type) {
    case "capture_started":
      if (state.stage !== "ready" && !TERMINAL_STAGES.has(state.stage)) {
        return state;
      }
      return {
        stage: "capturing",
        phraseId: event.phraseId,
        partialText: "",
        partialRevision: 0,
        finalText: "",
        captureStartedAt: event.startedAt,
      };

    case "partial_transcript":
      if (!isActive(state, event.phraseId)) return state;
      if (event.revision <= state.partialRevision) return state;
      return {
        ...state,
        partialText: event.text,
        partialRevision: event.revision,
      };

    case "capture_ended":
      if (state.phraseId !== event.phraseId || state.stage !== "capturing") {
        return state;
      }
      return {
        ...state,
        stage: "finalizing",
        captureEndedAt: event.endedAt,
      };

    case "final_transcript": {
      if (state.phraseId !== event.phraseId || state.stage !== "finalizing") {
        return state;
      }
      const finalText = event.text.trim();
      return {
        ...state,
        stage: finalText ? "final" : "empty",
        partialText: "",
        finalText,
        confidence: event.confidence,
        finalReceivedAt: event.receivedAt,
      };
    }

    case "cancelled":
      if (!isActive(state, event.phraseId)) return state;
      return {
        ...state,
        stage: "cancelled",
        partialText: "",
      };

    case "failed":
      if (!isActive(state, event.phraseId)) return state;
      return {
        ...state,
        stage: "failed",
        partialText: "",
        errorCode: event.code,
      };
  }
}

export function speechEndToFinalMs(state: TranscriptState): number | null {
  if (
    typeof state.captureEndedAt !== "number" ||
    typeof state.finalReceivedAt !== "number"
  ) {
    return null;
  }
  return Math.max(0, Math.round(state.finalReceivedAt - state.captureEndedAt));
}
