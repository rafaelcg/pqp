import { describe, expect, it } from "vitest";
import {
  activityRoutePath,
  describeActivity,
  formatBadge,
  rememberActivityChannel,
  rememberChannels,
  rememberServers,
  resolveNotificationLevel,
  shouldNotify,
  unreadByServer,
  type NotificationState,
} from "./notifications";

const SERVER = "11111111-1111-4111-8111-111111111111";
const CHANNEL = "22222222-2222-4222-8222-222222222222";

function stateWith(overrides: Partial<NotificationState> = {}): NotificationState {
  return { desktop: true, default: "all", servers: {}, channels: {}, ...overrides };
}

describe("resolveNotificationLevel", () => {
  it("falls back to the account default when nothing is set", () => {
    expect(resolveNotificationLevel(stateWith(), SERVER, CHANNEL)).toBe("all");
    expect(
      resolveNotificationLevel(stateWith({ default: "mentions" }), SERVER, CHANNEL),
    ).toBe("mentions");
  });

  it("takes the server's level for a channel that has none of its own", () => {
    const state = stateWith({ servers: { [SERVER]: "mentions" } });
    expect(resolveNotificationLevel(state, SERVER, CHANNEL)).toBe("mentions");
  });

  it("lets a channel override the server it belongs to, in both directions", () => {
    // Turning one channel down inside a normal server, and back up inside a
    // muted one, are the two reasons per-channel levels exist at all.
    const quiet = stateWith({
      servers: { [SERVER]: "all" },
      channels: { [CHANNEL]: "none" },
    });
    expect(resolveNotificationLevel(quiet, SERVER, CHANNEL)).toBe("none");

    const loud = stateWith({
      servers: { [SERVER]: "none" },
      channels: { [CHANNEL]: "all" },
    });
    expect(resolveNotificationLevel(loud, SERVER, CHANNEL)).toBe("all");
  });

  it("still resolves for a channel whose server is not known yet", () => {
    // Activity can arrive for a server this session has never opened, so the
    // channel level and the default have to work without one.
    const state = stateWith({ default: "mentions", channels: { [CHANNEL]: "all" } });
    expect(resolveNotificationLevel(state, null, CHANNEL)).toBe("all");
    expect(resolveNotificationLevel(state, null, "unknown")).toBe("mentions");
  });
});

describe("shouldNotify", () => {
  const base = {
    level: "all" as const,
    mention: false,
    channelId: CHANNEL,
    selectedChannelId: null as string | null,
    documentVisible: false,
  };

  it("says nothing about a channel the user is already looking at", () => {
    expect(
      shouldNotify({
        ...base,
        selectedChannelId: CHANNEL,
        documentVisible: true,
      }),
    ).toBe(false);
  });

  it("still notifies for the selected channel when the window is hidden", () => {
    expect(
      shouldNotify({ ...base, selectedChannelId: CHANNEL, documentVisible: false }),
    ).toBe(true);
  });

  it("still notifies for another channel while the window is visible", () => {
    expect(
      shouldNotify({ ...base, selectedChannelId: "other", documentVisible: true }),
    ).toBe(true);
  });

  it("stays silent at 'none' however the message arrived", () => {
    expect(shouldNotify({ ...base, level: "none" })).toBe(false);
    expect(shouldNotify({ ...base, level: "none", mention: true })).toBe(false);
  });

  it("at 'mentions' notifies only when named", () => {
    expect(shouldNotify({ ...base, level: "mentions" })).toBe(false);
    expect(shouldNotify({ ...base, level: "mentions", mention: true })).toBe(true);
  });
});

describe("formatBadge", () => {
  it("caps the count where the exact number stops mattering", () => {
    expect(formatBadge(1)).toBe("1");
    expect(formatBadge(99)).toBe("99");
    expect(formatBadge(240)).toBe("99+");
  });
});

describe("describeActivity", () => {
  it("names the channel and its server from the remembered directories", () => {
    rememberChannels([{ id: CHANNEL, serverId: SERVER, name: "general" }]);
    rememberServers([{ id: SERVER, name: "pqp" }]);

    expect(describeActivity(CHANNEL, { count: 1, mentions: 0 })).toEqual({
      channelId: CHANNEL,
      serverId: SERVER,
      channelName: "general",
      serverName: "pqp",
      count: 1,
      mentions: 0,
      kind: "server",
    });
  });

  it("names a channel whose server is not the one on screen", () => {
    const other = "33333333-3333-4333-8333-333333333333";
    const otherServer = "44444444-4444-4444-8444-444444444444";
    rememberChannels([{ id: other, serverId: otherServer, name: "deploys" }]);
    rememberServers([{ id: otherServer, name: "work" }]);

    // Covers a server whose channel list this session has already fetched.
    // `rememberChannels` is only ever called with the SELECTED server's
    // channels, so this is the easy half; the hard half — a server that has
    // never been opened — is `rememberActivityChannel` below.
    expect(describeActivity(other, { count: 1, mentions: 1 })).toMatchObject({
      channelName: "deploys",
      serverName: "work",
      mentions: 1,
    });
  });

  it("degrades to nulls for a channel this session has never seen", () => {
    const unknown = "55555555-5555-4555-8555-555555555555";
    expect(describeActivity(unknown, { count: 1, mentions: 0 })).toMatchObject({
      serverId: null,
      channelName: null,
      serverName: null,
    });
  });

  it("names a conversation after its participants, with no server", () => {
    const dm = "66666666-6666-4666-8666-666666666666";
    rememberChannels([
      { id: dm, serverId: null, name: "Ana", kind: "dm" },
    ]);

    expect(describeActivity(dm, { count: 1, mentions: 0 })).toMatchObject({
      serverId: null,
      channelName: "Ana",
      // A conversation belongs to no server, so there is nothing to say it came
      // from — and nothing may be borrowed from whichever server is on screen.
      serverName: null,
    });
  });
});

describe("rememberActivityChannel", () => {
  // The regression these cover, in one sentence: the app only ever fetches the
  // SELECTED server's channel list, so every activity frame from any other
  // server — and every frame from a thread, which is in no channel list at all
  // — described to nulls. That threw away the server id the frame was already
  // carrying, and with it the server's own notification level. A muted server
  // kept raising banners, and each one read "New activity / 1 new message"
  // with nothing to say where it came from and nothing in the app to look at.
  const bg = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const bgServer = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  it("takes the server from the frame for a channel no list has named", () => {
    rememberServers([{ id: bgServer, name: "QG" }]);
    rememberActivityChannel(bg, bgServer, "server");

    expect(describeActivity(bg, { count: 1, mentions: 0 })).toMatchObject({
      serverId: bgServer,
      // Still unnamed: the frame carries ids, not names, and no list has been
      // fetched for this server. The title falls back — but it now says which
      // server it fell back inside of.
      channelName: null,
      serverName: "QG",
    });
  });

  it("lets that server's own level silence it", () => {
    rememberActivityChannel(bg, bgServer, "server");
    const muted = stateWith({ servers: { [bgServer]: "none" } });
    const activity = describeActivity(bg, { count: 1, mentions: 0 });

    expect(
      resolveNotificationLevel(muted, activity.serverId, activity.channelId),
    ).toBe("none");
  });

  it("gives the notification somewhere to land when clicked", () => {
    rememberActivityChannel(bg, bgServer, "server");
    const activity = describeActivity(bg, { count: 1, mentions: 0 });

    expect(activityRoutePath(activity.channelId, activity.serverId)).toBe(
      `/app/server/${bgServer}/channel/${bg}`,
    );
  });

  it("never overwrites a name a real channel list already supplied", () => {
    const named = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    rememberChannels([{ id: named, serverId: bgServer, name: "geral" }]);
    rememberActivityChannel(named, bgServer, "server");

    expect(describeActivity(named, { count: 1, mentions: 0 })).toMatchObject({
      channelName: "geral",
    });
  });
});

describe("unreadByServer", () => {
  const server = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const inServer = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const dm = "12121212-1212-4212-8212-121212121212";

  it("files a channel's unread under the server it came from", () => {
    // Without this the server rail can only ever indicate the server already
    // selected, so a banner about any other one has no counterpart on screen:
    // the "nothing happened in the app" half of the same bug.
    rememberActivityChannel(inServer, server, "server");

    expect(
      unreadByServer({ [inServer]: { count: 2, mentions: 1 } }),
    ).toEqual({ [server]: { count: 2, mentions: 1 } });
  });

  it("keeps conversations off every server icon", () => {
    rememberChannels([{ id: dm, serverId: null, name: "Ana", kind: "dm" }]);

    expect(unreadByServer({ [dm]: { count: 3, mentions: 0 } })).toEqual({});
  });

  it("ignores a channel nothing has placed yet", () => {
    expect(
      unreadByServer({ "34343434-3434-4434-8434-343434343434": { count: 1, mentions: 0 } }),
    ).toEqual({});
  });
});

describe("activityRoutePath", () => {
  it("sends a server channel to its server", () => {
    const channel = "77777777-7777-4777-8777-777777777777";
    rememberChannels([
      { id: channel, serverId: SERVER, name: "general", kind: "server" },
    ]);
    expect(activityRoutePath(channel, SERVER)).toBe(
      `/app/server/${SERVER}/channel/${channel}`,
    );
  });

  it("sends a conversation to the conversation it is about", () => {
    // Without the kind this lands on /app, because a conversation has no server
    // id to build a channel URL from — a notification you click and nothing
    // opens is worse than none.
    const dm = "88888888-8888-4888-8888-888888888888";
    rememberChannels([{ id: dm, serverId: null, name: "Ana", kind: "dm" }]);
    expect(activityRoutePath(dm, null)).toBe(`/app/dm/${dm}`);
  });

  it("falls back to the app root for a channel it knows nothing about", () => {
    const unknown = "99999999-9999-4999-8999-999999999999";
    expect(activityRoutePath(unknown, null)).toBe("/app");
  });

  it("treats a channel from an API that predates conversations as a server channel", () => {
    const legacy = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    rememberChannels([{ id: legacy, serverId: SERVER, name: "general" }]);
    expect(activityRoutePath(legacy, SERVER)).toBe(
      `/app/server/${SERVER}/channel/${legacy}`,
    );
  });
});

describe("wantsActivityToast", () => {
  it("toasts a conversation only while the tab is visible", async () => {
    const { wantsActivityToast } = await import("./notifications");
    const context = { selectedChannelId: null, documentVisible: true };
    expect(wantsActivityToast({ kind: "dm" }, context)).toBe(true);
    expect(wantsActivityToast({ kind: "group" }, context)).toBe(true);
    // A server channel's badge is its signal; a hall would bury the screen.
    expect(wantsActivityToast({ kind: "server" }, context)).toBe(false);
    expect(wantsActivityToast({}, context)).toBe(false);
    // Hidden tab: the OS banner path owns it.
    expect(
      wantsActivityToast({ kind: "dm" }, { ...context, documentVisible: false }),
    ).toBe(false);
  });
});
