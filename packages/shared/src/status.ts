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
