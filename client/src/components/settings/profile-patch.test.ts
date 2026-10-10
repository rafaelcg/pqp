import { describe, expect, it } from "vitest";
import { updateProfileSchema, type User } from "@pqp/shared";
import { ApiError } from "@/lib/api";
import {
  AVATAR_URL_MAX_LENGTH,
  avatarLinkProblem,
  buildProfilePatch,
  hasBidiControl,
  isHandleTakenError,
  isProfileDirty,
  pendingHandleChange,
  profileDraftsFrom,
} from "@/components/settings/profile-patch";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    displayName: "Rafa",
    username: "rafa",
    discriminator: "0001",
    tag: "rafa#0001",
    avatarUrl: null,
    handle: null,
    handleChangedAt: null,
    ...overrides,
  } as unknown as User;
}

describe("buildProfilePatch", () => {
  it("leaves an unchanged display name out of the body", () => {
    const user = makeUser();
    const patch = buildProfilePatch(user, profileDraftsFrom(user));
    expect(patch).toEqual({
      displayName: undefined,
      username: "rafa",
      avatarUrl: null,
    });
    expect("handle" in patch).toBe(false);
  });

  it("sends a changed display name trimmed", () => {
    const user = makeUser();
    const patch = buildProfilePatch(user, {
      ...profileDraftsFrom(user),
      displayName: "  Rafael ",
    });
    expect(patch.displayName).toBe("Rafael");
  });

  it("sends a blank username as absent and a blank avatar as a clear", () => {
    const user = makeUser({ avatarUrl: "https://example.test/a.png" });
    const patch = buildProfilePatch(user, {
      displayName: "Rafa",
      username: "   ",
      handle: "",
      avatarUrl: " ",
    });
    expect(patch.username).toBeUndefined();
    expect(patch.avatarUrl).toBeNull();
  });

  it("sends the handle whenever it is non-empty, changed or not", () => {
    const user = makeUser({ handle: "rafa" });
    expect(buildProfilePatch(user, profileDraftsFrom(user)).handle).toBe("rafa");
    expect(
      buildProfilePatch(user, { ...profileDraftsFrom(user), handle: "rafa2" })
        .handle,
    ).toBe("rafa2");
  });

  it("never sends an empty handle, so the form cannot release one", () => {
    const user = makeUser({ handle: "rafa" });
    const patch = buildProfilePatch(user, {
      ...profileDraftsFrom(user),
      handle: "",
    });
    expect("handle" in patch).toBe(false);
  });
});

describe("isProfileDirty", () => {
  it("reads null and empty as the same value", () => {
    const user = makeUser({ handle: null, avatarUrl: null });
    expect(
      isProfileDirty(user, {
        displayName: "Rafa",
        username: "rafa",
        handle: "",
        avatarUrl: "",
      }),
    ).toBe(false);
  });

  it("ignores whitespace around a value", () => {
    const user = makeUser();
    expect(
      isProfileDirty(user, { ...profileDraftsFrom(user), displayName: " Rafa " }),
    ).toBe(false);
  });

  it("is dirty on any of the four fields", () => {
    const user = makeUser();
    const base = profileDraftsFrom(user);
    expect(isProfileDirty(user, { ...base, displayName: "R" })).toBe(true);
    expect(isProfileDirty(user, { ...base, username: "r" })).toBe(true);
    expect(isProfileDirty(user, { ...base, handle: "r" })).toBe(true);
    expect(isProfileDirty(user, { ...base, avatarUrl: "x" })).toBe(true);
  });

  it("does not count an emptied username or link as an edit", () => {
    const user = makeUser({ handle: "rafa" });
    const base = profileDraftsFrom(user);
    expect(isProfileDirty(user, { ...base, username: "" })).toBe(false);
    expect(isProfileDirty(user, { ...base, handle: "" })).toBe(false);
  });

  it("is never dirty without an account", () => {
    expect(
      isProfileDirty(null, {
        displayName: "x",
        username: "x",
        handle: "x",
        avatarUrl: "x",
      }),
    ).toBe(false);
  });
});

describe("pendingHandleChange", () => {
  it("is a claim for an account with no handle", () => {
    const user = makeUser();
    expect(
      pendingHandleChange(user, { ...profileDraftsFrom(user), handle: "rafa" }),
    ).toBe("claim");
  });

  it("is a change when a claimed handle differs", () => {
    const user = makeUser({ handle: "rafa" });
    expect(
      pendingHandleChange(user, { ...profileDraftsFrom(user), handle: "rafa2" }),
    ).toBe("change");
  });

  it("is nothing when the handle stays or is blank", () => {
    const user = makeUser({ handle: "rafa" });
    expect(pendingHandleChange(user, profileDraftsFrom(user))).toBeNull();
    expect(
      pendingHandleChange(user, { ...profileDraftsFrom(user), handle: "" }),
    ).toBeNull();
  });
});

describe("isHandleTakenError", () => {
  const withHandle = { handle: "rafa" };

  it("recognises the handle claim's 409", () => {
    expect(
      isHandleTakenError(new ApiError(409, "That handle is already taken"), withHandle),
    ).toBe(true);
  });

  it("ignores a username 409, a 409 without a handle in the patch, and other failures", () => {
    expect(
      isHandleTakenError(
        new ApiError(409, "That username has no numbers left. Please pick a different one."),
        withHandle,
      ),
    ).toBe(false);
    expect(
      isHandleTakenError(new ApiError(409, "That handle is already taken"), {}),
    ).toBe(false);
    expect(
      isHandleTakenError(new ApiError(429, "You can change your handle again on 2026-11-01"), withHandle),
    ).toBe(false);
    expect(isHandleTakenError(new Error("That handle is already taken"), withHandle)).toBe(
      false,
    );
  });
});

describe("avatarLinkProblem", () => {
  it("takes https links with a host and nothing else", () => {
    expect(avatarLinkProblem("https://example.com/a.png")).toBeNull();
    expect(avatarLinkProblem("http://example.com/a.png")).toBe("format");
    expect(avatarLinkProblem("//example.com/a.png")).toBe("format");
    expect(avatarLinkProblem("/api/avatars/1")).toBe("format");
    expect(avatarLinkProblem("https://")).toBe("format");
  });

  it("names the server's own length limit", () => {
    const at = `https://e.co/${"a".repeat(AVATAR_URL_MAX_LENGTH - 13)}`;
    expect(at.length).toBe(AVATAR_URL_MAX_LENGTH);
    expect(avatarLinkProblem(at)).toBeNull();
    expect(updateProfileSchema.safeParse({ avatarUrl: at }).success).toBe(true);
    expect(avatarLinkProblem(`${at}a`)).toBe("length");
    expect(updateProfileSchema.safeParse({ avatarUrl: `${at}a` }).success).toBe(false);
  });
});

describe("hasBidiControl", () => {
  it("finds the overrides, isolates and marks, and nothing in an ordinary name", () => {
    for (const ch of ["‪", "‮", "⁦", "⁩", "‎", "‏", "؜"]) {
      expect(hasBidiControl(`Rafa${ch}x`)).toBe(true);
    }
    expect(hasBidiControl("João da Silva ✨")).toBe(false);
    expect(hasBidiControl("محمد")).toBe(false);
  });
});
