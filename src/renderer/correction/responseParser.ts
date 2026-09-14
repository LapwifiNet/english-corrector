export type ParseFailureReason =
  | "empty"
  | "multiline"
  | "label_prefix"
  | "markdown"
  | "quoted"
  | "multiple_options"
  | "too_long";

export type ParseResult =
  { ok: true; text: string } | { ok: false; reason: ParseFailureReason };

const LABEL_RE =
  /^(corrected|correction|output|result|answer|rewrite|rewritten|fixed|revised)\b[^:]{0,20}:/i;
const PREAMBLE_RE =
  /^(here (is|are)|sure|certainly|of course|the corrected|i (have )?(corrected|fixed))\b/i;
const MARKDOWN_RE = /^(```|~~~|#{1,6}\s|>\s|[-*+]\s|\d+\.\s)/;
const OPTIONS_RE = /\b(option\s*\d|alternatively|you could also say)\b/i;
const MAX_OUTPUT_CHARS = 1000;

/**
 * The model must return exactly one plain sentence. Labels, markdown and
 * explanations are rejected instead of being stripped, so a drifting prompt
 * shows up as a fallback instead of being silently cleaned up.
 */
export function parseCorrectionOutput(raw: string): ParseResult {
  const text = raw.trim();

  if (text.length === 0) return { ok: false, reason: "empty" };
  if (text.length > MAX_OUTPUT_CHARS) return { ok: false, reason: "too_long" };
  if (/\r|\n/.test(text)) return { ok: false, reason: "multiline" };
  if (MARKDOWN_RE.test(text) || text.includes("```"))
    return { ok: false, reason: "markdown" };
  if (LABEL_RE.test(text) || PREAMBLE_RE.test(text))
    return { ok: false, reason: "label_prefix" };
  if (OPTIONS_RE.test(text)) return { ok: false, reason: "multiple_options" };
  if (/^["'\u201c\u2018].*["'\u201d\u2019]$/.test(text))
    return { ok: false, reason: "quoted" };

  return { ok: true, text };
}
