import type { ProtectedTokens } from "./contracts";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /(?:https?:\/\/|www\.)[^\s,;)]+/gi;
const DATE_RE = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const TIME_RE =
  /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b|\b\d{1,2}\s*(?:am|pm)\b/gi;
const CODE_RE = /\b[A-Za-z]+[-_]?\d+[A-Za-z0-9-]*\b/g;
const NUMBER_RE = /\d+(?:,\d{3})*(?:\.\d+)?%?/g;
const NAME_RE = /\b[A-Z][A-Za-z'\u2019]*(?:[-'\u2019][A-Za-z]+)*\b/g;

/**
 * Words that are capitalized for grammar reasons, not because they name
 * something. They are excluded so a sentence-initial capital fix is not
 * reported as a changed name.
 */
const NON_NAME_WORDS = new Set(
  (
    "i a an the this that these those we you he she they it me him her them us my our your his " +
    "its their is are am was were be been being do does did done can could will would should " +
    "shall may might must have has had let please sorry thanks thank yes no not ok okay so but " +
    "and or if when where what why how who whom whose which there here then now today tomorrow " +
    "yesterday because also just maybe sure hi hello hey good morning afternoon evening night " +
    "every some any all each both many much more most last next first second third before after " +
    "during while since until about with without for from to in on at by of as up down over " +
    "under again still even only very really actually everyone everybody someone somebody " +
    "nobody anyone anybody nothing something anything everything send sent give get got go went " +
    "come came make made take took see saw look check open close call talk tell ask need want " +
    "think know use using used run running ready done new old same other another such per " +
    "isn't aren't wasn't weren't don't doesn't didn't can't couldn't won't wouldn't shouldn't " +
    "haven't hasn't hadn't mustn't i'm i've i'll i'd it's that's there's here's what's " +
    "we're we've we'll you're you've you'll he's she's they're they've let's"
  ).split(" "),
);

function collect(
  text: string,
  pattern: RegExp,
): { matches: string[]; rest: string } {
  const matches: string[] = [];
  const rest = text.replace(
    new RegExp(pattern.source, pattern.flags),
    (match) => {
      matches.push(match.trim());
      return " ".repeat(match.length);
    },
  );
  return { matches, rest };
}

export function normalizeNumber(token: string): string {
  return token.replace(/,/g, "");
}

/**
 * Pulls out everything the corrector is not allowed to change. Order matters:
 * emails and URLs are removed before dates and numbers so their digits are not
 * counted twice.
 */
export function extractProtectedTokens(text: string): ProtectedTokens {
  const emails = collect(text, EMAIL_RE);
  const urls = collect(emails.rest, URL_RE);
  const dates = collect(urls.rest, DATE_RE);
  const times = collect(dates.rest, TIME_RE);
  const codes = collect(times.rest, CODE_RE);
  const numbers = collect(codes.rest, NUMBER_RE);
  const names = collect(numbers.rest, NAME_RE);

  return {
    emails: emails.matches,
    urls: urls.matches,
    dates: dates.matches,
    times: times.matches,
    codes: codes.matches,
    numbers: numbers.matches.map(normalizeNumber),
    names: names.matches.filter((token) => {
      const normalized = token.toLowerCase().replace(/\u2019/g, "'");
      return token.length > 1 && !NON_NAME_WORDS.has(normalized);
    }),
  };
}

/** Every token that must survive a correction, compared case-insensitively. */
export function nameLikeTokens(tokens: ProtectedTokens): string[] {
  return [
    ...tokens.emails,
    ...tokens.urls,
    ...tokens.dates,
    ...tokens.times,
    ...tokens.codes,
    ...tokens.names,
  ].map((token) => token.toLowerCase().replace(/\s+/g, " "));
}
