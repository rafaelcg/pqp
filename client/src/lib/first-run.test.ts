import { describe, expect, it } from "vitest";
import type { User } from "@pqp/shared";
import {
  firstRunDismissedPatch,
  firstRunState,
  shouldShowFirstRun,
  shouldStampFirstRunComplete,
} from "./first-run";

function user(overrides: Partial<User> = {}): User {
  return {
    id: "u1",
    clerkId: "clerk_1",
    displayName: "Dev User",
    username: "dev_user",
    discriminator: "0001",
    tag: "dev_user#0001",
    avatarUrl: null,
    preferences: { onboardedAt: "2026-08-01T00:00:00.000Z" },
    dmPrivacy: "server_members",
    ...overrides,
  } as User;
}

const NOTHING_DONE = { user: user(), serverCount: 0, friendCount: 0 };

describe("firstRunState", () => {
  it("reports all three outstanding for an account that has just signed up", () => {
    const state = firstRunState(NOTHING_DONE);
    expect(state.tasks.map((task) => task.id)).toEqual([
      "server",
      "friend",
      "avatar",
    ]);
    expect(state.tasks.every((task) => !task.done)).toBe(true);
    expect(state.complete).toBe(false);
  });

  it("ticks the server row off one server, however they got it", () => {
    const state = firstRunState({ ...NOTHING_DONE, serverCount: 1 });
    expect(state.tasks.find((task) => task.id === "server")?.done).toBe(true);
    expect(state.complete).toBe(false);
  });

  it("ticks the friend row off one friend", () => {
    const state = firstRunState({ ...NOTHING_DONE, friendCount: 1 });
    expect(state.tasks.find((task) => task.id === "friend")?.done).toBe(true);
  });

  it("ticks the avatar row off a stored URL", () => {
    const state = firstRunState({
      ...NOTHING_DONE,
      user: user({ avatarUrl: "https://example.test/a.png" }),
    });
    expect(state.tasks.find((task) => task.id === "avatar")?.done).toBe(true);
  });

  it("does not count an empty avatar string as a face", () => {
    // A cleared field has round-tripped as "" rather than null; ticking that
    // box would credit somebody for an avatar nobody can see.
    const state = firstRunState({
      ...NOTHING_DONE,
      user: user({ avatarUrl: "" }),
    });
    expect(state.tasks.find((task) => task.id === "avatar")?.done).toBe(false);
  });

  it("is complete only when all three are", () => {
    expect(
      firstRunState({
        user: user({ avatarUrl: "https://example.test/a.png" }),
        serverCount: 2,
        friendCount: 3,
      }).complete,
    ).toBe(true);
  });
});

describe("shouldShowFirstRun", () => {
  it("offers the card to an onboarded account with nothing done", () => {
    expect(shouldShowFirstRun(NOTHING_DONE)).toBe(true);
  });

  it("offers it while only some of the three are outstanding", () => {
    expect(shouldShowFirstRun({ ...NOTHING_DONE, serverCount: 1 })).toBe(true);
  });

  it("never offers it again once dismissed", () => {
    expect(
      shouldShowFirstRun({
        ...NOTHING_DONE,
        user: user({
          preferences: {
            onboardedAt: "2026-08-01T00:00:00.000Z",
            firstRunDismissedAt: "2026-08-02T00:00:00.000Z",
          },
        }),
      }),
    ).toBe(false);
  });

  it("treats an empty stamp as never dismissed, which is the only way to re-arm it", () => {
    // Preferences are one JSONB blob merged with `||`, so a key can be
    // overwritten but never removed — once this field is written there is no way
    // back to absent. Reading `""` as "never dismissed" is the only re-arm there
    // is, and it is what makes the flag testable at all. The iOS side has to say
    // this out loud (`FirstRun.isDismissed`); here it falls out of truthiness,
    // which is exactly why it needs a test to stop somebody "tidying" it into an
    // `!== undefined` check.
    expect(
      shouldShowFirstRun({
        ...NOTHING_DONE,
        user: user({
          preferences: {
            onboardedAt: "2026-08-01T00:00:00.000Z",
            firstRunDismissedAt: "",
          },
        }),
      }),
    ).toBe(true);
  });

  it("offers it in the session that just finished the wizard", () => {
    // The regression this pins. The wizard writes `onboardedAt` to the server
    // and deliberately does not patch the app's copy of the user, so for the
    // rest of that session the local preferences say onboarding never ran.
    // Gating on `onboardedAt` therefore hid the card from the only people it is
    // for — everybody who had just signed up.
    expect(
      shouldShowFirstRun({
        ...NOTHING_DONE,
        user: user({ preferences: {} }),
      }),
    ).toBe(true);
  });

  it("does not offer it when the API cannot record a dismissal", () => {
    // No preference store means "no thanks" would not stick, and a card that
    // returns every session is worse than no card.
    expect(
      shouldShowFirstRun({
        ...NOTHING_DONE,
        user: user({ preferences: undefined }),
      }),
    ).toBe(false);
  });

  it("does not offer it with no user at all", () => {
    expect(
      shouldShowFirstRun({ user: null, serverCount: 0, friendCount: 0 }),
    ).toBe(false);
  });

  it("does not offer it once everything is done", () => {
    expect(
      shouldShowFirstRun({
        user: user({ avatarUrl: "https://example.test/a.png" }),
        serverCount: 1,
        friendCount: 1,
      }),
    ).toBe(false);
  });
});

describe("shouldStampFirstRunComplete", () => {
  it("stamps once everything is done, so it can never come back", () => {
    // This is the whole point: visibility is derived from live state, and live
    // state comes back. Leaving your last server a year from now must not
    // reopen a "get into a server" nudge.
    expect(
      shouldStampFirstRunComplete({
        user: user({ avatarUrl: "https://example.test/a.png" }),
        serverCount: 1,
        friendCount: 1,
      }),
    ).toBe(true);
  });

  it("does not stamp while something is outstanding", () => {
    expect(shouldStampFirstRunComplete(NOTHING_DONE)).toBe(false);
    expect(
      shouldStampFirstRunComplete({ ...NOTHING_DONE, serverCount: 1 }),
    ).toBe(false);
  });

  it("does not stamp twice", () => {
    expect(
      shouldStampFirstRunComplete({
        user: user({
          avatarUrl: "https://example.test/a.png",
          preferences: {
            onboardedAt: "2026-08-01T00:00:00.000Z",
            firstRunDismissedAt: "2026-08-02T00:00:00.000Z",
          },
        }),
        serverCount: 1,
        friendCount: 1,
      }),
    ).toBe(false);
  });

  it("stamps an account that finished all three inside the wizard", () => {
    // Joined by invite, added a friend, uploaded an avatar in step 2 — as
    // finished as anybody. Waiting for `onboardedAt` would only move the
    // question to the next cold start.
    expect(
      shouldStampFirstRunComplete({
        user: user({
          avatarUrl: "https://example.test/a.png",
          preferences: {},
        }),
        serverCount: 1,
        friendCount: 1,
      }),
    ).toBe(true);
  });

  it("does not stamp when there is no preference store to stamp", () => {
    expect(
      shouldStampFirstRunComplete({
        user: user({ avatarUrl: "https://example.test/a.png", preferences: undefined }),
        serverCount: 1,
        friendCount: 1,
      }),
    ).toBe(false);
  });
});

describe("firstRunDismissedPatch", () => {
  it("carries the instant as ISO, and nothing else", () => {
    const patch = firstRunDismissedPatch(new Date("2026-08-08T12:00:00.000Z"));
    expect(patch).toEqual({ firstRunDismissedAt: "2026-08-08T12:00:00.000Z" });
  });
});
