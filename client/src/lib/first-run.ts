import type { User } from "@pqp/shared";

/**
 * The first-run checklist's decisions, with no React attached.
 *
 * Same split as `onboarding.ts`, for the same reason: the component is a list of
 * three rows and two buttons, and everything that can be got *wrong* — who sees
 * it, who never sees it again, and when "done" is done — is here where it can be
 * tested without a DOM.
 *
 * WHAT THIS FIXES. The wizard ends and the app opens on the hub, which for an
 * account with no servers is the Friends view with "No friends here yet" in it.
 * That is one of the three things a new account needs, and it is the only one
 * the hub ever mentions: `Create server` and `Join invite` live in the empty
 * state for a *selected server*, which an account with no servers cannot reach,
 * and the avatar is three clicks into a settings modal nothing points at. So the
 * screen a new person lands on after signing up offers one third of what they
 * came to do, and the other two thirds are unlabelled icons in a 56px rail.
 */

/** The three things, in the order they unlock each other. */
export type FirstRunTaskId = "server" | "friend" | "avatar";

export interface FirstRunTask {
  id: FirstRunTaskId;
  done: boolean;
}

export interface FirstRunState {
  /** All three, in display order, each with its own done-ness. */
  tasks: FirstRunTask[];
  /** Nothing left to do. */
  complete: boolean;
}

export interface FirstRunInputs {
  user: User | null;
  serverCount: number;
  friendCount: number;
}

/**
 * What is still outstanding, read from live state rather than from stored flags.
 *
 * Derived on purpose. A stored "created a server" bit would go stale the moment
 * somebody leaves the server again, and worse, it would need a write on every
 * one of the three paths — three more chances to record something that did not
 * happen. Counting what the app already has loaded cannot drift from the truth.
 *
 * `avatarUrl` is the whole avatar test. An empty string counts as absent: the
 * profile step stores `null` when the field is cleared, but a PATCH that trims
 * to nothing has historically round-tripped as `""`, and a checklist that calls
 * that done would tick a box for a face nobody can see.
 */
export function firstRunState({
  user,
  serverCount,
  friendCount,
}: FirstRunInputs): FirstRunState {
  const tasks: FirstRunTask[] = [
    { id: "server", done: serverCount > 0 },
    { id: "friend", done: friendCount > 0 },
    { id: "avatar", done: Boolean(user?.avatarUrl) },
  ];
  return { tasks, complete: tasks.every((task) => task.done) };
}

/**
 * Should the hub draw the checklist?
 *
 * Three "no"s, and they are the whole function:
 *
 *  - `preferences` entirely absent — an API that cannot record a dismissal.
 *    Offering a card whose "no thanks" does not stick means offering it forever,
 *    which is the nagging this was built to avoid. Same reasoning
 *    `shouldRunOnboarding` applies to the same missing field.
 *  - `firstRunDismissedAt` present — answered. Never again, on any device.
 *  - everything done — there is nothing to offer.
 *
 * NOTHING HERE LOOKS AT `onboardedAt`, and that is not an omission. It reads as
 * the obvious fourth guard — "do not stack a checklist under the wizard" — but
 * the wizard is a full-screen replacement, so the hub cannot render while it is
 * up and the guard protects against nothing. What it *would* do is suppress the
 * card in the one session it exists for: the wizard writes `onboardedAt` to the
 * server without patching the app's copy of the user (see `finish()` in
 * `onboarding-flow.tsx` for why it must not), so for the rest of that session the
 * local user still says onboarding never ran. Gating on it meant the person who
 * had just signed up — the entire audience — saw nothing.
 */
export function shouldShowFirstRun(
  inputs: FirstRunInputs,
  state: FirstRunState = firstRunState(inputs),
): boolean {
  const preferences = inputs.user?.preferences;
  if (!preferences) {
    return false;
  }
  if (preferences.firstRunDismissedAt) {
    return false;
  }
  return !state.complete;
}

/**
 * Should the card's dismissal be recorded without anybody clicking anything?
 *
 * Yes exactly when there is nothing left to do and nothing has been recorded.
 * This is what closes the derived-state loop described in the schema comment:
 * the card stops rendering the moment the third item is done, but "stops
 * rendering" is not "gone" while the reason it stopped can be undone. One write,
 * once per account, and the question can never be asked again.
 *
 * Deliberately does not require `onboardedAt`. An account still inside the
 * wizard that already has all three (joined by invite, has a friend, uploaded an
 * avatar in step 2) is as finished as any other, and making it wait would mean
 * asking it on the next cold start instead.
 */
export function shouldStampFirstRunComplete(
  inputs: FirstRunInputs,
  state: FirstRunState = firstRunState(inputs),
): boolean {
  const preferences = inputs.user?.preferences;
  if (!preferences || preferences.firstRunDismissedAt) {
    return false;
  }
  return state.complete;
}

/** The preference patch that closes the checklist for good, on every device. */
export function firstRunDismissedPatch(now: Date = new Date()): {
  firstRunDismissedAt: string;
} {
  return { firstRunDismissedAt: now.toISOString() };
}
