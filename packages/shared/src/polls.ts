import { z } from "zod";

// Restated rather than imported from api.ts: that file imports this one for
// `pollSchema` on `messageSchema`, and a cycle would make the leaf schemas
// undefined at module init.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Native channel polls. Discord's shape on purpose: a question, two to ten
 * options, a duration, single or multi select, live counts, author-or-manager
 * close. Votes are stored per user and listed on each option. Not anonymous.
 */

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_QUESTION_MAX_LENGTH = 300;
export const POLL_OPTION_MAX_LENGTH = 55;
export const POLL_DURATION_SECONDS = [
  3600, 14_400, 28_800, 86_400, 259_200, 604_800,
] as const;
export type PollDurationSeconds = (typeof POLL_DURATION_SECONDS)[number];
export const DEFAULT_POLL_DURATION_SECONDS = 86_400;

export const pollOptionLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(POLL_OPTION_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARS.test(value), "Invalid characters");

export const pollQuestionSchema = z
  .string()
  .trim()
  .min(1)
  .max(POLL_QUESTION_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARS.test(value), "Invalid characters");

export const pollDurationSecondsSchema = z
  .number()
  .int()
  .refine(
    (value): value is PollDurationSeconds =>
      (POLL_DURATION_SECONDS as readonly number[]).includes(value),
    "Invalid poll duration",
  );

export const pollRequestSchema = z.object({
  question: pollQuestionSchema,
  options: z.array(pollOptionLabelSchema).min(POLL_MIN_OPTIONS).max(POLL_MAX_OPTIONS),
  durationSeconds: pollDurationSecondsSchema.default(DEFAULT_POLL_DURATION_SECONDS),
  allowMultiselect: z.boolean().default(false),
});

export type PollRequest = z.infer<typeof pollRequestSchema>;

export const pollVoterSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().min(1),
  avatarUrl: z.string().nullable(),
});

export type PollVoter = z.infer<typeof pollVoterSchema>;

export const pollOptionSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1).max(POLL_OPTION_MAX_LENGTH),
  votes: z.number().int().nonnegative(),
  /** Whether *this viewer* voted for the option. Per-read, not on the wire for everyone. */
  voted: z.boolean(),
  /** Who picked this option. Defaulted so older history still parses. */
  voters: z.array(pollVoterSchema).default([]),
});

export type PollOption = z.infer<typeof pollOptionSchema>;

export const pollSchema = z.object({
  question: z.string().min(1).max(POLL_QUESTION_MAX_LENGTH),
  allowMultiselect: z.boolean(),
  closesAt: z.string(),
  closedAt: z.string().nullable(),
  options: z.array(pollOptionSchema).min(POLL_MIN_OPTIONS).max(POLL_MAX_OPTIONS),
  totalVotes: z.number().int().nonnegative(),
  canClose: z.boolean(),
});

export type Poll = z.infer<typeof pollSchema>;

export function isPollDuration(value: number): value is PollDurationSeconds {
  return (POLL_DURATION_SECONDS as readonly number[]).includes(value);
}

export function parsePollSlashArgs(raw: string): PollRequest | null {
  const parts = raw
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < POLL_MIN_OPTIONS + 1) {
    return null;
  }
  const [question, ...options] = parts;
  if (!question || options.length < POLL_MIN_OPTIONS) {
    return null;
  }
  const parsed = pollRequestSchema.safeParse({
    question,
    options,
    durationSeconds: DEFAULT_POLL_DURATION_SECONDS,
    allowMultiselect: false,
  });
  return parsed.success ? parsed.data : null;
}

export function isPollClosed(poll: Pick<Poll, "closesAt" | "closedAt">, now = Date.now()): boolean {
  if (poll.closedAt) {
    return true;
  }
  return Date.parse(poll.closesAt) <= now;
}
