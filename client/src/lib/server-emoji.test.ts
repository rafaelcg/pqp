import { describe, expect, it } from "vitest";
import type { ServerEmoji } from "@pqp/shared";
import { expandEmojiShortcodes } from "@/lib/emoji-shortcodes";
import {
  collapseCustomEmojiTokens,
  expandCustomEmoji,
  filterCustomEmoji,
} from "@/lib/server-emoji";
import { containRect } from "@/lib/server-emoji-upload";

const POG = "3f2a1c9e-0b1d-4c5e-8f6a-7b8c9d0e1f2a";
const FIRE = "7b8c9d0e-1f2a-4c5e-8f6a-3f2a1c9e0b1d";

function emoji(name: string, id: string): ServerEmoji {
  return {
    id,
    serverId: "00000000-0000-4000-8000-000000000000",
    name,
    url: `/api/emoji/${id}?v=abcd1234`,
    createdBy: null,
    createdAt: "2026-10-12T00:00:00.000Z",
  };
}

const LIST = [emoji("pog", POG), emoji("fire", FIRE)];

describe("expandCustomEmoji", () => {
  it("turns a known :name: into the stored token", () => {
    expect(expandCustomEmoji("gg :pog: wp", LIST)).toBe(`gg <:pog:${POG}> wp`);
  });

  it("leaves a name this server does not have exactly as typed", () => {
    expect(expandCustomEmoji("so :kek: then", LIST)).toBe("so :kek: then");
  });

  it("expands two in a row and one glued to a word", () => {
    expect(expandCustomEmoji(":pog::pog: gg:pog:", LIST)).toBe(
      `<:pog:${POG}><:pog:${POG}> gg<:pog:${POG}>`,
    );
  });

  it("never touches inline or fenced code", () => {
    const body = "use `:pog:` like this\n```\n:pog:\n```\n:pog:";
    expect(expandCustomEmoji(body, LIST)).toBe(
      `use \`:pog:\` like this\n\`\`\`\n:pog:\n\`\`\`\n<:pog:${POG}>`,
    );
  });

  it("is idempotent on a body that already holds tokens", () => {
    const once = expandCustomEmoji(":pog:", LIST);
    expect(expandCustomEmoji(once, LIST)).toBe(once);
  });

  it("does nothing in a conversation (no list)", () => {
    expect(expandCustomEmoji(":pog:", null)).toBe(":pog:");
  });

  it("wins over a built-in shortcode of the same name, and the built-in pass leaves the token alone", () => {
    const sent = expandEmojiShortcodes(expandCustomEmoji(":fire: :heart:", LIST));
    expect(sent).toBe(`<:fire:${FIRE}> ❤️`);
  });
});

describe("collapseCustomEmojiTokens", () => {
  it("gives the edit box the :name: a person typed", () => {
    expect(collapseCustomEmojiTokens(`gg <:pog:${POG}> wp`)).toBe("gg :pog: wp");
  });

  it("round-trips through an edit", () => {
    const stored = `<:pog:${POG}> and <:fire:${FIRE}>`;
    expect(expandCustomEmoji(collapseCustomEmojiTokens(stored), LIST)).toBe(stored);
  });
});

describe("filterCustomEmoji", () => {
  const many = [emoji("kekw", POG), emoji("pog", FIRE), emoji("poggers", POG), emoji("epog", FIRE)];

  it("puts prefix matches first, then substring matches", () => {
    expect(filterCustomEmoji("pog", many).map((e) => e.name)).toEqual(["pog", "poggers", "epog"]);
  });

  it("caps the list", () => {
    expect(filterCustomEmoji("", many, 2)).toHaveLength(2);
  });
});

describe("containRect", () => {
  it("fits a wide picture inside the square without cropping", () => {
    expect(containRect(256, 128, 128)).toEqual({ x: 0, y: 32, width: 128, height: 64 });
  });

  it("scales a small square up to fill", () => {
    expect(containRect(32, 32, 128)).toEqual({ x: 0, y: 0, width: 128, height: 128 });
  });
});
