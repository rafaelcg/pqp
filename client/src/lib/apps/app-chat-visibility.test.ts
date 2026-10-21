// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_CHAT_HIDDEN_KEY,
  appColumnLayout,
  chatUnreadSince,
  readAppChatHidden,
  UNREAD_SCAN_LIMIT,
  unreadBadgeText,
  writeAppChatHidden,
  type AppColumnLayoutInput,
} from "./app-chat-visibility";

const ME = "me";
const viewer = { id: ME, username: "rafa" };

function msg(id: string, authorId: string, body = "oi") {
  return { id, authorId, body };
}

afterEach(() => {
  window.localStorage.clear();
});

describe("the stored choice", () => {
  it("defaults to shown on a desktop and to hidden on a phone", () => {
    expect(readAppChatHidden(false)).toBe(false);
    expect(readAppChatHidden(true)).toBe(true);
  });

  it("remembers what the person chose, on either device", () => {
    writeAppChatHidden(true);
    expect(window.localStorage.getItem(APP_CHAT_HIDDEN_KEY)).toBe("1");
    expect(readAppChatHidden(false)).toBe(true);
    writeAppChatHidden(false);
    expect(readAppChatHidden(true)).toBe(false);
  });

  it("falls back to the default when storage throws", () => {
    const original = window.localStorage.getItem.bind(window.localStorage);
    Object.defineProperty(window.localStorage, "getItem", {
      configurable: true,
      value: () => {
        throw new Error("blocked");
      },
    });
    try {
      expect(readAppChatHidden(true)).toBe(true);
      expect(() => writeAppChatHidden(true)).not.toThrow();
    } finally {
      Object.defineProperty(window.localStorage, "getItem", {
        configurable: true,
        value: original,
      });
    }
  });
});

describe("what arrived while the chat was away", () => {
  const list = [msg("1", "bia"), msg("2", ME), msg("3", "bia"), msg("4", "caio")];
  const after = (id: string | null) => ({ id, at: 0 });

  it("counts other people's messages after the one that was newest", () => {
    expect(chatUnreadSince(list, after("1"), viewer)).toEqual({ count: 2, mention: false });
  });

  it("never counts the person's own messages", () => {
    expect(chatUnreadSince([msg("1", "bia"), msg("2", ME)], after("1"), viewer).count).toBe(0);
  });

  it("with no message to mark, only what is newer than the moment counts (history that loads later does not)", () => {
    const at = Date.parse("2026-10-21T12:00:00Z");
    const timed = [
      { ...msg("h1", "bia", "@rafa velho"), createdAt: "2026-10-21T11:00:00Z" },
      { ...msg("h2", "caio"), createdAt: "2026-10-21T11:59:00Z" },
      { ...msg("n1", "bia"), createdAt: "2026-10-21T12:00:05Z" },
    ];
    expect(chatUnreadSince(timed, { id: null, at }, viewer)).toEqual({ count: 1, mention: false });
  });

  it("a mention lights the count", () => {
    const named = [...list, msg("5", "bia", "@rafa bora?")];
    expect(chatUnreadSince(named, after("4"), viewer)).toEqual({ count: 1, mention: true });
    const everyone = [...list, { ...msg("5", "bia", "galera"), mentionEveryone: true }];
    expect(chatUnreadSince(everyone, after("4"), viewer).mention).toBe(true);
  });

  it("a page that no longer holds the mark counts nothing rather than everything", () => {
    expect(chatUnreadSince(list, after("gone"), viewer)).toEqual({ count: 0, mention: false });
  });

  it("looks back at most UNREAD_SCAN_LIMIT messages: a long absence counts, a replaced page does not", () => {
    const at = Date.parse("2026-10-21T12:00:00Z");
    const stamp = (i: number, base: number) => new Date(base + i * 1000).toISOString();
    const newer = Array.from({ length: UNREAD_SCAN_LIMIT + 50 }, (_, i) => ({
      ...msg(`m${i}`, "bia"),
      createdAt: stamp(i, at - 10_000),
    }));
    // m0..m9 are before the moment, the mark is m5; the last 100 are all after.
    expect(chatUnreadSince(newer, { id: "m5", at }, viewer).count).toBe(UNREAD_SCAN_LIMIT);
    // A jump to an older page of more than 100 messages, mark not in it.
    const older = Array.from({ length: UNREAD_SCAN_LIMIT + 50 }, (_, i) => ({
      ...msg(`o${i}`, "bia"),
      createdAt: stamp(i, at - 3_600_000),
    }));
    expect(chatUnreadSince(older, { id: "m5", at }, viewer)).toEqual({ count: 0, mention: false });
  });

  it("prints at most two characters", () => {
    expect(unreadBadgeText(3)).toBe("3");
    expect(unreadBadgeText(9)).toBe("9");
    expect(unreadBadgeText(10)).toBe("9+");
  });
});

describe("where the column goes", () => {
  const base: AppColumnLayoutInput = {
    paneVisible: true,
    md: true,
    chatHidden: false,
    inCall: true,
    callShape: "compact",
  };

  it("no app on screen: the conversation as always", () => {
    expect(appColumnLayout({ ...base, paneVisible: false })).toEqual({
      direction: "row",
      column: "full",
      chatAway: false,
    });
  });

  it("chat shown: beside the app on a desktop, under it on a phone", () => {
    expect(appColumnLayout(base).column).toBe("side");
    expect(appColumnLayout({ ...base, md: false })).toMatchObject({
      direction: "column",
      column: "below",
      chatAway: false,
    });
  });

  it("chat away and no call: the app takes the whole body", () => {
    for (const md of [true, false]) {
      expect(
        appColumnLayout({ ...base, md, chatHidden: true, inCall: false, callShape: "none" }),
      ).toMatchObject({ column: "hidden", chatAway: true });
    }
  });

  it("chat away in a call that is a card: a bar under the app, never gone", () => {
    expect(appColumnLayout({ ...base, chatHidden: true })).toEqual({
      direction: "column",
      column: "bar",
      chatAway: true,
    });
  });

  it("chat away in a call with pictures: the pictures keep the side column", () => {
    expect(appColumnLayout({ ...base, chatHidden: true, callShape: "expanded" })).toEqual({
      direction: "row",
      column: "stage",
      chatAway: true,
    });
    // A phone has no side: the pictures go under the app.
    expect(
      appColumnLayout({ ...base, md: false, chatHidden: true, callShape: "expanded" }),
    ).toMatchObject({ direction: "column", column: "below", chatAway: true });
  });
});
