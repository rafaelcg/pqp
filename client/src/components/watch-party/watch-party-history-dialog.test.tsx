import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WatchPartyHistoryList,
} from "./watch-party-history-dialog";
import type { WatchPartyHistoryEntry } from "@/lib/watch-party-history-api";

/**
 * The list a moderator actually reads, same shape as
 * `watch-party-options.test.tsx`: a plain function of its props, so the
 * "which controls show for which broadcast" logic is pinned without a
 * network mock. The dialog shell around it (fetching, the player swap) is
 * covered end to end, same as the rest of the watch-party surface
 * (`docs/WATCH_PARTY.md`).
 */

const ENDED: WatchPartyHistoryEntry = {
  sessionId: "1700000000000",
  startedAt: "2026-09-12T21:00:00.000Z",
  endedAt: "2026-09-12T23:30:00.000Z",
  durationSeconds: 9_000,
  presenter: { userId: "u1", displayName: "Alice" },
  replayAvailable: true,
  keepReplay: false,
};

function render(broadcasts: WatchPartyHistoryEntry[]) {
  return renderToStaticMarkup(
    <WatchPartyHistoryList
      broadcasts={broadcasts}
      loading={false}
      error={null}
      busySessionId={null}
      onToggleKeepReplay={() => {}}
      onWatch={() => {}}
    />,
  );
}

describe("WatchPartyHistoryList", () => {
  it("shows the empty state with nothing to list", () => {
    const html = render([]);
    expect(html).toContain("No broadcasts yet.");
  });

  it("offers Watch and the keep-replay toggle for an ended, available broadcast", () => {
    const html = render([ENDED]);
    expect(html).toContain("Watch");
    expect(html).toContain("Alice");
    expect(html).not.toContain("LIVE");
    expect(html).not.toContain("no longer available");
  });

  it("hides Watch and the toggle once the recording is gone, and says so", () => {
    const html = render([{ ...ENDED, replayAvailable: false }]);
    expect(html).not.toContain(">Watch<");
    expect(html).toContain("Recording no longer available");
  });

  it("shows a LIVE badge and no controls for a broadcast still running", () => {
    const html = render([
      {
        ...ENDED,
        endedAt: null,
        durationSeconds: null,
        replayAvailable: false,
      },
    ]);
    expect(html).toContain("LIVE");
    expect(html).toContain("In progress");
    expect(html).not.toContain(">Watch<");
    // A LIVE broadcast is not "gone" -- it just is not a replay yet, and
    // must not say so.
    expect(html).not.toContain("no longer available");
  });

  it("falls back to an unknown-presenter label rather than inventing a name", () => {
    const html = render([{ ...ENDED, presenter: null }]);
    expect(html).toContain("Unknown presenter");
  });

  it("formats duration as a clock, not raw seconds", () => {
    const html = render([{ ...ENDED, durationSeconds: 5_410 }]);
    // 5410s = 1h30m10s
    expect(html).toContain("1:30:10");
  });

  it("never renders a peak-viewer figure (the type carries none)", () => {
    const html = render([ENDED]);
    expect(html).not.toMatch(/peak/i);
  });
});
