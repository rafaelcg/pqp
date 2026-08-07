import { usernameSchema, type User } from "@pqp/shared";
import { ApiError } from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";

/**
 * The decisions first-run onboarding makes, with no React attached.
 *
 * The component below this is a form; everything that can be got *wrong* — who
 * sees the flow, who never sees it again, and what happens when the handle
 * somebody asks for is not the handle they get — lives here so it can be tested
 * without a DOM. The client has no jsdom and no testing-library, and adding both
 * to prove a three-field form renders is a worse trade than keeping the rules
 * out of the form in the first place.
 */

/**
 * Where in the flow we are, in order: read your handle, then say who you are,
 * then get somewhere with people in it. Only the first is compulsory.
 */
export type OnboardingStep = "handle" | "profile" | "landing";

/**
 * Should this account be shown the first-run flow?
 *
 * Three answers, and the two "no"s matter more than the "yes":
 *
 *  - `preferences` entirely absent — an API that predates the preference store.
 *    Read as "this deployment cannot record that the flow ran", so running it
 *    would mean running it on every single sign-in, forever. Same reasoning the
 *    bootstrap applies to a missing `ageGate`: an absent field is a statement
 *    about the server, not about the user.
 *  - `onboardedAt` present — finished, skipped, or grandfathered by the
 *    `onboarding_grandfather_2026_08` backfill. All three mean "not again".
 *  - otherwise — an account created after onboarding shipped that has not
 *    answered yet.
 *
 * Deliberately says nothing about the age gate. The bootstrap stops at the gate
 * before it ever gets here, and it must stay that way: onboarding somebody who
 * is about to be refused is asking a person to name themselves on their way out.
 */
export function shouldRunOnboarding(user: User | null): boolean {
  if (!user?.preferences) {
    return false;
  }
  return !user.preferences.onboardedAt;
}

/** The preference patch that closes the flow for good, on every device. */
export function onboardingCompletedPatch(now: Date = new Date()): {
  onboardedAt: string;
} {
  return { onboardedAt: now.toISOString() };
}

/**
 * What the handle field will accept, applied as you type rather than on submit.
 *
 * `usernameSchema` is `^[a-z0-9_]+$`, so a capital or an accent is not a
 * validation error to report — it is a keystroke to quietly fix. Someone typing
 * "João" should watch it become "joo", not submit and be told off.
 */
export function normalizeUsername(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32);
}

/** Is this something `PATCH /api/me` will accept as a username? */
export function isValidUsername(value: string): boolean {
  return usernameSchema.safeParse(value).success;
}

/**
 * What went wrong when the handle could not be saved — and, always, a way out.
 *
 * The 409 is the one that matters. `updateProfile` keeps your number when it can
 * and rolls a new one when the exact `name#number` pair is taken; it only
 * refuses when all 9,999 numbers behind a name are gone. That is a full
 * namespace, not a bad request, and the only recovery is a different name — so
 * the message has to say that rather than "try again", which would be an
 * instruction to repeat something that cannot work.
 *
 * Every branch returns a message and leaves the field editable. There is no
 * error state in this flow that ends the flow.
 */
export function handleErrorMessage(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return "onboarding.handle.error.taken";
    }
    if (error.status === 400 || error.status === 422) {
      return "onboarding.handle.error.invalid";
    }
  }
  return "onboarding.handle.error.generic";
}

/**
 * Did the server hand back a different tag than the one asked for?
 *
 * A rename that collides is answered with the same name and a fresh number,
 * silently. Silently is right for the settings modal, where the user already
 * knows their handle; it is wrong here, where the whole point of the step is
 * that they are seeing it for the first time. Told once, they know what to give
 * out. Not told, they hand out the number they typed at and nobody finds them.
 */
export function tagWasReassigned(
  requestedUsername: string,
  previousTag: string | null,
  nextTag: string | null,
): boolean {
  if (!nextTag || nextTag === previousTag) {
    return false;
  }
  // The name part is what they chose; a change there is their own doing. Only a
  // change in the number is news.
  return nextTag.startsWith(`${requestedUsername}#`);
}

/**
 * A pasted invite, reduced to the code the API wants.
 *
 * People paste the whole link, because the whole link is what they were sent.
 * The last path segment is the code in `/app/invite/<code>`, in
 * `pqp://invite/<code>`, and in a bare code (which has no segments to drop).
 */
export function normalizeInviteCode(input: string): string {
  const withoutQuery = input.trim().split(/[?#]/)[0] ?? "";
  const segments = withoutQuery.split(/[/\\]/).filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
