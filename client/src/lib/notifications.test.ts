import { describe, expect, it } from "vitest";
import {
  describeActivity,
  formatBadge,
  rememberChannels,
  rememberServers,
  resolveNotificationLevel,
  shouldNotify,
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
    });
  });

  it("names a channel whose server is not the one on screen", () => {
    const other = "33333333-3333-4333-8333-333333333333";
    const otherServer = "44444444-4444-4444-8444-444444444444";
    rememberChannels([{ id: other, serverId: otherServer, name: "deploys" }]);
    rememberServers([{ id: otherServer, name: "work" }]);

    // The whole point of the directories: an activity frame arriving for a
    // server the user is not looking at still says where it came from.
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
});
