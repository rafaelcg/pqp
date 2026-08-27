import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WatchPartyControls } from "./watch-party-controls";

/**
 * The transport bar on its own, because the `watching` view it belongs to is
 * only reachable through a real click and this suite has no DOM.
 *
 * What is worth pinning here is the difference between the three transport
 * modes, and the fact that the bar never draws itself over the player: it is a
 * sibling element, and the only thing standing between us and an IFrame API
 * terms violation is that nobody moves it.
 */

function render(
  props: Partial<Parameters<typeof WatchPartyControls>[0]> = {},
): string {
  return renderToStaticMarkup(
    <WatchPartyControls
      status="playing"
      transport="on"
      onPlay={() => {}}
      onPause={() => {}}
      onSkip={() => {}}
      {...props}
    />,
  );
}

describe("transport modes", () => {
  it("is live for somebody whose player is running", () => {
    const html = render();
    expect(html).toContain('aria-label="Pause"');
    expect(html).toContain('aria-label="Back 10 seconds"');
    expect(html).toContain('aria-label="Forward 10 seconds"');
    expect(html).not.toContain('aria-disabled="true"');
  });

  /**
   * The correctness rule, not decoration. A player that never started reports
   * position 0 for ever, and position 0 on a fresh `rev` outranks everybody and
   * drags the channel back to the beginning. Dimmed and explained, so it reads
   * as a rule rather than as a screen that broke.
   */
  it("is present and out of reach for somebody whose player failed", () => {
    const html = render({ transport: "unavailable" });
    expect(html).toContain('aria-label="Pause"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("watching along rather than driving");
  });

  it("is gone entirely for somebody who has not joined", () => {
    const html = render({ transport: "off" });
    expect(html).not.toContain('aria-label="Pause"');
    expect(html).not.toContain('aria-label="Play"');
    expect(html).not.toContain("watching along rather than driving");
  });
});

describe("what the channel is doing", () => {
  it("names whoever acted", () => {
    expect(render({ status: "paused", actorName: "Ana" })).toContain(
      "Ana paused",
    );
  });

  it("does not narrate your own press back at you", () => {
    expect(
      render({ status: "paused", actorName: "Ana", actorIsSelf: true }),
    ).toContain(">Paused<");
  });

  it("is announced, because a pause happens inside a cross-origin iframe", () => {
    expect(render()).toContain('aria-live="polite"');
  });

  it("never blames a person for the video ending", () => {
    expect(render({ status: "ended", actorName: "Ana" })).toContain(
      ">Finished<",
    );
  });
});

describe("party editing", () => {
  it("offers change and end only when the container allows them", () => {
    const bare = render();
    expect(bare).not.toContain("Change video");
    expect(bare).not.toContain('aria-label="End the watch party"');

    const full = render({
      onChangeVideo: () => {},
      onEndParty: () => {},
    });
    expect(full).toContain("Change video");
    expect(full).toContain('aria-label="End the watch party"');
  });
});
