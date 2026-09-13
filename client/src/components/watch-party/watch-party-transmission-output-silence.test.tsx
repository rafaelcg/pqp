// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WatchPartyTransmission } from "./watch-party-transmission";

/**
 * The live, timer-driven half of postmortem B2, which `renderToStaticMarkup`
 * in `watch-party-transmission.test.tsx` cannot reach: that suite never runs
 * an effect, so the polling loop behind `outputSilentWarning` never ticks.
 * This is the interactive counterpart, same `createRoot`/`act` idiom as
 * `watch-dock.test.tsx`. The rule itself (ten seconds, hold, reset) is
 * already pinned with no DOM at all in `watch-party-output-silence.test.ts`;
 * this only checks that the component wires the rule up correctly.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

function renderTransmission(
  outputLevelDb: (() => number | null) | undefined,
  startedAt = 1_757_000_000_000,
) {
  act(() => {
    root.render(
      <WatchPartyTransmission
        stream={{
          hlsUrl: "/api/voice/hls-playlist/c/1",
          startedAt,
          presenterPeerId: "peer-1",
          delaySeconds: 10,
          topHeight: 720,
          hasAudio: true,
        }}
        wentLiveAt="2026-09-09T12:00:00.000Z"
        audienceCount={137}
        // Left false so `useShareUplinkStrain`'s own polling never starts —
        // this test is about the output meter, not the uplink sampler.
        isPresenting={false}
        quality="auto"
        roomViewers={4}
        transport="livekit"
        now={new Date("2026-09-09T12:20:00.000Z")}
        outputLevelDb={outputLevelDb}
      />,
    );
  });
}

describe("the output-silence warning, live", () => {
  it("says nothing while the bus is carrying signal", () => {
    renderTransmission(() => -20);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(container.querySelector('[data-testid="watch-party-tx-output-silent-pill"]')).toBeNull();
  });

  it("stays quiet before the ten-second floor has held", () => {
    renderTransmission(() => Number.NEGATIVE_INFINITY);
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(container.querySelector('[data-testid="watch-party-tx-output-silent-pill"]')).toBeNull();
  });

  it("warns, in the COLLAPSED row, once true digital silence holds for ten seconds", () => {
    renderTransmission(() => Number.NEGATIVE_INFINITY);
    act(() => {
      vi.advanceTimersByTime(10_100);
    });
    // The panel is collapsed by default (never clicked open in this test),
    // so finding the pill here is the whole point: a hidden warning is a
    // warning nobody gets.
    expect(
      container.querySelector('[data-testid="watch-party-tx-output-silent-pill"]'),
    ).not.toBeNull();
  });

  it("recovers the moment the level comes back", () => {
    let level = Number.NEGATIVE_INFINITY;
    renderTransmission(() => level);
    act(() => {
      vi.advanceTimersByTime(10_100);
    });
    expect(
      container.querySelector('[data-testid="watch-party-tx-output-silent-pill"]'),
    ).not.toBeNull();

    level = -10;
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(container.querySelector('[data-testid="watch-party-tx-output-silent-pill"]')).toBeNull();
  });

  it("does not carry a warning, or a partial streak, from one broadcast into the next", () => {
    // The component itself never unmounts between two shows (the panel
    // stays open while the host ends one party and starts another); only
    // `stream.startedAt` says a new broadcast began. Farol, 2026-09-13: the
    // effect used to key only on whether a meter existed at all, so a
    // session that had already warned kept warning, and one only partway
    // into its own streak carried that partial count into the new show.
    renderTransmission(() => Number.NEGATIVE_INFINITY, 1_000);
    act(() => {
      vi.advanceTimersByTime(10_100);
    });
    expect(
      container.querySelector('[data-testid="watch-party-tx-output-silent-pill"]'),
    ).not.toBeNull();

    // A new broadcast starts, still silent from the first instant it could
    // be sampled. The old streak (and its warning) must not survive it.
    renderTransmission(() => Number.NEGATIVE_INFINITY, 2_000);
    expect(container.querySelector('[data-testid="watch-party-tx-output-silent-pill"]')).toBeNull();

    // And it takes a full ten seconds of THIS broadcast to warn again, not
    // whatever was left over from the last one.
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(container.querySelector('[data-testid="watch-party-tx-output-silent-pill"]')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1_100);
    });
    expect(
      container.querySelector('[data-testid="watch-party-tx-output-silent-pill"]'),
    ).not.toBeNull();
  });

  it("keeps the streak when the parent hands in a new callback mid-silence", () => {
    // The parent (`App.tsx`) passes `outputLevelDb` as its own prop, whose
    // identity can change on an unrelated rerender even though the reading
    // it produces has not. A fresh closure each time, same value, is exactly
    // that: it must not restart the ten-second streak (Farol, 2026-09-13).
    renderTransmission(() => Number.NEGATIVE_INFINITY);
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    renderTransmission(() => Number.NEGATIVE_INFINITY);
    act(() => {
      vi.advanceTimersByTime(4_100);
    });
    expect(
      container.querySelector('[data-testid="watch-party-tx-output-silent-pill"]'),
    ).not.toBeNull();
  });

  it("never warns when no output meter is available at all", () => {
    renderTransmission(undefined);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(container.querySelector('[data-testid="watch-party-tx-output-silent-pill"]')).toBeNull();
  });
});

/**
 * "Seu mic está mudo" folded into the B2 silence paragraph when both are
 * true at once (2026-09-13 addition). `isPresenting` has to be true here,
 * which also starts `useShareUplinkStrain`'s own sampler
 * (`shouldMeasureUplink` keys only on `isSharing`); that sampler reads an
 * empty stats registry in this environment and settles quietly, so it does
 * not interfere with what this test is checking.
 */
describe("the mic-muted line folded into the silence warning", () => {
  function renderPresenting(micMuted: boolean) {
    act(() => {
      root.render(
        <WatchPartyTransmission
          stream={{
            hlsUrl: "/api/voice/hls-playlist/c/1",
            startedAt: 1_757_000_000_000,
            presenterPeerId: "peer-1",
            delaySeconds: 10,
            topHeight: 720,
            hasAudio: true,
          }}
          wentLiveAt="2026-09-09T12:00:00.000Z"
          audienceCount={137}
          isPresenting
          quality="auto"
          roomViewers={4}
          transport="livekit"
          now={new Date("2026-09-09T12:20:00.000Z")}
          outputLevelDb={() => Number.NEGATIVE_INFINITY}
          micMuted={micMuted}
        />,
      );
    });
  }

  it("says the mic is muted too, once the silence warning is already showing", () => {
    renderPresenting(true);
    act(() => {
      vi.advanceTimersByTime(10_100);
    });
    // The panel is collapsed, so open it to read the expanded paragraph —
    // the toggle button is the same one every other transmission test uses.
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="watch-party-tx-toggle"]',
    );
    act(() => {
      toggle?.click();
    });
    const paragraph = container.querySelector(
      '[data-testid="watch-party-tx-output-silent"]',
    );
    expect(paragraph?.textContent).toContain("no sound");
    expect(paragraph?.textContent).toContain("Your mic is muted");
  });

  it("says only the silence line when the mic is open", () => {
    renderPresenting(false);
    act(() => {
      vi.advanceTimersByTime(10_100);
    });
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="watch-party-tx-toggle"]',
    );
    act(() => {
      toggle?.click();
    });
    const paragraph = container.querySelector(
      '[data-testid="watch-party-tx-output-silent"]',
    );
    expect(paragraph?.textContent).toContain("no sound");
    expect(paragraph?.textContent).not.toContain("mic is muted");
  });
});
