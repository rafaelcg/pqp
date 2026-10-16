// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEmoji } from "@pqp/shared";
import { expandEmojiShortcodes } from "@/lib/emoji-shortcodes";
import {
  collapseCustomEmojiTokens,
  customEmojiTokensIn,
  expandCustomEmoji,
  filterCustomEmoji,
  getCachedServerEmoji,
  loadServerEmoji,
  serverEmojiLoadFailed,
  setServerEmojiList,
  updateServerEmojiList,
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
    createdByName: null,
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

  it("stops expanding where the body would pass the message limit", () => {
    const body = `${"x".repeat(3940)} :pog: :pog:`;
    const sent = expandCustomEmoji(body, LIST);
    expect(sent).toBe(`${"x".repeat(3940)} <:pog:${POG}> :pog:`);
    expect(sent.length).toBeLessThanOrEqual(4000);
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

  it("leaves a token quoted in code as it is", () => {
    const stored = `\`<:pog:${POG}>\` <:pog:${POG}>`;
    expect(collapseCustomEmojiTokens(stored)).toBe(`\`<:pog:${POG}>\` :pog:`);
  });

  it("keeps a renamed emoji through an edit, with the held tokens on top", () => {
    // Stored as :old:, since renamed to :pog:; a new :old: belongs to FIRE.
    const stored = `<:old:${POG}> gg`;
    const renamed = [emoji("pog", POG), emoji("old", FIRE)];
    const edited = `${collapseCustomEmojiTokens(stored)} :pog:`;
    expect(expandCustomEmoji(edited, [...renamed, ...customEmojiTokensIn(stored)])).toBe(
      `<:old:${POG}> gg <:pog:${POG}>`,
    );
  });

  it("keeps every token when the list has not loaded", () => {
    const stored = `<:pog:${POG}> <:fire:${FIRE}>`;
    expect(
      expandCustomEmoji(collapseCustomEmojiTokens(stored), customEmojiTokensIn(stored)),
    ).toBe(stored);
  });
});

describe("the emoji cache", () => {
  const SERVER = "22222222-2222-4222-8222-222222222222";
  const listOf = (entries: ServerEmoji[]) => ({
    emoji: entries,
    limit: 50,
    uploadEnabled: true,
    maxBytes: 262144,
    size: 128,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies two writes to the latest list, not to the list each one started from", () => {
    const server = `${SERVER}-a`;
    setServerEmojiList(server, listOf([emoji("pog", POG), emoji("fire", FIRE)]));
    updateServerEmojiList(server, (current) =>
      current.map((e) => (e.id === POG ? emoji("pog2", POG) : e)),
    );
    updateServerEmojiList(server, (current) =>
      current.map((e) => (e.id === FIRE ? emoji("fire2", FIRE) : e)),
    );
    expect(getCachedServerEmoji(server)?.emoji.map((e) => e.name)).toEqual(["fire2", "pog2"]);
  });

  it("drops a read that started before a write", async () => {
    const server = `${SERVER}-b`;
    setServerEmojiList(server, listOf([emoji("pog", POG)]));
    let answer: (response: Response) => void = () => {};
    let asked: () => void = () => {};
    const fetchStarted = new Promise<void>((resolve) => (asked = resolve));
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
          asked();
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const read = loadServerEmoji(server, true);
    await fetchStarted;
    updateServerEmojiList(server, () => []);
    answer(
      new Response(JSON.stringify(listOf([emoji("pog", POG)])), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await read;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getCachedServerEmoji(server)?.emoji).toEqual([]);
  });

  it("reads again after a write that found no list cached", async () => {
    const server = `${SERVER}-d`;
    const answers: Array<(response: Response) => void> = [];
    let asked: () => void = () => {};
    let fetchStarted = new Promise<void>((resolve) => (asked = resolve));
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answers.push(resolve);
          asked();
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ok = (entries: ServerEmoji[]) =>
      new Response(JSON.stringify(listOf(entries)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const first = loadServerEmoji(server);
    await fetchStarted;
    fetchStarted = new Promise<void>((resolve) => (asked = resolve));
    updateServerEmojiList(server, (current) => [...current, emoji("pog", POG)]);
    // The read that started before the write answers without the new emoji.
    answers[0]!(ok([]));
    await first;
    expect(getCachedServerEmoji(server)).toBeNull();

    await fetchStarted;
    answers[1]!(ok([emoji("pog", POG)]));
    await vi.waitFor(() =>
      expect(getCachedServerEmoji(server)?.emoji.map((e) => e.name)).toEqual(["pog"]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("says when the first read failed", async () => {
    const server = `${SERVER}-c`;
    const fetchMock = vi.fn(
      async () =>
        new Response("{}", { status: 500, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await loadServerEmoji(server);
    expect(fetchMock).toHaveBeenCalled();
    expect(getCachedServerEmoji(server)).toBeNull();
    expect(serverEmojiLoadFailed(server)).toBe(true);
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
