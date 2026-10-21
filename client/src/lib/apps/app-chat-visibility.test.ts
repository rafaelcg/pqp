// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_CHAT_HIDDEN_KEY,
  appColumnLayout,
  advanceUnread,
  FRESH_TRACKER,
  readAppChatHidden,
  UNREAD_APPEND_LIMIT,
  unreadBadgeText,
  writeAppChatHidden,
  type AppColumnLayoutInput,
  type UnreadMessage,
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
  const base = [msg("1", "bia"), msg("2", ME)];
  /** Feeds the lists one after another, as successive renders. */
  const run = (...lists: UnreadMessage[][]) =>
    lists.reduce((state, list) => advanceUnread(state, list, viewer), FRESH_TRACKER);

  it("the list it first sees is the baseline, and counts nothing", () => {
    expect(run(base).unread).toEqual({ count: 0, mention: false });
  });

  it("counts other people's messages that arrive, one render or several at a time", () => {
    const one = [...base, msg("3", "bia")];
    const two = [...one, msg("4", "caio"), msg("5", "bia")];
    expect(run(base, one, two).unread).toEqual({ count: 3, mention: false });
  });

  it("never counts the person's own messages", () => {
    expect(run(base, [...base, msg("3", ME)]).unread.count).toBe(0);
  });

  it("the same list twice is the same state (safe to advance during render)", () => {
    const one = [...base, msg("3", "bia")];
    const once = run(base, one);
    expect(advanceUnread(once, one, viewer)).toBe(once);
  });

  it("a mention lights the count", () => {
    expect(run(base, [...base, msg("3", "bia", "@rafa bora?")]).unread).toEqual({
      count: 1,
      mention: true,
    });
    expect(
      run(base, [...base, { ...msg("3", "bia", "galera"), mentionEveryone: true }]).unread.mention,
    ).toBe(true);
  });

  it("history that loads after an empty list (a channel opened while away) is not unread", () => {
    const history = [msg("h1", "bia", "@rafa velho"), msg("h2", "caio")];
    expect(run([], history).unread).toEqual({ count: 0, mention: false });
    expect(run([], history, [...history, msg("n1", "bia")]).unread.count).toBe(1);
  });

  it("an empty list in between (a refetch) keeps the boundary, so what arrived meanwhile counts", () => {
    const back = [...base, msg("3", "bia"), msg("4", "caio")];
    expect(run(base, [], back).unread.count).toBe(2);
  });

  it("a replaced page, a jump or history loaded above counts nothing and keeps what was counted", () => {
    const one = [...base, msg("3", "bia")];
    const jumped = [msg("x1", "bia"), msg("x2", "bia"), msg("x3", "bia")];
    expect(run(base, one, jumped).unread.count).toBe(1);
    const above = [msg("0", "bia"), ...one];
    expect(run(base, one, above).unread.count).toBe(1);
  });

  it("a burst bigger than UNREAD_APPEND_LIMIT in one render reads as a page, not as arrivals", () => {
    const burst = Array.from({ length: UNREAD_APPEND_LIMIT + 5 }, (_, i) => msg(`b${i}`, "bia"));
    expect(run(base, [...base, ...burst]).unread.count).toBe(0);
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
