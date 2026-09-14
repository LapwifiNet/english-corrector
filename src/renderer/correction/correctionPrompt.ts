/**
 * Prompt config is versioned so regression tests can pin a known version.
 * Never edit the instruction text without bumping the version.
 */
export const CORRECTION_PROMPT_VERSION = "correction-v1";

export const CORRECTION_SYSTEM_INSTRUCTION = [
  "Correct the speaker's English.",
  "Preserve the exact meaning, names, numbers, tense, and intent.",
  "Do not answer the speaker.",
  "Do not translate.",
  "Return only the corrected sentence.",
  "If uncertain about a name or number, preserve the original text.",
  "If the sentence is already correct, return it unchanged.",
].join("\n");

export type PromptConfig = {
  version: string;
  systemInstruction: string;
  temperature: number;
  maxOutputTokens: number;
};

export const DEFAULT_PROMPT_CONFIG: PromptConfig = {
  version: CORRECTION_PROMPT_VERSION,
  systemInstruction: CORRECTION_SYSTEM_INSTRUCTION,
  temperature: 0,
  maxOutputTokens: 200,
};

/**
 * The speaker's sentence is data, never an instruction. The user turn carries
 * the transcript only, so a spoken "ignore the previous instruction" stays a
 * sentence to correct.
 */
export function buildUserTurn(originalText: string): string {
  return originalText;
}
