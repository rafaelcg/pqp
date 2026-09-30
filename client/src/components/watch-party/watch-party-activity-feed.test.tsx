// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WatchPartyActivityFeed } from "./watch-party-activity-feed";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("WatchPartyActivityFeed", () => {
  it("draws an empty feed with the audience count before anything happens", () => {
    const html = renderToStaticMarkup(
      <WatchPartyActivityFeed channelId="c1" audienceCount={0} hands={[]} />,
    );
    expect(html).toContain('data-testid="watch-party-activity"');
    expect(html).toContain("Nothing yet");
  });

  /**
   * Production rehearsal C, 2026-09-25: the presenter reloaded mid-party, the
   * feed mounted before the first `channel-live` frame, took "0" as its
   * baseline, and the one person already watching arrived as a fresh
   * "+1 assistindo". An unknown count is `null` now, and the baseline is the
   * first count this client actually knows.
   */
  it("takes no baseline from a count it does not know yet", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const audienceRows = () =>
      host.querySelectorAll('[data-watch-party-activity="audience"]').length;
    const render = (count: number | null) =>
      act(() => {
        root.render(
          <WatchPartyActivityFeed channelId="c1" audienceCount={count} hands={[]} />,
        );
      });

    render(null);
    render(1);
    expect(audienceRows()).toBe(0);

    // Somebody genuinely arriving after that is still a line.
    render(2);
    expect(audienceRows()).toBe(1);

    act(() => root.unmount());
  });
});
