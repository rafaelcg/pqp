import { describe, expect, it } from "vitest";
import {
  FEATURE_HINT_STORAGE_KEYS,
  isFeatureHintSeen,
  rememberFeatureHint,
  shouldOfferChannelPinHint,
  shouldOfferComposerFormatHint,
  shouldOfferShortcutsHint,
  shouldOfferWatchPartyHint,
  winningFeatureHint,
} from "./feature-hints";

function memory(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe("winningFeatureHint", () => {
  it("returns null when nobody wants a bubble", () => {
    expect(winningFeatureHint({})).toBeNull();
    expect(
      winningFeatureHint({ watchParty: false, composerFormat: false }),
    ).toBeNull();
  });

  it("lets Watch party beat the format bar, and format beat pin", () => {
    expect(
      winningFeatureHint({ watchParty: true, composerFormat: true, channelPin: true }),
    ).toBe("watchParty");
    expect(
      winningFeatureHint({ composerFormat: true, channelPin: true }),
    ).toBe("composerFormat");
    expect(winningFeatureHint({ channelPin: true })).toBe("channelPin");
  });
});

describe("remember / seen", () => {
  it("records each id under its own key", () => {
    const storage = memory();
    expect(isFeatureHintSeen("composerFormat", storage, true)).toBe(false);
    rememberFeatureHint("composerFormat", storage, true);
    expect(storage.getItem(FEATURE_HINT_STORAGE_KEYS.composerFormat)).toBe(
      "1",
    );
    expect(isFeatureHintSeen("composerFormat", storage, true)).toBe(true);
    expect(isFeatureHintSeen("watchParty", storage, true)).toBe(false);
  });

  it("writes nothing when persist is off", () => {
    const storage = memory();
    rememberFeatureHint("shortcuts", storage, false);
    expect(storage.getItem(FEATURE_HINT_STORAGE_KEYS.shortcuts)).toBeNull();
    expect(isFeatureHintSeen("shortcuts", storage, false)).toBe(false);
  });
});

describe("shouldOfferWatchPartyHint", () => {
  const ready = {
    seen: false,
    automated: false,
    connected: true,
    canStream: true,
    canShare: true,
  };

  it("shows once when the call strip can share", () => {
    expect(shouldOfferWatchPartyHint(ready)).toBe(true);
  });

  it("hides when the strip would not offer share", () => {
    expect(shouldOfferWatchPartyHint({ ...ready, seen: true })).toBe(false);
    expect(shouldOfferWatchPartyHint({ ...ready, automated: true })).toBe(false);
    expect(shouldOfferWatchPartyHint({ ...ready, connected: false })).toBe(
      false,
    );
    expect(shouldOfferWatchPartyHint({ ...ready, canStream: false })).toBe(
      false,
    );
    expect(shouldOfferWatchPartyHint({ ...ready, canShare: false })).toBe(
      false,
    );
  });
});

describe("shouldOfferChannelPinHint", () => {
  it("shows on a server channel list, once", () => {
    expect(
      shouldOfferChannelPinHint({
        seen: false,
        automated: false,
        serverOpen: true,
      }),
    ).toBe(true);
    expect(
      shouldOfferChannelPinHint({
        seen: true,
        automated: false,
        serverOpen: true,
      }),
    ).toBe(false);
    expect(
      shouldOfferChannelPinHint({
        seen: false,
        automated: false,
        serverOpen: false,
      }),
    ).toBe(false);
  });
});

describe("shouldOfferComposerFormatHint", () => {
  it("shows on a text channel, once", () => {
    expect(
      shouldOfferComposerFormatHint({
        seen: false,
        automated: false,
        textChannelOpen: true,
      }),
    ).toBe(true);
    expect(
      shouldOfferComposerFormatHint({
        seen: true,
        automated: false,
        textChannelOpen: true,
      }),
    ).toBe(false);
    expect(
      shouldOfferComposerFormatHint({
        seen: false,
        automated: false,
        textChannelOpen: false,
      }),
    ).toBe(false);
  });
});

describe("shouldOfferShortcutsHint", () => {
  it("waits for a keyboard, a quiet beat, and an empty attached slot", () => {
    expect(
      shouldOfferShortcutsHint({
        seen: false,
        automated: false,
        hasKeyboard: true,
        quietReady: true,
        attachedHint: null,
      }),
    ).toBe(true);
    expect(
      shouldOfferShortcutsHint({
        seen: false,
        automated: false,
        hasKeyboard: true,
        quietReady: false,
        attachedHint: null,
      }),
    ).toBe(false);
    expect(
      shouldOfferShortcutsHint({
        seen: false,
        automated: false,
        hasKeyboard: false,
        quietReady: true,
        attachedHint: null,
      }),
    ).toBe(false);
    expect(
      shouldOfferShortcutsHint({
        seen: false,
        automated: false,
        hasKeyboard: true,
        quietReady: true,
        attachedHint: "composerFormat",
      }),
    ).toBe(false);
  });
});
