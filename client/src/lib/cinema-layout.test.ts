import { describe, expect, it } from "vitest";
import { translateMessage } from "@/lib/i18n/instance";
import {
  cinemaOrientation,
  presenceAvatars,
  seatedInWatchPartyRoom,
  shouldShowCinema,
} from "./cinema-layout";

describe("shouldShowCinema", () => {
  it("shows cinema only for a live stream's audience", () => {
    expect(shouldShowCinema({ live: true, audience: true })).toBe(true);
  });

  it("stays off the ordinary stage for a joined participant", () => {
    expect(shouldShowCinema({ live: true, audience: false })).toBe(false);
  });

  it("stays off when nothing is live, even for an audience viewer", () => {
    expect(shouldShowCinema({ live: false, audience: true })).toBe(false);
  });

  it("stays off with neither condition", () => {
    expect(shouldShowCinema({ live: false, audience: false })).toBe(false);
  });

  // 2026-09-13: a viewer watching a watch party over HLS pressed Entrar and
  // got two pictures at two delays, two soundtracks. `WatchChannelStage`
  // correctly unmounted its own HLS player the instant the seat landed;
  // `CallStage` was the second, independent source, defaulting a freshly
  // seated participant straight into this same cinema view. Once seated in a
  // watch party's own room, the SFU screen share is the one and only
  // picture, never HLS again — no combination of `live`/`audience` may
  // override it.
  it("never shows cinema once seated in a watch party's own room", () => {
    expect(
      shouldShowCinema({ live: true, audience: true, isWatchParty: true }),
    ).toBe(false);
    expect(
      shouldShowCinema({ live: true, audience: false, isWatchParty: true }),
    ).toBe(false);
    expect(
      shouldShowCinema({ live: false, audience: true, isWatchParty: true }),
    ).toBe(false);
  });

  it("keeps the ordinary rule when isWatchParty is left unset", () => {
    // Same defaults as before this flag existed: nothing about a plain call
    // or a watch-party-disabled build moves.
    expect(shouldShowCinema({ live: true, audience: true })).toBe(true);
  });
});

describe("seatedInWatchPartyRoom", () => {
  it("is true once the party store has caught up", () => {
    expect(seatedInWatchPartyRoom(true, true)).toBe(true);
  });

  // THE SECOND HALF OF THE 2026-09-13 INCIDENT. A host presses "Entrar no
  // palco"; `voiceState.voiceChannelId` updates and the seat is real before
  // `watchParties.byChannel[id]?.state` (its own fetch/socket) has caught up
  // to "live". `watchPartyChrome` reads false on that render, but this
  // account is already seated in a watch party channel, so the join button
  // must still stay off.
  it("is true from the channel's own type even while watchPartyChrome lags", () => {
    expect(seatedInWatchPartyRoom(false, true)).toBe(true);
  });

  it("is true when only watchPartyChrome says so (defence in depth)", () => {
    expect(seatedInWatchPartyRoom(true, false)).toBe(true);
  });

  it("is false for an ordinary, non-watch-party voice channel", () => {
    expect(seatedInWatchPartyRoom(false, false)).toBe(false);
  });
});

describe("cinemaOrientation", () => {
  it("is desktop at or above the lg breakpoint", () => {
    expect(cinemaOrientation(true)).toBe("desktop");
  });

  it("is phone below the lg breakpoint", () => {
    expect(cinemaOrientation(false)).toBe("phone");
  });
});

describe("presenceAvatars", () => {
  it("caps the strip at 8 by default", () => {
    const people = Array.from({ length: 20 }, (_, i) => i);
    expect(presenceAvatars(people)).toHaveLength(8);
  });

  it("keeps every entry under the cap", () => {
    expect(presenceAvatars([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("voice.cinema.watching presence line", () => {
  it("pluralizes zero as the group form", () => {
    expect(translateMessage("voice.cinema.watching", { count: 0 })).toBe(
      "0 people watching",
    );
  });

  it("singularizes exactly one", () => {
    expect(translateMessage("voice.cinema.watching", { count: 1 })).toBe(
      "1 person watching",
    );
  });

  it("pluralizes a large audience", () => {
    expect(translateMessage("voice.cinema.watching", { count: 512 })).toBe(
      "512 people watching",
    );
  });
});
