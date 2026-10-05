// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetSettingsRowsForTest,
} from "@/components/settings/kit/registry";
import { SettingsSectionContext } from "@/components/settings/kit/sections";
import {
  AppearanceSection,
  MODE_BEFORE_NIGHT_KEY,
  rememberModeBeforeNight,
  takeModeBeforeNight,
} from "@/components/settings/appearance-section";
import { getAccentHue, setAccentHuePreference } from "@/lib/accent";
import { getAppearance, setAppearancePreference } from "@/lib/appearance";
import { getThemeState, setThemePreference } from "@/lib/theme";
import { DEFAULT_CHAT_DISPLAY, getChatDisplay, setChatDisplay } from "@/lib/chat-display";

// The account sync is tested in preferences.test.ts; here it only has to not
// go out, except in the one test that wants to see a refusal reach the tab.
vi.mock("@/lib/preferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/preferences")>()),
  queuePreferenceSync: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  updatePreferences: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// Radix's slider measures its thumb with a ResizeObserver jsdom does not have.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

let root: Root | null = null;
let host: HTMLElement | null = null;
const onShowLinkEmbeds = vi.fn();

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SettingsSectionContext.Provider value="appearance">
        <AppearanceSection showLinkEmbeds onShowLinkEmbeds={onShowLinkEmbeds} />
      </SettingsSectionContext.Provider>,
    ),
  );
}

function group(name: string): HTMLElement {
  const found = [...host!.querySelectorAll<HTMLElement>('[role="radiogroup"]')].find(
    (el) => el.getAttribute("aria-label") === name,
  );
  if (!found) {
    throw new Error(`no radiogroup named ${name}`);
  }
  return found;
}

function radio(inside: ParentNode, name: RegExp | string): HTMLButtonElement {
  const found = [...inside.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (el) =>
      typeof name === "string"
        ? el.textContent?.trim() === name || el.getAttribute("aria-label") === name
        : name.test(el.textContent ?? "") || name.test(el.getAttribute("aria-label") ?? ""),
  );
  if (!found) {
    throw new Error(`no radio ${String(name)}`);
  }
  return found;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function rowText(id: string): string {
  return host!.querySelector(`[data-settings-row="${id}"]`)?.textContent ?? "";
}

beforeEach(() => {
  resetSettingsRowsForTest();
  localStorage.clear();
  setAppearancePreference("signal");
  setThemePreference("system");
  setAccentHuePreference("default");
  setChatDisplay(DEFAULT_CHAT_DISPLAY, { immediate: true });
  onShowLinkEmbeds.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("the mode before Night", () => {
  it("remembers a mode once and forgets it when read", () => {
    rememberModeBeforeNight("light");
    expect(localStorage.getItem(MODE_BEFORE_NIGHT_KEY)).toBe("light");
    expect(takeModeBeforeNight()).toBe("light");
    expect(takeModeBeforeNight()).toBeNull();
  });

  it("ignores a stored value that is not a mode", () => {
    localStorage.setItem(MODE_BEFORE_NIGHT_KEY, "sepia");
    expect(takeModeBeforeNight()).toBeNull();
  });
});

describe("Modo", () => {
  it("is called Mode, with light, dark and automatic", () => {
    mount();
    const mode = group("Mode");
    expect(
      [...mode.querySelectorAll('[role="radio"]')].map((el) => el.textContent),
    ).toEqual(["Light", "Dark", "Automatic"]);
    expect(rowText("brightness")).toContain("Follows your device's light and dark");
  });

  it("locks light and automatic under Night, says why, and brings the old mode back", () => {
    mount();
    const mode = group("Mode");
    click(radio(mode, "Light"));
    expect(getThemeState().preference).toBe("light");

    click(radio(host!, /^Night/));
    expect(getAppearance()).toBe("night");
    expect(getThemeState().resolved).toBe("dark");

    const light = radio(group("Mode"), /Light/);
    const automatic = radio(group("Mode"), /Automatic/);
    expect(light.getAttribute("aria-disabled")).toBe("true");
    expect(automatic.getAttribute("aria-disabled")).toBe("true");
    // A locked option is not a dead button: tapping it explains itself.
    click(light);
    const tip = host!.querySelector('[role="tooltip"]');
    expect(tip?.textContent).toBe("Night only exists in dark");
    expect(light.getAttribute("aria-describedby")).toBe(tip?.id);
    expect(getThemeState().preference).toBe("dark");
    expect(rowText("brightness")).toContain("your previous mode comes back");

    click(radio(host!, /^Classic/));
    expect(getAppearance()).toBe("signal");
    expect(getThemeState().preference).toBe("light");
    expect(radio(group("Mode"), /Light/).getAttribute("aria-checked")).toBe("true");
  });

  it("leaves Night on dark when it was dark before", () => {
    mount();
    click(radio(group("Mode"), "Dark"));
    click(radio(host!, /^Night/));
    click(radio(host!, /^Harmony/));
    expect(getThemeState().preference).toBe("dark");
  });

  it("skips locked options with the arrow keys", () => {
    mount();
    click(radio(host!, /^Night/));
    const dark = radio(group("Mode"), /Dark/);
    dark.focus();
    act(() => {
      dark.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(dark);
    expect(getThemeState().preference).toBe("dark");
  });

  it("moves with the arrow keys when nothing is locked", () => {
    // The case above cannot tell "skipped" from "did nothing": under Night
    // both neighbours of Dark are locked. Here the next option is open.
    mount();
    click(radio(group("Mode"), /Light/));
    const light = radio(group("Mode"), /Light/);
    light.focus();
    act(() => {
      light.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    const dark = radio(group("Mode"), /Dark/);
    expect(document.activeElement).toBe(dark);
    expect(getThemeState().preference).toBe("dark");
  });
});

describe("Visual", () => {
  it("says what it changes and calls the first look Original", () => {
    mount();
    expect(rowText("look")).toContain("Changes the background and colors of the interface.");
    expect(radio(host!, /^Classic/).textContent).toContain("Original");
  });
});

describe("Cor de destaque", () => {
  it("names the swatches by color, with a from-the-look choice first", () => {
    mount();
    const accent = group("Accent color");
    const names = [...accent.querySelectorAll('[role="radio"]')].map(
      (el) => el.getAttribute("aria-label") ?? el.textContent?.trim(),
    );
    expect(names).toEqual([
      "From look",
      "Red",
      "Orange",
      "Green",
      "Teal",
      "Cyan",
      "Blue",
      "Purple",
      "Pink",
    ]);
    expect(radio(accent, "From look").getAttribute("aria-checked")).toBe("true");
    expect(rowText("accent")).toContain("Using the look's color.");
    expect(host!.textContent).not.toContain("Back to the look's color");
  });

  it("picks a color, shows its name, and goes back with the named button", () => {
    mount();
    click(radio(group("Accent color"), "Cyan"));
    expect(getAccentHue()).toBe(210);
    expect(radio(group("Accent color"), "From look").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(rowText("accent")).toContain("Custom color. Works with any look.");
    const slider = host!.querySelector('[role="slider"]')!;
    expect(slider.getAttribute("aria-valuetext")).toBe("Cyan");
    // 360 is the same color as 0, so the slider stops one short of it.
    expect(slider.getAttribute("aria-valuemax")).toBe("359");

    const reset = [...host!.querySelectorAll("button")].find(
      (el) => el.textContent === "Back to the look's color",
    )!;
    click(reset);
    expect(getAccentHue()).toBe("default");
    expect(host!.textContent).not.toContain("Back to the look's color");
  });

  it("keeps the From look dot on the look's own accent when a custom one is set", () => {
    const dot = () =>
      radio(group("Accent color"), "From look").querySelector<HTMLElement>("span")!;
    mount();
    // No custom accent: the live accent IS the look's, so the dot wears it.
    expect(dot().className).toContain("bg-accent");
    click(radio(group("Accent color"), "Cyan"));
    // A custom accent overrides the live token; the dot must not follow it.
    expect(dot().className).not.toContain("bg-accent");
    expect(dot().getAttribute("style")).toContain("--swatch-signal-accent");
    click(radio(host!, /^Hearth/));
    expect(dot().getAttribute("style")).toContain("--swatch-hearth-accent");
  });

  it("calls a hue that is not a swatch by its tone", () => {
    setAccentHuePreference(40);
    mount();
    expect(
      host!.querySelector('[role="slider"]')!.getAttribute("aria-valuetext"),
    ).toBe("Tone 40");
  });
});

describe("Contraste", () => {
  it("describes the option that is on", () => {
    mount();
    const contrast = group("Contrast");
    click(radio(contrast, "Default"));
    expect(rowText("contrast")).toContain("Normal colors.");
    expect(rowText("contrast")).not.toContain("High:");
    click(radio(contrast, "High"));
    expect(rowText("contrast")).toContain("High: text and borders stand out more.");
  });
});

describe("Segmented controls", () => {
  it("never cut a label short: cells grow with their text and wrap", () => {
    // Spanish "Predeterminado" and "Más grande" did not fit an equal share of
    // the track and were truncated. jsdom has no layout, so this pins the
    // mode that cannot truncate.
    mount();
    for (const name of ["Contrast", "Density", "Text size", "Space between groups"]) {
      const radios = group(name);
      expect(radios.className).toContain("flex-wrap");
      expect(radios.querySelector(".truncate")).toBeNull();
    }
  });
});

describe("Account sync", () => {
  it("tells the tab when a theme choice did not reach the account", async () => {
    const api = await import("@/lib/api");
    const actual = await vi.importActual<typeof import("@/lib/preferences")>(
      "@/lib/preferences",
    );
    vi.mocked(api.updatePreferences).mockRejectedValueOnce(new Error("offline"));
    mount();
    expect(host!.textContent).not.toContain("Could not save to your account");
    await act(async () => {
      actual.queuePreferenceSync({ theme: "dark" }, { immediate: true });
      await Promise.resolve();
    });
    expect(host!.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not save to your account",
    );
    // A later change sends it again; once that lands the line goes.
    vi.mocked(api.updatePreferences).mockResolvedValueOnce({ preferences: {} });
    await act(async () => {
      actual.queuePreferenceSync({ contrast: "more" }, { immediate: true });
      await Promise.resolve();
    });
    expect(host!.textContent).not.toContain("Could not save to your account");
  });

  it("stays quiet about a failure in a preference this tab does not own", async () => {
    const api = await import("@/lib/api");
    const actual = await vi.importActual<typeof import("@/lib/preferences")>(
      "@/lib/preferences",
    );
    vi.mocked(api.updatePreferences).mockRejectedValueOnce(new Error("offline"));
    mount();
    await act(async () => {
      actual.queuePreferenceSync({ muteOnJoin: true }, { immediate: true });
      await Promise.resolve();
    });
    expect(host!.textContent).not.toContain("Could not save to your account");
    vi.mocked(api.updatePreferences).mockResolvedValueOnce({ preferences: {} });
    await act(async () => {
      actual.queuePreferenceSync({ muteOnJoin: true }, { immediate: true });
      await Promise.resolve();
    });
  });
});

describe("Chat", () => {
  const resetButton = () =>
    [...host!.querySelectorAll<HTMLButtonElement>("button")].find(
      (el) => el.textContent === "Restore density, size and spacing",
    )!;

  it("keeps the restore button in view, inert while everything is at the default", () => {
    mount();
    expect(resetButton().disabled).toBe(true);
    click(radio(group("Density"), "Compact"));
    expect(resetButton().disabled).toBe(false);
  });

  it("names density on the restore button, since it restores density too", () => {
    mount();
    click(radio(group("Density"), "Compact"));
    expect(resetButton().textContent).toContain("density");
    click(resetButton());
    expect(getChatDisplay().density).toBe("cozy");
  });

  it("restores density, text size and spacing, and leaves link previews alone", () => {
    mount();
    click(radio(group("Density"), "Compact"));
    click(radio(group("Text size"), "Large"));
    click(radio(group("Space between groups"), "Roomy"));
    expect(getChatDisplay().density).toBe("compact");

    click(resetButton());
    expect(getChatDisplay()).toEqual(DEFAULT_CHAT_DISPLAY);
    expect(resetButton().disabled).toBe(true);
    expect(onShowLinkEmbeds).not.toHaveBeenCalled();
  });

  it("describes the link preview switch", () => {
    mount();
    expect(rowText("link-previews")).toContain("Show link previews");
    expect(rowText("link-previews")).toContain("Only changes what you see.");
  });
});

describe("Idioma", () => {
  it("says the app reloads", () => {
    mount();
    expect(rowText("language")).toContain("Switching the language reloads the app.");
  });
});
