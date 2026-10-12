import { describe, expect, it } from "vitest";
import {
  deafenToggle,
  micLock,
  muteSet,
  muteToggle,
  type MicDeafen,
  type MicLocks,
} from "./deafen-mute";

const open: MicLocks = { canSpeak: true, serverMuted: false };
const serverMuted: MicLocks = { canSpeak: true, serverMuted: true };
const listenOnly: MicLocks = { canSpeak: false, serverMuted: false };

function mic(partial: Partial<MicDeafen> = {}): MicDeafen {
  return { muted: false, deafened: false, muteBeforeDeafen: null, ...partial };
}

describe("deafen and mute", () => {
  it("undeafen restores an open mic", () => {
    const deafened = deafenToggle(mic(), open);
    expect(deafened).toEqual({
      muted: true,
      deafened: true,
      muteBeforeDeafen: false,
    });
    expect(deafenToggle(deafened, open)).toEqual(mic());
  });

  it("undeafen keeps a mic that was already muted", () => {
    const deafened = deafenToggle(mic({ muted: true }), open);
    expect(deafened.muteBeforeDeafen).toBe(true);
    expect(deafenToggle(deafened, open)).toEqual(mic({ muted: true }));
  });

  it("a mute while deafened sticks when hearing comes back", () => {
    const deafened = deafenToggle(mic(), open);
    const mutedWhileDeaf = muteSet(deafened, true, open);
    expect(mutedWhileDeaf.deafened).toBe(true);
    expect(mutedWhileDeaf.muted).toBe(true);
    expect(deafenToggle(mutedWhileDeaf, open).muted).toBe(true);
    expect(deafenToggle(mutedWhileDeaf, open).deafened).toBe(false);
  });

  it("unmuting while deafened also undeafens", () => {
    const deafened = deafenToggle(mic({ muted: true }), open);
    expect(muteToggle(deafened, open)).toEqual(mic());
    expect(muteSet(deafened, false, open)).toEqual(mic());
  });

  it("repeats the same undeafen result when hearing is toggled twice", () => {
    const muted = mic({ muted: true });
    const once = deafenToggle(deafenToggle(muted, open), open);
    const twice = deafenToggle(deafenToggle(once, open), open);
    expect(once).toEqual(muted);
    expect(twice).toEqual(muted);
  });

  it("does not let undeafen lift a moderator mute or a listen-only seat", () => {
    const deafened = deafenToggle(mic(), serverMuted);
    expect(deafenToggle(deafened, serverMuted).muted).toBe(true);
    expect(deafenToggle(deafened, serverMuted).deafened).toBe(false);

    const locked = deafenToggle(mic(), listenOnly);
    expect(deafenToggle(locked, listenOnly).muted).toBe(true);
  });

  it("a moderator mute during deafen sticks after both are lifted in order", () => {
    const deafened = deafenToggle(mic(), open);
    const locked = micLock(deafened, serverMuted);
    expect(locked.muteBeforeDeafen).toBe(true);
    const stillMuted = deafenToggle(locked, open);
    expect(stillMuted.deafened).toBe(false);
    expect(stillMuted.muted).toBe(true);
  });

  it("the mute control does nothing while the seat cannot speak", () => {
    const deafened = deafenToggle(mic(), open);
    expect(muteToggle(deafened, listenOnly)).toEqual(deafened);
    expect(muteSet(deafened, false, listenOnly).deafened).toBe(true);
    expect(muteSet(deafened, false, listenOnly).muted).toBe(true);
  });

  it("unmute while deafened and server-muted restores hearing and leaves the mic off", () => {
    const deafened = deafenToggle(mic(), open);
    const next = muteToggle(deafened, serverMuted);
    expect(next.deafened).toBe(false);
    expect(next.muted).toBe(true);
  });
});
