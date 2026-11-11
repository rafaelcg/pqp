// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { JamClock, JamLaneMix } from "@/hooks/use-jam-playback";
import { track } from "@/lib/jam-test-fixtures";
import { JamTrackRow, type JamTrackRowProps } from "./jam-track-row";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const clock: JamClock = { subscribe: () => () => undefined };
const IDLE: JamLaneMix = { muted: false, solo: false, volume: 1 };

function render(overrides: Partial<JamTrackRowProps> = {}) {
  const props: JamTrackRowProps = {
    track: track({ authorName: "Bia" }),
    timeline: { startMs: 0, endMs: 60000 },
    clock,
    lane: IDLE,
    viewerId: "someone-else",
    index: 0,
    competing: false,
    voted: false,
    canSwitchMix: false,
    canDelete: false,
    canVote: true,
    auditioning: false,
    canAdjust: false,
    adjusting: false,
    onLane: () => undefined,
    onVote: () => undefined,
    onSwitchMix: () => undefined,
    onAdjust: () => undefined,
    onDelete: () => undefined,
    onAudition: () => undefined,
    onSeek: () => undefined,
    ...overrides,
  };
  act(() =>
    root.render(
      <TooltipProvider>
        <ul>
          <JamTrackRow {...props} />
        </ul>
      </TooltipProvider>,
    ),
  );
  return host.querySelector<HTMLElement>("li")!;
}

describe("a lane's head", () => {
  it("always says the instrument and the person, even on the viewer's own row with its Ajustar button", () => {
    const own = render({ viewerId: "44444444-4444-4444-8444-444444444444", track: track({ authorId: "44444444-4444-4444-8444-444444444444" }), canAdjust: true });
    const name = own.querySelector<HTMLElement>("[data-jam-lane-name]")!;
    expect(name.textContent).toContain("Guitar");
    expect(name.textContent).toContain("you");
    // wraps instead of cutting: nothing on the name is truncated or hidden at any width
    expect(name.innerHTML).not.toMatch(/truncate|hidden/);
    // the button is its own control, never inside the name column
    const adjust = own.querySelector<HTMLElement>("[data-jam-adjust-open]")!;
    expect(adjust).not.toBeNull();
    expect(name.contains(adjust)).toBe(false);
    expect(adjust.getAttribute("aria-label")).toBe("Adjust my recording");
  });

  it("puts the out-of-the-song pill after the person, never over the instrument, and its buttons on their own line", () => {
    const out = render({ track: track({ inMix: false, authorName: "Bia" }), canSwitchMix: true, competing: true });
    const name = out.querySelector<HTMLElement>("[data-jam-lane-name]")!;
    const pill = [...name.querySelectorAll("span")].find((one) => one.textContent === "alternate version")!;
    expect(pill).toBeTruthy();
    const instrument = name.firstElementChild as HTMLElement;
    expect(instrument.textContent).toBe("Guitar");
    expect(instrument.contains(pill)).toBe(false);
    const actions = out.querySelector("[data-jam-lane-actions]")!;
    expect(actions.querySelector("[data-jam-mix-switch]")).not.toBeNull();
    expect(actions.querySelector("[data-jam-vote]")).not.toBeNull();
    expect(name.contains(actions)).toBe(false);
  });

  it("keeps the lane's own mute, solo and volume in one cluster that says it is only for the listener", () => {
    const row = render();
    const cluster = row.querySelector<HTMLElement>("[data-jam-lane-mix]")!;
    expect(cluster.getAttribute("role")).toBe("group");
    expect(cluster.getAttribute("aria-label")).toBe("Only you hear this");
    expect(cluster.querySelector("[data-jam-mute]")).not.toBeNull();
    expect(cluster.querySelector("[data-jam-solo]")).not.toBeNull();
    expect(cluster.querySelectorAll('[role="slider"]')).toHaveLength(1);
    // the solo is a plain word, not a bare "S"
    expect(row.querySelector("[data-jam-solo]")!.getAttribute("aria-label")).toBe("Hear only Guitar, Bia");
  });

  it("makes every lane control 44 px under a finger", () => {
    const row = render({ canAdjust: true, viewerId: "x", track: track({ authorId: "x" }) });
    for (const selector of ["[data-jam-mute]", "[data-jam-solo]", "[data-jam-adjust-open]"]) {
      expect(row.querySelector(selector)!.className).toMatch(/pointer-coarse:h-11/);
    }
    expect(row.querySelector('[role="slider"]')!.closest("[data-slider]")!.className).toMatch(/pointer-coarse:h-11/);
  });
});

describe("the saved volume", () => {
  it("shows on the lane as a static label, not a second slider", () => {
    const row = render({ track: track({ gain: 0.6 }) });
    const label = row.querySelector<HTMLElement>("[data-jam-gain]")!;
    expect(label.textContent).toBe("recorded at -40%");
    expect(label.getAttribute("role")).toBeNull();
    expect(label.querySelector("input, [role='slider'], button")).toBeNull();
    // the lane keeps exactly one volume control: the listener's
    expect(row.querySelectorAll('[role="slider"]')).toHaveLength(1);
    expect(row.querySelector('[role="slider"]')!.getAttribute("aria-label")).toBe("Your volume for Guitar, rafa");
  });

  it("is absent when the recording is as recorded", () => {
    expect(render().querySelector("[data-jam-gain]")).toBeNull();
  });
});

describe("solo", () => {
  it("dims the lanes that are not soloed, and not the soloed one", () => {
    const quiet = render({ othersSoloed: true });
    expect(quiet.getAttribute("data-solo-dimmed")).toBe("true");
    expect(quiet.querySelector("[data-jam-lane-name]")!.className).toContain("opacity-40");
    // the transition is for people who accept motion only
    expect(quiet.querySelector("[data-jam-lane-name]")!.className).toContain("motion-safe:transition-opacity");
    // the controls stay at full strength so the dimmed lane can still be unmuted
    expect(quiet.querySelector("[data-jam-lane-mix]")!.className).not.toContain("opacity-40");

    const loud = render({ othersSoloed: true, lane: { ...IDLE, solo: true } });
    expect(loud.getAttribute("data-solo-dimmed")).toBeNull();
    expect(loud.querySelector("[data-jam-lane-name]")!.className).not.toContain("opacity-40");

    const alone = render({ othersSoloed: false });
    expect(alone.getAttribute("data-solo-dimmed")).toBeNull();
  });
});

describe("the adjust editor", () => {
  it("opens as a child of the lane it edits", () => {
    const row = render({ canAdjust: true, adjusting: true, editor: <div data-jam-adjust="x">editor</div> });
    const slot = row.querySelector("[data-jam-editor-slot]")!;
    expect(slot).not.toBeNull();
    expect(slot.querySelector("[data-jam-adjust]")).not.toBeNull();
    expect(row.className).toContain("bg-surface-2/60");
  });
});

describe("a recording's video", () => {
  it("is a focusable 16:9 button, and opens the same video big on the engine's clock", () => {
    const detach = vi.fn();
    const attachVideo = vi.fn((_trackId: string, _element: HTMLVideoElement) => detach);
    const row = render({ track: track({ videoUrl: "https://example.test/v.mp4", authorName: "Bia" }), attachVideo });
    const open = row.querySelector<HTMLButtonElement>("[data-jam-lane-video-open]")!;
    expect(open.tagName).toBe("BUTTON");
    expect(open.getAttribute("aria-label")).toBe("Watch the video: Guitar, Bia");
    expect(open.className).toContain("aspect-video");
    expect(attachVideo).toHaveBeenCalledTimes(1);

    act(() => open.click());
    expect(document.querySelector("[data-jam-lane-video-big]")).not.toBeNull();
    // a second element on the same stem, each followed on its own
    expect(attachVideo).toHaveBeenCalledTimes(2);
    expect(attachVideo.mock.calls[0]![0]).toBe(attachVideo.mock.calls[1]![0]);
    expect(attachVideo.mock.calls[0]![1]).not.toBe(attachVideo.mock.calls[1]![1]);
  });
});
