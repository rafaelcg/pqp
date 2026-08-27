import { describe, expect, it } from "vitest";
import type { WatchPartyState } from "@pqp/shared";
import en from "@/locales/en/translation.json";
import ptBR from "@/locales/pt-BR/translation.json";
import {
  failurePresentation,
  keepsJoined,
  showsComposer,
  showsPartyEditing,
  showsPlayer,
  statusKey,
  transportAvailability,
  watchPartyView,
  type PlaybackFailureReason,
} from "./watch-party-view";

/**
 * The branches are the module. Which state renders which affordance is the
 * whole contract between the sync layer and the person looking at the screen,
 * and none of it is visible from a component that only ever gets rendered in a
 * browser by hand.
 */

function party(overrides: Partial<WatchPartyState> = {}): WatchPartyState {
  return {
    videoId: "dQw4w9WgXcQ",
    status: "playing",
    positionMs: 0,
    atMs: 0,
    rev: 1,
    actorId: "peer-a",
    ...overrides,
  };
}

const NO_PARTY = {
  party: null,
  joined: false,
  failure: null,
  composing: false,
} as const;

describe("watchPartyView", () => {
  it("offers a one-line launcher when there is no party", () => {
    expect(watchPartyView(NO_PARTY)).toEqual({ kind: "launcher", reason: null });
  });

  it("opens the paste form when it is asked for", () => {
    expect(watchPartyView({ ...NO_PARTY, composing: true }).kind).toBe("compose");
  });

  it("asks for a video when the party exists but carries none", () => {
    // `videoId: null` is a real state in the wire contract: the party outlives
    // the video that started it.
    expect(
      watchPartyView({
        party: party({ videoId: null }),
        joined: true,
        failure: null,
        composing: false,
      }).kind,
    ).toBe("compose");
  });

  it("shows the join card before the click and the player after it", () => {
    const before = watchPartyView({
      party: party(),
      joined: false,
      failure: null,
      composing: false,
    });
    const after = watchPartyView({
      party: party(),
      joined: true,
      failure: null,
      composing: false,
    });
    expect(before.kind).toBe("join");
    expect(after.kind).toBe("watching");
  });

  it("does not invite a click into a video already known to refuse", () => {
    // Failure outranks the join gesture. The other ordering asks somebody to
    // press a button whose only outcome is an error card.
    const view = watchPartyView({
      party: party(),
      joined: false,
      failure: "notPlayable",
      composing: false,
    });
    expect(view).toEqual({ kind: "failed", reason: "notPlayable" });
  });
});

describe("the join gesture gates playback", () => {
  /**
   * The single most important assertion in this file. A browser will not start
   * a video nobody asked for, and the answer is not to mount the player quietly
   * and hope: it is to not mount it at all until somebody clicks.
   */
  it("mounts the player in exactly one view", () => {
    const kinds = [
      watchPartyView(NO_PARTY),
      watchPartyView({ ...NO_PARTY, composing: true }),
      watchPartyView({
        party: party(),
        joined: false,
        failure: null,
        composing: false,
      }),
      watchPartyView({
        party: party(),
        joined: false,
        failure: "refererBlocked",
        composing: false,
      }),
      watchPartyView({
        party: party(),
        joined: true,
        failure: null,
        composing: false,
      }),
    ];
    expect(kinds.map(showsPlayer)).toEqual([false, false, false, false, true]);
  });

  it("forgets the click when the party is torn down", () => {
    expect(keepsJoined(true, party())).toBe(true);
    expect(keepsJoined(true, null)).toBe(false);
  });

  it("keeps the click across a change of video", () => {
    // Autoplay activation is sticky per document, so a second gate would gate
    // nothing and would put a click between a group and the next thing they
    // chose to watch together.
    expect(keepsJoined(true, party({ videoId: "other-video" }))).toBe(true);
  });
});

describe("a failed player is a reader and never a writer", () => {
  const failed = watchPartyView({
    party: party(),
    joined: true,
    failure: "notPlayable",
    composing: false,
  });

  /**
   * Not decoration. A player that never started reports position 0 for ever,
   * and position 0 on a fresh `rev` outranks everybody and drags the whole
   * channel back to the beginning of the video. The UI is where that is
   * prevented.
   */
  it("never leaves the transport dispatching from a failed player", () => {
    expect(transportAvailability(failed)).toBe("unavailable");
  });

  it("shows the controls rather than hiding them, so the rule is legible", () => {
    // "unavailable" and "off" are different answers on purpose: controls that
    // vanish read as a screen that broke, controls that are dimmed read as a
    // rule.
    expect(transportAvailability(failed)).not.toBe("off");
  });

  it("only dispatches transport for somebody actually watching", () => {
    expect(
      transportAvailability(
        watchPartyView({
          party: party(),
          joined: true,
          failure: null,
          composing: false,
        }),
      ),
    ).toBe("on");
    expect(
      transportAvailability(
        watchPartyView({
          party: party(),
          joined: false,
          failure: null,
          composing: false,
        }),
      ),
    ).toBe("off");
    expect(transportAvailability(watchPartyView(NO_PARTY))).toBe("off");
  });

  it("still lets the person who picked a broken video pick another", () => {
    // Loading a video states its own position and ending the party carries no
    // position at all, so neither can lose the `rev` race the ban is about.
    expect(showsPartyEditing(failed)).toBe(true);
  });
});

const ALL_REASONS: PlaybackFailureReason[] = [
  "notPlayable",
  "ageRestricted",
  "refererBlocked",
  "videoUnavailable",
  "playerFailed",
];

describe("failure copy", () => {
  const catalogue = en as Record<string, string>;
  const portuguese = ptBR as Record<string, string>;

  it("gives every reason a sentence rather than a blank frame", () => {
    for (const reason of ALL_REASONS) {
      const { title, body } = failurePresentation(reason);
      expect(catalogue[title]).toBeTruthy();
      expect(catalogue[body]).toBeTruthy();
      expect(portuguese[title]).toBeTruthy();
      expect(portuguese[body]).toBeTruthy();
    }
  });

  /**
   * The refactor this guards against is real and cheap to make: two
   * near-identical cards get collapsed into one "could not play" branch, and
   * nobody notices until somebody is told to try a different video when the
   * video was fine all along.
   */
  it("keeps the two named failures genuinely distinct in both languages", () => {
    const named: PlaybackFailureReason[] = ["notPlayable", "refererBlocked"];
    for (const cat of [catalogue, portuguese]) {
      const titles = named.map((r) => cat[failurePresentation(r).title]);
      const bodies = named.map((r) => cat[failurePresentation(r).body]);
      expect(new Set(titles).size).toBe(2);
      expect(new Set(bodies).size).toBe(2);
    }
  });

  /**
   * The merge, pinned by object identity rather than by two strings happening
   * to agree.
   *
   * `describeYouTubeError` cannot produce `ageRestricted`: 101 and 150 are
   * returned for uploader-disabled embedding and for age restriction alike,
   * and only the Data API separates them. A separate age-restriction card
   * could therefore never render, which is the same failure as a test that
   * cannot fail. This is what stops the folklore that "150 means age
   * restricted" being helpfully re-added later.
   */
  it("has one card for the codes we cannot tell apart, not several", () => {
    expect(failurePresentation("ageRestricted")).toBe(
      failurePresentation("notPlayable"),
    );
  });

  /**
   * Measured on 2026-08-27: embedding disabled, age restricted, deleted,
   * private and a string that is not a video id ALL report error 150, so this
   * one card is what renders for every one of them. Naming a single cause here
   * would be a confident lie on the only branch that fires, which is why the
   * body has to offer the possibilities and commit to none of them.
   */
  it("offers the possibilities without committing to one", () => {
    const body = failurePresentation("notPlayable").body;
    for (const phrase of ["private or taken down", "link may be wrong", "age restriction"]) {
      expect(catalogue[body]).toContain(phrase);
    }
    for (const phrase of ["privado ou ter sido removido", "link pode estar errado", "restrição de idade"]) {
      expect(portuguese[body]).toContain(phrase);
    }
    // The tell that it is not claiming to know: it says so out loud.
    expect(catalogue[body]).toContain("does not say which");
    expect(portuguese[body]).toContain("não diz qual");
  });

  it("puts error 153 in its own tone, because the fault is not the video's", () => {
    expect(failurePresentation("refererBlocked").tone).toBe("environment");
    for (const reason of ALL_REASONS) {
      if (reason === "refererBlocked") continue;
      expect(failurePresentation(reason).tone).not.toBe("environment");
    }
  });

  it("says the Referer out loud, so the fix is findable", () => {
    const body = failurePresentation("refererBlocked").body;
    expect(catalogue[body]).toContain("Referer");
    expect(portuguese[body]).toContain("Referer");
  });

  it("never tells somebody the video is the problem when it is not", () => {
    // The 153 copy has to point at this window, not at the video. "Try another
    // video" would send somebody off to fail four more times.
    for (const cat of [catalogue, portuguese]) {
      const body = cat[failurePresentation("refererBlocked").body]!;
      expect(body.toLowerCase()).not.toContain("outro vídeo,");
      expect(body.toLowerCase()).not.toContain("another video.");
    }
    expect(catalogue["watchParty.failure.refererBlocked.title"]).toContain(
      "not the video",
    );
    expect(portuguese["watchParty.failure.refererBlocked.title"]).toContain(
      "não é o vídeo",
    );
  });

  it("offers a retry only where a second attempt can end differently", () => {
    // A retry button beside "the uploader turned embedding off" is guaranteed
    // to fail, and one of those teaches people to stop pressing the ones that
    // work.
    expect(failurePresentation("notPlayable").retryable).toBe(false);
    expect(failurePresentation("videoUnavailable").retryable).toBe(false);
    expect(failurePresentation("refererBlocked").retryable).toBe(true);
    expect(failurePresentation("playerFailed").retryable).toBe(true);
  });
});

/*
 * The link builder is `lib/watch-party/player.ts`'s `watchOnYouTubeUrl` and is
 * tested there. This module used to carry a second one; two answers to "what
 * URL is this video at" is one more than the question has.
 */

describe("statusKey", () => {
  it("names whoever acted, because that is the question people have", () => {
    expect(statusKey("paused", "Ana", false)).toBe("watchParty.status.pausedBy");
    expect(statusKey("playing", "Ana", false)).toBe(
      "watchParty.status.playingBy",
    );
  });

  it("does not narrate your own action back at you", () => {
    expect(statusKey("paused", "Ana", true)).toBe("watchParty.status.paused");
  });

  it("falls back to the plain word when there is no name to use", () => {
    expect(statusKey("playing", null, false)).toBe("watchParty.status.playing");
    expect(statusKey("paused", undefined, false)).toBe(
      "watchParty.status.paused",
    );
  });

  it("never attributes the end of a video to a person", () => {
    // Nobody pressed "end". The player reached the end on its own.
    expect(statusKey("ended", "Ana", false)).toBe("watchParty.status.ended");
  });
});

describe("showsComposer", () => {
  it("is the whole content of the compose view", () => {
    expect(showsComposer({ kind: "compose", reason: null }, false)).toBe(true);
  });

  it("opens as a strip beside a running player rather than replacing it", () => {
    // Unmounting the player to type a link would drop this person out of the
    // party in order to change what the party is watching.
    expect(showsComposer({ kind: "watching", reason: null }, true)).toBe(true);
    expect(showsComposer({ kind: "watching", reason: null }, false)).toBe(false);
  });
});
