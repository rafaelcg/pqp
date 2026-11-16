// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DesktopUpdateBridge, DesktopUpdateState } from "@/lib/desktop";
import { updatePhase } from "@/lib/desktop-update";
import { setInCall } from "@/lib/in-call-state";
import {
  isUpdateOffered,
  resetUpdateState,
  setBuildStaleness,
} from "@/lib/update-prompt-state";
import { UpdateIndicator } from "./update-indicator";

/**
 * The rail's update button is always there, like T3 Code's: up to date, an
 * update to download, downloading, ready, or a failure to retry. The shell's
 * half is driven through a fake bridge; the web half through the version poll's
 * published state.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function fakeBridge(initial: DesktopUpdateState) {
  let push: ((state: DesktopUpdateState) => void) | null = null;
  const bridge: DesktopUpdateBridge = {
    getState: vi.fn(async () => initial),
    check: vi.fn(async () => true),
    download: vi.fn(async () => true),
    install: vi.fn(async () => true),
    onState: (cb) => {
      push = cb;
      return () => {
        push = null;
      };
    },
  };
  return {
    bridge,
    emit: async (state: DesktopUpdateState) => {
      await act(async () => push?.(state));
    },
  };
}

async function mount(shellBridge: DesktopUpdateBridge | null) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <TooltipProvider>
        <UpdateIndicator variant="rail" always shellBridge={shellBridge} apply={async () => {}} />
      </TooltipProvider>,
    );
  });
}

function button(): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>("[data-update-indicator]");
  if (!found) {
    throw new Error("no update button");
  }
  return found;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ entries: [] }) })),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setInCall(false);
  resetUpdateState();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("updatePhase", () => {
  it("puts a downloaded shell update first, since its restart loads the newest site too", () => {
    expect(
      updatePhase({
        shell: { status: "downloaded", version: "0.9.0" },
        webOffered: true,
        checking: false,
      }),
    ).toEqual({ kind: "ready", via: "shell", version: "0.9.0" });
  });

  it("offers the web build when the shell has nothing", () => {
    expect(
      updatePhase({ shell: { status: "up-to-date", checkedAt: 1 }, webOffered: true, checking: false }),
    ).toEqual({ kind: "ready", via: "web", version: null });
  });

  it("puts an operator-pushed web build before a shell download", () => {
    expect(
      updatePhase({
        shell: { status: "available", version: "0.9.0" },
        webOffered: true,
        webUrgent: true,
        checking: false,
      }),
    ).toEqual({ kind: "ready", via: "web", version: null });
  });

  it("says current with nothing anywhere, and checking while a check runs", () => {
    expect(updatePhase({ shell: null, webOffered: false, checking: false })).toEqual({ kind: "current" });
    expect(updatePhase({ shell: null, webOffered: false, checking: true })).toEqual({ kind: "checking" });
  });
});

describe("isUpdateOffered", () => {
  it("shows a held-back build to somebody who checked by hand", () => {
    const build = { stale: true, forced: false, latestBuild: "b", since: 1, announceAt: 10_000 };
    expect(isUpdateOffered({ build, waiting: false }, 5_000)).toBe(false);
    expect(isUpdateOffered({ build, waiting: false, askedFor: "b" }, 5_000)).toBe(true);
  });

  it("holds the NEXT deploy for the gate again after a check", () => {
    const next = { stale: true, forced: false, latestBuild: "c", since: 2, announceAt: 10_000 };
    expect(isUpdateOffered({ build: next, waiting: false, askedFor: "b" }, 5_000)).toBe(false);
  });
});

describe("the always-on rail button", () => {
  it("is drawn on the web with nothing to take, and a click checks again", async () => {
    await mount(null);
    expect(button().dataset.updatePhase).toBe("current");
    await act(async () => button().click());
    expect(button().dataset.updatePhase).toBe("checking");
    expect(button().disabled).toBe(true);
  });

  it("downloads on the first click and shows the progress ring", async () => {
    const { bridge, emit } = fakeBridge({ status: "available", version: "0.9.0" });
    await mount(bridge);
    expect(button().dataset.updatePhase).toBe("available");
    expect(button().getAttribute("aria-label")).toContain("0.9.0");
    await act(async () => button().click());
    expect(bridge.download).toHaveBeenCalledTimes(1);
    await emit({ status: "downloading", version: "0.9.0", percent: 40 });
    expect(button().dataset.updatePhase).toBe("downloading");
    expect(document.querySelector("[data-update-progress]")?.getAttribute("data-update-progress")).toBe("40");
    expect(button().disabled).toBe(true);
  });

  it("restarts on the second click, through the popover", async () => {
    const { bridge } = fakeBridge({ status: "downloaded", version: "0.9.0" });
    await mount(bridge);
    expect(button().dataset.updatePhase).toBe("ready");
    await act(async () => button().click());
    const apply = document.querySelector<HTMLButtonElement>("[data-testid=update-indicator-apply]");
    expect(apply?.textContent).toBe("Restart");
    await act(async () => apply!.click());
    expect(bridge.install).toHaveBeenCalledTimes(1);
  });

  it("asks twice in a call, with the shell's own warning", async () => {
    setInCall(true);
    const { bridge } = fakeBridge({ status: "downloaded", version: "0.9.0" });
    await mount(bridge);
    await act(async () => button().click());
    expect(document.querySelector("[data-testid=update-indicator-apply]")).toBeNull();
    expect(document.body.textContent).toContain("installs when you quit pqp");
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-testid=update-indicator-now]")!.click(),
    );
    expect(document.body.textContent).toContain("Restarting now closes the app");
    expect(bridge.install).not.toHaveBeenCalled();
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-testid=update-indicator-confirm]")!.click(),
    );
    expect(bridge.install).toHaveBeenCalledTimes(1);
  });

  it("gives the button back when the restart is refused", async () => {
    const { bridge } = fakeBridge({ status: "downloaded", version: "0.9.0" });
    bridge.install = vi.fn(async () => false);
    await mount(bridge);
    await act(async () => button().click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-testid=update-indicator-apply]")!.click(),
    );
    expect(document.querySelector("[role=alert]")?.textContent).toContain("Could not restart");
  });

  it("retries a failed download with a click", async () => {
    const { bridge } = fakeBridge({ status: "error", context: "download", version: "0.9.0" });
    await mount(bridge);
    expect(button().dataset.updatePhase).toBe("error");
    await act(async () => button().click());
    expect(bridge.download).toHaveBeenCalledTimes(1);
  });

  it("hides the dot when there is nothing to take", async () => {
    await mount(null);
    expect(button().querySelector("span[aria-hidden=true]")).toBeNull();
    await act(async () => {
      setBuildStaleness({ stale: true, forced: false, latestBuild: "b", since: 1 });
    });
    expect(button().dataset.updatePhase).toBe("ready");
    expect(button().querySelector("span[aria-hidden=true]")).not.toBeNull();
  });
});
