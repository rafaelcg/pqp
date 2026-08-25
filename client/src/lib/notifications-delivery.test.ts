/**
 * The banner itself, not the decision that leads to it.
 *
 * Everything else about notifications is unit-tested through `shouldNotify` and
 * `describeActivity`, which is exactly how a bug got to production: those take
 * a server id as an argument, and the app was passing `null` for every server
 * whose channel list it had not fetched — which is every server except the one
 * on screen, plus every thread. `resolveNotificationLevel` then never saw the
 * server's own level, so a MUTED server kept raising banners reading "New
 * activity / 1 new message", with nothing in the app to look at.
 *
 * These tests drive the same path the live `channel-activity` handler drives,
 * from the frame's fields to a constructed `Notification`, so a null that gets
 * reintroduced anywhere along it fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./sounds", () => ({ playActivitySound: vi.fn() }));

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

// `environment: "node"`, so the module's `typeof window === "undefined"` guards
// would short-circuit every delivery. Standing a window up is what makes this a
// test of the browser path rather than of the guard.
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
  describeActivity,
  notifyChannelActivity,
  rememberActivityChannel,
  rememberServers,
  resetNotificationBursts,
  setDesktopNotificationsEnabled,
  setServerNotificationLevel,
} = await import("./notifications");

const SERVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHANNEL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ELSEWHERE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/**
 * The live handler, minus React. `serverId` and `kind` come off the frame — the
 * server has always sent both — and the channel is one no `GET /channels` has
 * ever named, because its server is not the one on screen.
 */
function frameArrives(frame: {
  channelId: string;
  serverId: string | null;
  mention?: boolean;
}) {
  rememberActivityChannel(frame.channelId, frame.serverId, "server");
  notifyChannelActivity(
    describeActivity(frame.channelId, {
      count: 1,
      mentions: frame.mention ? 1 : 0,
    }),
    { selectedChannelId: ELSEWHERE, documentVisible: true },
  );
}

beforeEach(() => {
  raised.length = 0;
  resetNotificationBursts();
  setDesktopNotificationsEnabled(true);
  setServerNotificationLevel(SERVER, null);
  rememberServers([{ id: SERVER, name: "QG" }]);
});

afterEach(() => {
  resetNotificationBursts();
  setServerNotificationLevel(SERVER, null);
});

describe("a banner for a server the app has no channel list for", () => {
  it("says which server it came from", () => {
    frameArrives({ channelId: CHANNEL, serverId: SERVER });

    expect(raised).toHaveLength(1);
    // The channel is still unnamed — the frame carries ids — but the banner is
    // no longer anonymous, which is the difference between "something happened
    // in QG" and a notification with nowhere to attach it.
    expect(raised[0]!.title).toContain("QG");
  });

  it("obeys that server's mute", () => {
    setServerNotificationLevel(SERVER, "none");
    frameArrives({ channelId: CHANNEL, serverId: SERVER });

    expect(raised).toEqual([]);
  });

  it("obeys 'mentions only' on that server", () => {
    setServerNotificationLevel(SERVER, "mentions");

    frameArrives({ channelId: CHANNEL, serverId: SERVER });
    expect(raised).toEqual([]);

    resetNotificationBursts();
    frameArrives({ channelId: CHANNEL, serverId: SERVER, mention: true });
    expect(raised).toHaveLength(1);
  });
});

describe("a banner for a thread", () => {
  // A thread is a channel that appears in no channel list at all, so before the
  // frame's server id was read it was the most anonymous notification the app
  // could raise: no name, no badge, no route. It is still not in the sidebar —
  // that is by design, the parent's thread chip owns it — but it now belongs to
  // a server, which is what a mute needs in order to reach it.
  const THREAD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  it("is silenced by muting the server the thread lives in", () => {
    setServerNotificationLevel(SERVER, "none");
    frameArrives({ channelId: THREAD, serverId: SERVER });

    expect(raised).toEqual([]);
  });
});
