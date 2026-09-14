export type PhraseId = string;

export type CorrectionRequest = {
  phraseId: PhraseId;
  originalText: string;
  locale: "en";
};

export type CorrectionOutcome = "changed" | "unchanged" | "fallback";

/**
 * The first four codes come from the Epic 3 contract.
 * "question_changed" is a proposed extension and still needs product sign-off.
 */
export type CorrectionWarning =
  | "name_changed"
  | "number_changed"
  | "negation_changed"
  | "invalid_output"
  | "question_changed";

export type CorrectionErrorCode =
  | "empty_input"
  | "timeout"
  | "provider_error"
  | "invalid_output"
  | "unsafe_output";

export type CorrectionResult = {
  phraseId: PhraseId;
  originalText: string;
  correctedText: string;
  outcome: CorrectionOutcome;
  warnings: CorrectionWarning[];
  errorCode?: CorrectionErrorCode;
  providerLatencyMs?: number;
  promptVersion: string;
};

export type CorrectionAdapter = {
  readonly name: string;
  correct(request: CorrectionRequest, signal: AbortSignal): Promise<string>;
};

export type ProtectedTokens = {
  emails: string[];
  urls: string[];
  dates: string[];
  times: string[];
  codes: string[];
  numbers: string[];
  names: string[];
};

export class CorrectionCancelled extends Error {
  readonly phraseId: PhraseId;

  constructor(phraseId: PhraseId) {
    super("Correction cancelled for phrase " + phraseId);
    this.name = "CorrectionCancelled";
    this.phraseId = phraseId;
  }
}
