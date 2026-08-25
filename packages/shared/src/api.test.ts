import { describe, expect, it } from "vitest";
import {
  buildReplyExcerpt,
  createChannelSchema,
  extractMentionUsernames,
  formatUserTag,
  messageBodySchema,
  messageReplyRefSchema,
  messageSchema,
  reactionEmojiSchema,
  REPLY_EXCERPT_MAX_LENGTH,
  updateProfileSchema,
  userPreferencesSchema,
} from "./api.js";
import { messageCreateMessageSchema } from "./chat.js";
import { gifSchema, isGifMediaUrl, stillGifUrl } from "./gifs.js";
import {
  messageSearchQuerySchema,
  parseSearchSnippet,
  SEARCH_HIGHLIGHT_CLOSE,
  SEARCH_HIGHLIGHT_OPEN,
} from "./search.js";

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

  it("accepts a partial, trimmed acquisition and bounds every field", () => {
    const parsed = updateProfileSchema.safeParse({
      acquisition: { source: "  google ", campaign: "tela-br", landing: "/tela" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.acquisition).toEqual({
        source: "google",
        campaign: "tela-br",
        landing: "/tela",
      });
    }
    expect(updateProfileSchema.safeParse({ acquisition: {} }).success).toBe(true);
    // A query string is user-writable, so the bound is the whole defence.
    expect(
      updateProfileSchema.safeParse({ acquisition: { source: "x".repeat(101) } })
        .success,
    ).toBe(false);
    expect(
      updateProfileSchema.safeParse({ acquisition: { gclid: "x".repeat(200) } })
        .success,
    ).toBe(true);
    expect(
      updateProfileSchema.safeParse({ acquisition: { gclid: "x".repeat(201) } })
        .success,
    ).toBe(false);
    expect(
      updateProfileSchema.safeParse({ acquisition: { source: 42 } }).success,
    ).toBe(false);
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

  it("accepts a sounds patch without requiring every cue", () => {
    expect(
      userPreferencesSchema.safeParse({
        sounds: { enabled: true, message: false },
      }).success,
    ).toBe(true);
  });

  it("rejects a theme outside the three the stylesheet defines", () => {
    expect(userPreferencesSchema.safeParse({ theme: "neon" }).success).toBe(false);
  });

  it("accepts the four appearance skins and rejects a brand name", () => {
    expect(userPreferencesSchema.safeParse({ appearance: "signal" }).success).toBe(
      true,
    );
    expect(userPreferencesSchema.safeParse({ appearance: "harmony" }).success).toBe(
      true,
    );
    expect(userPreferencesSchema.parse({ appearance: "guild" })).toEqual({
      appearance: "harmony",
    });
    expect(userPreferencesSchema.parse({ appearance: "accord" })).toEqual({
      appearance: "harmony",
    });
    expect(userPreferencesSchema.safeParse({ appearance: "hearth" }).success).toBe(
      true,
    );
    expect(userPreferencesSchema.safeParse({ appearance: "night" }).success).toBe(
      true,
    );
    expect(
      userPreferencesSchema.safeParse({ appearance: "discord" }).success,
    ).toBe(false);
    expect(
      userPreferencesSchema.safeParse({ appearance: "onyx" }).success,
    ).toBe(false);
  });

  it("accepts a default or integer accent hue", () => {
    expect(userPreferencesSchema.safeParse({ accentHue: "default" }).success).toBe(
      true,
    );
    expect(userPreferencesSchema.safeParse({ accentHue: 210 }).success).toBe(true);
    expect(userPreferencesSchema.safeParse({ accentHue: 361 }).success).toBe(
      false,
    );
    expect(userPreferencesSchema.safeParse({ accentHue: 12.5 }).success).toBe(
      false,
    );
  });

  it("accepts the three contrast preferences", () => {
    expect(userPreferencesSchema.safeParse({ contrast: "default" }).success).toBe(
      true,
    );
    expect(userPreferencesSchema.safeParse({ contrast: "more" }).success).toBe(
      true,
    );
    expect(userPreferencesSchema.safeParse({ contrast: "system" }).success).toBe(
      true,
    );
    expect(userPreferencesSchema.safeParse({ contrast: "loud" }).success).toBe(
      false,
    );
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

describe("buildReplyExcerpt", () => {
  it("flattens a multi-line body to one line", () => {
    expect(buildReplyExcerpt("first\n\nsecond   third")).toBe(
      "first second third",
    );
  });

  it("truncates to something the schema will accept", () => {
    const excerpt = buildReplyExcerpt("x".repeat(400));
    expect(excerpt.length).toBeLessThanOrEqual(REPLY_EXCERPT_MAX_LENGTH);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(messageReplyRefSchema.shape.excerpt.safeParse(excerpt).success).toBe(
      true,
    );
  });

  it("does not cut an emoji in half", () => {
    // A lone surrogate renders as U+FFFD, which looks like a corrupt message.
    const excerpt = buildReplyExcerpt(`${"a".repeat(118)}🔥tail`);
    expect(excerpt).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(excerpt.length).toBeLessThanOrEqual(REPLY_EXCERPT_MAX_LENGTH);
  });

  it("leaves a short body untouched", () => {
    expect(buildReplyExcerpt("  short  ")).toBe("short");
  });
});

describe("reply protocol", () => {
  it("defaults replyTo to null so pre-reply clients still parse a message", () => {
    const parsed = messageSchema.parse({
      id: "00000000-0000-4000-8000-000000000001",
      channelId: "00000000-0000-4000-8000-000000000002",
      authorId: "00000000-0000-4000-8000-000000000003",
      authorName: "A",
      authorTag: null,
      authorAvatarUrl: null,
      body: "hi",
      createdAt: new Date(0).toISOString(),
    });
    expect(parsed.replyTo).toBeNull();
  });

  it("represents a parent that is gone with no author", () => {
    expect(
      messageReplyRefSchema.safeParse({
        id: "00000000-0000-4000-8000-000000000001",
        authorId: null,
        authorName: null,
        excerpt: "",
        deleted: true,
      }).success,
    ).toBe(true);
  });

  it("only accepts a uuid as the parent on the wire", () => {
    const base = {
      type: "message-create" as const,
      channelId: "00000000-0000-4000-8000-000000000002",
      body: "hi",
    };
    expect(messageCreateMessageSchema.safeParse(base).success).toBe(true);
    expect(
      messageCreateMessageSchema.safeParse({ ...base, replyToId: "nope" })
        .success,
    ).toBe(false);
  });
});

describe("isGifMediaUrl", () => {
  it("accepts the media hosts the picker actually returns", () => {
    expect(
      isGifMediaUrl("https://media3.giphy.com/media/abc123/giphy.gif"),
    ).toBe(true);
    expect(isGifMediaUrl("https://media.giphy.com/media/abc/giphy.webp")).toBe(
      true,
    );
    expect(isGifMediaUrl("https://i.giphy.com/abc123.gif")).toBe(true);
    expect(isGifMediaUrl("https://media.tenor.com/xyz/happy-dance.gif")).toBe(
      true,
    );
  });

  it("keeps query strings, which every CDN URL carries", () => {
    expect(
      isGifMediaUrl("https://media0.giphy.com/media/abc/giphy.gif?cid=1&ct=g"),
    ).toBe(true);
  });

  it("refuses any host outside the allowlist", () => {
    // The whole point of the allowlist: an arbitrary host must render as a
    // link, never as an image the reader's browser fetches on sight.
    expect(isGifMediaUrl("https://evil.example/tracker.gif")).toBe(false);
    expect(isGifMediaUrl("https://giphy.com.evil.example/giphy.gif")).toBe(
      false,
    );
    expect(isGifMediaUrl("https://notgiphy.com/media/abc/giphy.gif")).toBe(
      false,
    );
  });

  it("refuses http and embedded credentials", () => {
    expect(isGifMediaUrl("http://media.giphy.com/media/abc/giphy.gif")).toBe(
      false,
    );
    expect(
      isGifMediaUrl("https://user:pw@media.giphy.com/media/abc/giphy.gif"),
    ).toBe(false);
  });

  it("refuses a credential-shaped URL whose real host is elsewhere", () => {
    expect(isGifMediaUrl("https://media.giphy.com@evil.example/a.gif")).toBe(
      false,
    );
  });

  it("refuses paths that are not images, and non-URLs", () => {
    expect(isGifMediaUrl("https://media.giphy.com/media/abc/giphy.mp4")).toBe(
      false,
    );
    expect(isGifMediaUrl("https://media.giphy.com/media/abc")).toBe(false);
    expect(isGifMediaUrl("just some text")).toBe(false);
  });
});

describe("stillGifUrl", () => {
  it("derives GIPHY's still rendition", () => {
    expect(stillGifUrl("https://media2.giphy.com/media/abc/giphy.gif")).toBe(
      "https://media2.giphy.com/media/abc/giphy_s.gif",
    );
  });

  it("returns null where no still can be named", () => {
    // Tenor publishes no derivable still, and inventing one would 404.
    expect(stillGifUrl("https://media.tenor.com/xyz/dance.gif")).toBeNull();
    expect(stillGifUrl("https://media.giphy.com/media/abc/200w.gif")).toBeNull();
    expect(stillGifUrl("https://evil.example/giphy.gif")).toBeNull();
  });
});

describe("gifSchema", () => {
  const gif = {
    id: "abc123",
    url: "https://media.giphy.com/media/abc/giphy.gif",
    previewUrl: "https://media.giphy.com/media/abc/200w.gif",
    previewStillUrl: null,
    width: 200,
    height: 150,
    title: "a cat",
  };

  it("accepts the normalised shape the proxy emits", () => {
    expect(gifSchema.safeParse(gif).success).toBe(true);
  });

  it("requires positive integer dimensions the grid can lay out with", () => {
    expect(gifSchema.safeParse({ ...gif, width: 0 }).success).toBe(false);
    expect(gifSchema.safeParse({ ...gif, height: 1.5 }).success).toBe(false);
  });

  it("requires a still to be null rather than absent", () => {
    const { previewStillUrl: _omitted, ...withoutStill } = gif;
    expect(gifSchema.safeParse(withoutStill).success).toBe(false);
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

describe("messageSearchQuerySchema", () => {
  it("accepts an ordinary phrase", () => {
    expect(messageSearchQuerySchema.safeParse("deploy notes").success).toBe(true);
  });

  it("rejects a query too short to be worth a database round trip", () => {
    expect(messageSearchQuerySchema.safeParse("a").success).toBe(false);
    expect(messageSearchQuerySchema.safeParse("x".repeat(201)).success).toBe(
      false,
    );
  });

  it("rejects control characters, which Postgres cannot take as parameters", () => {
    expect(
      messageSearchQuerySchema.safeParse(`bad${String.fromCharCode(0)}`).success,
    ).toBe(false);
  });
});

describe("parseSearchSnippet", () => {
  const open = SEARCH_HIGHLIGHT_OPEN;
  const close = SEARCH_HIGHLIGHT_CLOSE;

  it("splits a snippet into plain and matched runs", () => {
    expect(parseSearchSnippet(`the ${open}otter${close} swims`)).toEqual([
      { text: "the ", match: false },
      { text: "otter", match: true },
      { text: " swims", match: false },
    ]);
  });

  it("handles a match at either end and several matches", () => {
    expect(parseSearchSnippet(`${open}a${close} b ${open}c${close}`)).toEqual([
      { text: "a", match: true },
      { text: " b ", match: false },
      { text: "c", match: true },
    ]);
  });

  it("returns nothing for an empty snippet", () => {
    expect(parseSearchSnippet("")).toEqual([]);
  });

  it("never leaks a delimiter into the text it emits", () => {
    for (const segment of parseSearchSnippet(`stray ${close} marker ${open}x`)) {
      expect(segment.text).not.toContain(open);
      expect(segment.text).not.toContain(close);
    }
  });
});
