import { describe, expect, it } from "vitest";
import {
  createChannelSchema,
  extractMentionUsernames,
  formatUserTag,
  messageBodySchema,
  reactionEmojiSchema,
  updateProfileSchema,
  userPreferencesSchema,
} from "./api.js";

describe("messageBodySchema", () => {
  it("accepts ordinary and multi-line text", () => {
    expect(messageBodySchema.safeParse("hello").success).toBe(true);
    expect(messageBodySchema.safeParse("line one\nline two\ttabbed").success).toBe(
      true,
    );
  });

  it("rejects empty and oversized bodies", () => {
    expect(messageBodySchema.safeParse("").success).toBe(false);
    expect(messageBodySchema.safeParse("x".repeat(4001)).success).toBe(false);
  });

  it("rejects control characters that Postgres cannot store", () => {
    // A NUL byte in a text parameter raises SQLSTATE 22021 at the driver level,
    // which would surface as a 500 rather than a validation error.
    const nul = String.fromCharCode(0);
    const bell = String.fromCharCode(7);
    const del = String.fromCharCode(127);
    expect(messageBodySchema.safeParse(`bad${nul}byte`).success).toBe(false);
    expect(messageBodySchema.safeParse(`bell${bell}`).success).toBe(false);
    expect(messageBodySchema.safeParse(`del${del}`).success).toBe(false);
  });
});

describe("reactionEmojiSchema", () => {
  it("accepts emoji", () => {
    expect(reactionEmojiSchema.safeParse("🔥").success).toBe(true);
  });

  it("rejects whitespace and control characters", () => {
    expect(reactionEmojiSchema.safeParse("a b").success).toBe(false);
    expect(reactionEmojiSchema.safeParse(" ").success).toBe(false);
    expect(
      reactionEmojiSchema.safeParse(`x${String.fromCharCode(0)}`).success,
    ).toBe(false);
    expect(reactionEmojiSchema.safeParse("x".repeat(33)).success).toBe(false);
  });
});

describe("extractMentionUsernames", () => {
  it("finds usernames and lowercases them", () => {
    expect(extractMentionUsernames("hey @alice and @Bob_2")).toEqual([
      "alice",
      "bob_2",
    ]);
  });

  it("dedupes repeats", () => {
    expect(extractMentionUsernames("@alice @alice")).toEqual(["alice"]);
  });

  it("ignores things that are not usernames", () => {
    // A single character is below the two-character minimum.
    expect(extractMentionUsernames("email me at a@b.com")).toEqual([]);
    expect(extractMentionUsernames("@a")).toEqual([]);
    expect(extractMentionUsernames("no mentions here")).toEqual([]);
  });

  it("is not stateful across calls despite the shared global regex", () => {
    // A /g regex carries lastIndex; reusing one across calls is a classic bug.
    expect(extractMentionUsernames("@alice")).toEqual(["alice"]);
    expect(extractMentionUsernames("@alice")).toEqual(["alice"]);
  });
});

describe("createChannelSchema", () => {
  it("accepts slug-like names", () => {
    expect(createChannelSchema.safeParse({ name: "general", type: "text" }).success).toBe(
      true,
    );
  });

  it("rejects spaces and punctuation", () => {
    expect(
      createChannelSchema.safeParse({ name: "not ok!", type: "text" }).success,
    ).toBe(false);
  });

  it("rejects unknown channel types", () => {
    expect(
      createChannelSchema.safeParse({ name: "ok", type: "video" }).success,
    ).toBe(false);
  });
});

describe("updateProfileSchema", () => {
  it("requires an http(s) or root-relative avatar", () => {
    expect(
      updateProfileSchema.safeParse({ avatarUrl: "https://x.example/a.png" }).success,
    ).toBe(true);
    expect(updateProfileSchema.safeParse({ avatarUrl: "/local.png" }).success).toBe(
      true,
    );
    expect(
      updateProfileSchema.safeParse({ avatarUrl: "javascript:alert(1)" }).success,
    ).toBe(false);
  });

  it("constrains usernames to the slug charset", () => {
    expect(updateProfileSchema.safeParse({ username: "good_name1" }).success).toBe(
      true,
    );
    expect(updateProfileSchema.safeParse({ username: "Bad Name" }).success).toBe(
      false,
    );
    expect(updateProfileSchema.safeParse({ username: "a" }).success).toBe(false);
  });
});

describe("userPreferencesSchema", () => {
  it("accepts a partial patch and an empty one", () => {
    expect(userPreferencesSchema.safeParse({ theme: "light" }).success).toBe(true);
    expect(userPreferencesSchema.safeParse({}).success).toBe(true);
  });

  it("bounds the volumes to the ranges the UI exposes", () => {
    expect(userPreferencesSchema.safeParse({ inputVolume: 2 }).success).toBe(true);
    expect(userPreferencesSchema.safeParse({ inputVolume: 2.5 }).success).toBe(
      false,
    );
    // Output is attenuation only — there is no gain stage on playback.
    expect(userPreferencesSchema.safeParse({ outputVolume: 1 }).success).toBe(true);
    expect(userPreferencesSchema.safeParse({ outputVolume: 1.5 }).success).toBe(
      false,
    );
  });

  it("rejects a theme outside the three the stylesheet defines", () => {
    expect(userPreferencesSchema.safeParse({ theme: "neon" }).success).toBe(false);
  });

  it("drops audio device ids so they cannot follow a user to another machine", () => {
    const parsed = userPreferencesSchema.parse({
      muteOnJoin: true,
      inputDeviceId: "3f9c…-mic",
      outputDeviceId: "a71b…-speakers",
    });
    expect(parsed).toEqual({ muteOnJoin: true });
  });
});

describe("formatUserTag", () => {
  it("joins username and discriminator", () => {
    expect(formatUserTag("alice", "0042")).toBe("alice#0042");
  });

  it("returns null when either half is missing", () => {
    expect(formatUserTag(null, "0042")).toBeNull();
    expect(formatUserTag("alice", null)).toBeNull();
  });
});
