import { describe, expect, it } from "vitest";
import {
  ATTACHED_FEATURE_HINT_ORDER,
  FEATURE_HINT_STORAGE_KEYS,
  isFeatureHintSeen,
  rememberFeatureHint,
  shouldOfferBringFriendsHint,
  shouldOfferCallDockHint,
  shouldOfferChannelPinHint,
  shouldOfferComposerFormatHint,
  shouldOfferMusicHint,
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

  it("lets the moved controls beat every hint that points at one of them", () => {
    expect(
      winningFeatureHint({
        callDock: true,
        watchPartyHost: true,
        watchPartyViewer: true,
        watchParty: true,
        music: true,
        composerFormat: true,
      }),
    ).toBe("callDock");
    expect(ATTACHED_FEATURE_HINT_ORDER[0]).toBe("callDock");
    // And steps aside once it has had its turn.
    expect(winningFeatureHint({ callDock: false, music: true })).toBe("music");
  });

  it("lets Watch party beat the format bar, and format beat pin", () => {
    expect(
      winningFeatureHint({ watchParty: true, composerFormat: true, channelPin: true }),
    ).toBe("watchParty");
    expect(
      winningFeatureHint({ composerFormat: true, channelPin: true }),
    ).toBe("composerFormat");
    expect(winningFeatureHint({ channelPin: true })).toBe("channelPin");
    expect(
      winningFeatureHint({ watchParty: true, bringFriends: true }),
    ).toBe("watchParty");
    expect(
      winningFeatureHint({ bringFriends: true, music: true }),
    ).toBe("bringFriends");
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

describe("shouldOfferCallDockHint", () => {
  const ready = {
    seen: false,
    automated: false,
    dockVisible: true,
    connected: true,
  };

  it("shows the first time the dock opens in a room you are in", () => {
    expect(shouldOfferCallDockHint(ready)).toBe(true);
  });

  it("stays away once seen, under automation, off the dock, or before the join lands", () => {
    expect(shouldOfferCallDockHint({ ...ready, seen: true })).toBe(false);
    expect(shouldOfferCallDockHint({ ...ready, automated: true })).toBe(false);
    expect(shouldOfferCallDockHint({ ...ready, dockVisible: false })).toBe(
      false,
    );
    expect(shouldOfferCallDockHint({ ...ready, connected: false })).toBe(
      false,
    );
  });

  it("has a key of its own", () => {
    expect(FEATURE_HINT_STORAGE_KEYS.callDock).toBe(
      "pqp:feature-hint-call-dock-2026-09",
    );
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

describe("shouldOfferBringFriendsHint", () => {
  const ready = {
    seen: false,
    automated: false,
    presenting: true,
    inServer: true,
    canInvite: true,
    roomSize: 1,
  };

  it("shows once when you are presenting to a small server call", () => {
    expect(shouldOfferBringFriendsHint(ready)).toBe(true);
    expect(shouldOfferBringFriendsHint({ ...ready, roomSize: 2 })).toBe(true);
  });

  it("hides for viewers, DMs, a full trio, or a second look", () => {
    expect(shouldOfferBringFriendsHint({ ...ready, seen: true })).toBe(false);
    expect(shouldOfferBringFriendsHint({ ...ready, automated: true })).toBe(
      false,
    );
    expect(shouldOfferBringFriendsHint({ ...ready, presenting: false })).toBe(
      false,
    );
    expect(shouldOfferBringFriendsHint({ ...ready, inServer: false })).toBe(
      false,
    );
    expect(shouldOfferBringFriendsHint({ ...ready, canInvite: false })).toBe(
      false,
    );
    expect(shouldOfferBringFriendsHint({ ...ready, roomSize: 3 })).toBe(false);
    expect(shouldOfferBringFriendsHint({ ...ready, roomSize: 0 })).toBe(false);
  });

  it("records under the September 2026 key", () => {
    const storage = memory();
    rememberFeatureHint("bringFriends", storage, true);
    expect(storage.getItem(FEATURE_HINT_STORAGE_KEYS.bringFriends)).toBe("1");
    expect(isFeatureHintSeen("bringFriends", storage, true)).toBe(true);
    expect(isFeatureHintSeen("bringFriends", storage, false)).toBe(false);
  });
});

describe("shouldOfferMusicHint", () => {
  const ready = {
    seen: false,
    automated: false,
    connected: true,
    canSpeak: true,
    playing: false,
    filaOpen: false,
  };

  it("shows once in a call where nobody has put anything on", () => {
    expect(shouldOfferMusicHint(ready)).toBe(true);
  });

  it("stays quiet for a listener, a room with music on, and an open panel", () => {
    expect(shouldOfferMusicHint({ ...ready, seen: true })).toBe(false);
    expect(shouldOfferMusicHint({ ...ready, automated: true })).toBe(false);
    expect(shouldOfferMusicHint({ ...ready, connected: false })).toBe(false);
    // Without SPEAK there is nothing this person could add, so the card
    // would be describing a control they cannot use.
    expect(shouldOfferMusicHint({ ...ready, canSpeak: false })).toBe(false);
    // The bar is on screen: the card would point at what they are reading.
    expect(shouldOfferMusicHint({ ...ready, playing: true })).toBe(false);
    // They already opened the panel the card exists to send them to.
    expect(shouldOfferMusicHint({ ...ready, filaOpen: true })).toBe(false);
  });

  it("records under the second September 2026 key", () => {
    const storage = memory();
    // The card was re-aimed twice under the first key, so everybody who saw
    // the sidebar-era copy has it stamped and would never see this one.
    expect(FEATURE_HINT_STORAGE_KEYS.music).toBe(
      "pqp:feature-hint-music-2026-09-2",
    );
    rememberFeatureHint("music", storage, true);
    expect(isFeatureHintSeen("music", storage, true)).toBe(true);
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
