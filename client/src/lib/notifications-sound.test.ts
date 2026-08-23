import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const playActivitySound = vi.fn();

vi.mock("./sounds", () => ({
  playActivitySound: (...args: unknown[]) => playActivitySound(...args),
}));

const CHANNEL = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

const {
  notifyChannelActivity,
  notifyOpenChannelMessage,
  resetNotificationBursts,
  setChannelNotificationLevel,
  setDesktopNotificationsEnabled,
  setDoNotDisturb,
} = await import("./notifications");

function activity(mentions = 0) {
  return {
    channelId: CHANNEL,
    serverId: null,
    channelName: "general",
    serverName: null,
    count: 1,
    mentions,
  };
}

const away = {
  selectedChannelId: OTHER,
  documentVisible: true,
};

beforeEach(() => {
  playActivitySound.mockReset();
  setDoNotDisturb(false);
  setDesktopNotificationsEnabled(false);
  resetNotificationBursts();
});

afterEach(() => {
  resetNotificationBursts();
  setDoNotDisturb(false);
});

describe("notifyChannelActivity sounds", () => {
  it("stays silent for a plain message when desktop banners are off", () => {
    notifyChannelActivity(activity(0), away);
    expect(playActivitySound).not.toHaveBeenCalled();
  });

  it("plays the mention cue when the burst named the reader", () => {
    notifyChannelActivity(activity(1), away);
    expect(playActivitySound).toHaveBeenCalledWith(1);
  });

  it("stays silent while Do Not Disturb is on", () => {
    setDoNotDisturb(true);
    notifyChannelActivity(activity(1), away);
    expect(playActivitySound).not.toHaveBeenCalled();
  });

  it("stays silent for the channel the user is already looking at", () => {
    notifyChannelActivity(activity(0), {
      selectedChannelId: CHANNEL,
      documentVisible: true,
    });
    expect(playActivitySound).not.toHaveBeenCalled();
  });
});

describe("notifyOpenChannelMessage", () => {
  afterEach(() => {
    setChannelNotificationLevel(CHANNEL, null);
  });

  it("stays silent for a plain message in the channel already on screen", () => {
    notifyOpenChannelMessage(CHANNEL, false);
    expect(playActivitySound).not.toHaveBeenCalled();
  });

  it("plays the mention cue when the open-channel message named the reader", () => {
    notifyOpenChannelMessage(CHANNEL, true);
    expect(playActivitySound).toHaveBeenCalledWith(1);
  });

  it("stays silent while Do Not Disturb is on", () => {
    setDoNotDisturb(true);
    notifyOpenChannelMessage(CHANNEL, true);
    expect(playActivitySound).not.toHaveBeenCalled();
  });

  it("stays silent when the channel is muted", () => {
    setChannelNotificationLevel(CHANNEL, "none");
    notifyOpenChannelMessage(CHANNEL, true);
    expect(playActivitySound).not.toHaveBeenCalled();
  });

  it("at 'mentions' plays only when named", () => {
    setChannelNotificationLevel(CHANNEL, "mentions");
    notifyOpenChannelMessage(CHANNEL, false);
    expect(playActivitySound).not.toHaveBeenCalled();
    notifyOpenChannelMessage(CHANNEL, true);
    expect(playActivitySound).toHaveBeenCalledWith(1);
  });
});
