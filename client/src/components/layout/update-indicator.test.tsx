// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setInCall, setWatchingParty } from "@/lib/in-call-state";
import {
  resetUpdateState,
  setBuildStaleness,
  setUpdateWaiting,
  type BuildStaleness,
} from "@/lib/update-prompt-state";
import {
  UpdateIndicator,
  formatPublished,
  placePopover,
} from "./update-indicator";

/**
 * The quiet half of "a new version is ready". What this pins is what the
 * product stopped doing on 2026-10-13, when a person was shown a blocking card
 * every few seconds: nothing here opens by itself, blocks, or reloads, and a
 * call or a watch party is told in so many words what updating NOW would cost.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let applied: (string | null)[] = [];

async function mount(props: { onOpenWhatsNew?: () => void } = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <TooltipProvider>
        <UpdateIndicator
          {...props}
          apply={async (target) => {
            applied.push(target);
          }}
        />
      </TooltipProvider>,
    );
  });
}

const STALE: BuildStaleness = {
  stale: true,
  forced: false,
  latestBuild: "def456",
  since: 1,
  builtAt: Date.UTC(2026, 9, 13, 9, 12),
};

beforeEach(() => {
  applied = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        entries: [
          { pr: 1, at: Date.now() + 1000, note: { en: "Servers can be reordered." } },
          { pr: 2, at: Date.now() + 2000, note: {} },
        ],
      }),
    })),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setInCall(false);
  setWatchingParty(false);
  resetUpdateState();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const button = () =>
  document.querySelector("[data-update-indicator]") as HTMLButtonElement | null;
const popover = () => document.querySelector("[data-update-popover]");
const click = (el: Element | null) => act(() => (el as HTMLElement).click());

describe("the indicator", () => {
  it("is absent while the page is current", async () => {
    await mount();
    expect(button()).toBeNull();
  });

  it("is a small button with a dot once a new build is announced, and nothing else", async () => {
    await mount();
    act(() => setBuildStaleness(STALE));
    expect(button()).not.toBeNull();
    expect(button()?.getAttribute("aria-label")).toBe("New version ready");
    // It does not open, block or reload by itself.
    expect(popover()).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(applied).toEqual([]);
  });

  it("is absent while the build is held for the daily announcement, and appears when its hour comes", async () => {
    vi.useFakeTimers();
    await mount();
    act(() => setBuildStaleness({ ...STALE, announceAt: Date.now() + 60_000 }));
    expect(button()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(button()).not.toBeNull();
  });

  it("is drawn with emphasis when the operator pushed the update, and still does not open", async () => {
    await mount();
    act(() => setBuildStaleness({ ...STALE, forced: true }));
    expect(button()?.hasAttribute("data-update-emphasis")).toBe(true);
    expect(button()?.getAttribute("aria-label")).toBe("New version ready, worth updating");
    expect(popover()).toBeNull();
  });

  it("shows for a waiting worker the version poll has not spoken about", async () => {
    await mount();
    act(() => setUpdateWaiting(true));
    expect(button()).not.toBeNull();
  });

  it("goes when the page is current again", async () => {
    await mount();
    act(() => setBuildStaleness(STALE));
    click(button());
    expect(popover()).not.toBeNull();
    act(() =>
      setBuildStaleness({ stale: false, forced: false, latestBuild: null, since: null }),
    );
    expect(button()).toBeNull();
    expect(popover()).toBeNull();
  });
});

describe("the popover", () => {
  async function open() {
    await mount();
    act(() => setBuildStaleness(STALE));
    await act(async () => {
      click(button());
    });
  }

  it("says what is ready, when it was published, and what changed", async () => {
    await open();
    const text = popover()?.textContent ?? "";
    expect(text).toContain("New version ready");
    expect(text).toContain("Published");
    expect(text).toContain("What's changed");
    // The one change with a line written for a person is quoted; the other is
    // only counted, never shown as a pull request title.
    expect(text).toContain("Servers can be reordered.");
    expect(text).toContain("and 1 more small improvement");
    expect(button()?.getAttribute("aria-expanded")).toBe("true");
  });

  it("has one primary button, and it applies the update to the newest build", async () => {
    await open();
    const apply = document.querySelector('[data-testid="update-indicator-apply"]');
    expect(apply?.textContent).toBe("Update");
    await act(async () => {
      click(apply);
    });
    expect(applied).toEqual(["def456"]);
  });

  it("closes on Escape and gives focus back to the button", async () => {
    await open();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it("closes on a press outside, and not on one inside", async () => {
    await open();
    act(() => {
      popover()!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(popover()).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(popover()).toBeNull();
  });

  it("links to the in-app news when it can", async () => {
    const seen: string[] = [];
    await mount({ onOpenWhatsNew: () => seen.push("opened") });
    act(() => setBuildStaleness(STALE));
    await act(async () => {
      click(button());
    });
    const more = Array.from(popover()!.querySelectorAll("button")).find(
      (b) => b.textContent === "See all the news",
    );
    expect(more).toBeTruthy();
    click(more!);
    expect(seen).toEqual(["opened"]);
    expect(popover()).toBeNull();
  });

  it("falls back to a plain line when the list cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await open();
    expect(popover()?.textContent).toContain("Small improvements and fixes.");
  });

  it("says the update is held back, and that taking it now costs the call, when in a call", async () => {
    await mount();
    act(() => setInCall(true));
    act(() => setBuildStaleness(STALE));
    await act(async () => {
      click(button());
    });
    const text = popover()?.textContent ?? "";
    expect(text).toContain("You are in a call, so the update waits");
    // No one-click update in a call.
    expect(document.querySelector('[data-testid="update-indicator-apply"]')).toBeNull();
    expect(applied).toEqual([]);

    // Update now asks again, naming what it ends, and only then does it go.
    await act(async () => {
      click(document.querySelector('[data-testid="update-indicator-now"]'));
    });
    expect(popover()?.textContent).toContain("ends your call and stops your screen share");
    expect(applied).toEqual([]);
    await act(async () => {
      click(document.querySelector('[data-testid="update-indicator-confirm"]'));
    });
    expect(applied).toEqual(["def456"]);
  });

  it("can be declined after the warning", async () => {
    await mount();
    act(() => setInCall(true));
    act(() => setBuildStaleness(STALE));
    await act(async () => {
      click(button());
    });
    await act(async () => {
      click(document.querySelector('[data-testid="update-indicator-now"]'));
    });
    const keep = Array.from(popover()!.querySelectorAll("button")).find(
      (b) => b.textContent === "Not now",
    );
    click(keep!);
    expect(document.querySelector("[data-update-confirm]")).toBeNull();
    expect(applied).toEqual([]);
  });

  it("treats a watch party the same way", async () => {
    await mount();
    act(() => setWatchingParty(true));
    act(() => setBuildStaleness(STALE));
    await act(async () => {
      click(button());
    });
    expect(popover()?.textContent).toContain("You are watching a watch party");
    expect(document.querySelector('[data-testid="update-indicator-apply"]')).toBeNull();
  });

  it("hands the button back, with the reason, when applying fails", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <TooltipProvider>
          <UpdateIndicator apply={async () => ({ ok: false, reason: "offline" })} />
        </TooltipProvider>,
      );
    });
    act(() => setBuildStaleness(STALE));
    await act(async () => {
      click(button());
    });
    await act(async () => {
      click(document.querySelector('[data-testid="update-indicator-apply"]'));
    });
    const apply = document.querySelector(
      '[data-testid="update-indicator-apply"]',
    ) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    expect(apply.textContent).toBe("Try again");
    expect(popover()?.querySelector('[role="alert"]')?.textContent).toContain("offline");
  });
});

describe("placePopover", () => {
  const viewport = { width: 1000, height: 700 };
  const size = { width: 320, height: 240 };

  it("opens to the right of a rail button, growing upward from its bottom edge", () => {
    const at = placePopover(
      { left: 20, top: 640, right: 56, bottom: 676 },
      size,
      viewport,
      "right",
    );
    expect(at.left).toBe(66);
    expect(at.top).toBe(676 - 240);
  });

  it("opens below a row button, and keeps off the edges of a phone", () => {
    const phone = { width: 390, height: 800 };
    const at = placePopover(
      { left: 340, top: 10, right: 376, bottom: 46 },
      size,
      phone,
      "below",
    );
    expect(at.top).toBe(56);
    // Pulled back inside the window rather than half off it.
    expect(at.left).toBe(390 - 320 - 8);
  });

  it("never lands above the top or left of the window", () => {
    const at = placePopover(
      { left: 0, top: 20, right: 10, bottom: 30 },
      size,
      viewport,
      "right",
    );
    expect(at.top).toBeGreaterThanOrEqual(8);
    expect(at.left).toBeGreaterThanOrEqual(8);
  });
});

describe("formatPublished", () => {
  it("is a short date and time in the given language", () => {
    const at = Date.UTC(2026, 9, 13, 9, 12);
    expect(formatPublished(at, "en")).toMatch(/Oct/);
    expect(formatPublished(at, "pt-BR")).toMatch(/out/i);
  });
});
