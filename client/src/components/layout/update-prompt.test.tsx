// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { isUpdateWaiting, resetUpdateState } from "@/lib/update-prompt-state";
import type { ServiceWorkerControls } from "@/lib/register-sw";
import { UpdatePrompt } from "./update-prompt";

/**
 * `UpdatePrompt` used to be the corner card. It is the service worker's half of
 * the quiet update indicator now: it renders nothing, and records that a worker
 * is waiting. What a person sees is `update-indicator.test.tsx`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function fakeWorker() {
  let notify: (() => void) | null = null;
  let disposed = 0;
  const register = (onNeedRefresh: () => void): ServiceWorkerControls => {
    notify = onNeedRefresh;
    return {
      async update() {},
      dispose() {
        notify = null;
        disposed += 1;
      },
    };
  };
  return {
    register,
    arrive: () => act(() => notify?.()),
    disposed: () => disposed,
  };
}

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetUpdateState();
  document.body.innerHTML = "";
});

describe("UpdatePrompt", () => {
  it("draws nothing, even when a new build lands", async () => {
    const worker = fakeWorker();
    await mount(<UpdatePrompt register={worker.register} />);
    expect(host?.innerHTML).toBe("");

    worker.arrive();
    // No card, no dialog, no corner element of any kind: an interruption is
    // what this replaced.
    expect(document.body.querySelector('[data-corner-card="update"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(host?.innerHTML).toBe("");
  });

  it("records that a worker is waiting, for the indicator to read", async () => {
    const worker = fakeWorker();
    await mount(<UpdatePrompt register={worker.register} />);
    expect(isUpdateWaiting()).toBe(false);
    worker.arrive();
    expect(isUpdateWaiting()).toBe(true);
  });

  it("lets go of the worker when it unmounts", async () => {
    const worker = fakeWorker();
    await mount(<UpdatePrompt register={worker.register} />);
    act(() => root?.unmount());
    root = null;
    expect(worker.disposed()).toBe(1);
  });
});
