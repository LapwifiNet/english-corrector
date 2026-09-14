export type PhraseId = string;

export type PhraseStage =
  | "ready"
  | "capturing"
  | "finalizing"
  | "final"
  | "empty"
  | "cancelled"
  | "failed";

export type PhraseEvent =
  | {
      type: "capture_started";
      phraseId: PhraseId;
      startedAt: number;
    }
  | {
      type: "partial_transcript";
      phraseId: PhraseId;
      revision: number;
      text: string;
    }
  | {
      type: "capture_ended";
      phraseId: PhraseId;
      endedAt: number;
    }
  | {
      type: "final_transcript";
      phraseId: PhraseId;
      text: string;
      receivedAt: number;
      confidence?: number;
    }
  | {
      type: "cancelled";
      phraseId: PhraseId;
    }
  | {
      type: "failed";
      phraseId: PhraseId;
      code: string;
    };

export type CapturedAudioFrame = {
  phraseId: PhraseId;
  sequence: number;
  capturedAt: number;
  sampleRate: number;
  samples: Float32Array;
};

export type TranscriptionSession = {
  write: (frame: CapturedAudioFrame) => void;
  finish: () => Promise<void>;
  cancel: () => void;
};

export type StartTranscriptionRequest = {
  phraseId: PhraseId;
  signal: AbortSignal;
  onEvent: (event: PhraseEvent) => void;
};

export interface StreamingTranscriber {
  start(request: StartTranscriptionRequest): TranscriptionSession;
}

export function createPhraseId(): PhraseId {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `phrase-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
