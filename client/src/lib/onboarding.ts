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
 * Where in the wizard we are, in order: say who you are (name, photo, and the
 * @ people type to find you), then pick where the group lives, then take the
 * invite. None is compulsory; the wizard's footer closes it from any step.
 */
export type OnboardingStep = "you" | "room" | "ready";

/**
 * Every screen a first run can show, the age gate included. The gate is its
 * own component (the server gates it), but it draws the same dots, so it is
 * counted as the first screen rather than the wizard starting at 1 of 3 after
 * the person has already answered one.
 */
export type FirstRunScreen = "age" | OnboardingStep;

/**
 * Who is walking through, which decides how many screens there are.
 *
 * - `invite`: arrived on an invite link. The app joins behind the wizard, so
 *   "where does the group live" is answered and there is no invite to hand
 *   out. Age, then you, then the room.
 * - `import`: arrived on `?import=discord`. The create dialog opens on the
 *   paste the moment the wizard closes, and it has its own done screen.
 * - `cold`: neither. Age, you, room, and the invite for the room they made.
 */
export type OnboardingPath = "cold" | "invite" | "import";

export function onboardingPath({
  invite,
  importing,
}: {
  invite: boolean;
  importing: boolean;
}): OnboardingPath {
  // An invite wins: the person clicked into a room, and the import can still
  // be reached from the + in the rail once they are in it.
  if (invite) {
    return "invite";
  }
  return importing ? "import" : "cold";
}

/** The screens a path shows, in order, gate first. */
export function screensFor(path: OnboardingPath): readonly FirstRunScreen[] {
  return path === "cold" ? ["age", "you", "room", "ready"] : ["age", "you"];
}

/**
 * Where a screen sits in the dots: zero-based index and total. A screen the
 * path does not show (typed invite on step 3 of a two-screen path cannot
 * happen, but `ready` after a cold create can) is clamped to the last dot, so
 * the counter never reads past its own end.
 */
export function screenPosition(
  path: OnboardingPath,
  screen: FirstRunScreen,
): { index: number; total: number } {
  const screens = screensFor(path);
  const found = screens.indexOf(screen);
  return {
    index: found === -1 ? screens.length - 1 : found,
    total: screens.length,
  };
}

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
      return "onboarding.you.error.taken";
    }
    if (error.status === 400 || error.status === 422) {
      return "onboarding.you.error.invalid";
    }
  }
  return "onboarding.you.error.generic";
}

/**
 * Did the server hand back a different NUMBER than the one they had?
 *
 * A rename that collides is answered with the same name and a fresh number,
 * silently. Silently is right for the settings modal, where the user already
 * knows their handle; it is wrong here, where the whole point of the step is
 * that they are seeing it for the first time. Told once, they know what to give
 * out. Not told, they hand out the number they typed at and nobody finds them.
 *
 * Compared on the number rather than on the whole tag. The name part is what
 * they chose, so a change there is their own doing, and `updateProfile` keeps
 * the account's existing number whenever it can; that is the common case, not
 * news. Comparing whole tags reads every successful rename as a reassignment
 * the moment the name differs from before, which is the bug the Android port
 * of this function found on its emulator walk, pull request 806: "Esse já
 * tinha dono" after every rename that worked.
 */
export function tagWasReassigned(
  requestedUsername: string,
  previousTag: string | null,
  nextTag: string | null,
): boolean {
  if (!nextTag || !nextTag.startsWith(`${requestedUsername}#`)) {
    return false;
  }
  const previousNumber = previousTag?.split("#").pop() ?? "";
  if (!previousNumber) {
    return false;
  }
  return nextTag.split("#").pop() !== previousNumber;
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

/**
 * What the room step's invite door ended in.
 *
 * - `opened`: joined, and the room is open behind the wizard. Finish.
 * - `invalid`: nothing usable was pasted, or the API refused the code.
 * - `notOpened`: the join WORKED but opening the room did not. The wizard
 *   must stay, say so, and retry only the opening (`serverId`), never finish
 *   onto a room that is not there.
 */
export type RoomJoinResult =
  | { kind: "opened"; serverId: string }
  | { kind: "invalid" }
  | { kind: "notOpened"; serverId: string };

/**
 * The invite door, with no React attached so it can be tested.
 *
 * Whatever was pasted (a bare code, `https://pqp.gg/app/invite/<code>?ref=…`,
 * the same without a scheme, `/i/<code>`, `pqp://invite/<code>`) goes through
 * `normalizeInviteCode` before it reaches the API. `joinedId` is set on a
 * retry after `notOpened`, and skips the join. Never rejects.
 */
export async function joinFromRoomStep({
  input,
  joinedId,
  joinInvite,
  openJoined,
}: {
  input: string;
  joinedId: string | null;
  joinInvite: (code: string) => Promise<{ serverId: string }>;
  openJoined: (serverId: string) => Promise<void>;
}): Promise<RoomJoinResult> {
  let serverId = joinedId;
  if (!serverId) {
    const code = normalizeInviteCode(input);
    if (!code) {
      return { kind: "invalid" };
    }
    try {
      serverId = (await joinInvite(code)).serverId;
    } catch {
      return { kind: "invalid" };
    }
  }
  try {
    await openJoined(serverId);
  } catch {
    return { kind: "notOpened", serverId };
  }
  return { kind: "opened", serverId };
}
