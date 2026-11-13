// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    // a long name is cut with an ellipsis (its words are the tooltip), never wrapped into the next column
    expect(name.innerHTML).toMatch(/truncate/);
    expect(name.querySelector("[title='Guitar']")).not.toBeNull();
    // "Ajustar" is an icon in the controls: its own control, never inside the name column, with a name for a screen reader
    const adjust = own.querySelector<HTMLElement>("[data-jam-adjust-open]")!;
    expect(adjust).not.toBeNull();
    expect(name.contains(adjust)).toBe(false);
    expect(adjust.getAttribute("aria-label")).toBe("Adjust my recording");
    expect(adjust.textContent).toBe("");
    expect(own.querySelector("[data-jam-lane-controls]")!.contains(adjust)).toBe(true);
    // and the identity and the controls are different cells of the one lane frame
    expect(own.querySelector("[data-jam-lane-identity]")!.contains(adjust)).toBe(false);
  });

  it("puts the out-of-the-song pill on the clip, never over the instrument, and its buttons in the controls", () => {
    const out = render({ track: track({ inMix: false, authorName: "Bia" }), canSwitchMix: true, competing: true });
    const name = out.querySelector<HTMLElement>("[data-jam-lane-name]")!;
    const pill = out.querySelector<HTMLElement>("[data-jam-out-pill]")!;
    expect(pill.textContent).toBe("alternate version");
    const instrument = name.firstElementChild as HTMLElement;
    expect(instrument.textContent).toBe("Guitar");
    expect(name.contains(pill)).toBe(false);
    const controls = out.querySelector("[data-jam-lane-controls]")!;
    expect(controls.querySelector("[data-jam-mix-switch]")).not.toBeNull();
    expect(controls.querySelector("[data-jam-vote]")).not.toBeNull();
    expect(controls.querySelector("[data-jam-audition]")).not.toBeNull();
    // icon-only, each with its own name
    expect(controls.querySelector("[data-jam-mix-switch]")!.getAttribute("aria-label")).toBe("Use this recording");
    expect(name.contains(controls)).toBe(false);
  });

  it("keeps the lane's own mute, solo and volume in one cluster that says it is only for the listener", () => {
    const row = render();
    const cluster = row.querySelector<HTMLElement>("[data-jam-lane-mix]")!;
    expect(cluster.getAttribute("role")).toBe("group");
    expect(cluster.getAttribute("aria-label")).toBe("Only you hear this");
    expect(cluster.querySelector("[data-jam-mute]")).not.toBeNull();
    expect(cluster.querySelector("[data-jam-solo]")).not.toBeNull();
    expect(cluster.querySelectorAll('[role="slider"]')).toHaveLength(1);
    // the sentence that used to sit above the ruler is the headphones' own words now
    const note = cluster.querySelector<HTMLElement>("[data-jam-mine-note]")!;
    expect(note.getAttribute("aria-label")).toBe("Mute (M), solo (S) and volume here change only what you hear.");
    expect(note.tabIndex).toBe(0);
    // mute and solo are the letters a mixer uses, each named in full for a screen reader and by its tooltip
    expect(row.querySelector("[data-jam-solo]")!.getAttribute("aria-label")).toBe("Hear only Guitar, Bia");
    expect(row.querySelector("[data-jam-mute]")!.getAttribute("aria-label")).toBe("Mute Guitar, Bia");
    expect(row.querySelector("[data-jam-mute]")!.textContent).toBe("M");
    expect(row.querySelector("[data-jam-solo]")!.textContent).toBe("S");
  });

  it("makes every lane control 44 px under a finger", () => {
    const row = render({ canAdjust: true, viewerId: "x", track: track({ authorId: "x" }) });
    for (const selector of ["[data-jam-mute]", "[data-jam-solo]", "[data-jam-adjust-open]"]) {
      expect(row.querySelector(selector)!.className).toMatch(/pointer-coarse:h-11/);
    }
    expect(row.querySelector('[role="slider"]')!.closest("[data-slider]")!.className).toMatch(/pointer-coarse:h-11/);
  });

  it("is one line on a wide band and two on a narrow one, by the band's own width", () => {
    const row = render();
    const frame = row.querySelector<HTMLElement>("[data-jam-lane-frame]")!;
    // three columns once the band is wide (a container query: the song panel is a side panel), a wrapping flow before
    expect(frame.className).toContain("@min-[40rem]/band:grid-cols-[var(--lane-id)_minmax(0,1fr)_var(--lane-ctl)]");
    expect(frame.className).toContain("flex-wrap");
  });
});

describe("alternate takes keep their actions while they are heard", () => {
  it("an out-of-mix take being auditioned still has its stop control, its vote and 'use this', beside the listener's mix", () => {
    const row = render({ track: track({ inMix: false, authorName: "Bia" }), canSwitchMix: true, competing: true, auditioning: true });
    const controls = row.querySelector("[data-jam-lane-controls]")!;
    const stop = controls.querySelector<HTMLElement>("[data-jam-audition]")!;
    expect(stop.getAttribute("aria-label")).toBe("Back to the recording in the song");
    expect(stop.getAttribute("aria-pressed")).toBe("true");
    expect(controls.querySelector("[data-jam-vote]")).not.toBeNull();
    expect(controls.querySelector("[data-jam-mix-switch]")).not.toBeNull();
    // and it is heard, so the listener's cluster is there too
    expect(controls.querySelector("[data-jam-lane-mix]")).not.toBeNull();
  });

  it("an in-mix take that competes with another still has its vote", () => {
    const row = render({ competing: true });
    expect(row.querySelector("[data-jam-lane-controls] [data-jam-vote]")).not.toBeNull();
    expect(row.querySelector("[data-jam-lane-controls] [data-jam-lane-mix]")).not.toBeNull();
    // it is in the mix: nothing to audition, nothing to switch in
    expect(row.querySelector("[data-jam-audition]")).toBeNull();
    expect(row.querySelector("[data-jam-mix-switch]")).toBeNull();
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
  it("is not in the lane: the song's stage above the lanes shows it", () => {
    const row = render({ track: track({ videoUrl: "https://example.test/v.mp4", authorName: "Bia" }) });
    expect(row.querySelector("video")).toBeNull();
    expect(row.querySelector("[data-jam-lane-video-open]")).toBeNull();
  });
});
