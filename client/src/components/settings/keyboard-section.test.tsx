// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KeyboardSection,
  isBrowserReservedChord,
} from "@/components/settings/keyboard-section";
import { SettingsShellContext } from "@/components/settings/kit";
import {
  defaultLocalSettings,
  type LocalSettings,
} from "@/components/settings/local-settings";
import type { KeyBinding } from "@/components/voice/push-to-talk";
import { defaultShortcutBindings } from "@/lib/keyboard-shortcuts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function stubPointer(fine: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: fine,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** Holds the draft the way Configurações does, so a patch re-renders. */
function Harness({
  initial,
  onPatch,
  openSection,
}: {
  initial: Partial<LocalSettings>;
  onPatch: (partial: Partial<LocalSettings>) => void;
  openSection: (section: string, rowId?: string) => void;
}) {
  const [draft, setDraft] = useState<LocalSettings>({
    ...defaultLocalSettings,
    ...initial,
  });
  return (
    <SettingsShellContext.Provider
      value={{
        profileDirty: false,
        openSection: openSection as never,
        headerActionsSlot: null,
      }}
    >
      <KeyboardSection
        draftLocal={draft}
        patchLocal={(partial) => {
          onPatch(partial);
          setDraft((current) => ({ ...current, ...partial }));
        }}
        onShowOverlay={() => undefined}
      />
    </SettingsShellContext.Provider>
  );
}

function mount(
  initial: Partial<LocalSettings> = {},
  {
    onPatch = () => undefined,
    openSection = () => undefined,
  }: {
    onPatch?: (partial: Partial<LocalSettings>) => void;
    openSection?: (section: string, rowId?: string) => void;
  } = {},
) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <Harness initial={initial} onPatch={onPatch} openSection={openSection} />,
    ),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const row = (id: string) =>
  host!.querySelector<HTMLElement>(`[data-settings-row="${id}"]`);

const fieldIn = (id: string) =>
  row(id)!.querySelector<HTMLButtonElement>("[data-key-binding-field]")!;

function press(code: string, key: string, init: KeyboardEventInit = {}) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code, key, bubbles: true, ...init }),
    );
  });
}

const J: KeyBinding = {
  code: "KeyJ",
  label: "J",
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
};

describe("KeyboardSection push-to-talk row", () => {
  it("says the key is off while the mode is voice activity", () => {
    stubPointer(true);
    mount({ inputMode: "voice-activity" });
    const ptt = row("push-to-talk")!;
    expect(ptt.textContent).toContain("Off");
    expect(ptt.textContent).toContain("Change the mode in Voice & Video");
    expect(ptt.querySelector("kbd")).toBeNull();
  });

  it("shows the key and the hold-to-talk line when the mode is push-to-talk", () => {
    stubPointer(true);
    mount({ inputMode: "push-to-talk" });
    const ptt = row("push-to-talk")!;
    expect(ptt.querySelector("kbd")).not.toBeNull();
    expect(ptt.textContent).toContain("Hold to talk");
    expect(ptt.textContent).not.toContain("Off");
  });

  it("opens Voz e vídeo on the push-to-talk row", () => {
    stubPointer(true);
    const openSection = vi.fn();
    mount({ inputMode: "voice-activity" }, { openSection });
    act(() => row("push-to-talk")!.click());
    expect(openSection).toHaveBeenCalledWith("voice", "ptt");
  });
});

describe("KeyboardSection conflicts", () => {
  it("offers to swap with the action that owns the chord", () => {
    stubPointer(true);
    const patches: Array<Partial<LocalSettings>> = [];
    mount({}, { onPatch: (partial) => patches.push(partial) });
    const defaults = defaultShortcutBindings(false);

    act(() => fieldIn("toggle-mute").click());
    press("KeyD", "D", { ctrlKey: true, shiftKey: true });
    // The chord is Deafen's. Nothing is saved, the field stays armed.
    expect(patches).toHaveLength(0);
    expect(fieldIn("toggle-mute").getAttribute("aria-pressed")).toBe("true");
    const alert = row("toggle-mute")!.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("already belongs to Deafen / undeafen");

    const swap = [...row("toggle-mute")!.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Swap with"),
    )!;
    expect(swap.textContent).toBe("Swap with Deafen / undeafen");
    act(() => swap.click());

    expect(patches).toHaveLength(1);
    const shortcuts = patches[0]!.shortcuts!;
    expect(shortcuts.toggleMute?.code).toBe("KeyD");
    // Deafen gets Mute's old chord, so neither is left without a key.
    expect(shortcuts.toggleDeafen).toEqual(defaults.toggleMute);
    expect(row("toggle-mute")!.querySelector('[role="alert"]')).toBeNull();
  });

  it("swaps on Enter too", () => {
    stubPointer(true);
    const patches: Array<Partial<LocalSettings>> = [];
    mount({}, { onPatch: (partial) => patches.push(partial) });
    act(() => fieldIn("toggle-mute").click());
    press("KeyD", "D", { ctrlKey: true, shiftKey: true });
    press("Enter", "Enter");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.shortcuts!.toggleMute?.code).toBe("KeyD");
  });

  it("does not offer a swap with the push-to-talk key", () => {
    stubPointer(true);
    const patches: Array<Partial<LocalSettings>> = [];
    mount(
      {
        shortcuts: { toggleMute: J },
        pushToTalkKey: {
          ...J,
          code: "KeyK",
          label: "K",
          device: "keyboard",
        },
      },
      { onPatch: (partial) => patches.push(partial) },
    );
    act(() => fieldIn("toggle-mute").click());
    press("KeyK", "K");
    expect(row("toggle-mute")!.querySelector('[role="alert"]')).not.toBeNull();
    expect(
      [...row("toggle-mute")!.querySelectorAll("button")].some((b) =>
        b.textContent?.startsWith("Swap with"),
      ),
    ).toBe(false);
    press("Enter", "Enter");
    expect(patches).toHaveLength(0);
  });
});

describe("KeyboardSection warnings", () => {
  it("says a key without Ctrl or Cmd stops at text boxes, in the row that breaks the rule", () => {
    stubPointer(true);
    mount({ shortcuts: { toggleMute: J } });
    expect(row("toggle-mute")!.textContent).toContain(
      "Without Ctrl/Cmd, this key only works outside text boxes",
    );
    // Deafen keeps its default chord, so it stays quiet.
    expect(row("toggle-deafen")!.textContent).not.toContain("Without Ctrl/Cmd");
    // Canais says it once for the whole group, not on every row.
    expect(row("previous-channel")!.textContent).not.toContain("Without Ctrl/Cmd");
    expect(host!.textContent).toContain("They do not fire while you type.");
  });

  it("warns, and keeps the key, when the browser owns the chord", () => {
    stubPointer(true);
    mount({
      shortcuts: {
        openUserSettings: { ...J, code: "KeyW", label: "W", ctrl: true },
      },
    });
    expect(host!.textContent).toContain("The browser uses this combination");
    expect(fieldIn("open-user-settings").textContent).toContain("W");
    // No warning on the defaults.
    act(() => root!.unmount());
    host!.remove();
    mount();
    expect(host!.textContent).not.toContain("The browser uses this combination");
  });
});

describe("KeyboardSection without a keyboard", () => {
  it("says so in one sentence and drops the buttons", () => {
    stubPointer(false);
    mount();
    expect(host!.textContent).toBe("Keyboard shortcuts are available on a computer.");
    expect(host!.querySelector("button")).toBeNull();
  });

  it("shows the rows once a physical key is pressed", () => {
    stubPointer(false);
    mount();
    press("KeyA", "a");
    expect(row("toggle-mute")).not.toBeNull();
    expect(host!.textContent).not.toContain("available on a computer");
  });

  it("does not take a soft keyboard's keydown for a keyboard", () => {
    stubPointer(false);
    mount();
    press("", "Unidentified");
    expect(row("toggle-mute")).toBeNull();
  });
});

describe("isBrowserReservedChord", () => {
  const chord = (over: Partial<KeyBinding>): KeyBinding => ({ ...J, ...over });

  it("lists the chords no browser lets a page take", () => {
    expect(isBrowserReservedChord(chord({ code: "KeyW", ctrl: true }), false)).toBe(true);
    expect(isBrowserReservedChord(chord({ code: "KeyW", meta: true }), true)).toBe(true);
    expect(isBrowserReservedChord(chord({ code: "KeyT", meta: true }), true)).toBe(true);
    expect(isBrowserReservedChord(chord({ code: "Digit3", ctrl: true }), false)).toBe(true);
    expect(
      isBrowserReservedChord(chord({ code: "KeyT", ctrl: true, shift: true }), false),
    ).toBe(true);
    expect(isBrowserReservedChord(chord({ code: "KeyQ", meta: true }), true)).toBe(true);
  });

  it("leaves the rest alone, including every default", () => {
    expect(isBrowserReservedChord(chord({ code: "KeyQ", ctrl: true }), false)).toBe(false);
    expect(isBrowserReservedChord(chord({ code: "KeyW" }), false)).toBe(false);
    expect(isBrowserReservedChord(chord({ code: "KeyW", ctrl: true, alt: true }), false)).toBe(
      false,
    );
    for (const apple of [true, false]) {
      for (const binding of Object.values(defaultShortcutBindings(apple))) {
        expect(isBrowserReservedChord(binding, apple)).toBe(false);
      }
    }
  });
});

describe("KeyboardSection reset", () => {
  it("opens the confirm on Keep shortcuts, so a second Enter resets nothing", async () => {
    stubPointer(true);
    mount();
    const reset = [...host!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Reset…",
    )!;
    await act(async () => {
      reset.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement?.textContent).toBe("Keep shortcuts");
  });
});
