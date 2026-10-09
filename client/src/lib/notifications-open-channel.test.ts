/**
 * `notify_open_channel`: a message in the channel that is open, while the
 * window is away.
 *
 * The server sends no `channel-activity` for a channel a socket has open, so
 * the open channel never reached the banner path at all; a minimised window on
 * #general stayed silent however many people spoke. These tests drive the same
 * function the chat controller calls and read what reached the OS, with the
 * flag set the way the client learns it (the `/api/push/config` answer), and
 * check that off is byte for byte the old behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sounds = vi.hoisted(() => ({
  playActivitySound: vi.fn(),
  playCue: vi.fn(),
}));
vi.mock("./sounds", () => sounds);

interface RaisedNotification {
  title: string;
  body: string;
  tag: string;
}

const raised: RaisedNotification[] = [];

class FakeNotification {
  static permission = "granted";
  onclick: (() => void) | null = null;
  constructor(title: string, options: { body: string; tag: string }) {
    raised.push({ title, body: options.body, tag: options.tag });
  }
  close() {}
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.Notification = FakeNotification;
globals.addEventListener = () => {};
globals.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globals.window = globals;

const {
  notifyOpenChannelMessage,
  notifyOpenChannelWhileAway,
  rememberChannels,
  rememberServers,
  resetNotificationBursts,
  setChannelNotificationLevel,
  setDesktopNotificationsEnabled,
  setDefaultNotificationLevel,
  setDoNotDisturb,
  setNotificationBlockedAuthors,
  setServerNotificationLevel,
  shouldBannerOpenChannel,
} = await import("./notifications");
const { notifyConfigFromPushConfig, setNotifyConfigForTests } = await import(
  "./notify-config"
);

const SERVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHANNEL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AUTHOR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const AWAY = { documentVisible: false, windowFocused: false };
const BLURRED = { documentVisible: true, windowFocused: false };
const IN_FRONT = { documentVisible: true, windowFocused: true };

beforeEach(() => {
  raised.length = 0;
  sounds.playActivitySound.mockClear();
  sounds.playCue.mockClear();
  resetNotificationBursts();
  setDesktopNotificationsEnabled(true);
  setDefaultNotificationLevel("all");
  setDoNotDisturb(false);
  setNotificationBlockedAuthors(new Set());
  setNotifyConfigForTests({ notifyOpenChannel: true });
  rememberServers([{ id: SERVER, name: "QG" }]);
  rememberChannels([
    { id: CHANNEL, serverId: SERVER, name: "geral", kind: "server" },
    { id: DM, serverId: null, name: "Ana", kind: "dm" },
  ]);
});

afterEach(() => {
  resetNotificationBursts();
  setServerNotificationLevel(SERVER, null);
  setChannelNotificationLevel(CHANNEL, null);
  setNotifyConfigForTests(null);
});

describe("when the open channel is allowed to banner", () => {
  it("never with the flag off", () => {
    for (const window of [AWAY, BLURRED, IN_FRONT]) {
      expect(shouldBannerOpenChannel({ flagOn: false, ...window })).toBe(false);
    }
  });

  it("stays quiet while the window is visible and focused", () => {
    expect(shouldBannerOpenChannel({ flagOn: true, ...IN_FRONT })).toBe(false);
  });

  it("fires hidden/minimised, and visible but blurred", () => {
    expect(shouldBannerOpenChannel({ flagOn: true, ...AWAY })).toBe(true);
    expect(shouldBannerOpenChannel({ flagOn: true, ...BLURRED })).toBe(true);
  });
});

describe("the flag as the client reads it from /api/push/config", () => {
  it("is on only for an explicit true", () => {
    expect(notifyConfigFromPushConfig({ notifyOpenChannel: true })).toEqual({
      notifyOpenChannel: true,
    });
    for (const value of [undefined, false, null, "true", 1]) {
      expect(notifyConfigFromPushConfig({ notifyOpenChannel: value })).toEqual({
        notifyOpenChannel: false,
      });
    }
  });
});

describe("a message in the open channel while the window is away", () => {
  it("raises the ordinary banner, titled with the channel and server", () => {
    const took = notifyOpenChannelWhileAway(CHANNEL, false, { authorId: AUTHOR, ...AWAY });

    expect(took).toBe(true);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.title).toBe("#geral — QG");
    expect(raised[0]!.tag).toBe(CHANNEL);
  });

  it("does it for a blurred window that is still visible", () => {
    expect(notifyOpenChannelWhileAway(CHANNEL, false, { authorId: AUTHOR, ...BLURRED })).toBe(true);
    expect(raised).toHaveLength(1);
  });

  it("is not taken when the window is in front: the caller keeps the old path", () => {
    expect(notifyOpenChannelWhileAway(CHANNEL, true, { authorId: AUTHOR, ...IN_FRONT })).toBe(false);
    expect(raised).toEqual([]);
  });

  it("is not taken with the flag off, even with the window away", () => {
    setNotifyConfigForTests({ notifyOpenChannel: false });
    expect(notifyOpenChannelWhileAway(CHANNEL, true, { authorId: AUTHOR, ...AWAY })).toBe(false);
    expect(raised).toEqual([]);
    expect(sounds.playActivitySound).not.toHaveBeenCalled();
  });

  it("obeys a muted channel and a muted server", () => {
    setChannelNotificationLevel(CHANNEL, "none");
    expect(notifyOpenChannelWhileAway(CHANNEL, true, { authorId: AUTHOR, ...AWAY })).toBe(true);
    expect(raised).toEqual([]);

    setChannelNotificationLevel(CHANNEL, null);
    setServerNotificationLevel(SERVER, "none");
    resetNotificationBursts();
    expect(notifyOpenChannelWhileAway(CHANNEL, true, { authorId: AUTHOR, ...AWAY })).toBe(true);
    expect(raised).toEqual([]);
  });

  it("at 'mentions' banners the mention and not the plain message", () => {
    setServerNotificationLevel(SERVER, "mentions");
    notifyOpenChannelWhileAway(CHANNEL, false, { authorId: AUTHOR, ...AWAY });
    expect(raised).toEqual([]);

    notifyOpenChannelWhileAway(CHANNEL, true, { authorId: AUTHOR, ...AWAY });
    expect(raised).toHaveLength(1);
  });

  it("says nothing on Do Not Disturb, and does not hand the message back", () => {
    setDoNotDisturb(true);
    expect(notifyOpenChannelWhileAway(CHANNEL, true, { authorId: AUTHOR, ...AWAY })).toBe(true);
    expect(raised).toEqual([]);
    expect(sounds.playActivitySound).not.toHaveBeenCalled();
  });

  it("says nothing for an author this account blocked", () => {
    setNotificationBlockedAuthors(new Set([AUTHOR]));
    expect(notifyOpenChannelWhileAway(CHANNEL, true, { authorId: AUTHOR, ...AWAY })).toBe(true);
    expect(raised).toEqual([]);
    expect(sounds.playActivitySound).not.toHaveBeenCalled();
  });

  it("needs the desktop opt-in like any other banner", () => {
    setDesktopNotificationsEnabled(false);
    notifyOpenChannelWhileAway(CHANNEL, false, { authorId: AUTHOR, ...AWAY });
    expect(raised).toEqual([]);
  });

  it("coalesces a burst into one banner, like every other channel", () => {
    notifyOpenChannelWhileAway(CHANNEL, false, { authorId: AUTHOR, ...AWAY });
    notifyOpenChannelWhileAway(CHANNEL, false, { authorId: AUTHOR, ...AWAY });
    notifyOpenChannelWhileAway(CHANNEL, false, { authorId: AUTHOR, ...AWAY });
    expect(raised).toHaveLength(1);
  });

  it("plays the mention sound once, not once here and once in the old path", () => {
    notifyOpenChannelWhileAway(CHANNEL, true, { authorId: AUTHOR, ...AWAY });
    expect(sounds.playActivitySound).toHaveBeenCalledTimes(1);
  });

  it("gives a conversation its message cue and a banner", () => {
    notifyOpenChannelWhileAway(DM, false, { authorId: AUTHOR, ...AWAY });
    expect(raised).toHaveLength(1);
    expect(raised[0]!.title).toBe("Ana");
    expect(sounds.playCue).toHaveBeenCalledWith("message");
  });
});

describe("the old path, untouched", () => {
  it("still plays the mention sound for the open channel", () => {
    notifyOpenChannelMessage(CHANNEL, true);
    expect(sounds.playActivitySound).toHaveBeenCalledTimes(1);
    expect(raised).toEqual([]);
  });
});

describe("the wiring the decision depends on", () => {
  // A function nobody calls passes every test above (CLAUDE.md pitfalls 9 and
  // 12), so the three call sites are pinned by reading the source.
  const read = async (file: string) =>
    (await import("node:fs")).readFileSync(
      new URL(`../${file}`, import.meta.url),
      "utf8",
    );

  it("the chat controller asks before the history early return, for the primary view only", async () => {
    const chat = await read("hooks/use-chat.ts");
    const ask = chat.indexOf("notifyOpenChannelWhileAway(channelId");
    const history = chat.indexOf("if (hasNewer) {");
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeLessThan(history);
    expect(chat).toMatch(/frames === PRIMARY_CHANNEL_FRAMES &&\s*notifyOpenChannelWhileAway/);
    expect(chat).toMatch(/fromSomebodyElse && !bannered/);
  });

  it("the app loads the flag and hands over the blocked authors", async () => {
    const app = await read("App.tsx");
    expect(app).toMatch(/useEffect\(\(\) => startNotifyConfig\(\), \[\]\)/);
    expect(app).toMatch(/setNotificationBlockedAuthors\(blockedUserIds\)/);
  });
});
