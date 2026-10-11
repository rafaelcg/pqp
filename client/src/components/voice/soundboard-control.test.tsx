// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

/*
 * THE SOUNDBOARD PANEL, from the keyboard and from a screen reader. QA found
 * that focus never entered the panel (it is portaled to the end of <body>),
 * Escape dropped focus on <body>, a scroll anywhere closed it under a
 * keyboard user, the mute button's name contradicted its pressed state, and a
 * refused click lit its tile as if it had played. Each case is pinned here.
 */

vi.mock("@/hooks/use-voice-config", () => ({
  useVoiceConfig: () => ({ soundboard: true }),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchSoundboard: async () => ({ sounds: [], maxSounds: 24 }),
}));

vi.mock("@/lib/sounds", () => ({
  sharedAudioContext: () => null,
  decodeAudioBuffer: async () => null,
  unlockSounds: () => undefined,
}));

const { SoundboardControl } = await import("./soundboard-control");
const {
  noteOwnSoundboardEcho,
  registerSoundboardSender,
  resetSoundboardPendingForTests,
} = await import("@/lib/soundboard");

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let unregister: (() => void) | null = null;
const sent: string[] = [];

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <TooltipProvider>
        <SoundboardControl
          serverId="00000000-0000-4000-8000-000000000001"
          canUse
          canManage={false}
          size="h-10 w-10"
          iconSize="h-5 w-5"
        />
      </TooltipProvider>,
    );
  });
}

function trigger(): HTMLButtonElement {
  return host!.querySelector<HTMLButtonElement>("button[aria-haspopup='dialog']")!;
}

function panel(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-soundboard-panel]");
}

function tiles(): HTMLButtonElement[] {
  return [...panel()!.querySelectorAll<HTMLButtonElement>(".grid button")];
}

function open() {
  act(() => {
    trigger().click();
  });
  // Placement lands on the next frame; focus follows it.
  act(() => {
    vi.advanceTimersByTime(50);
  });
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, ...init }),
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "Date"] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })),
  );
  // The volume slider measures itself; jsdom has no ResizeObserver.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  sent.length = 0;
  resetSoundboardPendingForTests();
  unregister = registerSoundboardSender((soundId) => {
    sent.push(soundId);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  unregister?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("soundboard panel focus", () => {
  it("moves focus to the first sound on open, and Escape brings it back to the trigger", () => {
    mount();
    open();
    expect(panel()).not.toBeNull();
    expect(document.activeElement).toBe(tiles()[0]);

    press("Escape");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("keeps Tab inside the panel while it is open", () => {
    mount();
    open();
    const focusable = [
      ...panel()!.querySelectorAll<HTMLElement>('button:not([disabled]), [role="slider"]'),
    ];
    const last = focusable.at(-1)!;
    act(() => last.focus());
    press("Tab");
    expect(document.activeElement).toBe(focusable[0]);
    press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("stays open when something else on the page scrolls", () => {
    mount();
    open();
    const list = document.createElement("div");
    document.body.appendChild(list);
    act(() => {
      list.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(200);
    });
    expect(panel()).not.toBeNull();
    list.remove();
  });
});

describe("soundboard panel names and states", () => {
  it("names the trigger and the mute button once, and lets the state carry the rest", () => {
    mount();
    expect(trigger().hasAttribute("aria-pressed")).toBe(false);
    open();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const mute = panel()!.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
    const name = mute.getAttribute("aria-label");
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    act(() => mute.click());
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    expect(mute.getAttribute("aria-label")).toBe(name);
    act(() => mute.click());
  });

  it("does not announce a sound tile as a toggle", () => {
    mount();
    open();
    for (const tile of tiles()) {
      expect(tile.hasAttribute("aria-pressed")).toBe(false);
    }
  });
});

describe("a click the room never echoed", () => {
  it("does not light the tile and says it did not play", () => {
    mount();
    open();
    const status = panel()!.querySelector("[role='status']")!;
    act(() => tiles()[0]!.click());
    expect(sent).toHaveLength(1);
    expect(tiles()[0]!.hasAttribute("data-playing")).toBe(false);
    expect(status.textContent).toBe("");

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(status.textContent).not.toBe("");
  });

  it("says nothing when the echo comes back", () => {
    mount();
    open();
    const status = panel()!.querySelector("[role='status']")!;
    act(() => tiles()[0]!.click());
    act(() => noteOwnSoundboardEcho(sent[0]!));
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(status.textContent).toBe("");
  });
});
