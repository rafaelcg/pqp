/**
 * The desktop banner's own sound (bug #123).
 *
 * The shell honours a `silent` field: `true` only while the app plays its own
 * cue for that event, `false` when it plays none (app sounds off, that cue off,
 * or an event with no cue such as a channel message or a stream starting), so
 * the OS banner is never mute. Every route to `desktop.notify` has to say so.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sounds = vi.hoisted(() => ({
  enabled: true,
  message: true,
  playActivitySound: vi.fn(),
  playCue: vi.fn(),
}));
vi.mock("./sounds", () => ({
  playActivitySound: sounds.playActivitySound,
  playCue: sounds.playCue,
  getSoundState: () => ({
    enabled: sounds.enabled,
    message: sounds.message,
    mention: true,
    voiceJoin: true,
    voiceLeave: true,
    incomingCall: true,
    outgoingCall: true,
    nudge: true,
  }),
}));

interface Bridged {
  title: string;
  body: string;
  tag: string;
  path: string;
  silent?: boolean;
}
const bridged: Bridged[] = [];

class FakeNotification {
  static permission = "granted";
  onclick: (() => void) | null = null;
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.Notification = FakeNotification;
globals.addEventListener = () => {};
globals.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globals.window = globals;
globals.pqpDesktop = {
  isElectron: true,
  platform: "win32",
  notify: (payload: Bridged) => {
    bridged.push(payload);
  },
};

const {
  bannerIsSilent,
  describeActivity,
  notifyChannelActivity,
  notifyIncomingCall,
  notifyStreamStarted,
  rememberChannels,
  resetNotificationBursts,
  setDesktopNotificationsEnabled,
} = await import("./notifications");

const CHANNEL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEXT_CHANNEL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SERVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const away = {
  selectedChannelId: null,
  documentVisible: false,
  windowFocused: false,
};

beforeEach(() => {
  bridged.length = 0;
  sounds.enabled = true;
  sounds.message = true;
  resetNotificationBursts();
  setDesktopNotificationsEnabled(true);
  rememberChannels([
    { id: CHANNEL, serverId: null, name: "Ana", kind: "dm" },
    { id: TEXT_CHANNEL, serverId: SERVER, name: "geral", kind: "server" },
  ]);
});

describe("silent on the desktop bridge follows what the app actually plays", () => {
  it("is silent only while the app plays that cue itself", () => {
    expect(bannerIsSilent("message")).toBe(true);
    sounds.message = false;
    expect(bannerIsSilent("message")).toBe(false);
    sounds.message = true;
    sounds.enabled = false;
    expect(bannerIsSilent("message")).toBe(false);
  });

  it("a DM banner is silent while its app cue plays", () => {
    notifyChannelActivity(describeActivity(CHANNEL, { count: 1, mentions: 0 }), away);
    expect(bridged).toHaveLength(1);
    expect(bridged[0]!.silent).toBe(true);
  });

  it("a DM banner lets the OS make its sound when app sounds are off", () => {
    sounds.enabled = false;
    notifyChannelActivity(describeActivity(CHANNEL, { count: 1, mentions: 0 }), away);
    expect(bridged).toHaveLength(1);
    expect(bridged[0]!.silent).toBe(false);
  });

  it("a DM banner lets the OS make its sound when only the message cue is off", () => {
    sounds.message = false;
    notifyChannelActivity(describeActivity(CHANNEL, { count: 1, mentions: 0 }), away);
    expect(bridged[0]!.silent).toBe(false);
  });

  it("an ordinary channel message has no app cue, so its banner keeps the OS sound", () => {
    notifyChannelActivity(describeActivity(TEXT_CHANNEL, { count: 1, mentions: 0 }), away);
    expect(bridged).toHaveLength(1);
    expect(bridged[0]!.silent).toBe(false);
  });

  it("a mention in a channel plays the app cue, so its banner is silent", () => {
    notifyChannelActivity(describeActivity(TEXT_CHANNEL, { count: 1, mentions: 1 }), away);
    expect(bridged[0]!.silent).toBe(true);
  });

  it("an incoming call follows the same rule", () => {
    notifyIncomingCall(
      { conversationId: CHANNEL, kind: "dm", callerName: "Ana" },
      { windowFocused: false },
    );
    expect(bridged.at(-1)!.silent).toBe(true);
    sounds.enabled = false;
    notifyIncomingCall(
      { conversationId: CHANNEL, kind: "dm", callerName: "Ana" },
      { windowFocused: false },
    );
    expect(bridged.at(-1)!.silent).toBe(false);
  });

  it("a stream starting has no app cue, so the OS sound plays", () => {
    const frame = {
      serverId: SERVER,
      channelId: CHANNEL,
      channelName: "filminho",
      serverName: "QG",
      sharerName: "Alberto",
      kind: "voice" as const,
    };
    expect(notifyStreamStarted(frame, { windowFocused: false, openServerId: null })).toBe(true);
    expect(bridged.at(-1)!.silent).toBe(false);
  });
});

describe("the shell is told when somebody is signed in", () => {
  it("the signed-in app shell reports it, and un-reports it on unmount", async () => {
    const app = (await import("node:fs")).readFileSync(
      new URL("../App.tsx", import.meta.url),
      "utf8",
    );
    expect(app).toMatch(/getDesktop\(\)\?\.setSignedIn\?\.\(true\)/);
    expect(app).toMatch(/return \(\) => getDesktop\(\)\?\.setSignedIn\?\.\(false\)/);
  });
});
