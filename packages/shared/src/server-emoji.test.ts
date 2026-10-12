import { describe, expect, it } from "vitest";
import { buildReplyExcerpt } from "./api.js";
import { deriveThreadName } from "./threads.js";
import {
  CUSTOM_EMOJI_TOKEN_PATTERN,
  createServerEmojiUploadSchema,
  customEmojiToken,
  customEmojiTokensAsText,
  isValidServerEmojiName,
  MAX_SERVER_EMOJI_BYTES,
  normalizeServerEmojiName,
} from "./server-emoji.js";

const ID = "3f2a1c9e-0b1d-4c5e-8f6a-7b8c9d0e1f2a";

describe("server emoji names", () => {
  it.each(["pog", "kek_w", "a1", "x".repeat(32)])("accepts %s", (name) => {
    expect(isValidServerEmojiName(name)).toBe(true);
  });

  it.each(["a", "x".repeat(33), "Pog", "two words", "pão", "pog!", ":pog:", ""])(
    "refuses %j",
    (name) => {
      expect(isValidServerEmojiName(name)).toBe(false);
    },
  );

  it.each([
    ["Pog Champ.png", "pog_champ"],
    ["coração-partido.webp", "coracao_partido"],
    ["  --kek--  ", "kek"],
    ["😀.png", ""],
    ["a".repeat(40), "a".repeat(32)],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeServerEmojiName(input)).toBe(expected);
  });
});

describe("the upload request", () => {
  it("refuses a byte size of zero and an animated or scriptable type", () => {
    const base = { name: "pog", contentType: "image/png", byteSize: 100 };
    expect(createServerEmojiUploadSchema.safeParse(base).success).toBe(true);
    expect(createServerEmojiUploadSchema.safeParse({ ...base, byteSize: 0 }).success).toBe(false);
    for (const contentType of ["image/gif", "image/svg+xml"]) {
      expect(createServerEmojiUploadSchema.safeParse({ ...base, contentType }).success).toBe(
        false,
      );
    }
    expect(MAX_SERVER_EMOJI_BYTES).toBe(256 * 1024);
  });
});

describe("the message token", () => {
  it("round-trips name and id", () => {
    const body = `gg ${customEmojiToken("pog", ID)} wp`;
    const matches = [...body.matchAll(CUSTOM_EMOJI_TOKEN_PATTERN)];
    expect(matches).toHaveLength(1);
    expect(matches[0]![1]).toBe("pog");
    expect(matches[0]![2]).toBe(ID);
  });

  it("ignores a bare :name: and a malformed id", () => {
    expect([..."so :pog: and <:pog:not-a-uuid>".matchAll(CUSTOM_EMOJI_TOKEN_PATTERN)]).toEqual(
      [],
    );
  });
});

describe("plain-text surfaces", () => {
  const body = `gg ${customEmojiToken("pog", ID)}${customEmojiToken("kek", ID)} wp`;

  it("read a token as the :name: that was typed", () => {
    expect(customEmojiTokensAsText(body)).toBe("gg :pog::kek: wp");
  });

  it("apply to a reply excerpt and a thread name", () => {
    expect(buildReplyExcerpt(body)).toBe("gg :pog::kek: wp");
    expect(deriveThreadName(body)).toBe("gg :pog::kek: wp");
  });
});
