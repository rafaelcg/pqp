// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_CHAT_HIDDEN_KEY,
  appColumnLayout,
  chatUnreadSince,
  readAppChatHidden,
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

  it("counts other people's messages after the one that was newest", () => {
    expect(chatUnreadSince(list, "1", viewer)).toEqual({ count: 2, mention: false });
  });

  it("never counts the person's own messages", () => {
    expect(chatUnreadSince([msg("1", "bia"), msg("2", ME)], "1", viewer).count).toBe(0);
  });

  it("an empty channel when hidden counts everything that came after", () => {
    expect(chatUnreadSince(list, null, viewer).count).toBe(3);
  });

  it("a mention lights the count", () => {
    const named = [...list, msg("5", "bia", "@rafa bora?")];
    expect(chatUnreadSince(named, "4", viewer)).toEqual({ count: 1, mention: true });
    const everyone = [...list, { ...msg("5", "bia", "galera"), mentionEveryone: true }];
    expect(chatUnreadSince(everyone, "4", viewer).mention).toBe(true);
  });

  it("a page that no longer holds the mark counts nothing rather than everything", () => {
    expect(chatUnreadSince(list, "gone", viewer)).toEqual({ count: 0, mention: false });
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
