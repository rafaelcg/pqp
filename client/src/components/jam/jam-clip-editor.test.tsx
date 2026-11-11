// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withNudge, type TakeEdits } from "@/lib/jam-take-edit";
import { JamClipEditor, NUDGE_HOLD_DELAY_MS, NUDGE_REPEAT_MS, nudgeStepFor } from "./jam-clip-editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
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
  vi.useRealTimers();
});

/** The editor with its numbers kept in state, as a caller does, and every asked step logged. */
function Harness({ steps }: { steps: number[] }) {
  const [edits, setEdits] = useState<TakeEdits>({ trimStartMs: 0, trimEndMs: 0, nudgeMs: 0, gain: 1 });
  return (
    <JamClipEditor
      instrument="guitar"
      peaks={[0.2, 0.6, 0.9]}
      source={{ baseOffsetMs: 0, durationMs: 4000, minTrimStartMs: 0 }}
      edits={edits}
      band={[]}
      edited={false}
      onTrimStart={() => undefined}
      onTrimEnd={() => undefined}
      onGain={() => undefined}
      onNudge={(ms) => {
        steps.push(ms - edits.nudgeMs);
        setEdits(withNudge(edits, ms));
      }}
    />
  );
}

function mount(steps: number[]) {
  act(() => root.render(<Harness steps={steps} />));
}

function button(which: "earlier" | "later") {
  return host.querySelector<HTMLButtonElement>(`[data-jam-nudge="${which}"]`)!;
}

function press(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  });
}

function release(element: HTMLElement, type = "pointerup") {
  act(() => {
    element.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });
}

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const readout = () => host.querySelector("[aria-live]")!.textContent;

describe("the step a held nudge button takes", () => {
  it("is 10 ms, then 50 ms after about 600 ms, then 100 ms after about 1.5 s", () => {
    expect(nudgeStepFor(0)).toBe(10);
    expect(nudgeStepFor(599)).toBe(10);
    expect(nudgeStepFor(600)).toBe(50);
    expect(nudgeStepFor(1499)).toBe(50);
    expect(nudgeStepFor(1500)).toBe(100);
  });
});

describe("pressing and holding earlier / later", () => {
  it("a plain press-and-release is one 10 ms step", () => {
    const steps: number[] = [];
    mount(steps);
    press(button("later"));
    release(button("later"));
    wait(2000);
    expect(steps).toEqual([10]);
    expect(readout()).toBe("10 ms later");
  });

  it("repeats while held and speeds up: 10 ms, then 50, then 100", () => {
    const steps: number[] = [];
    mount(steps);
    press(button("earlier"));
    expect(steps).toEqual([-10]);
    // nothing repeats before the hold delay, so a tap stays one step
    wait(NUDGE_HOLD_DELAY_MS - 1);
    expect(steps).toHaveLength(1);
    wait(1);
    expect(steps).toEqual([-10, -10]);
    // one tick at a time, as a browser does: each step renders before the next
    for (let tick = 0; tick < 20; tick++) {
      wait(NUDGE_REPEAT_MS);
    }
    const sizes = steps.map((step) => Math.abs(step));
    expect(sizes.slice(0, 4)).toEqual([10, 10, 10, 10]);
    expect(sizes).toContain(50);
    expect(sizes.indexOf(50)).toBeGreaterThan(sizes.lastIndexOf(10));
    // the third speed is asked for past 1.5 s even though the clamp (500) is reached first
    expect(sizes).toContain(100);
    expect(sizes.indexOf(100)).toBeGreaterThan(sizes.lastIndexOf(50));
    expect(readout()).toBe("500 ms earlier");
  });

  it.each([
    ["pointerup"],
    // React derives onPointerLeave from pointerout with nothing entered
    ["pointerout"],
    ["pointercancel"],
  ])("stops on %s", (type) => {
    const steps: number[] = [];
    mount(steps);
    press(button("later"));
    wait(NUDGE_HOLD_DELAY_MS + NUDGE_REPEAT_MS);
    const before = steps.length;
    expect(before).toBeGreaterThan(1);
    release(button("later"), type);
    wait(3000);
    expect(steps).toHaveLength(before);
  });

  it("stops when the button loses focus", () => {
    const steps: number[] = [];
    mount(steps);
    press(button("later"));
    wait(NUDGE_HOLD_DELAY_MS + NUDGE_REPEAT_MS);
    const before = steps.length;
    act(() => {
      button("later").dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    wait(3000);
    expect(steps).toHaveLength(before);
  });

  it("stops when the editor goes away", () => {
    const steps: number[] = [];
    mount(steps);
    press(button("later"));
    act(() => root.unmount());
    wait(3000);
    expect(steps).toHaveLength(1);
    root = createRoot(host);
  });

  it("a click that did not come from a pointer (the keyboard) is one 10 ms step", () => {
    const steps: number[] = [];
    mount(steps);
    act(() => button("later").click());
    act(() => button("later").click());
    expect(steps).toEqual([10, 10]);
  });
});

describe("touch targets", () => {
  it("every control is 44 px under a finger while the visible handles stay slim", () => {
    mount([]);
    for (const grip of ["start", "end"]) {
      const handle = host.querySelector<HTMLElement>(`[data-jam-clip-handle="${grip}"]`)!;
      expect(handle.className).toMatch(/\bw-5\b/);
      expect(handle.className).toContain("pointer-coarse:w-11");
      expect((handle.firstElementChild as HTMLElement).className).toContain("w-2.5");
    }
    expect(button("earlier").className).toContain("pointer-coarse:h-11");
    expect(button("later").className).toContain("pointer-coarse:h-11");
    expect(host.querySelector('[data-slider="volume"]')!.className).toContain("pointer-coarse:h-11");
  });
});

describe("the volume group", () => {
  it("says it is what everybody hears, and keeps the stage short in a landscape phone", () => {
    mount([]);
    const group = host.querySelector<HTMLElement>("[data-jam-clip-volume]")!;
    expect(group.getAttribute("role")).toBe("group");
    const title = document.getElementById(group.getAttribute("aria-labelledby")!)!;
    expect(title.textContent).toBe("Everybody hears it like this");
    expect(group.querySelectorAll('[role="slider"]')).toHaveLength(1);
    expect(host.querySelector<HTMLElement>("[data-jam-clip-stage]")!.className).toContain("[@media(max-height:32rem)]:h-28");
  });
});
