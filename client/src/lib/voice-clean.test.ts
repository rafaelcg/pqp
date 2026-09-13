import { describe, expect, it } from "vitest";
import {
  VOICE_CLEAN_SETTINGS_SEEN_KEY,
  isVoiceCleanSettingsSeen,
  markVoiceCleanSettingsSeen,
  shouldOfferVoiceCleanNudge,
  shouldShowVoiceCleanSettingsBadge,
  voiceCleanNudgeDismissedPatch,
} from "./voice-clean";

function baseInput() {
  return {
    dismissed: false,
    automated: false,
    inCall: true,
    micOn: true,
    presentingWatchParty: false,
    isDesktopViewport: true,
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("shouldOfferVoiceCleanNudge", () => {
  it("offers the card when every condition is met", () => {
    expect(shouldOfferVoiceCleanNudge(baseInput())).toBe(true);
  });

  it("stays quiet once dismissed", () => {
    expect(
      shouldOfferVoiceCleanNudge({ ...baseInput(), dismissed: true }),
    ).toBe(false);
  });

  it("never shows to an automated browser", () => {
    expect(
      shouldOfferVoiceCleanNudge({ ...baseInput(), automated: true }),
    ).toBe(false);
  });

  it("requires being in a call", () => {
    expect(
      shouldOfferVoiceCleanNudge({ ...baseInput(), inCall: false }),
    ).toBe(false);
  });

  it("requires the mic to be on", () => {
    expect(shouldOfferVoiceCleanNudge({ ...baseInput(), micOn: false })).toBe(
      false,
    );
  });

  it("stays off the call bar while presenting a watch party", () => {
    expect(
      shouldOfferVoiceCleanNudge({
        ...baseInput(),
        presentingWatchParty: true,
      }),
    ).toBe(false);
  });

  it("does not show on a narrow (phone) viewport", () => {
    expect(
      shouldOfferVoiceCleanNudge({ ...baseInput(), isDesktopViewport: false }),
    ).toBe(false);
  });

  it("combines every rule rather than short-circuiting on the first true one", () => {
    expect(
      shouldOfferVoiceCleanNudge({
        dismissed: true,
        automated: true,
        inCall: false,
        micOn: false,
        presentingWatchParty: true,
        isDesktopViewport: false,
      }),
    ).toBe(false);
  });
});

describe("voiceCleanNudgeDismissedPatch", () => {
  it("stamps the instant it is called with", () => {
    const now = new Date("2026-09-13T12:00:00.000Z");
    expect(voiceCleanNudgeDismissedPatch(now)).toEqual({
      voiceCleanNudgeDismissedAt: "2026-09-13T12:00:00.000Z",
    });
  });
});

describe("voice clean settings NOVO dot", () => {
  it("is unseen the first time, and remembers once marked", () => {
    const storage = memoryStorage();
    expect(isVoiceCleanSettingsSeen(storage, true)).toBe(false);
    markVoiceCleanSettingsSeen(storage, true);
    expect(storage.getItem(VOICE_CLEAN_SETTINGS_SEEN_KEY)).toBe("1");
    expect(isVoiceCleanSettingsSeen(storage, true)).toBe(true);
  });

  it("clears the badge once the section has been seen", () => {
    expect(
      shouldShowVoiceCleanSettingsBadge({
        settingsSeen: true,
        nudgeDismissed: false,
      }),
    ).toBe(false);
  });

  it("clears the badge once the nudge was acted on", () => {
    expect(
      shouldShowVoiceCleanSettingsBadge({
        settingsSeen: false,
        nudgeDismissed: true,
      }),
    ).toBe(false);
  });

  it("shows the badge until either happens", () => {
    expect(
      shouldShowVoiceCleanSettingsBadge({
        settingsSeen: false,
        nudgeDismissed: false,
      }),
    ).toBe(true);
  });
});
