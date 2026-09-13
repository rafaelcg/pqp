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

function renderTransmission(outputLevelDb: (() => number | null) | undefined) {
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

  it("never warns when no output meter is available at all", () => {
    renderTransmission(undefined);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(container.querySelector('[data-testid="watch-party-tx-output-silent-pill"]')).toBeNull();
  });
});
