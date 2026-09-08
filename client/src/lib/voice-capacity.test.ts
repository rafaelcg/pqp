import { afterEach, describe, expect, it } from "vitest";
import { CAMERA_LIMIT, SCREEN_SHARE_LIMIT } from "@pqp/shared";
import { loadLocale, setActiveCatalogue } from "@/lib/i18n";
import {
  capacityNoticeMessage,
  capacityRiseBetween,
  capacityRose,
  isVoiceCapacityHintSeen,
  rememberVoiceCapacityHint,
  roomCapacity,
  shouldShowCapacityNotice,
  voiceCapacityHintKey,
} from "./voice-capacity";

/**
 * The maps are module state shared with the running app, so a test that
 * changes one and does not put it back decides what every later test reads.
 *
 * Both are `as const` now (the voice server has no count for either, so both
 * `livekit` entries are the literal `null`), which makes the entries readonly
 * to a type checker and still perfectly writable at runtime. The cast is what
 * lets a test move a limit to prove the copy follows the code.
 */
type MutableLimits = Record<string, number | null>;
const REAL_SCREENS = SCREEN_SHARE_LIMIT.livekit;
const REAL_CAMERAS = CAMERA_LIMIT.livekit;

function setScreens(limit: number | null): void {
  (SCREEN_SHARE_LIMIT as MutableLimits).livekit = limit;
}

function setCameras(limit: number | null): void {
  (CAMERA_LIMIT as MutableLimits).livekit = limit;
}

afterEach(() => {
  setScreens(REAL_SCREENS);
  setCameras(REAL_CAMERAS);
  setActiveCatalogue(undefined);
});

/** A localStorage stand-in. The real one is not available under Node. */
function fakeStorage(): Pick<Storage, "getItem" | "setItem"> {
  const rows = new Map<string, string>();
  return {
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => {
      rows.set(key, value);
    },
  };
}

const ROOM = "33333333-3333-4333-8333-333333333333";

describe("capacityRiseBetween", () => {
  it("reports the rise when a room is moved mid-call", () => {
    const rise = capacityRiseBetween("mesh", "livekit");
    expect(rise).not.toBeNull();
    expect(rise).toEqual(roomCapacity("livekit"));
  });

  it("says nothing to somebody who arrived after the change", () => {
    // No `before`: this seat was minted by `welcome`, not carried across a
    // `voice-transport-changed`. Nothing changed for them.
    expect(capacityRiseBetween(null, "livekit")).toBeNull();
  });

  it("says nothing when the limits did not move", () => {
    expect(capacityRiseBetween("livekit", "livekit")).toBeNull();
    expect(capacityRiseBetween("mesh", "mesh")).toBeNull();
  });

  it("says nothing when the room got smaller", () => {
    expect(capacityRiseBetween("livekit", "mesh")).toBeNull();
  });

  it("stays silent on a change that gains nothing", () => {
    // The trigger is the capability, never the transport's name. Identical
    // numbers on both sides is a room that moved and a call that did not, and
    // there is nothing to tell the people in it.
    const same = { people: 8, screens: 2, cameras: 3 };
    expect(capacityRose(same, { ...same })).toBe(false);
    expect(capacityRose(same, { ...same, screens: 4 })).toBe(true);
    expect(capacityRose(same, { ...same, cameras: null })).toBe(true);
    expect(capacityRose(same, { ...same, people: null })).toBe(true);
    // Uncapped to a number is a fall, and a fall is not news either.
    expect(capacityRose({ ...same, cameras: null }, same)).toBe(false);
  });
});

describe("capacityNoticeMessage", () => {
  it("names the numbers the shared maps hold, not numbers of its own", () => {
    // A room that HAS a screen count, which the voice server no longer does;
    // the numbers are still read out of the map for any transport that names
    // one, and this is the proof that the copy follows the code.
    setScreens(7);
    setCameras(5);
    const before = capacityNoticeMessage(roomCapacity("livekit"));
    expect(before).toContain("7");

    setScreens(9);
    const after = capacityNoticeMessage(roomCapacity("livekit"));
    expect(after).toContain("9");
    expect(after).not.toBe(before);
  });

  it("says cameras in words when the room has no camera count to name", () => {
    setScreens(7);
    setCameras(null);
    const message = capacityNoticeMessage(roomCapacity("livekit"));
    expect(message).toContain("7");
    expect(message).toContain("camera for everyone");
    // The bug this shape exists to prevent: a null limit rendered into a slot.
    expect(message).not.toContain("null");
  });

  /**
   * WHAT THE VOICE SERVER ACTUALLY SAYS TODAY (2026-09-08).
   *
   * Both limits are `null` there now: `CAMERA_LIMIT.livekit` went first, and
   * `SCREEN_SHARE_LIMIT.livekit` followed when the share count was replaced by
   * the box's budget. So the branch this room really takes is the one with no
   * numbers in it at all, and it must read as a promise rather than as a gap.
   */
  it("promises both in words when the room has no count for either", () => {
    expect(SCREEN_SHARE_LIMIT.livekit).toBeNull();
    expect(CAMERA_LIMIT.livekit).toBeNull();
    const message = capacityNoticeMessage(roomCapacity("livekit"));
    expect(message).toContain("screen and camera for everyone");
    expect(message).not.toContain("null");
    expect(message).not.toContain("undefined");
  });

  it("speaks Portuguese when the catalogue is Portuguese", async () => {
    await loadLocale("pt-BR");
    try {
      expect(capacityNoticeMessage(roomCapacity("livekit"))).toContain(
        "Agora cabe mais gente",
      );
      // The room as it really is: no count for either, so the sentence has to
      // carry the promise instead of a number.
      expect(capacityNoticeMessage(roomCapacity("livekit"))).toContain(
        "tela e câmera pra todo mundo",
      );
      setScreens(7);
      setCameras(null);
      expect(capacityNoticeMessage(roomCapacity("livekit"))).toContain(
        "câmera pra todo mundo",
      );
    } finally {
      await loadLocale("en");
    }
  });

  it("reads an uncapped camera as a rise over any camera count", () => {
    setCameras(null);
    expect(capacityRiseBetween("mesh", "livekit")).not.toBeNull();
  });

  it("reads an uncapped screen count as a rise over the mesh number", () => {
    // The mesh side still names a number (its own measured limit falls back to
    // `SCREEN_SHARE_LIMIT.mesh`), and going from a number to "no number" is
    // the biggest rise there is.
    expect(SCREEN_SHARE_LIMIT.mesh).toBeGreaterThan(0);
    expect(capacityRiseBetween("mesh", "livekit")).not.toBeNull();
  });
});

describe("once per person per room", () => {
  it("shows the card, then never again in that room", () => {
    const storage = fakeStorage();
    const rise = capacityRiseBetween("mesh", "livekit");

    expect(isVoiceCapacityHintSeen(ROOM, storage, true)).toBe(false);
    expect(
      shouldShowCapacityNotice({
        rise,
        seen: isVoiceCapacityHintSeen(ROOM, storage, true),
        automated: false,
      }),
    ).toBe(true);

    rememberVoiceCapacityHint(ROOM, storage, true);

    expect(isVoiceCapacityHintSeen(ROOM, storage, true)).toBe(true);
    expect(
      shouldShowCapacityNotice({
        rise,
        seen: isVoiceCapacityHintSeen(ROOM, storage, true),
        automated: false,
      }),
    ).toBe(false);
  });

  it("keeps one room's card out of another room's way", () => {
    const storage = fakeStorage();
    rememberVoiceCapacityHint(ROOM, storage, true);
    const other = "44444444-4444-4444-8444-444444444444";
    expect(isVoiceCapacityHintSeen(other, storage, true)).toBe(false);
    expect(voiceCapacityHintKey(other)).not.toBe(voiceCapacityHintKey(ROOM));
  });

  it("never shows to an automated browser", () => {
    expect(
      shouldShowCapacityNotice({
        rise: capacityRiseBetween("mesh", "livekit"),
        seen: false,
        automated: true,
      }),
    ).toBe(false);
  });
});
