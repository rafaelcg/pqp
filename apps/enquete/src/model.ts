import type { JsonValue } from "@pqp/shared";

/*
 * The poll's session state, as the app writes and reads it:
 *
 *   {
 *     poll:   { question, options: string[], multi: boolean },   host, once
 *     votes:  { [seatId]: bitmask of the chosen options },        one key per seat
 *     closed: { counts: number[], voters: number },               host, when the vote closes
 *     result: { question, winners: string[], votes, voters }      host, with `closed`
 *   }
 *
 * `votes` is keyed by SEAT, never by user: the app does not know who anybody
 * is, and a person who leaves and comes back is a new seat. A merge patch of
 * `{ votes: { [seat]: mask } }` touches only that seat's key, so two people
 * voting at the same moment never overwrite each other and a vote needs no
 * `baseRev`. Once `closed` exists the screen shows its frozen counts and
 * ignores `votes`, so a vote that lands after the host pressed the button
 * cannot change what everybody saw.
 *
 * `result` is the small line the quiet "terminou" card shows once the session
 * is over (see docs/APPS.md, "The result of a session"): at most
 * `RESULT_MAX_BYTES` of compact JSON, built by `buildResult`.
 */

/** The limits of a native channel poll (`packages/shared/src/polls.ts`, a test keeps them equal). */
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;
export const QUESTION_MAX_LENGTH = 300;
export const OPTION_MAX_LENGTH = 55;
/** What the server copies into `app_sessions.summary.result`. */
export const RESULT_MAX_BYTES = 512;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export interface Poll {
  question: string;
  options: string[];
  multi: boolean;
}

export interface Closed {
  counts: number[];
  voters: number;
}

/** The closing line in the host's language: the winner(s) and the votes each got, or that nobody voted. */
export type ResultText = (winners: readonly string[], votes: number) => string;

/** The longest closing line the quiet card shows (the card renders `summary.result.text`, at most this many characters). */
export const RESULT_TEXT_MAX_CHARS = 200;
/** Names spelled out in the closing line; a tie of more ends in an ellipsis. */
const RESULT_TEXT_NAMES = 3;

const defaultResultText: ResultText = (winners, votes) =>
  winners.length === 0 ? "" : `${winners.join(", ")} (${votes})`;

export interface PollResult {
  /** What the card shows (plain text, at most 200 characters). The other fields are the poll's own record. */
  text: string;
  question: string;
  winners: string[];
  votes: number;
  voters: number;
}

export interface PollState {
  poll: Poll | null;
  votes: Record<string, number>;
  closed: Closed | null;
  result: PollResult | null;
}

export const EMPTY_STATE: PollState = { poll: null, votes: {}, closed: null, result: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Counts of `code points`, which is what a person sees as a character, close enough for a limit. */
function length(text: string): number {
  return Array.from(text).length;
}

function cleanText(raw: string, max: number): string | null {
  const text = raw.trim();
  if (text.length === 0 || length(text) > max || CONTROL_CHARS.test(text)) return null;
  return text;
}

export type DraftProblem = "question" | "options" | "duplicate" | "characters" | "too-long";

export type DraftResult = { ok: true; poll: Poll } | { ok: false; problem: DraftProblem };

/**
 * What the host typed, checked with the same rules as a native poll: trimmed,
 * no control characters, 300 for the question and 55 per option, two to ten
 * options. Empty options are dropped (the form keeps blank rows), repeated ones
 * (ignoring case) are refused.
 */
export function validateDraft(question: string, options: string[], multi: boolean): DraftResult {
  const q = question.trim();
  if (q.length === 0) return { ok: false, problem: "question" };
  if (CONTROL_CHARS.test(q)) return { ok: false, problem: "characters" };
  if (length(q) > QUESTION_MAX_LENGTH) return { ok: false, problem: "too-long" };

  const kept: string[] = [];
  for (const raw of options) {
    const text = raw.trim();
    if (text.length === 0) continue;
    if (CONTROL_CHARS.test(text)) return { ok: false, problem: "characters" };
    if (length(text) > OPTION_MAX_LENGTH) return { ok: false, problem: "too-long" };
    kept.push(text);
  }
  if (kept.length < MIN_OPTIONS || kept.length > MAX_OPTIONS) return { ok: false, problem: "options" };
  const seen = new Set(kept.map((text) => text.toLocaleLowerCase()));
  if (seen.size !== kept.length) return { ok: false, problem: "duplicate" };
  return { ok: true, poll: { question: q, options: kept, multi } };
}

function readPoll(value: unknown): Poll | null {
  if (!isRecord(value)) return null;
  const question = typeof value.question === "string" ? cleanText(value.question, QUESTION_MAX_LENGTH) : null;
  if (question === null || !Array.isArray(value.options)) return null;
  if (value.options.length < MIN_OPTIONS || value.options.length > MAX_OPTIONS) return null;
  const options: string[] = [];
  for (const raw of value.options) {
    const text = typeof raw === "string" ? cleanText(raw, OPTION_MAX_LENGTH) : null;
    if (text === null) return null;
    options.push(text);
  }
  return { question, options, multi: value.multi === true };
}

function readClosed(value: unknown, optionCount: number): Closed | null {
  if (!isRecord(value) || !Array.isArray(value.counts) || value.counts.length !== optionCount) return null;
  const counts = value.counts.map((n) => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0));
  const voters = typeof value.voters === "number" && Number.isSafeInteger(value.voters) && value.voters >= 0 ? value.voters : 0;
  return { counts, voters };
}

function readResult(value: unknown): PollResult | null {
  if (!isRecord(value) || typeof value.question !== "string" || !Array.isArray(value.winners)) return null;
  const winners = value.winners.filter((w): w is string => typeof w === "string");
  const votes = typeof value.votes === "number" ? value.votes : 0;
  const voters = typeof value.voters === "number" ? value.voters : 0;
  const text = typeof value.text === "string" ? value.text : "";
  return { text, question: value.question, winners, votes, voters };
}

/** The state value the host handed over, read defensively: anything off becomes "no poll yet". */
export function readState(value: JsonValue): PollState {
  if (!isRecord(value)) return EMPTY_STATE;
  const poll = readPoll(value.poll);
  const votes: Record<string, number> = {};
  if (isRecord(value.votes)) {
    for (const [seat, mask] of Object.entries(value.votes)) {
      if (typeof mask === "number" && Number.isSafeInteger(mask) && mask > 0) votes[seat] = mask;
    }
  }
  return {
    poll,
    votes,
    closed: poll ? readClosed(value.closed, poll.options.length) : null,
    result: poll ? readResult(value.result) : null,
  };
}

/** The bit of option `index`. */
export function bit(index: number): number {
  return 2 ** index;
}

export function hasBit(mask: number, index: number): boolean {
  return Math.floor(mask / bit(index)) % 2 === 1;
}

export function popcount(mask: number): number {
  let n = 0;
  for (let i = 0; i < MAX_OPTIONS; i += 1) if (hasBit(mask, i)) n += 1;
  return n;
}

/**
 * One seat's choice as the poll counts it: bits outside the options are
 * dropped, and a single-choice poll keeps only the lowest bit, so a mask a
 * client should never have written still counts as one vote.
 */
export function normalizeMask(mask: number, poll: Poll): number {
  let out = 0;
  for (let i = 0; i < poll.options.length; i += 1) {
    if (hasBit(mask, i)) {
      out += bit(i);
      if (!poll.multi) break;
    }
  }
  return out;
}

export interface Tally {
  counts: number[];
  voters: number;
}

export function tally(poll: Poll, votes: Record<string, number>): Tally {
  const counts = poll.options.map(() => 0);
  let voters = 0;
  for (const raw of Object.values(votes)) {
    const mask = normalizeMask(raw, poll);
    if (mask === 0) continue;
    voters += 1;
    for (let i = 0; i < counts.length; i += 1) if (hasBit(mask, i)) counts[i] = (counts[i] ?? 0) + 1;
  }
  return { counts, voters };
}

/** What the screen shows: the frozen counts once the vote is closed, the live ones before. */
export function shownTally(state: PollState): Tally | null {
  if (!state.poll) return null;
  return state.closed ?? tally(state.poll, state.votes);
}

/** Indexes with the most votes; empty when nobody voted. More than one is a tie. */
export function winnerIndexes(counts: number[]): number[] {
  const top = Math.max(0, ...counts);
  if (top === 0) return [];
  return counts.flatMap((n, i) => (n === top ? [i] : []));
}

function bytesOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * The small line that outlives the session: the question, the winning
 * option(s), the votes the winner got and how many people voted. Shrunk until
 * its compact JSON fits `RESULT_MAX_BYTES` (a 300 character question in a
 * language that takes four bytes a character does not on its own).
 */
export function buildResult(
  poll: Poll,
  counts: number[],
  voters: number,
  resultText: ResultText = defaultResultText,
): PollResult {
  const indexes = winnerIndexes(counts);
  const votes = indexes.length > 0 ? (counts[indexes[0]!] ?? 0) : 0;
  const winnerLabels = indexes.map((i) => poll.options[i] ?? "");
  const textFor = (labelMax: number): string => {
    const names = winnerLabels.slice(0, RESULT_TEXT_NAMES).map((label) => clip(label, labelMax));
    if (winnerLabels.length > RESULT_TEXT_NAMES) names.push("\u2026");
    return clip(resultText(names, votes), RESULT_TEXT_MAX_CHARS);
  };
  const make = (questionMax: number, labelMax: number, winnerMax: number): PollResult => ({
    text: textFor(labelMax),
    question: clip(poll.question, questionMax),
    winners: winnerLabels.slice(0, winnerMax).map((label) => clip(label, labelMax)),
    votes,
    voters,
  });
  for (const [questionMax, labelMax, winnerMax] of [
    [QUESTION_MAX_LENGTH, OPTION_MAX_LENGTH, MAX_OPTIONS],
    [140, OPTION_MAX_LENGTH, 4],
    [80, 40, 3],
    [60, 30, 2],
    [40, 20, 1],
  ] as const) {
    const result = make(questionMax, labelMax, winnerMax);
    if (bytesOf(result) <= RESULT_MAX_BYTES) return result;
  }
  // last resort, for names of four-byte characters: the card's line first, then the rest, until it fits
  const last = make(20, 10, 1);
  last.question = "";
  while (bytesOf(last) > RESULT_MAX_BYTES && last.text.length > 1) last.text = clip(last.text, Math.max(1, Array.from(last.text).length - 8));
  return last;
}

/** The merge patch that starts the poll. */
export function startPatch(poll: Poll): JsonValue {
  return { poll: { question: poll.question, options: poll.options, multi: poll.multi } };
}

/** The merge patch for one seat's vote. A mask of 0 takes the vote back (merge patch `null` deletes the key). */
export function votePatch(seatId: string, mask: number): JsonValue {
  return { votes: { [seatId]: mask === 0 ? null : mask } };
}

/** The merge patch that closes the vote: the frozen counts and the line for the card. */
export function closePatch(poll: Poll, votes: Record<string, number>, resultText?: ResultText): JsonValue {
  const { counts, voters } = tally(poll, votes);
  const result = buildResult(poll, counts, voters, resultText);
  return { closed: { counts, voters }, result: { ...result } };
}

/** A bar's share of the people who voted (in a multiple choice poll the shares add up to more than 100). */
export function percent(count: number, voters: number): number {
  return voters === 0 ? 0 : Math.round((count / voters) * 100);
}
