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
    expect(status.className).toContain("truncate");
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

  it("dims a locked trigger to the design system's disabled opacity", () => {
    mount("serverMuted");
    expect(trigger().className).toContain("opacity-40");
    expect(trigger().className).not.toContain("opacity-50");
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
