import { z } from "zod";

/**
 * Per-user status — "is this person around" — as opposed to `presence-update`
 * in chat.ts, which answers "who is looking at this channel right now". The two
 * are different questions and neither one substitutes for the other: a person
 * can be online and reading nothing, or looking at a channel while invisible.
 *
 * THE SHIPPED STATES, AND WHY THERE ARE ONLY THESE.
 *
 * Four states are visible to other people, and only two of the four are things
 * a person may assert about themselves. The split is deliberate: a status that
 * mixes fact and preference in one field is a status nobody can trust.
 *
 * - `online`  — DERIVED. At least one authenticated socket, nothing manual set.
 *               There is no column for it and there must never be one: a stored
 *               "online" is a lie the moment a process dies holding the socket.
 * - `idle`    — DERIVED, from a client-side inactivity signal (`set-idle`). The
 *               server cannot infer it: an abandoned tab still answers pings and
 *               still holds a socket, so "no traffic" is not "nobody there".
 * - `dnd`     — MANUAL, stored. Means "I am here, do not interrupt me"; the
 *               client suppresses its own desktop notifications on it, so it is
 *               a behaviour and not a coloured dot.
 * - `offline` — the ABSENCE of any connection. Never stored, never set.
 *
 * `invisible` is a manual choice that is never seen by anyone else: it resolves
 * to `offline` on every surface. It is in `manualStatusSchema` and deliberately
 * NOT in `userStatusSchema`, which is the type of "what a third party is told".
 * Keeping it out of that union is the type system's half of the privacy
 * guarantee — a function returning `UserStatus` cannot leak it by accident.
 *
 * WHAT WAS REJECTED. A *manual* idle (Discord has one). "Idle" is the single
 * state whose meaning is objective — nobody has touched this device in a while —
 * and letting it be asserted turns it into one more opinion, at which point it
 * needs a rule for whether real activity clears it, and either answer is wrong:
 * clearing it ignores what the person asked for, not clearing it means the badge
 * says "away" while they type. Someone who wants to be left alone has `dnd`;
 * someone who wants to disappear has `invisible`.
 */

/** What an account may set about itself. Absent from storage means `online`. */
export const manualStatusSchema = z.enum(["online", "dnd", "invisible"]);

export type ManualStatus = z.infer<typeof manualStatusSchema>;

/**
 * What anybody else is allowed to be told. `invisible` is absent on purpose —
 * see the note above.
 */
export const userStatusSchema = z.enum(["online", "idle", "dnd", "offline"]);

export type UserStatus = z.infer<typeof userStatusSchema>;

export const DEFAULT_MANUAL_STATUS = "online" satisfies ManualStatus;

/**
 * How long a client waits, with no pointer or keyboard event, before reporting
 * itself idle.
 *
 * Ten minutes rather than one or two because the transition is what costs: the
 * frame is sent on a change of state, so a short threshold turns one person
 * reading a long message into a stream of idle/active flips. At ten minutes a
 * typical session produces a handful of frames an hour.
 */
export const IDLE_AFTER_MS = 10 * 60_000;

/**
 * "I stopped touching this" / "I am back". Ephemeral by construction: it is
 * scoped to the socket that sent it and dies with it, which is exactly right —
 * an idle flag that outlived the connection would be a stored derived state,
 * the thing this design refuses to have.
 *
 * Sent only on a transition, never on a timer.
 */
export const setIdleMessageSchema = z.object({
  type: z.literal("set-idle"),
  idle: z.boolean(),
});

export type SetIdleMessage = z.infer<typeof setIdleMessageSchema>;

// ------------------------------------------------------ the custom status

/**
 * O RECADO: one short line a person writes about themselves, drawn under their
 * name wherever a name and a picture already sit together.
 *
 * MSN's "personal message", not Discord's activity feed. It is free text the
 * account wrote and nothing the system inferred, which is what keeps it in a
 * different category from everything above: `manualStatus` is a choice out of
 * three fixed options and `idle` is a measurement, while this is prose. The two
 * never merge into one field. A pip answers "can I reach this person", a recado
 * answers "what is going on with them", and collapsing the two would cost the
 * pip the only property that makes it worth drawing, which is that it always
 * means the same thing.
 *
 * IT IS NOT PART OF THE STATUS REGISTRY, and that is the load-bearing
 * difference. Everything above is derived from live sockets and is deliberately
 * never stored; a recado is stored, on `users`, because the person typed it and
 * it has to survive their laptop lid closing. So it does not reach other
 * clients through the status pull on the member list. It reaches them through
 * `profile-update`, the frame that already fans a rename and a new avatar out
 * to every connected socket: one more short string on a frame that exists,
 * rather than a second push path with its own fan-out cost.
 *
 * NO EXPIRY IN THIS VERSION. "Clear after an hour" needs a second column, a
 * guard on every read path, and a way to tell everybody else when the hour is
 * up, and that last part is the expensive one. Nothing wakes up to send a
 * `profile-update` at a timestamp, so a lazily expired status would stay on
 * other people's screens until something unrelated made them refetch. Doing it
 * properly is a sweeper job, which is a second feature rather than a flag on
 * this one. See docs/NOW_PLAYING.md.
 */

/**
 * Eighty characters, counted in code points.
 *
 * The member sidebar is 15rem (240px) at every width it is drawn, including the
 * drawer a phone gets, and the text column inside a row is about 192px of that
 * once the avatar and the gutters are taken out. At 11px that is roughly 35
 * characters on screen, so ANY cap above about 35 truncates in the sidebar, and
 * the number is really answering a different question: how long may this be
 * before it stops being a status and starts being a paragraph somebody pasted.
 * Eighty is a sentence. It is also what fits on two lines of the profile card,
 * which is the one surface that shows the whole thing.
 *
 * CODE POINTS, NOT UTF-16 UNITS. `z.string().max()` counts units, so a cap of
 * 80 would be 40 emoji, and a recado is mostly emoji in the product this is
 * modelled on. Counting code points means one emoji costs one character, which
 * is what the person typing believes. A ZWJ family sequence still costs one per
 * component, and that is accepted: the alternative is segmenting grapheme
 * clusters on both clients and the server and keeping the three in step.
 */
export const CUSTOM_STATUS_MAX_LENGTH = 80;

/**
 * Code points a recado may not contain, checked AFTER normalisation.
 *
 * Written as arithmetic rather than as a character class because every one of
 * these is invisible in a source file, and a regex literal full of invisible
 * characters is a line nobody can review. Three groups:
 *
 *  1. C0 and DEL and C1. Postgres refuses a NUL outright (SQLSTATE 22021), and
 *     unlike a message body a recado is one line, so it has no use for the rest
 *     either. Newline and tab never reach here: `normalizeCustomStatus`
 *     collapses them to a space first, so pasting a two-line signature produces
 *     one line rather than an error about a character the person cannot see.
 *  2. The bidi OVERRIDES (U+202A to U+202E). These reorder everything drawn
 *     after them, so one of them in a recado can visually rewrite the names of
 *     the people listed below it in the sidebar.
 *  3. The bidi ISOLATES (U+2066 to U+2069), same problem, newer spelling.
 *
 * ZWJ (U+200D) and the variation selectors are deliberately NOT here: they are
 * how a family emoji and a coloured heart are spelled, and this field is
 * supposed to be full of both.
 */
function isForbiddenInCustomStatus(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * The invisible spaces `\s` does not cover. A recado padded out to eighty
 * non-breaking spaces is a blank line that pushes every row under it down, and
 * a zero-width space is how somebody makes an "empty" status that is not empty.
 */
function isInvisibleSpace(code: number): boolean {
  return code === 0x00a0 || code === 0x200b || code === 0xfeff;
}

/** Code points, not UTF-16 units. See `CUSTOM_STATUS_MAX_LENGTH`. */
export function customStatusLength(value: string): number {
  return [...value].length;
}

/**
 * What somebody typed, as the line it becomes: every run of whitespace becomes
 * one ordinary space, and the ends are trimmed.
 *
 * Lossy on purpose and never rejected for shape, because this runs against
 * pasted text and refusing a paste is worse than tidying it. One pass rather
 * than a collapse followed by a trim, so there is no order to get wrong.
 *
 * Idempotent: `normalize(normalize(x)) === normalize(x)`.
 */
export function normalizeCustomStatus(raw: string): string {
  let out = "";
  let gap = false;
  for (const character of raw) {
    const code = character.codePointAt(0)!;
    if (/\s/.test(character) || isInvisibleSpace(code)) {
      // Only a gap BETWEEN things is kept, which is what makes this trim the
      // leading run for free and the trailing run by never flushing it.
      gap = out.length > 0;
      continue;
    }
    if (gap) {
      out += " ";
      gap = false;
    }
    out += character;
  }
  return out;
}

/**
 * Why a recado cannot be saved, or null when it can.
 *
 * A discriminated reason rather than a message, same as `HandleRejection` in
 * profiles.ts and for the same reason: the client renders it in two languages
 * and the server renders it in neither.
 */
export type CustomStatusRejection = "length" | "characters";

export function validateCustomStatus(
  value: string,
): CustomStatusRejection | null {
  if (customStatusLength(value) > CUSTOM_STATUS_MAX_LENGTH) {
    return "length";
  }
  for (const character of value) {
    if (isForbiddenInCustomStatus(character.codePointAt(0)!)) {
      return "characters";
    }
  }
  return null;
}

/**
 * The wire shape. Normalises before it measures, so the eighty is counted
 * against what will actually be stored rather than against the whitespace
 * somebody pasted, and an all-whitespace body becomes `""` here (and `NULL` in
 * the column) rather than a row that renders as an empty second line.
 *
 * The outer `.max()` is a cheap ceiling on the raw body so a megabyte of spaces
 * is refused before anything walks it. It sits far above the real cap on
 * purpose: the real one is the refinement, which runs on the normalised value
 * and is the number the counter in the form shows.
 */
export const customStatusSchema = z
  .string()
  .max(4000)
  .transform(normalizeCustomStatus)
  .refine(
    (value) => validateCustomStatus(value) === null,
    `Keep it to ${CUSTOM_STATUS_MAX_LENGTH} characters, on one line.`,
  );
