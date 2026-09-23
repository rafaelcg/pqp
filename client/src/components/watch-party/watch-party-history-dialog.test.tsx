import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WatchPartyDownloadPanel,
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
 *
 * Grouping itself (available vs. folded, "short" vs. "unavailable") is
 * `lib/watch-party-history-grouping.test.ts`'s job; this file only pins that
 * the list actually renders what that function hands it -- the title
 * fallback lives server-side (`server/src/api/watch-party-history.test.ts`),
 * this only pins that whatever `title` the API sends is what shows.
 */

const ENDED: WatchPartyHistoryEntry = {
  sessionId: "1700000000000",
  title: "Filme da sexta",
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

  it("shows the title and offers Watch and the keep-replay toggle for an ended, available broadcast", () => {
    const html = render([ENDED]);
    expect(html).toContain("Filme da sexta");
    expect(html).toContain("Watch");
    expect(html).toContain("Alice");
    expect(html).not.toContain("LIVE");
    expect(html).not.toContain("no longer available");
    // Not in the folded accordion.
    expect(html).not.toContain("Older recordings");
  });

  it("offers the download toggle on an available broadcast, and not on a folded one", () => {
    expect(render([ENDED])).toContain(
      'data-testid="watch-party-history-download-toggle"',
    );
    expect(render([{ ...ENDED, replayAvailable: false }])).not.toContain(
      'data-testid="watch-party-history-download-toggle"',
    );
  });

  it("folds an unavailable broadcast under the collapsed 'Older recordings' accordion, hides its Watch button and says why", () => {
    const html = render([{ ...ENDED, replayAvailable: false }]);
    expect(html).toContain("Older recordings (1)");
    expect(html).not.toContain(">Watch<");
    expect(html).toContain("Recording no longer available");
    // Collapsed by default: the row is in the DOM but hidden.
    expect(html).toMatch(/<ul hidden(?:=""|[\s>])[^>]*data-testid="watch-party-history-older-list"/);
  });

  it("folds a sub-minute broadcast as a 'Restart', not as an unavailable recording, even while it is still available", () => {
    const html = render([{ ...ENDED, durationSeconds: 12 }]);
    expect(html).toContain("Older recordings (1)");
    expect(html).toContain("Restart");
    expect(html).not.toContain("Recording no longer available");
    expect(html).not.toContain(">Watch<");
  });

  it("shows a LIVE badge and no controls for a broadcast still running, and never folds it away", () => {
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
    // A LIVE broadcast is not "gone" -- it just is not a replay yet -- and
    // it is not "old" either: it stays in the main list, plain, never behind
    // the "Older recordings" accordion.
    expect(html).not.toContain("no longer available");
    expect(html).not.toContain("Older recordings");
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

  it("counts the folded accordion across several broadcasts of either fold reason", () => {
    const html = render([
      ENDED,
      { ...ENDED, sessionId: "2", replayAvailable: false },
      { ...ENDED, sessionId: "3", durationSeconds: 5 },
    ]);
    expect(html).toContain("Older recordings (2)");
  });
});

/**
 * The download panel's three states, rendered on their own because the panel
 * only mounts after a click and this file renders static markup.
 *
 * What matters here is that an ABSENT file reads as a fact about the night
 * ("camera not used", "voice recording was off") rather than as an error or
 * a dead link: a moderator who never turned the camera on should not be left
 * wondering whether the download is broken.
 */
describe("WatchPartyDownloadPanel", () => {
  it("says it is working while the sizes are being fetched", () => {
    expect(
      renderToStaticMarkup(<WatchPartyDownloadPanel state={undefined} />),
    ).toContain("Loading");
  });

  it("surfaces a failure to list the files", () => {
    const html = renderToStaticMarkup(
      <WatchPartyDownloadPanel
        state={{ status: "error", message: "Could not list the files." }}
      />,
    );
    expect(html).toContain("Could not list the files.");
    expect(html).not.toContain("<a");
  });

  it("offers a plain download link with a size for each file that exists", () => {
    const html = renderToStaticMarkup(
      <WatchPartyDownloadPanel
        state={{
          status: "ready",
          downloads: {
            film: { bytes: 2_400_000_000, url: "https://api.test/film?t=abc" },
            camera: { bytes: 38_000_000, url: "https://api.test/camera?t=abc" },
            voice: { bytes: 12_000, url: "https://api.test/voice?t=abc" },
          },
        }}
      />,
    );
    expect(html).toContain('href="https://api.test/film?t=abc"');
    // A navigation, not a scripted save: the attribute has to be there.
    expect(html).toContain("download=");
    expect(html).toContain("2.4 GB");
    expect(html).toContain("38 MB");
    expect(html).toContain("12 kB");
    expect(html).toContain("ffmpeg -i file.ts -c copy file.mp4");
  });

  it("greys out a file the broadcast never wrote, and says which fact it was", () => {
    const html = renderToStaticMarkup(
      <WatchPartyDownloadPanel
        state={{
          status: "ready",
          downloads: {
            film: { bytes: 1_000_000, url: "https://api.test/film?t=abc" },
            camera: null,
            voice: null,
          },
        }}
      />,
    );
    expect(html).toContain("camera not used");
    expect(html).toContain("voice recording was off");
    expect(html).not.toContain('href="https://api.test/camera');
    expect(html).toContain('data-testid="watch-party-history-download-voice-missing"');
  });

  it("says a film is being prepared instead of calling it unavailable", () => {
    const html = renderToStaticMarkup(
      <WatchPartyDownloadPanel
        state={{
          status: "ready",
          downloads: {
            film: null,
            camera: { bytes: 38_000_000, url: "https://api.test/camera?t=abc" },
            voice: null,
          },
          preparing: ["film"],
        }}
      />,
    );
    expect(html).toContain('data-testid="watch-party-history-download-film-preparing"');
    expect(html).toContain("being prepared");
    expect(html).not.toContain("recording unavailable");
    expect(html).not.toContain('data-testid="watch-party-history-download-film-missing"');
  });
});
