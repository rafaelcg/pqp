// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
// `?raw`: this project's tsconfig carries no node types (the em dash test does the same).
import studioSource from "./use-jam-studio.ts?raw";
import { phaseHoldsUnsentWork, useLeaveGuard, type LeaveGuardPhase } from "./use-leave-guard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Reload or navigating away DURING a recording lost the take with no warning:
 * the leave-page prompt was armed only once the recording stopped (jam persona
 * QA, 2026-11-19). It is armed from the count-in on.
 */

function Probe({ active }: { active: boolean }) {
  useLeaveGuard(active);
  return null;
}

/** What the browser does on a reload: fire `beforeunload` and see whether anybody asked to stop it. */
function reloadIsStopped(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(active: boolean) {
  host = document.createElement("div");
  root = createRoot(host);
  act(() => root!.render(<Probe active={active} />));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host = null;
});

describe("which phases hold work that a reload would lose", () => {
  const holds: Record<LeaveGuardPhase, boolean> = {
    boot: false,
    unsupported: false,
    setup: false,
    countdown: true,
    recording: true,
    review: true,
    posting: true,
    done: false,
  };
  for (const [phase, expected] of Object.entries(holds) as Array<[LeaveGuardPhase, boolean]>) {
    it(`${phase}: ${expected ? "asks" : "does not ask"}`, () => {
      expect(phaseHoldsUnsentWork(phase)).toBe(expected);
    });
  }
});

describe("the leave guard", () => {
  it("lets a reload through while nothing is at stake", () => {
    mount(false);
    expect(reloadIsStopped()).toBe(false);
  });

  it("makes the browser ask while it is armed, and stops asking when it is not", () => {
    mount(true);
    expect(reloadIsStopped()).toBe(true);
    act(() => root!.render(<Probe active={false} />));
    expect(reloadIsStopped()).toBe(false);
  });

  it("is armed from a recording the way it is from a take waiting to be sent", () => {
    mount(phaseHoldsUnsentWork("recording"));
    expect(reloadIsStopped()).toBe(true);
  });

  it("leaves nothing behind when the studio closes", () => {
    mount(true);
    act(() => root!.unmount());
    root = null;
    expect(reloadIsStopped()).toBe(false);
  });
});

describe("the studio", () => {
  it("arms the guard from the phase through this one list, not a copy of it", () => {
    expect(studioSource).toContain("useLeaveGuard(phaseHoldsUnsentWork(phase))");
    expect(studioSource).not.toContain('addEventListener("beforeunload"');
  });
});
