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

const board = vi.hoisted(() => ({
  sounds: [] as Array<Record<string, unknown>>,
  fetches: 0,
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchSoundboard: async () => {
    board.fetches += 1;
    return { sounds: board.sounds, maxSounds: 24, slotsUsed: board.sounds.length };
  },
}));

function customSound(id: string, name: string) {
  return {
    id,
    name,
    emoji: "✨",
    contentType: "audio/mpeg",
    byteSize: 1000,
    durationMs: 1000,
    volume: 1,
    url: `http://storage.test/${id}.mp3`,
  };
}

vi.mock("@/lib/sounds", () => ({
  sharedAudioContext: () => null,
  decodeAudioBuffer: async () => null,
  unlockSounds: () => undefined,
}));

const { SoundboardControl } = await import("./soundboard-control");
const { SOUNDBOARD_PLAY_BURST } = await import("@pqp/shared");
const {
  noteOwnSoundboardEcho,
  registerSoundboardSender,
  resetSoundboardPendingForTests,
} = await import("@/lib/soundboard");

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let unregister: (() => void) | null = null;
const sent: string[] = [];

type Lock = "deafened" | "serverMuted" | "audience" | "micLocked" | null;
let canManageNow = false;

function render(lock: Lock) {
  act(() => {
    root!.render(
      <TooltipProvider>
        <SoundboardControl
          serverId="00000000-0000-4000-8000-000000000001"
          canUse
          canManage={canManageNow}
          lock={lock}
          size="h-10 w-10"
          iconSize="h-5 w-5"
        />
      </TooltipProvider>,
    );
  });
}

function mount(lock: Lock = null, canManage = false) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  canManageNow = canManage;
  render(lock);
}

/** The accessible name a screen reader gets: aria-label, else the text. */
function accessibleName(element: Element): string {
  return (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
}

function buttonsNamed(container: ParentNode, name: RegExp): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
    name.test(accessibleName(button)),
  );
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
  localStorage.clear();
  sent.length = 0;
  board.sounds = [];
  board.fetches = 0;
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
      vi.advanceTimersByTime(3100);
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
      vi.advanceTimersByTime(3100);
    });
    expect(status.textContent).toBe("");
  });
});

describe("holding a key or mashing the board", () => {
  it("ignores key repeat on a tile", () => {
    mount();
    open();
    const tile = tiles()[0]!;
    const repeat = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
    act(() => {
      tile.dispatchEvent(repeat);
    });
    expect(repeat.defaultPrevented).toBe(true);
  });

  it("sends at most a short burst and says the rest did not play", () => {
    mount();
    open();
    const status = panel()!.querySelector("[role='status']")!;
    for (let i = 0; i < 10; i += 1) {
      act(() => tiles()[0]!.click());
    }
    expect(sent.length).toBe(SOUNDBOARD_PLAY_BURST);
    expect(status.textContent).not.toBe("");
  });

  it("is readable in the light theme and does not rely on colour alone", () => {
    mount();
    open();
    act(() => {
      for (let i = 0; i < 6; i += 1) {
        tiles()[0]!.click();
      }
    });
    const status = panel()!.querySelector("[role='status']")!;
    // The soft warning pair is the one the bench measures at 4.5:1; the bare
    // warning colour is a 3:1 token for fills and icons, and was 4.45:1 as text.
    expect(status.className).toContain("bg-warning-soft");
    expect(status.className).toContain("text-on-warning-soft");
    expect(status.className).not.toMatch(/(^| )text-warning/);
    const icon = status.querySelector("svg")!;
    expect(icon).not.toBeNull();
    expect(icon.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the panel's layout when the notice shows: it takes the title's line", () => {
    mount();
    open();
    act(() => {
      for (let i = 0; i < 6; i += 1) {
        tiles()[0]!.click();
      }
    });
    const status = panel()!.querySelector("[role='status']")!;
    expect(status.className).toContain("absolute");
    expect(status.querySelector(".truncate")).not.toBeNull();
  });
});

describe("the clip list follows the server", () => {
  it("shows a clip somebody else added when the panel opens", async () => {
    mount();
    open();
    expect(tiles()).toHaveLength(6);
    press("Escape");
    board.sounds = [customSound("11111111-1111-4111-8111-111111111111", "Buzinão")];
    act(() => {
      vi.advanceTimersByTime(2_100);
    });
    await act(async () => {
      trigger().click();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(tiles()).toHaveLength(7);
    expect(tiles()[6]!.getAttribute("aria-label")).toBe("Buzinão");
  });

  it("says a clip was removed when its click is refused and the list no longer has it", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    board.sounds = [customSound(id, "Velho")];
    mount();
    await act(async () => {
      trigger().click();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(tiles()).toHaveLength(7);
    board.sounds = [];
    act(() => tiles()[6]!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    const status = panel()!.querySelector("[role='status']")!;
    expect(status.textContent).toMatch(/removed|removido|eliminado/i);
    expect(tiles()).toHaveLength(6);
  });
});

describe("a board locked for a reason that will pass", () => {
  it("stays visible, does not open, and says why", () => {
    mount("deafened");
    const button = trigger();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-label")).not.toBeNull();
    act(() => button.click());
    expect(panel()).toBeNull();
  });
});

describe("moving around the board", () => {
  it("moves between tiles with the arrow keys and keeps one tile in the Tab order", () => {
    mount();
    open();
    const all = tiles();
    expect(all.filter((tile) => tile.tabIndex === 0)).toHaveLength(1);
    expect(document.activeElement).toBe(all[0]);
    press("ArrowRight");
    expect(document.activeElement).toBe(all[1]);
    press("ArrowDown");
    expect(document.activeElement).toBe(all[4]);
    press("End");
    expect(document.activeElement).toBe(all.at(-1));
    press("Home");
    expect(document.activeElement).toBe(all[0]);
    press("ArrowLeft");
    expect(document.activeElement).toBe(all[0]);
  });

  it("shows how many slots are used next to Add", async () => {
    board.sounds = [customSound("33333333-3333-4333-8333-333333333333", "Um")];
    mount(null, true);
    await act(async () => {
      trigger().click();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(panel()!.textContent).toMatch(/1 (de|of) 24/);
  });
});


describe("the trigger's name", () => {
  it("is found by role and name in every state, not only while locked", () => {
    mount();
    // An icon-only button with no name is invisible to a screen reader.
    expect(accessibleName(trigger())).not.toBe("");
    expect(buttonsNamed(host!, /^soundboard$/i)).toHaveLength(1);

    render("deafened");
    expect(buttonsNamed(host!, /^soundboard: ./i)).toHaveLength(1);
    expect(trigger().getAttribute("aria-disabled")).toBe("true");

    render(null);
    expect(buttonsNamed(host!, /^soundboard$/i)).toHaveLength(1);
    expect(trigger().hasAttribute("aria-disabled")).toBe(false);
  });

  it("shows a locked trigger as an outline with a lock badge, not a dimmed icon", () => {
    mount("serverMuted");
    const className = trigger().className;
    // An icon at 40% opacity measured 3.0:1 in the light theme.
    expect(className).not.toMatch(/(^| )opacity-/);
    expect(className).toContain("text-text-secondary");
    const badge = host!.querySelector("[data-soundboard-lock-badge]")!;
    expect(badge).not.toBeNull();
    expect(badge.getAttribute("aria-hidden")).toBe("true");
    expect(badge.querySelector("svg")).not.toBeNull();

    render(null);
    expect(host!.querySelector("[data-soundboard-lock-badge]")).toBeNull();
  });

  it("does not use the waveform that means somebody is speaking", () => {
    mount();
    const svg = trigger().querySelector("svg")!;
    expect(svg.getAttribute("class")).toContain("lucide-party-popper");
    expect(svg.getAttribute("class")).not.toContain("lucide-audio-lines");
  });

  it("shows a muted badge on the closed trigger and puts it in the name", () => {
    mount();
    const plain = accessibleName(trigger());
    expect(host!.querySelector("[data-soundboard-muted]")).toBeNull();

    open();
    const mute = panel()!.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
    act(() => mute.click());
    act(() => trigger().click());

    expect(host!.querySelector("[data-soundboard-muted]")).not.toBeNull();
    expect(host!.querySelector("[data-soundboard-muted]")!.getAttribute("aria-hidden")).toBe("true");
    expect(accessibleName(trigger())).not.toBe(plain);
    expect(accessibleName(trigger()).startsWith(plain)).toBe(true);
  });
});

describe("a lock that arrives while the panel is open", () => {
  it("closes the panel and returns focus to the trigger when focus was inside it", () => {
    mount();
    open();
    expect(panel()!.contains(document.activeElement)).toBe(true);

    render("deafened");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("leaves focus alone when it was somewhere else", () => {
    mount();
    open();
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    act(() => elsewhere.focus());

    render("serverMuted");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});

describe("the per-person overlap cap", () => {
  function clickAndEcho(index: number) {
    act(() => tiles()[index]!.click());
    act(() => noteOwnSoundboardEcho(sent.at(-1)!));
  }

  it("refuses the fourth click at once while three of your own clips still sound", () => {
    mount();
    open();
    const status = panel()!.querySelector("[role='status']")!;
    // Trombone runs 4.6 s.
    for (let i = 0; i < 3; i += 1) {
      clickAndEcho(5);
    }
    expect(sent).toHaveLength(3);
    expect(status.textContent).toBe("");

    act(() => tiles()[5]!.click());
    expect(sent).toHaveLength(3);
    expect(status.textContent).not.toBe("");
  });

  it("lets a click through again once one of the three has ended", () => {
    mount();
    open();
    clickAndEcho(1); // laugh, 2.2 s
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    clickAndEcho(5);
    clickAndEcho(5);
    act(() => tiles()[5]!.click());
    expect(sent).toHaveLength(3);

    act(() => {
      vi.advanceTimersByTime(1300); // 2.3 s since the laugh
    });
    act(() => tiles()[5]!.click());
    expect(sent).toHaveLength(4);
  });

  it("does not spend budget on a click it refused", () => {
    mount();
    open();
    for (let i = 0; i < 3; i += 1) {
      clickAndEcho(5);
    }
    for (let i = 0; i < 6; i += 1) {
      act(() => tiles()[5]!.click());
    }
    expect(sent).toHaveLength(3);

    // Every trombone has ended; two tokens were spent minus the two earned.
    act(() => {
      vi.advanceTimersByTime(4700);
    });
    for (let i = 0; i < 6; i += 1) {
      act(() => tiles()[1]!.click());
    }
    // 5 - 3 spent + 2 earned = 4. Had the refused clicks paid, only 2 go out.
    expect(sent).toHaveLength(3 + 4);
  });

  it("forgets the count when the call is left", async () => {
    const { stopSoundboardClips } = await import("@/lib/soundboard");
    mount();
    open();
    for (let i = 0; i < 3; i += 1) {
      clickAndEcho(5);
    }
    act(() => stopSoundboardClips());
    act(() => tiles()[5]!.click());
    expect(sent).toHaveLength(4);
  });
});

describe("the send budget matches the server's", () => {
  it("banks no time while the bucket is full", () => {
    mount();
    open();
    act(() => tiles()[0]!.click()); // t0: 4 left, refill clock starts here
    act(() => {
      vi.advanceTimersByTime(3500); // full again; the clock restarts now
    });
    for (let i = 0; i < SOUNDBOARD_PLAY_BURST; i += 1) {
      act(() => tiles()[0]!.click());
    }
    expect(sent).toHaveLength(1 + SOUNDBOARD_PLAY_BURST);

    // 500 ms after the bucket emptied: nothing earned yet.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    act(() => tiles()[0]!.click());
    expect(sent).toHaveLength(1 + SOUNDBOARD_PLAY_BURST);

    // One full refill period after it emptied.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    act(() => tiles()[0]!.click());
    expect(sent).toHaveLength(2 + SOUNDBOARD_PLAY_BURST);
  });
});

describe("a long custom name", () => {
  const long = "Uma risada muito longa que não cabe";

  it("is readable in full on focus, and the tile keeps its name", async () => {
    board.sounds = [customSound("44444444-4444-4444-8444-444444444444", long)];
    mount();
    await act(async () => {
      trigger().click();
      await vi.advanceTimersByTimeAsync(50);
    });
    const custom = tiles()[6]!;
    expect(custom.getAttribute("aria-label")).toBe(long);

    act(() => custom.focus());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    const tips = [...document.querySelectorAll("[role='tooltip']")];
    expect(tips.some((tip) => tip.textContent?.includes(long))).toBe(true);
  });
});

describe("Add when the board is full", () => {
  function fullBoard() {
    return Array.from({ length: 24 }, (_, i) =>
      customSound(`55555555-5555-4555-8555-${String(i).padStart(12, "0")}`, `Som ${i + 1}`),
    );
  }

  it("stays reachable, does nothing, and says why", async () => {
    board.sounds = fullBoard();
    mount(null, true);
    await act(async () => {
      trigger().click();
      await vi.advanceTimersByTimeAsync(50);
    });
    const add = [...panel()!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-disabled") === "true",
    )!;
    expect(add).toBeDefined();
    expect(add.disabled).toBe(false);
    expect(add.className).toContain("opacity-40");

    // Opening the add dialog closes the panel, so an open panel is a no-op.
    act(() => add.click());
    expect(panel()).not.toBeNull();

    act(() => add.focus());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    const tips = [...document.querySelectorAll("[role='tooltip']")];
    expect(tips.some((tip) => tip.textContent?.includes("24"))).toBe(true);
  });

  it("is a live button while there is room", async () => {
    board.sounds = fullBoard().slice(0, 23);
    mount(null, true);
    await act(async () => {
      trigger().click();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(panel()!.querySelector("[aria-disabled='true']")).toBeNull();
  });
});

function stubViewport(width: number, height: number, sheet: boolean) {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("innerHeight", height);
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: sheet && query.includes("max-width: 639px"),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

function lockHint(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-soundboard-lock-hint]");
}

describe("why a locked button does nothing, on a screen with no hover", () => {
  it("says the reason when the button is tapped, and the button stays focusable", () => {
    mount("deafened");
    expect(lockHint()).toBeNull();
    act(() => trigger().click());
    expect(lockHint()).not.toBeNull();
    // The visible reason is the one the accessible name ends with.
    expect(accessibleName(trigger()).endsWith(lockHint()!.textContent!)).toBe(true);
    expect(trigger().getAttribute("aria-disabled")).toBe("true");
    expect(panel()).toBeNull();
    // Reading it never moves focus off the button.
    act(() => trigger().focus());
    expect(document.activeElement).toBe(trigger());
  });

  it("names the lock that is in force", () => {
    mount("serverMuted");
    act(() => trigger().click());
    const first = lockHint()!.textContent;
    render("micLocked");
    expect(lockHint()!.textContent).not.toBe(first);
  });

  it("goes after a few seconds", () => {
    mount("audience");
    act(() => trigger().click());
    expect(lockHint()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(lockHint()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(lockHint()).toBeNull();
  });

  it("goes on a tap anywhere else, on Escape, and on a second tap on the button", () => {
    mount("audience");
    act(() => trigger().click());
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(lockHint()).toBeNull();

    act(() => trigger().click());
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(lockHint()).toBeNull();

    act(() => trigger().click());
    press("Escape");
    expect(lockHint()).toBeNull();

    // The button itself is not "outside": a tap on it toggles, never re-opens.
    act(() => trigger().click());
    act(() => {
      trigger().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(lockHint()).not.toBeNull();
    act(() => trigger().click());
    expect(lockHint()).toBeNull();
  });

  it("is gone when the lock lifts", () => {
    mount("audience");
    act(() => trigger().click());
    render(null);
    expect(lockHint()).toBeNull();
  });
});

describe("the board on a phone", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is an anchored popover on a desktop-sized window", () => {
    stubViewport(1280, 800, false);
    mount();
    open();
    expect(panel()!.getAttribute("data-presentation")).toBe("popover");
    expect(panel()!.querySelector("[data-soundboard-close]")).toBeNull();
    expect(panel()!.querySelector<HTMLElement>(".grid")!.style.gridTemplateColumns).toBe(
      "repeat(3, minmax(0, 1fr))",
    );
  });

  it("is a sheet on a narrow window, with more columns and a close button", () => {
    stubViewport(390, 664, true);
    mount();
    open();
    expect(panel()!.getAttribute("data-presentation")).toBe("sheet");
    expect(panel()!.querySelector<HTMLElement>(".grid")!.style.gridTemplateColumns).toBe(
      "repeat(4, minmax(0, 1fr))",
    );
    const close = panel()!.querySelector<HTMLButtonElement>("[data-soundboard-close]")!;
    expect(close.className).toContain("h-10");
    act(() => close.click());
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("is a sheet in landscape, where the window is wide but short", () => {
    vi.stubGlobal("innerWidth", 750);
    vi.stubGlobal("innerHeight", 342);
    vi.stubGlobal("matchMedia", (query: string) => ({
      media: query,
      matches: query.includes("max-height: 520px"),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    mount();
    open();
    expect(panel()!.getAttribute("data-presentation")).toBe("sheet");
    expect(panel()!.querySelector<HTMLElement>(".grid")!.style.gridTemplateColumns).toBe(
      "repeat(6, minmax(0, 1fr))",
    );
  });

  it("steps the arrow keys by the columns it draws", () => {
    stubViewport(390, 664, true);
    mount();
    open();
    const all = tiles();
    expect(document.activeElement).toBe(all[0]);
    press("ArrowDown");
    expect(document.activeElement).toBe(all[4]);
    press("ArrowUp");
    expect(document.activeElement).toBe(all[0]);
  });

  it("fits a 280px screen without leaving it", () => {
    stubViewport(280, 568, true);
    mount();
    open();
    const style = panel()!.style;
    const left = Number.parseFloat(style.left);
    const width = Number.parseFloat(style.width);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + width).toBeLessThanOrEqual(280 - 8);
  });

  it("gives the mute button, the slider and Add a thumb-sized target", async () => {
    stubViewport(390, 664, true);
    mount(null, true);
    await act(async () => {
      trigger().click();
      await vi.advanceTimersByTimeAsync(50);
    });
    const mute = panel()!.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
    const add = buttonsNamed(panel()!, /^(add|adicionar|añadir|agregar)$/i)[0]!;
    const slider = panel()!.querySelector<HTMLElement>("[data-slider='volume']")!;
    expect(mute.className).toContain("h-10 w-10");
    expect(add.className).toContain("h-10");
    expect(slider.className).toContain("h-10");
  });

  it("asks for the same sizes on a coarse pointer at any width", () => {
    stubViewport(1280, 800, false);
    mount();
    open();
    expect(panel()!.querySelector("button[aria-pressed]")!.className).toContain(
      "pointer-coarse:h-10",
    );
    expect(panel()!.querySelector("[data-slider='volume']")!.className).toContain(
      "pointer-coarse:h-10",
    );
  });

  it("keeps the slider's width when the count and Add are there", async () => {
    stubViewport(390, 664, true);
    mount(null, true);
    await act(async () => {
      trigger().click();
      await vi.advanceTimersByTimeAsync(50);
    });
    const slider = panel()!.querySelector<HTMLElement>("[data-slider='volume']")!;
    expect(slider.className).toContain("min-w-[7rem]");
    expect(slider.parentElement!.className).toContain("flex-wrap");
    expect(panel()!.textContent).toMatch(/0 (de|of) 24 (sons|sounds|sonidos)/);
  });
});

describe("the panel's height follows the window", () => {
  const NATURAL = 400;
  let anchorTop = 0;
  let rectSpy: { mockRestore: () => void } | null = null;
  let heightSpy: { mockRestore: () => void } | null = null;

  beforeEach(() => {
    // The grid reports its full content whatever the panel's cap is, which is
    // what the panel measures. The chrome around it is nothing here.
    heightSpy = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("grid") ? NATURAL : 0;
      });
    rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("aria-haspopup") === "dialog") {
          return {
            top: anchorTop,
            bottom: anchorTop + 40,
            left: 300,
            right: 340,
            width: 40,
            height: 40,
            x: 300,
            y: anchorTop,
            toJSON: () => ({}),
          };
        }
        return new DOMRect(0, 0, 0, 0);
      });
  });

  afterEach(() => {
    heightSpy?.mockRestore();
    rectSpy?.mockRestore();
    vi.unstubAllGlobals();
  });

  it("returns to full size after the window gets taller", () => {
    stubViewport(1280, 300, false);
    anchorTop = 250;
    mount();
    open();
    // 250 above the button, less the gap and the margin: the panel is capped.
    expect(Number.parseFloat(panel()!.style.maxHeight)).toBeLessThan(NATURAL);

    vi.stubGlobal("innerHeight", 900);
    anchorTop = 850;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(Number.parseFloat(panel()!.style.maxHeight)).toBe(NATURAL);
  });
});

describe("the clip grid scrolls", () => {
  function gridScrollState(grid: HTMLElement) {
    const state = { top: 0 };
    Object.defineProperty(grid, "scrollTop", {
      configurable: true,
      get: () => state.top,
      set: (value: number) => {
        state.top = value;
      },
    });
    return state;
  }

  it("keeps its scroll position when a scroll event comes from inside the panel", () => {
    stubViewport(390, 664, true);
    board.sounds = Array.from({ length: 20 }, (_, i) => customSound(`c${i}`, `Clip ${i}`));
    mount();
    open();
    const grid = panel()!.querySelector<HTMLElement>(".grid")!;
    const state = gridScrollState(grid);
    // A browser clamps a grid's scrollTop to 0 the moment its panel's cap is
    // lifted (the old measurement did exactly that, on every scroll event).
    const setMax = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, "maxHeight");
    const liftedCaps: string[] = [];
    const livePanel = panel()!;
    const style = livePanel.style;
    Object.defineProperty(style, "maxHeight", {
      configurable: true,
      get: () => setMax?.get?.call(style) as string,
      set: (value: string) => {
        if (value === "none") {
          liftedCaps.push(value);
          state.top = 0;
        }
        setMax?.set?.call(style, value);
      },
    });
    state.top = 140;
    act(() => {
      grid.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(50);
    });
    expect(liftedCaps).toEqual([]);
    expect(state.top).toBe(140);
    expect(panel()).not.toBeNull();
  });

  it("scrolls the focused tile into view when the arrows or End move focus", async () => {
    stubViewport(390, 664, true);
    board.sounds = Array.from({ length: 20 }, (_, i) => customSound(`c${i}`, `Clip ${i}`));
    mount();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      await act(async () => {
        trigger().click();
        await vi.advanceTimersByTimeAsync(50);
      });
      const all = tiles();
      expect(all.length).toBeGreaterThan(10);
      press("End");
      expect(document.activeElement).toBe(all.at(-1));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

describe("the sheet's header and size on a phone", () => {
  let anchorRect: { top: number; bottom: number } = { top: 0, bottom: 40 };
  let rectSpy: { mockRestore: () => void } | null = null;
  let heightSpy: { mockRestore: () => void } | null = null;

  beforeEach(() => {
    heightSpy = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("grid") ? 600 : 0;
      });
    rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("aria-haspopup") === "dialog") {
          return {
            top: anchorRect.top,
            bottom: anchorRect.bottom,
            left: 300,
            right: 340,
            width: 40,
            height: anchorRect.bottom - anchorRect.top,
            x: 300,
            y: anchorRect.top,
            toJSON: () => ({}),
          };
        }
        return new DOMRect(0, 0, 0, 0);
      });
  });

  afterEach(() => {
    heightSpy?.mockRestore();
    rectSpy?.mockRestore();
    vi.unstubAllGlobals();
  });

  it("gives the header its own fixed height, with the close button inside the line", () => {
    stubViewport(390, 664, true);
    anchorRect = { top: 560, bottom: 600 };
    mount();
    open();
    const header = panel()!.querySelector<HTMLElement>("[data-soundboard-header]")!;
    expect(header.className).toContain("shrink-0");
    expect(header.className).toContain("h-10");
    const close = header.querySelector<HTMLElement>("[data-soundboard-close]")!;
    expect(close).not.toBeNull();
    // Inline, not floated over the grid below.
    expect(close.className).not.toContain("absolute");
    expect(close.className).toContain("h-10");
    // The grid and the footer start below the header.
    expect(header.nextElementSibling!.classList.contains("grid")).toBe(true);
  });

  it("keeps two rows of tiles on a phone on its side, 300px tall", () => {
    stubViewport(750, 300, true);
    // The call bar's row sits in the lower half: a tall bar leaves little room.
    anchorRect = { top: 190, bottom: 230 };
    mount();
    open();
    const maxHeight = Number.parseFloat(panel()!.style.maxHeight);
    // Two 68px rows and a 6px gap, plus the compact header (40) and footer (40+).
    const twoRows = 68 * 2 + 6;
    expect(maxHeight - (40 + 40 + 20)).toBeGreaterThanOrEqual(twoRows);
    // It took the call bar's room: the sheet reaches the bottom margin.
    const bottom = Number.parseFloat(panel()!.style.top) + maxHeight;
    expect(bottom).toBe(300 - 8);
    expect(panel()!.querySelector("[data-soundboard-close]")).not.toBeNull();
  });

  it("stays above the call bar when there is room for two rows", () => {
    stubViewport(390, 664, true);
    anchorRect = { top: 560, bottom: 600 };
    mount();
    open();
    const bottom =
      Number.parseFloat(panel()!.style.top) + Number.parseFloat(panel()!.style.maxHeight);
    expect(bottom).toBeLessThanOrEqual(560 - 8);
  });
});

describe("the lock note and the notice on a narrow screen", () => {
  it("keeps the lock note inside the viewport when the button is at the right edge", () => {
    stubViewport(360, 640, true);
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("aria-haspopup") === "dialog") {
          return {
            top: 580,
            bottom: 620,
            left: 316,
            right: 356,
            width: 40,
            height: 40,
            x: 316,
            y: 580,
            toJSON: () => ({}),
          };
        }
        return new DOMRect(0, 0, 0, 0);
      });
    mount("deafened");
    act(() => trigger().click());
    const note = lockHint()!;
    const left = Number.parseFloat(note.style.left);
    const width = Number.parseFloat(note.style.width);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + width).toBeLessThanOrEqual(360 - 8);
    spy.mockRestore();
  });

  it("lets the did-not-play notice wrap in the sheet instead of cutting it off", () => {
    stubViewport(280, 568, true);
    mount();
    open();
    for (let i = 0; i < SOUNDBOARD_PLAY_BURST + 1; i += 1) {
      act(() => tiles()[0]!.click());
    }
    const notice = panel()!.querySelector<HTMLElement>("[data-soundboard-notice]")!;
    expect(notice.className).toContain("min-h-5");
    expect(notice.querySelector(".truncate")).toBeNull();
  });
});
