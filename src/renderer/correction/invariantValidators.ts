import { extractProtectedTokens, nameLikeTokens } from "./protectedTokens";
import type { CorrectionWarning, ProtectedTokens } from "./contracts";

const NEGATION_WORDS = [
  "not",
  "no",
  "never",
  "none",
  "nobody",
  "nothing",
  "nowhere",
  "neither",
  "nor",
  "without",
  "hardly",
  "barely",
  "scarcely",
];

const WH_WORDS = [
  "what",
  "why",
  "when",
  "where",
  "who",
  "whom",
  "whose",
  "which",
  "how",
];

const AUX_WORDS = [
  "is",
  "are",
  "am",
  "was",
  "were",
  "do",
  "does",
  "did",
  "can",
  "could",
  "will",
  "would",
  "should",
  "shall",
  "may",
  "might",
  "must",
  "isn't",
  "aren't",
  "doesn't",
  "don't",
  "didn't",
  "can't",
  "couldn't",
  "won't",
];

export function countNegations(text: string): number {
  const expanded = text
    .toLowerCase()
    .replace(/n['\u2019]t\b/g, " not")
    .replace(/\bcannot\b/g, "can not");
  const words = expanded.split(/[^a-z']+/).filter(Boolean);
  return words.filter((word) => NEGATION_WORDS.includes(word)).length;
}

export function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.endsWith("?")) return true;
  const firstWord = trimmed
    .toLowerCase()
    .split(/[^a-z'\u2019]+/)
    .filter(Boolean)[0];
  if (!firstWord) return false;
  return WH_WORDS.includes(firstWord) || AUX_WORDS.includes(firstWord);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive word match, so "notion" to "Notion" is a capitalization fix
 * and not a changed name.
 */
export function containsToken(text: string, token: string): boolean {
  const haystack = text.toLowerCase().replace(/\s+/g, " ");
  const pattern = new RegExp(
    "(^|[^a-z0-9])" + escapeRegExp(token) + "([^a-z0-9]|$)",
    "i",
  );
  return pattern.test(haystack);
}

function numbersDiffer(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return true;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.some((value, index) => value !== sortedRight[index]);
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Latin letters only. Anything else in the output looks like a translation. */
function hasNonLatinDrift(original: string, corrected: string): boolean {
  const nonLatin = /[^\u0000-\u007F]/;
  return !nonLatin.test(original) && nonLatin.test(corrected);
}

export type ValidationOptions = {
  /** Word-count ratio allowed between corrected and original text. */
  maxLengthRatio?: number;
  /** Absolute word difference always tolerated, for very short phrases. */
  wordSlack?: number;
};

/**
 * Returns every invariant the corrected sentence breaks. An empty array means
 * the correction is safe to speak into the call.
 */
export function validateCorrection(
  originalText: string,
  correctedText: string,
  originalTokens: ProtectedTokens,
  options: ValidationOptions = {},
): CorrectionWarning[] {
  const maxLengthRatio = options.maxLengthRatio ?? 1.6;
  const wordSlack = options.wordSlack ?? 2;
  const warnings: CorrectionWarning[] = [];
  const correctedTokens = extractProtectedTokens(correctedText);

  if (numbersDiffer(originalTokens.numbers, correctedTokens.numbers)) {
    warnings.push("number_changed");
  }

  const dropped = nameLikeTokens(originalTokens).filter(
    (token) => !containsToken(correctedText, token),
  );
  const invented = nameLikeTokens(correctedTokens).filter(
    (token) => !containsToken(originalText, token),
  );
  if (dropped.length > 0 || invented.length > 0) {
    warnings.push("name_changed");
  }

  if (countNegations(originalText) !== countNegations(correctedText)) {
    warnings.push("negation_changed");
  }

  if (isQuestion(originalText) !== isQuestion(correctedText)) {
    warnings.push("question_changed");
  }

  const originalWords = wordCount(originalText);
  const correctedWords = wordCount(correctedText);
  const withinSlack = Math.abs(correctedWords - originalWords) <= wordSlack;
  const ratio = correctedWords / Math.max(originalWords, 1);
  const withinRatio = ratio <= maxLengthRatio && ratio >= 1 / maxLengthRatio;

  if (
    (!withinSlack && !withinRatio) ||
    hasNonLatinDrift(originalText, correctedText)
  ) {
    warnings.push("invalid_output");
  }

  return warnings;
}
