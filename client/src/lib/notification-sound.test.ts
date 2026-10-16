import { describe, expect, it } from "vitest";
import {
  appWillPlayCue,
  bannerSilent,
  cueForBurstActivity,
} from "./notification-sound";
import type { SoundState } from "./sounds";

const ON: SoundState = {
  enabled: true,
  message: true,
  mention: true,
  voiceJoin: true,
  voiceLeave: true,
  incomingCall: true,
  outgoingCall: true,
  nudge: true,
};

describe("cueForBurstActivity", () => {
  it("mirrors what the burst flush plays", () => {
    expect(cueForBurstActivity({ mentions: 2, kind: "server" })).toBe("mention");
    expect(cueForBurstActivity({ mentions: 1, kind: "dm" })).toBe("mention");
    expect(cueForBurstActivity({ mentions: 0, systemKind: "nudge", kind: "dm" })).toBe("nudge");
    expect(cueForBurstActivity({ mentions: 0, kind: "dm" })).toBe("message");
    expect(cueForBurstActivity({ mentions: 0, kind: "group" })).toBe("message");
  });

  it("has no cue for an ordinary channel message", () => {
    expect(cueForBurstActivity({ mentions: 0, kind: "server" })).toBeNull();
    expect(cueForBurstActivity({ mentions: 0 })).toBeNull();
  });
});

describe("appWillPlayCue", () => {
  it("needs the master switch and the cue's own switch", () => {
    expect(appWillPlayCue(ON, "message")).toBe(true);
    expect(appWillPlayCue({ ...ON, message: false }, "message")).toBe(false);
    expect(appWillPlayCue({ ...ON, enabled: false }, "message")).toBe(false);
  });

  it("is false for an event with no cue", () => {
    expect(appWillPlayCue(ON, null)).toBe(false);
  });
});

describe("bannerSilent", () => {
  it("is silent while the window is in front, whatever the settings", () => {
    expect(bannerSilent({ windowFocused: true, sounds: ON, cue: null })).toBe(true);
    expect(
      bannerSilent({ windowFocused: true, sounds: { ...ON, enabled: false }, cue: "mention" }),
    ).toBe(true);
  });

  it("is silent when the window is away and the app plays the cue", () => {
    expect(bannerSilent({ windowFocused: false, sounds: ON, cue: "mention" })).toBe(true);
    expect(bannerSilent({ windowFocused: false, sounds: ON, cue: "incomingCall" })).toBe(true);
  });

  it("lets the OS sound play when the window is away and the app plays nothing", () => {
    expect(bannerSilent({ windowFocused: false, sounds: ON, cue: null })).toBe(false);
    expect(
      bannerSilent({ windowFocused: false, sounds: { ...ON, enabled: false }, cue: "mention" }),
    ).toBe(false);
    expect(
      bannerSilent({ windowFocused: false, sounds: { ...ON, nudge: false }, cue: "nudge" }),
    ).toBe(false);
  });
});
