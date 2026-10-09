/**
 * `desktop_notify_default_on`: the split account defaults, the desktop app's
 * banner switch starting on, and the browser's one-time offer.
 *
 * The flag is set the way the client learns it (the `/api/push/config` answer
 * folded by `desktopNotifyDefaultOnFromPushConfig`), and every rule is checked
 * both ways: flag off is the behaviour before this existed.
 *
 * The case that matters most: with the flag on and nothing chosen, an ordinary
 * message in a server must NOT become a banner, even though the desktop app's
 * switch now starts on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sounds = vi.hoisted(() => ({
  playActivitySound: vi.fn(),
  playCue: vi.fn(),
}));
vi.mock("./sounds", () => sounds);

const sync = vi.hoisted(() => ({ patches: [] as unknown[] }));
vi.mock("./preferences", () => ({
  queuePreferenceSync: (patch: unknown) => {
    sync.patches.push(patch);
  },
}));

interface RaisedNotification {
  title: string;
  body: string;
  tag: string;
}

const raised: RaisedNotification[] = [];
const bridged: { title: string; body: string; tag: string; path: string }[] = [];

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
  adoptNotificationPreferences,
  desktopBannersEnabled,
  describeActivity,
  dmDefaultLevel,
  getNotificationState,
  getNotifyOfferPending,
  notifyChannelActivity,
  notifyStreamStarted,
  rememberChannels,
  rememberServers,
  resetNotificationBursts,
  resolveNotificationLevel,
  serverDefaultLevel,
  setChannelNotificationLevel,
  setDefaultNotificationLevel,
  setDesktopNotificationsEnabled,
  setDmDefaultNotificationLevel,
  setDoNotDisturb,
  setServerDefaultNotificationLevel,
  setServerNotificationLevel,
  shouldQueueNotifyOffer,
  dismissNotifyOffer,
} = await import("./notifications");
const {
  desktopNotifyDefaultOnFromPushConfig,
  setDesktopNotifyDefaultOnForTests,
} = await import("./notify-defaults-config");

const SERVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHANNEL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** Back to an account that never opened the settings. */
function freshAccount(): void {
  adoptNotificationPreferences({ desktop: false, desktopChosen: false, default: "all" });
  // `adopt` keeps what it is not told about, so the split is cleared by hand.
  const state = getNotificationState();
  state.dmDefault = null;
  state.serverDefault = null;
  setServerNotificationLevel(SERVER, null);
  setChannelNotificationLevel(CHANNEL, null);
  setChannelNotificationLevel(DM, null);
}

function inDesktopApp(): void {
  globals.pqpDesktop = {
    isElectron: true,
    platform: "darwin",
    notify: (payload: { title: string; body: string; tag: string; path: string }) => {
      bridged.push(payload);
    },
  };
}

function inBrowser(): void {
  delete globals.pqpDesktop;
}

const HIDDEN = { selectedChannelId: OTHER, documentVisible: false, windowFocused: false };
const FOREGROUND = { selectedChannelId: OTHER, documentVisible: true, windowFocused: true };

function serverMessage(mentions = 0, context = HIDDEN) {
  notifyChannelActivity(
    describeActivity(CHANNEL, { count: 1, mentions }),
    context,
  );
}

function directMessage(context = HIDDEN) {
  notifyChannelActivity(describeActivity(DM, { count: 1, mentions: 0 }), context);
}

beforeEach(() => {
  raised.length = 0;
  bridged.length = 0;
  sync.patches.length = 0;
  sounds.playActivitySound.mockClear();
  sounds.playCue.mockClear();
  FakeNotification.permission = "granted";
  resetNotificationBursts();
  setDoNotDisturb(false);
  inBrowser();
  setDesktopNotifyDefaultOnForTests(false);
  freshAccount();
  rememberServers([{ id: SERVER, name: "QG" }]);
  rememberChannels([
    { id: CHANNEL, serverId: SERVER, name: "geral", kind: "server" },
    { id: DM, serverId: null, name: "Ana", kind: "dm" },
  ]);
});

afterEach(() => {
  resetNotificationBursts();
  inBrowser();
  setDesktopNotifyDefaultOnForTests(false);
});

describe("the flag as the client reads it from /api/push/config", () => {
  it("is on only for an explicit true", () => {
    expect(desktopNotifyDefaultOnFromPushConfig({ desktopNotifyDefaultOn: true })).toBe(true);
    for (const value of [undefined, false, null, "true", 1]) {
      expect(desktopNotifyDefaultOnFromPushConfig({ desktopNotifyDefaultOn: value })).toBe(false);
    }
  });
});

describe("resolving the account default", () => {
  it("flag off: `default` speaks for conversations and servers alike, as it always did", () => {
    setDefaultNotificationLevel("mentions");
    expect(resolveNotificationLevel(getNotificationState(), null, DM)).toBe("mentions");
    expect(resolveNotificationLevel(getNotificationState(), SERVER, CHANNEL)).toBe("mentions");
    // And an explicit split is ignored until the flag is on.
    setDmDefaultNotificationLevel("none");
    expect(resolveNotificationLevel(getNotificationState(), null, DM)).toBe("mentions");
  });

  describe("flag on", () => {
    beforeEach(() => setDesktopNotifyDefaultOnForTests(true));

    it("nothing chosen: conversations are 'all', servers are 'mentions'", () => {
      const state = getNotificationState();
      expect(resolveNotificationLevel(state, null, DM)).toBe("all");
      expect(resolveNotificationLevel(state, SERVER, CHANNEL)).toBe("mentions");
      expect(dmDefaultLevel(state)).toBe("all");
      expect(serverDefaultLevel(state)).toBe("mentions");
    });

    it("a stored `default: all` is not a choice for servers", () => {
      // Every save writes every field, so this is what an account that only
      // ever flipped some other switch carries.
      adoptNotificationPreferences({ default: "all" });
      expect(resolveNotificationLevel(getNotificationState(), SERVER, CHANNEL)).toBe("mentions");
    });

    it("an old account that set `default` to something else keeps it for both", () => {
      adoptNotificationPreferences({ default: "none" });
      const state = getNotificationState();
      expect(resolveNotificationLevel(state, null, DM)).toBe("none");
      expect(resolveNotificationLevel(state, SERVER, CHANNEL)).toBe("none");
      adoptNotificationPreferences({ default: "mentions" });
      expect(resolveNotificationLevel(getNotificationState(), null, DM)).toBe("mentions");
    });

    it("setting one default leaves the other where it was", () => {
      setServerDefaultNotificationLevel("all");
      let state = getNotificationState();
      expect(resolveNotificationLevel(state, SERVER, CHANNEL)).toBe("all");
      expect(resolveNotificationLevel(state, null, DM)).toBe("all");

      setDmDefaultNotificationLevel("mentions");
      state = getNotificationState();
      expect(resolveNotificationLevel(state, null, DM)).toBe("mentions");
      expect(resolveNotificationLevel(state, SERVER, CHANNEL)).toBe("all");
    });

    it("a channel or server override beats both defaults", () => {
      setDmDefaultNotificationLevel("none");
      setServerDefaultNotificationLevel("none");
      setServerNotificationLevel(SERVER, "all");
      setChannelNotificationLevel(DM, "all");
      const state = getNotificationState();
      expect(resolveNotificationLevel(state, SERVER, CHANNEL)).toBe("all");
      expect(resolveNotificationLevel(state, null, DM)).toBe("all");
    });
  });

  it("re-reads when the flag flips, without a save", () => {
    const before = getNotificationState();
    setDesktopNotifyDefaultOnForTests(true);
    expect(getNotificationState()).not.toBe(before);
  });
});

describe("the preference round trip", () => {
  it("an old object with no split reads as unset, and is written back without one", () => {
    adoptNotificationPreferences({ desktop: true, default: "mentions", servers: {}, channels: {} });
    const state = getNotificationState();
    expect(state.dmDefault).toBeNull();
    expect(state.serverDefault).toBeNull();

    setDesktopNotificationsEnabled(true);
    const written = (sync.patches.at(-1) as { notifications: Record<string, unknown> })
      .notifications;
    expect(written).not.toHaveProperty("dmDefault");
    expect(written).not.toHaveProperty("serverDefault");
    expect(written.default).toBe("mentions");
  });

  it("a choice is written, with every other field alongside it", () => {
    setServerDefaultNotificationLevel("mentions");
    setDmDefaultNotificationLevel("all");
    const written = (sync.patches.at(-1) as { notifications: Record<string, unknown> })
      .notifications;
    expect(written).toMatchObject({
      dmDefault: "all",
      serverDefault: "mentions",
      default: "all",
      desktopChosen: false,
    });
    expect(written).toHaveProperty("servers");
    expect(written).toHaveProperty("channels");
  });

  it("the server's copy wins on read", () => {
    adoptNotificationPreferences({ dmDefault: "none", serverDefault: "all", desktopChosen: true });
    const state = getNotificationState();
    expect(state.dmDefault).toBe("none");
    expect(state.serverDefault).toBe("all");
    expect(state.desktopChosen).toBe(true);
  });
});

describe("the desktop app's banner switch", () => {
  it("is the stored switch with the flag off, even in the desktop app", () => {
    inDesktopApp();
    expect(desktopBannersEnabled()).toBe(false);
    setDesktopNotificationsEnabled(true);
    expect(desktopBannersEnabled()).toBe(true);
  });

  it("starts ON in the desktop app with the flag on", () => {
    setDesktopNotifyDefaultOnForTests(true);
    inDesktopApp();
    expect(desktopBannersEnabled()).toBe(true);
  });

  it("stays off in a browser: the permission has to be asked for from a click", () => {
    setDesktopNotifyDefaultOnForTests(true);
    expect(desktopBannersEnabled()).toBe(false);
  });

  it("stays off once the person turned it off", () => {
    setDesktopNotifyDefaultOnForTests(true);
    inDesktopApp();
    setDesktopNotificationsEnabled(false);
    expect(getNotificationState().desktopChosen).toBe(true);
    expect(desktopBannersEnabled()).toBe(false);
  });

  it("a DM raises a banner through the shell's bridge on a fresh account", () => {
    setDesktopNotifyDefaultOnForTests(true);
    inDesktopApp();
    directMessage();
    expect(bridged).toHaveLength(1);
    expect(bridged[0]!.title).toBe("Ana");
  });

  it("MUST NOT turn an ordinary server message into a banner", () => {
    setDesktopNotifyDefaultOnForTests(true);
    inDesktopApp();
    for (let i = 0; i < 5; i += 1) {
      resetNotificationBursts();
      serverMessage(0);
    }
    expect(bridged).toEqual([]);
    expect(raised).toEqual([]);
  });

  it("a mention in a server still does", () => {
    setDesktopNotifyDefaultOnForTests(true);
    inDesktopApp();
    serverMessage(1);
    expect(bridged).toHaveLength(1);
  });

  it("a server the person set to all banners every message, and a muted one none", () => {
    setDesktopNotifyDefaultOnForTests(true);
    inDesktopApp();
    setServerNotificationLevel(SERVER, "all");
    serverMessage(0);
    expect(bridged).toHaveLength(1);

    bridged.length = 0;
    resetNotificationBursts();
    setServerNotificationLevel(SERVER, "none");
    serverMessage(1);
    expect(bridged).toEqual([]);
  });

  it("flag off, nothing changes: the desktop app raises nothing on a fresh account", () => {
    inDesktopApp();
    directMessage();
    serverMessage(1);
    expect(bridged).toEqual([]);
  });
});

describe("a stream starting keeps its old reading of the default", () => {
  const frame = {
    serverId: SERVER,
    channelId: CHANNEL,
    channelName: "filminho",
    serverName: "QG",
    sharerName: "Alberto",
    kind: "voice" as const,
  };
  const context = { windowFocused: false, openServerId: null };

  it("nobody chose a level: notified, even though server messages default to mentions", () => {
    setDesktopNotifyDefaultOnForTests(true);
    inDesktopApp();
    expect(notifyStreamStarted(frame, context)).toBe(true);
  });

  it("a server default the person did choose is honoured", () => {
    setDesktopNotifyDefaultOnForTests(true);
    inDesktopApp();
    setServerDefaultNotificationLevel("mentions");
    expect(notifyStreamStarted(frame, context)).toBe(false);
  });

  it("a muted server is not notified", () => {
    setDesktopNotifyDefaultOnForTests(true);
    inDesktopApp();
    setServerNotificationLevel(SERVER, "none");
    expect(notifyStreamStarted(frame, context)).toBe(false);
  });
});

describe("the browser's one-time offer", () => {
  const base = {
    flagOn: true,
    inDesktopApp: false,
    bannersOn: false,
    permission: "default" as const,
    documentVisible: false,
    kind: "dm" as const,
    mentions: 0,
  };

  it("the first DM to a hidden tab queues it", () => {
    expect(shouldQueueNotifyOffer(base)).toBe(true);
  });

  it("so does a mention in a server", () => {
    expect(shouldQueueNotifyOffer({ ...base, kind: "server", mentions: 1 })).toBe(true);
  });

  it("an ordinary server message does not", () => {
    expect(shouldQueueNotifyOffer({ ...base, kind: "server", mentions: 0 })).toBe(false);
  });

  it("not with the flag off, in the desktop app, with banners on, or while the tab is visible", () => {
    expect(shouldQueueNotifyOffer({ ...base, flagOn: false })).toBe(false);
    expect(shouldQueueNotifyOffer({ ...base, inDesktopApp: true })).toBe(false);
    expect(shouldQueueNotifyOffer({ ...base, bannersOn: true })).toBe(false);
    expect(shouldQueueNotifyOffer({ ...base, documentVisible: true })).toBe(false);
  });

  it("only while the browser can still be asked", () => {
    expect(shouldQueueNotifyOffer({ ...base, permission: "denied" })).toBe(false);
    expect(shouldQueueNotifyOffer({ ...base, permission: "granted" })).toBe(false);
    expect(shouldQueueNotifyOffer({ ...base, permission: "unsupported" })).toBe(false);
  });

  describe("through the live path", () => {
    beforeEach(() => {
      setDesktopNotifyDefaultOnForTests(true);
      FakeNotification.permission = "default";
    });

    it("a DM that arrives while the tab is hidden leaves the offer pending", () => {
      directMessage();
      expect(getNotifyOfferPending()).toBe(true);
      // No banner: the permission is not there, which is the whole point.
      expect(raised).toEqual([]);
    });

    it("a DM in front of the reader does not", () => {
      directMessage(FOREGROUND);
      expect(getNotifyOfferPending()).toBe(false);
    });

    it("a muted conversation does not", () => {
      setChannelNotificationLevel(DM, "none");
      directMessage();
      expect(getNotifyOfferPending()).toBe(false);
    });

    it("an ordinary server message does not, a mention does", () => {
      serverMessage(0);
      expect(getNotifyOfferPending()).toBe(false);
      resetNotificationBursts();
      serverMessage(1);
      expect(getNotifyOfferPending()).toBe(true);
    });

    it("flag off: never", () => {
      setDesktopNotifyDefaultOnForTests(false);
      directMessage();
      expect(getNotifyOfferPending()).toBe(false);
    });

    it("Do Not Disturb: never", () => {
      setDoNotDisturb(true);
      directMessage();
      expect(getNotifyOfferPending()).toBe(false);
    });

    it("dismissing clears it", () => {
      directMessage();
      dismissNotifyOffer();
      expect(getNotifyOfferPending()).toBe(false);
    });
  });
});

describe("the wiring the decision depends on", () => {
  // A function nobody calls passes every test above (CLAUDE.md pitfalls 9 and
  // 12), so the call sites are pinned by reading the source.
  const read = async (file: string) =>
    (await import("node:fs")).readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

  it("the app loads the flag and draws the card in the corner queue", async () => {
    const app = await read("App.tsx");
    expect(app).toMatch(/useEffect\(\(\) => startNotifyDefaultsConfig\(\), \[\]\)/);
    expect(app).toMatch(/notifyOffer: wantsNotifyOfferCard && notifyOfferReady/);
    expect(app).toMatch(/enabled=\{effectiveCornerHint === "notifyOffer"\}/);
  });

  it("the settings screen shows the two defaults only with the flag on", async () => {
    const section = await read("components/settings/notifications-section.tsx");
    expect(section).toMatch(/splitDefaults \? \(/);
    expect(section).toMatch(/desktopBannersEnabled\(state\)/);
  });
});
