import { describe, expect, it } from "vitest";
import type { User } from "@pqp/shared";
import { ApiError } from "@/lib/api";
import { en } from "@/lib/i18n";
import {
  handleErrorMessage,
  isValidUsername,
  joinFromRoomStep,
  normalizeInviteCode,
  normalizeUsername,
  onboardingCompletedPatch,
  onboardingPath,
  screenPosition,
  screensFor,
  shouldRunOnboarding,
  tagWasReassigned,
} from "./onboarding";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    clerkId: "user_test",
    displayName: "joao@example.com",
    username: "joao_example_com",
    discriminator: "0417",
    tag: "joao_example_com#0417",
    avatarUrl: null,
    customStatus: null,
    bannerUrl: null,
    handle: null,
    handleChangedAt: null,
    preferences: {},
    dmPrivacy: "server_members",
    ageGate: "passed",
    isInstanceModerator: false,
    ...overrides,
  };
}

describe("shouldRunOnboarding", () => {
  it("shows the flow for a new user", () => {
    // A brand-new account: preferences row exists (the API always sends one)
    // but nothing has ever been stored in it.
    expect(shouldRunOnboarding(makeUser())).toBe(true);
  });

  it("shows the flow for a new user who already changed an unrelated setting", () => {
    expect(
      shouldRunOnboarding(makeUser({ preferences: { theme: "light" } })),
    ).toBe(true);
  });

  it("does not show the flow again once it has been completed", () => {
    const done = makeUser({
      preferences: onboardingCompletedPatch(new Date("2026-08-07T12:00:00Z")),
    });
    expect(shouldRunOnboarding(done)).toBe(false);
  });

  it("does not show the flow again after it was skipped", () => {
    // Skipping writes the same key as finishing. There is no third state, on
    // purpose: "skipped" and "done" want identical behaviour forever after.
    expect(shouldRunOnboarding(makeUser({ preferences: onboardingCompletedPatch() }))).toBe(
      false,
    );
  });

  it("does not show the flow for an existing user", () => {
    // What the `onboarding_grandfather_2026_08` backfill writes to every
    // account that existed before the flow shipped. Indistinguishable from a
    // completed run by design — both mean "do not surprise this person".
    const existing = makeUser({
      preferences: { theme: "dark", onboardedAt: "2026-08-07T00:00:00Z" },
    });
    expect(shouldRunOnboarding(existing)).toBe(false);
  });

  it("does not show the flow when the API predates the preference store", () => {
    // Nowhere to record that it ran, so running it would mean running it on
    // every sign-in for the rest of that deployment's life.
    expect(shouldRunOnboarding(makeUser({ preferences: undefined }))).toBe(false);
  });

  it("does not show the flow when there is no user yet", () => {
    expect(shouldRunOnboarding(null)).toBe(false);
  });

  it("stamps completion as an ISO instant", () => {
    expect(onboardingCompletedPatch(new Date("2026-08-07T12:34:56Z"))).toEqual({
      onboardedAt: "2026-08-07T12:34:56.000Z",
    });
  });
});

describe("normalizeUsername", () => {
  it("lowercases and drops what the schema forbids", () => {
    expect(normalizeUsername("João Silva")).toBe("joosilva");
    expect(normalizeUsername("Cool_Name99")).toBe("cool_name99");
  });

  it("stops at the 32-character ceiling the schema enforces", () => {
    expect(normalizeUsername("a".repeat(50))).toHaveLength(32);
  });

  it("agrees with the shared schema about what is valid", () => {
    expect(isValidUsername("cool_name")).toBe(true);
    expect(isValidUsername("a")).toBe(false);
    expect(isValidUsername("Cool")).toBe(false);
    expect(isValidUsername("")).toBe(false);
  });
});

describe("a taken username", () => {
  it("is reported as a name to change rather than an action to retry", () => {
    // 409 is an exhausted namespace: all 9,999 numbers behind the name are
    // gone. "Try again" would be an instruction to repeat what cannot work.
    const key = handleErrorMessage(
      new ApiError(409, "That username has no numbers left."),
    );
    expect(key).toBe("onboarding.you.error.taken");
    expect(en[key]).toMatch(/pick another|another one/i);
  });

  it("never produces a message that ends the flow", () => {
    for (const error of [
      new ApiError(409, "exhausted"),
      new ApiError(400, "bad"),
      new ApiError(422, "bad"),
      new ApiError(500, "boom"),
      new TypeError("offline"),
      null,
    ]) {
      const key = handleErrorMessage(error);
      // Every branch resolves to a real sentence the user can act on, so the
      // step always re-renders with an editable field behind the message.
      expect(en[key]).toBeTruthy();
      expect(en[key]).not.toBe(key);
    }
  });

  it("distinguishes a rejected name from a rejected request", () => {
    expect(handleErrorMessage(new ApiError(400, "bad"))).toBe(
      "onboarding.you.error.invalid",
    );
    expect(handleErrorMessage(new ApiError(503, "down"))).toBe(
      "onboarding.you.error.generic",
    );
  });

  it("notices when the server quietly handed back a different number", () => {
    // The common collision: the name was free but `name#0417` was not, so
    // `updateProfile` allocated a new discriminator and answered 200.
    expect(tagWasReassigned("joao", "joao_example_com#0417", "joao#5512")).toBe(
      true,
    );
  });

  it("says nothing when the tag is exactly what was asked for", () => {
    expect(tagWasReassigned("joao", "joao#0417", "joao#0417")).toBe(false);
    expect(tagWasReassigned("joao", "old#0417", null)).toBe(false);
  });
});

describe("normalizeInviteCode", () => {
  it("takes the code out of whatever was pasted", () => {
    expect(normalizeInviteCode("  AB12CD  ")).toBe("AB12CD");
    expect(normalizeInviteCode("https://pqp.gg/app/invite/AB12CD")).toBe("AB12CD");
    expect(normalizeInviteCode("pqp://invite/AB12CD")).toBe("AB12CD");
    expect(normalizeInviteCode("/app/invite/AB12CD?from=whatsapp")).toBe("AB12CD");
    expect(
      normalizeInviteCode("https://pqp.gg/app/invite/AB12CD?ref=onboarding"),
    ).toBe("AB12CD");
    expect(normalizeInviteCode("pqp.gg/app/invite/AB12CD?ref=discord")).toBe("AB12CD");
    expect(normalizeInviteCode("pqp.gg/i/AB12CD")).toBe("AB12CD");
    expect(normalizeInviteCode("https://pqp.gg/i/AB12CD/")).toBe("AB12CD");
  });

  it("survives an input with nothing usable in it", () => {
    expect(normalizeInviteCode("")).toBe("");
    expect(normalizeInviteCode("///")).toBe("");
  });
});

describe("first-run screens", () => {
  it("an invitee sees two screens, and both are counted from the gate", () => {
    const path = onboardingPath({ invite: true, importing: false });
    expect(path).toBe("invite");
    expect(screensFor(path)).toEqual(["age", "you"]);
    expect(screenPosition(path, "age")).toEqual({ index: 0, total: 2 });
    expect(screenPosition(path, "you")).toEqual({ index: 1, total: 2 });
  });

  it("an import link is two screens too: the dialog takes it from there", () => {
    const path = onboardingPath({ invite: false, importing: true });
    expect(path).toBe("import");
    expect(screensFor(path)).toEqual(["age", "you"]);
  });

  it("a cold organizer gets four, and the last one is the invite", () => {
    const path = onboardingPath({ invite: false, importing: false });
    expect(screensFor(path)).toEqual(["age", "you", "room", "ready"]);
    expect(screenPosition(path, "ready")).toEqual({ index: 3, total: 4 });
  });

  it("an invite outranks an import intent", () => {
    expect(onboardingPath({ invite: true, importing: true })).toBe("invite");
  });

  it("clamps a screen the path does not have to the last dot", () => {
    expect(screenPosition("invite", "ready")).toEqual({ index: 1, total: 2 });
  });
});

describe("joinFromRoomStep", () => {
  const opened = async () => {};

  it("sends the API the code, not the pasted link", async () => {
    for (const input of [
      "https://pqp.gg/app/invite/AB12CD?ref=onboarding",
      "pqp.gg/app/invite/AB12CD?ref=discord",
      "pqp.gg/i/AB12CD",
      "  AB12CD ",
    ]) {
      const sent: string[] = [];
      const result = await joinFromRoomStep({
        input,
        joinedId: null,
        joinInvite: async (code) => {
          sent.push(code);
          return { serverId: "s1" };
        },
        openJoined: opened,
      });
      expect(sent).toEqual(["AB12CD"]);
      expect(result).toEqual({ kind: "opened", serverId: "s1" });
    }
  });

  it("does not finish when the join worked and the room did not open", async () => {
    const result = await joinFromRoomStep({
      input: "AB12CD",
      joinedId: null,
      joinInvite: async () => ({ serverId: "s1" }),
      openJoined: async () => {
        throw new Error("refresh failed");
      },
    });
    // Resolves (no unhandled rejection) with a retry state, not "opened".
    expect(result).toEqual({ kind: "notOpened", serverId: "s1" });
  });

  it("retries only the opening once the join is known to have worked", async () => {
    let joins = 0;
    const result = await joinFromRoomStep({
      input: "ignored",
      joinedId: "s1",
      joinInvite: async () => {
        joins += 1;
        return { serverId: "s2" };
      },
      openJoined: opened,
    });
    expect(joins).toBe(0);
    expect(result).toEqual({ kind: "opened", serverId: "s1" });
  });

  it("reports a refused or empty code as invalid, without opening anything", async () => {
    let opens = 0;
    const open = async () => {
      opens += 1;
    };
    expect(
      await joinFromRoomStep({
        input: "   ",
        joinedId: null,
        joinInvite: async () => ({ serverId: "x" }),
        openJoined: open,
      }),
    ).toEqual({ kind: "invalid" });
    expect(
      await joinFromRoomStep({
        input: "dead",
        joinedId: null,
        joinInvite: async () => {
          throw new Error("404");
        },
        openJoined: open,
      }),
    ).toEqual({ kind: "invalid" });
    expect(opens).toBe(0);
  });
});
