/**
 * Push-to-talk says when the microphone is open. It must not also decide where
 * a phrase ends, because then nothing reaches the corrector until the key is
 * released and the listener always waits for the whole breath.
 *
 * This endpointer closes a phrase while the key is still held, so one hold can
 * produce several phrases and the relay stays close behind the speaker.
 *
 * Cutting in the wrong place costs more than cutting late: the corrector loses
 * the context that keeps the meaning intact. Every rule below exists to hold a
 * phrase open while the evidence for an ending is still weak.
 */

export type EndpointReason = "silence" | "max_duration" | "release";

/** Why an ending was refused. Kept explicit for metrics and for tests. */
export type EndpointHeldBack =
  | "not_open"
  | "no_speech_yet"
  | "still_speaking"
  | "silence_too_short"
  | "phrase_too_short"
  | "too_few_words"
  | "continuation_token";

export type PhraseEndpointDecision =
  | { endpoint: false; heldBack: EndpointHeldBack }
  | {
      endpoint: true;
      reason: EndpointReason;
      at: number;
      durationMs: number;
      words: number;
    };

/**
 * Function words that cannot end an English sentence. A transcript ending on
 * one of them is almost always a speaker still mid-thought.
 */
export const DEFAULT_CONTINUATION_TOKENS: readonly string[] = [
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "because",
  "but",
  "by",
  "for",
  "from",
  "if",
  "in",
  "into",
  "is",
  "my",
  "of",
  "on",
  "or",
  "our",
  "so",
  "that",
  "the",
  "their",
  "to",
  "was",
  "were",
  "when",
  "while",
  "with",
  "your",
];

export type PhraseEndpointerOptions = {
  /** Silence after voice that closes a phrase. */
  silenceThresholdMs?: number;
  /** A breath shorter than this is treated as a pause, not an ending. */
  minPhraseDurationMs?: number;
  /** Fewer words than this merge into the next phrase instead of shipping. */
  minPhraseWords?: number;
  /** A phrase this long is closed even mid-sentence, so relay cannot stall. */
  maxPhraseDurationMs?: number;
  continuationTokens?: readonly string[];
};

export const DEFAULT_PHRASE_ENDPOINTER: Required<PhraseEndpointerOptions> = {
  silenceThresholdMs: 500,
  minPhraseDurationMs: 600,
  minPhraseWords: 3,
  maxPhraseDurationMs: 10_000,
  continuationTokens: DEFAULT_CONTINUATION_TOKENS,
};

export type PhraseEndpointSample = {
  /** Local voice activity for this frame, from the voice activity detector. */
  speaking: boolean;
  at: number;
  /** Best transcript for the open phrase so far. A partial is fine. */
  text: string;
};

export type PhraseEndpointerSnapshot = {
  open: boolean;
  openedAt: number | null;
  lastVoiceAt: number | null;
  sawSpeech: boolean;
  silenceBonusMs: number;
};

export type PhraseEndpointer = {
  open: (at: number) => void;
  push: (sample: PhraseEndpointSample) => PhraseEndpointDecision;
  /** Releasing the key flushes whatever is open, with no quality gate. */
  release: (at: number, text: string) => PhraseEndpointDecision;
  /** Backpressure raises the bar for an ending when playback falls behind. */
  setSilenceBonus: (ms: number) => void;
  snapshot: () => PhraseEndpointerSnapshot;
  reset: () => void;
};

const SENTENCE_END = /[.!?]["')\]]?\s*$/;
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu;

export function phraseWords(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

function bareToken(word: string): string {
  return word.toLowerCase().replace(EDGE_PUNCTUATION, "");
}

/**
 * Punctuation from the provider is stronger evidence than our word list: a
 * transcript that already ends a sentence is allowed to close on any word.
 */
export function endsOnContinuation(
  text: string,
  tokens: ReadonlySet<string>,
): boolean {
  if (SENTENCE_END.test(text)) return false;

  const words = phraseWords(text);
  const last = words.at(-1);
  if (last === undefined) return false;

  return tokens.has(bareToken(last));
}

export function createPhraseEndpointer(
  options: PhraseEndpointerOptions = {},
): PhraseEndpointer {
  const settings = { ...DEFAULT_PHRASE_ENDPOINTER, ...options };
  const tokens = new Set(
    settings.continuationTokens.map((token) => token.toLowerCase()),
  );

  let openedAt: number | null = null;
  let lastVoiceAt: number | null = null;
  let sawSpeech = false;
  let silenceBonusMs = 0;

  function reset(): void {
    openedAt = null;
    lastVoiceAt = null;
    sawSpeech = false;
  }

  function close(
    reason: EndpointReason,
    at: number,
    text: string,
  ): PhraseEndpointDecision {
    const durationMs = Math.max(0, at - (openedAt ?? at));
    const words = phraseWords(text).length;
    reset();
    return { endpoint: true, reason, at, durationMs, words };
  }

  return {
    open: (at) => {
      openedAt = at;
      lastVoiceAt = null;
      sawSpeech = false;
    },

    push: (sample) => {
      if (openedAt === null) return { endpoint: false, heldBack: "not_open" };

      if (sample.speaking) {
        sawSpeech = true;
        lastVoiceAt = sample.at;
      }

      const durationMs = sample.at - openedAt;

      // A phrase that never ends starves the relay, so length alone can close
      // it. Quality gates are skipped here on purpose: shipping a mid-sentence
      // cut beats holding the listener in silence.
      if (sawSpeech && durationMs >= settings.maxPhraseDurationMs) {
        return close("max_duration", sample.at, sample.text);
      }

      if (!sawSpeech) return { endpoint: false, heldBack: "no_speech_yet" };
      if (sample.speaking) {
        return { endpoint: false, heldBack: "still_speaking" };
      }
      if (lastVoiceAt === null) {
        return { endpoint: false, heldBack: "no_speech_yet" };
      }

      const silenceMs = sample.at - lastVoiceAt;
      if (silenceMs < settings.silenceThresholdMs + silenceBonusMs) {
        return { endpoint: false, heldBack: "silence_too_short" };
      }
      if (durationMs < settings.minPhraseDurationMs) {
        return { endpoint: false, heldBack: "phrase_too_short" };
      }
      if (phraseWords(sample.text).length < settings.minPhraseWords) {
        return { endpoint: false, heldBack: "too_few_words" };
      }
      if (endsOnContinuation(sample.text, tokens)) {
        return { endpoint: false, heldBack: "continuation_token" };
      }

      return close("silence", sample.at, sample.text);
    },

    release: (at, text) => {
      if (openedAt === null) return { endpoint: false, heldBack: "not_open" };
      if (!sawSpeech) {
        reset();
        return { endpoint: false, heldBack: "no_speech_yet" };
      }

      // The speaker ended the turn by hand. Word count and continuation words
      // no longer matter; refusing here would drop audio the speaker expects.
      return close("release", at, text);
    },

    setSilenceBonus: (ms) => {
      silenceBonusMs = Math.max(0, ms);
    },

    snapshot: () => ({
      open: openedAt !== null,
      openedAt,
      lastVoiceAt,
      sawSpeech,
      silenceBonusMs,
    }),

    reset,
  };
}
