/**
 * The desktop banner's own sound.
 *
 * The shell used to make every banner silent. It now honours a `silent` field:
 * `true` while the app's sounds are on (the app plays its own cue, an OS sound
 * would double it), `false` when the person turned app sounds off, so the OS
 * banner is not mute. Every route to `desktop.notify` has to say so.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sounds = vi.hoisted(() => ({
  enabled: true,
  playActivitySound: vi.fn(),
  playCue: vi.fn(),
}));
vi.mock("./sounds", () => ({
  playActivitySound: sounds.playActivitySound,
  playCue: sounds.playCue,
  getSoundState: () => ({ enabled: sounds.enabled }),
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
  appPlaysSounds,
  describeActivity,
  notifyChannelActivity,
  notifyIncomingCall,
  notifyStreamStarted,
  rememberChannels,
  resetNotificationBursts,
  setDesktopNotificationsEnabled,
} = await import("./notifications");

const CHANNEL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  bridged.length = 0;
  sounds.enabled = true;
  resetNotificationBursts();
  setDesktopNotificationsEnabled(true);
  rememberChannels([{ id: CHANNEL, serverId: null, name: "Ana", kind: "dm" }]);
});

describe("silent on the desktop bridge follows the app's sounds", () => {
  it("reads the master switch", () => {
    expect(appPlaysSounds()).toBe(true);
    sounds.enabled = false;
    expect(appPlaysSounds()).toBe(false);
  });

  it("a message banner is silent while app sounds are on", () => {
    notifyChannelActivity(describeActivity(CHANNEL, { count: 1, mentions: 0 }), {
      selectedChannelId: null,
      documentVisible: false,
      windowFocused: false,
    });
    expect(bridged).toHaveLength(1);
    expect(bridged[0]!.silent).toBe(true);
  });

  it("a message banner lets the OS make its sound when app sounds are off", () => {
    sounds.enabled = false;
    notifyChannelActivity(describeActivity(CHANNEL, { count: 1, mentions: 0 }), {
      selectedChannelId: null,
      documentVisible: false,
      windowFocused: false,
    });
    expect(bridged).toHaveLength(1);
    expect(bridged[0]!.silent).toBe(false);
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

  it("a stream starting follows the same rule", () => {
    const frame = {
      serverId: SERVER,
      channelId: CHANNEL,
      channelName: "filminho",
      serverName: "QG",
      sharerName: "Alberto",
      kind: "voice" as const,
    };
    expect(notifyStreamStarted(frame, { windowFocused: false, openServerId: null })).toBe(true);
    expect(bridged.at(-1)!.silent).toBe(true);
    sounds.enabled = false;
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
