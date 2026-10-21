// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRINGS } from "../i18n";
import type { LibraryItem } from "../library";
import { mountOnboarding, resetOnboardingSession, SEEN_KEY } from "../onboarding";
import { memoryStore } from "../store";
import { createFicha, createNamePrompt } from "./ficha";
import { createShelf } from "./shelf";
import { createSlotDrawer } from "./slot-drawer";
import { createTopBar } from "./top-bar";

const t = STRINGS["pt-BR"];

function item(n: number, patch: Partial<LibraryItem> = {}): LibraryItem {
  return {
    sha256: n.toString(16).padStart(64, "0"),
    platform: "nes",
    ext: ".nes",
    bytes: 1024 * n,
    headerTitle: "",
    userTitle: `Fita ${n}`,
    addedAt: 1000 + n,
    lastPlayedAt: 0,
    playSeconds: 0,
    artSeed: n,
    hasSram: false,
    slots: [],
    hasFile: true,
    ...patch,
  };
}

function key(target: EventTarget, name: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: name, code: name, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = "";
  resetOnboardingSession();
});

const mounted: Array<{ destroy(): void }> = [];

afterEach(() => {
  // a dialog listens on the document: one left behind would answer the next test's keys
  for (const dialog of mounted.splice(0)) dialog.destroy();
  vi.restoreAllMocks();
});

describe("the name field (no form can submit in a sandboxed frame)", () => {
  function mountPrompt() {
    const onSubmit = vi.fn<(title: string) => void>();
    const onSkip = vi.fn<() => void>();
    const prompt = createNamePrompt({ t, initial: "Fita sem nome 1", skipLabel: "Pular", onSubmit, onSkip });
    document.body.append(prompt.element);
    const input = prompt.element.querySelector("input")!;
    return { prompt, input, onSubmit, onSkip };
  }

  it("is not a form: the browser blocks a form's submission in a frame without allow-forms before any event", () => {
    const { prompt } = mountPrompt();
    expect(prompt.element.tagName).not.toBe("FORM");
    expect(prompt.element.querySelector("form")).toBeNull();
    expect(prompt.element.querySelector('[type="submit"]')).toBeNull();
  });

  it("Enter in the field commits the name, cancelling the key", () => {
    const { input, onSubmit } = mountPrompt();
    input.value = "Padrão verde";
    const event = key(input, "Enter");
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Padrão verde");
    expect(event.defaultPrevented).toBe(true);
  });

  it("an Enter that only confirms an input method's composition is not a commit", () => {
    const { input, onSubmit } = mountPrompt();
    key(input, "Enter", { isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("the button commits too, and Escape or the other button skips", () => {
    const { prompt, input, onSubmit, onSkip } = mountPrompt();
    input.value = "Outra";
    const [save, skip] = [...prompt.element.querySelectorAll("button")];
    save!.click();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Outra");
    skip!.click();
    key(input, "Escape");
    expect(onSkip).toHaveBeenCalledTimes(2);
  });

  it("keeps its keys to itself: the shelf's and the game's shortcuts never hear a name being typed", () => {
    const { input } = mountPrompt();
    const heard = vi.fn();
    document.body.addEventListener("keydown", heard);
    key(input, "n");
    key(input, "Enter");
    expect(heard).not.toHaveBeenCalled();
  });

  it("renaming in the Ficha: Enter commits there as well", () => {
    const onRename = vi.fn();
    const ficha = createFicha({ item: item(1), t, now: 5000, id: "f", mode: "rename", onPlay: vi.fn(), onSaves: vi.fn(), onRename, onRemove: vi.fn(), onClose: vi.fn() });
    document.body.append(ficha.element);
    const input = ficha.element.querySelector<HTMLInputElement>(".loc-nameprompt input")!;
    input.value = "Nome novo";
    key(input, "Enter");
    expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ sha256: item(1).sha256 }), "Nome novo");
  });
});

describe("the Ficha gives the keyboard back to what opened it", () => {
  function mountFicha(mode: "view" | "confirm" | "rename" = "view") {
    const onRestoreFocus = vi.fn();
    const onClose = vi.fn();
    const ficha = createFicha({
      item: item(1),
      t,
      now: 5000,
      id: "ficha",
      mode,
      onPlay: vi.fn(),
      onSaves: vi.fn(),
      onRename: vi.fn(),
      onRemove: vi.fn(),
      onClose,
      onRestoreFocus,
    });
    document.body.append(ficha.element);
    return { ficha, onRestoreFocus, onClose };
  }
  const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".loc-ficha button")].find((b) => b.textContent === name)!;

  it("Escape from the remove question lands on Tirar da prateleira, the button that asked it", () => {
    mountFicha();
    button(t["ficha.remove"]).click();
    expect(document.activeElement).toBe(button(t["ficha.remove.no"]));
    key(document.activeElement!, "Escape");
    expect(document.activeElement).toBe(button(t["ficha.remove"]));
    // still the card, still in view
    expect(document.querySelector(".loc-ficha")?.getAttribute("data-mode")).toBe("view");
  });

  it("'Deixar aí' lands there too", () => {
    mountFicha();
    button(t["ficha.remove"]).click();
    button(t["ficha.remove.no"]).click();
    expect(document.activeElement).toBe(button(t["ficha.remove"]));
  });

  it("Escape from the name field lands on Renomear", () => {
    mountFicha();
    button(t["ficha.rename"]).click();
    expect(document.activeElement?.tagName).toBe("INPUT");
    key(document.activeElement!, "Escape");
    expect(document.activeElement).toBe(button(t["ficha.rename"]));
  });

  it("a question opened by the Delete key on a box has no button to go back to: the box is told", () => {
    const { onRestoreFocus } = mountFicha("confirm");
    key(document.querySelector(".loc-ficha-confirm button")!, "Escape");
    expect(onRestoreFocus).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".loc-ficha")?.getAttribute("data-mode")).toBe("view");
  });

  it("Escape in the plain card closes it", () => {
    const { onClose } = mountFicha();
    key(button(t["ficha.play"]), "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("the shelf", () => {
  function mountShelf(over: Partial<Parameters<typeof createShelf>[0]> = {}) {
    const shelf = createShelf({
      t,
      items: [item(1), item(2), item(3)],
      storage: "ready",
      onPlay: vi.fn(),
      onPick: vi.fn(),
      onSaves: vi.fn(),
      onRename: vi.fn(),
      onRemove: vi.fn(),
      ...over,
    });
    document.body.append(shelf.element);
    return shelf;
  }
  const box = (n: number) => document.querySelector<HTMLElement>(`[data-sha="${item(n).sha256}"]`)!;

  it("Delete asks to remove, and Escape from the question lands back on the box", () => {
    mountShelf();
    box(2).focus();
    key(box(2), "Delete");
    expect(document.activeElement?.closest(".loc-ficha-confirm")).not.toBeNull();
    key(document.activeElement!, "Escape");
    expect(document.activeElement).toBe(box(2));
  });

  it("focuses a box without scrolling the page when asked to (the shelf drawn again after a game)", () => {
    const shelf = mountShelf();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    shelf.focus(item(3).sha256, { preventScroll: true });
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(box(3));
    // and the ordinary call still lets the browser scroll the box into view
    shelf.focus(item(1).sha256);
    expect(focus).toHaveBeenLastCalledWith(undefined);
  });

  it("says the device refused the last cartridge, whatever the meter reads, until told otherwise", () => {
    const shelf = mountShelf({ usage: { used: 10, cap: 1000 }, refused: true });
    const notice = () => document.querySelector<HTMLElement>(".loc-notice")!;
    expect(notice().hidden).toBe(false);
    expect(notice().textContent).toBe(t["err.storage"]);
    shelf.update({ refused: false });
    expect(notice().hidden).toBe(true);
    // the meter's own line is unchanged
    shelf.update({ usage: { used: 950, cap: 1000 } });
    expect(notice().textContent).toBe(t["shelf.full"]);
  });
});

describe("the saves drawer's battery line", () => {
  function drawer(battery?: boolean) {
    const value = createSlotDrawer({
      t,
      locale: "pt-BR",
      slots: [],
      current: 1,
      autosave: true,
      ...(battery !== undefined ? { battery } : {}),
      onLoad: vi.fn(),
      onSave: vi.fn(),
      onSelect: vi.fn(),
      onDelete: vi.fn(),
      onToggleAutosave: vi.fn(),
    });
    document.body.append(value.element);
    value.open();
    return value;
  }

  it("is drawn for a game with a battery save, and only then", () => {
    const value = drawer(false);
    expect(value.element.querySelector(".loc-slots-sram")).toBeNull();
    value.update({ battery: true });
    expect(value.element.querySelector(".loc-slots-sram")?.textContent).toContain("30 segundos");
    value.update({ battery: false });
    expect(value.element.querySelector(".loc-slots-sram")).toBeNull();
  });

  it("is drawn when the caller does not say (the old behaviour)", () => {
    expect(drawer().element.querySelector(".loc-slots-sram")).not.toBeNull();
  });
});

describe("the top bar", () => {
  it("gives the keyboard back to Controles", () => {
    const bar = createTopBar({ t, onPick: vi.fn(), onControls: vi.fn() });
    document.body.append(bar.element);
    bar.focusControls();
    expect(document.activeElement?.getAttribute("aria-label")).toBe(t["hud.controls"]);
  });

  it("falls back to the primary button when the bar has no Controles", () => {
    const bar = createTopBar({ t, onPick: vi.fn() });
    document.body.append(bar.element);
    bar.focusControls();
    expect(document.activeElement).toBe(bar.pickButton);
  });
});

describe("the walkthrough and the map are real dialogs", () => {
  const stubPad = { start() {}, stop() {}, poll() {}, found: false };

  function mount(over: Partial<Parameters<typeof mountOnboarding>[0]> = {}) {
    document.body.innerHTML = '<button id="opener">Controles</button><section id="root" hidden></section>';
    const root = document.getElementById("root")!;
    const opener = document.getElementById("opener") as HTMLButtonElement;
    opener.focus();
    const onDone = vi.fn();
    const store = memoryStore();
    const dialog = mountOnboarding({ root, t, store, onPick: vi.fn(), onDone, gamepad: stubPad, ...over });
    mounted.push(dialog);
    return { root, opener, onDone, dialog, store };
  }

  it("takes the keyboard onto the step's title once its section is shown (a hidden section cannot take focus in a browser)", () => {
    const { root, dialog } = mount();
    root.hidden = false;
    dialog.focus();
    expect(document.activeElement?.id).toBe("onb-title");
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");
  });

  it("Escape skips the walkthrough, remembers it was shown, and goes back to what opened it", async () => {
    const { root, opener, onDone, dialog, store } = mount();
    root.hidden = false;
    dialog.focus();
    const event = key(document.activeElement!, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(onDone).toHaveBeenCalledExactlyOnceWith("skip");
    expect(document.activeElement).toBe(opener);
    await vi.waitFor(async () => expect(await store.get(SEEN_KEY)).not.toBeNull());
  });

  it("Escape closes the map alone (Controles), writes no first-visit flag, and gives the focus back", async () => {
    const { root, opener, onDone, dialog, store } = mount({ steps: [3] });
    root.hidden = false;
    dialog.focus();
    key(document.activeElement!, "Escape");
    expect(onDone).toHaveBeenCalledExactlyOnceWith("close");
    expect(document.activeElement).toBe(opener);
    expect(await store.get(SEEN_KEY)).toBeNull();
  });

  it("while a button is listening for a key, Escape only stops the listening", () => {
    const { root, onDone, dialog } = mount({ steps: [3] });
    root.hidden = false;
    dialog.focus();
    root.querySelector<SVGElement | HTMLElement>('.loc-pad-callout[data-group="a"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(root.querySelector(".loc-onb-listen")?.textContent).not.toBe("");
    key(document.activeElement ?? document.body, "Escape");
    expect(onDone).not.toHaveBeenCalled();
    expect(root.querySelector(".loc-onb-listen")?.textContent).toBe("");
  });

  it("goes back to an opener it was handed, even if the focus was elsewhere when it mounted", () => {
    document.body.innerHTML = '<button id="a">a</button><button id="b">b</button><section id="root"></section>';
    document.getElementById("a")!.focus();
    const onDone = vi.fn();
    const dialog = mountOnboarding({
      root: document.getElementById("root")!,
      t,
      onPick: vi.fn(),
      onDone,
      gamepad: stubPad,
      opener: document.getElementById("b"),
      steps: [3],
    });
    mounted.push(dialog);
    key(document.activeElement ?? document.body, "Escape");
    expect(onDone).toHaveBeenCalled();
    expect(document.activeElement?.id).toBe("b");
  });
});
