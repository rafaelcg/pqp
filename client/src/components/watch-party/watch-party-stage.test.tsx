import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WatchPartyState } from "@pqp/shared";
import {
  describeYouTubeError,
  type PlaybackFailureReason,
  type PlayerFailure,
} from "@/lib/watch-party/player";
import { WatchPartyStage } from "./watch-party-stage";

/**
 * The panel as a person meets it.
 *
 * These are not "does React render" tests. Each one pins a rule that a
 * refactor could quietly break while every unit test still passed: that the
 * player element is genuinely absent before the click, that a failed
 * participant's transport is present but out of reach, and that every failure
 * card carries a link that actually goes somewhere.
 *
 * `react-dom/server` and no DOM, the same way the rest of `client/` renders
 * components in tests. Effects do not run, which is fine: nothing here depends
 * on one.
 */

/** A sentinel standing in for the YouTube player the container owns. */
const PLAYER = <div data-player="yes" />;
const PLAYER_MARK = 'data-player="yes"';

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

function render(
  props: Partial<ComponentProps<typeof WatchPartyStage>> = {},
): string {
  return renderToStaticMarkup(
    <WatchPartyStage
      party={party()}
      player={PLAYER}
      parseVideoUrl={() => ({ videoId: "dQw4w9WgXcQ", startMs: 0 })}
      onLoadVideo={() => {}}
      onPlay={() => {}}
      onPause={() => {}}
      onSkip={() => {}}
      onEndParty={() => {}}
      {...props}
    />,
  );
}

describe("the join gesture", () => {
  it("does not put a player on the page before somebody clicks", () => {
    const html = render();
    expect(html).not.toContain(PLAYER_MARK);
    expect(html).toContain("Join the watch party");
  });

  it("reads as an invitation, not as a browser warning", () => {
    const html = render();
    // The headline is where the channel is, which is the actual proposition.
    // The browser's requirement is small print underneath.
    expect(html).toContain("The channel is watching right now");
    expect(html).toContain("A browser only starts a video after a click");
    expect(html).not.toContain("blocked");
  });

  it("says the channel is paused rather than pretending it is playing", () => {
    expect(render({ party: party({ status: "paused" }) })).toContain(
      "The channel has the video paused",
    );
  });

  it("offers no transport to somebody who has not joined", () => {
    // No remote control you never picked up.
    const html = render();
    expect(html).not.toContain('aria-label="Pause"');
    expect(html).not.toContain('aria-label="Back 10 seconds"');
  });
});

describe("no party yet", () => {
  it("is one line above the transcript, not a poster", () => {
    const html = render({ party: null });
    expect(html).toContain("Watch together");
    expect(html).not.toContain(PLAYER_MARK);
    // The paste field is behind the button: a voice channel is used without a
    // watch party far more often than with one.
    expect(html).not.toContain('type="url"');
  });
});

function failed(
  reason: PlaybackFailureReason,
  overrides: Partial<PlayerFailure> = {},
): PlayerFailure {
  return {
    reason,
    code: null,
    videoId: "dQw4w9WgXcQ",
    environmental: reason === "refererBlocked",
    watchOnYouTubeUrl: null,
    ...overrides,
  };
}

describe("a failed player is one person's problem", () => {
  const REASONS: Array<[PlaybackFailureReason, string]> = [
    ["notPlayable", "This video will not play here"],
    ["refererBlocked", "The problem is here, not the video"],
    ["videoUnavailable", "Video unavailable"],
    ["playerFailed", "The YouTube player gave up"],
  ];

  it.each(REASONS)("%s gets its own sentence", (reason, headline) => {
    expect(render({ failure: failed(reason) })).toContain(headline);
  });

  it.each(REASONS)("%s offers a way to watch it anyway", (reason) => {
    const html = render({
      failure: failed(reason),
      party: party({ positionMs: 61_000 }),
    });
    expect(html).toContain(
      'href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=61s"',
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Watch on YouTube");
  });

  it("prefers the link the player stamped at the moment it broke", () => {
    // That one is accurate to where this person was, which is not where the
    // channel has got to since.
    const html = render({
      failure: failed("notPlayable", {
        watchOnYouTubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s",
      }),
      party: party({ positionMs: 900_000 }),
    });
    expect(html).toContain("t=12s");
  });

  it("tells the person the party carried on without them", () => {
    expect(render({ failure: failed("notPlayable") })).toContain(
      "The rest of the channel is still watching",
    );
  });

  /**
   * The correctness rule, checked through the rendered markup rather than only
   * through the pure function: the controls are on the page and marked
   * unavailable, so a failed player can neither drive the channel nor look as
   * though the app broke.
   */
  it("renders the transport as unavailable rather than absent", () => {
    const html = render({ failure: failed("refererBlocked") });
    expect(html).toContain('aria-label="Pause"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain(
      "The video will not play here, so you are watching along rather than driving",
    );
  });

  it("offers a retry only where one could end differently", () => {
    expect(
      render({ failure: failed("refererBlocked"), onRetryPlayback: () => {} }),
    ).toContain("Try again");
    expect(
      render({ failure: failed("notPlayable"), onRetryPlayback: () => {} }),
    ).not.toContain("Try again");
  });

  it("prints the raw code when the player carried one", () => {
    // Useless to read, and the entire content of a useful bug report.
    expect(render({ failure: failed("refererBlocked", { code: 153 }) })).toContain(
      "YouTube error 153",
    );
    expect(render({ failure: failed("playerFailed") })).not.toContain(
      "YouTube error",
    );
  });

  /**
   * A code with no sentence of its own still gets one. `describeYouTubeError`
   * is the real mapping, so this goes through it rather than asserting against
   * a reason picked by hand.
   */
  it("gives an unrecognised code a sentence rather than a blank frame", () => {
    const html = render({
      failure: describeYouTubeError(999, "dQw4w9WgXcQ", 0),
    });
    expect(html).toContain("The YouTube player gave up");
    expect(html).toContain("YouTube error 999");
    expect(html).toContain("Watch on YouTube");
  });

  it("keeps the escape hatch pointing at the video that failed", () => {
    const html = render({
      failure: failed("videoUnavailable", { videoId: "other-one" }),
      party: party({ videoId: "other-one" }),
    });
    expect(html).toContain("watch?v=other-one");
  });

  /**
   * One card covers both causes, because the IFrame API cannot tell them
   * apart. Asserted on the rendered page so the merge is visible to whoever
   * reads this file, not only to whoever reads the map.
   */
  // 150 is the code every unplayable video reports, measured 2026-08-27, so
  // this card stands in for five different situations and must not pick one.
  it("offers every possibility for code 150 without picking one", () => {
    const html = render({ failure: failed("notPlayable", { code: 150 }) });
    expect(html).toContain("This video will not play here");
    expect(html).toContain("private or taken down");
    expect(html).toContain("age restriction");
    expect(html).toContain("does not say which");
    expect(html).not.toContain("Try again");
  });
});

describe("a party with no video", () => {
  it("asks for one", () => {
    const html = render({ party: party({ videoId: null }) });
    expect(html).toContain('type="url"');
    expect(html).toContain("Paste a YouTube link");
    expect(html).not.toContain(PLAYER_MARK);
  });

  it("can still be ended, rather than being a room with no door", () => {
    // Reachable only from a peer clearing the video, which is a state the wire
    // contract allows and this panel never produces itself.
    expect(render({ party: party({ videoId: null }) })).toContain(
      'aria-label="End the watch party"',
    );
  });

  it("offers no transport, because there is nothing to drive", () => {
    expect(render({ party: party({ videoId: null }) })).not.toContain(
      'aria-label="Pause"',
    );
  });
});

/*
 * The `watching` view is only reachable through a real click, which needs a
 * DOM this suite deliberately does not have. It is pinned two ways instead:
 * `showsPlayer` in `watch-party-view.test.ts` says the player mounts there and
 * only there, and `watch-party-controls.test.tsx` renders the bar directly.
 */
