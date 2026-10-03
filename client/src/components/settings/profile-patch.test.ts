import { describe, expect, it } from "vitest";
import type { User } from "@pqp/shared";
import {
  buildProfilePatch,
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
