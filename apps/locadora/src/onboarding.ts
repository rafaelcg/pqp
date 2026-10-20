/**
 * The first visit (mock 2, SPEC 4.2): two screens in a panel with the neon sign
 * on a rail. 1 the welcome, 2 the controller map (platform tabs, remap,
 * gamepad) with the console and its first cartridge beside or under it. The
 * house rules are not a step any more: the receipt on the Balcão is the
 * permanent copy and the pqp consent sheet has its own.
 *
 * Shown once per device: the flag is a row in the device store
 * (`seen:onboarding`); without a store it is once per session. Reopened from
 * Controles with `steps: [3]`, which shows the map alone with a Close button
 * and writes no flag.
 *
 * Two halves. The top of the file is plain logic (the flag, the step walk,
 * the Tab wrap) and is what the tests pin. `mountOnboarding` is the DOM, which
 * only wires those to the controller map and `gamepad.ts`.
 */
import { createGamepadWatcher, type GamepadWatcher } from "./gamepad";
import type { Strings } from "./i18n";
import {
  createRemapSession,
  defaultKeymaps,
  DPAD,
  keyLabel,
  PLATFORMS,
  type Keymaps,
  type PadButton,
  type Platform,
  type RemapSession,
  type RemapState,
} from "./keymap";
import type { DeviceStore } from "./store";
import { createCartridgeScene } from "./ui/cartridge";
import { createControllerMap, type ControllerMap, type ControllerMapStrings } from "./ui/controller-map";
import { fill, h } from "./ui/dom";

/* ---- the flag ---- */

/** The device-store key of the "already shown" flag (SPEC 9). */
export const SEEN_KEY = "seen:onboarding";

/** What stands in for the store when there is none, or when it will not answer. */
let seenThisSession = false;

/** Tests only: forget that this session already showed it. */
export function resetOnboardingSession(): void {
  seenThisSession = false;
}

export async function hasSeenOnboarding(store?: DeviceStore): Promise<boolean> {
  if (seenThisSession) return true;
  if (!store) return false;
  try {
    return (await store.get(SEEN_KEY)) !== null;
  } catch {
    return false;
  }
}

export async function markOnboardingSeen(store?: DeviceStore, now: () => number = Date.now): Promise<void> {
  seenThisSession = true;
  if (!store) return;
  try {
    await store.put(SEEN_KEY, new Uint8Array([1]), { at: now() });
  } catch {
    // a full or refusing store only means it is shown again next time
  }
}

/**
 * `?welcome=1` on the frame's own address forces the walkthrough on load, for testing and for a link that says
 * "show me the welcome". It is a replay: it never reads or writes the seen flag, so a device that had not seen the
 * welcome still gets it the first time for real, and one that had does not forget. Only `1` counts.
 */
export function welcomeForced(search: string): boolean {
  try {
    return new URLSearchParams(search).get("welcome") === "1";
  } catch {
    return false;
  }
}

export async function shouldShowOnboarding(store?: DeviceStore): Promise<boolean> {
  return !(await hasSeenOnboarding(store));
}

/* ---- the steps ---- */

/** 1 the street, 2 the map with the console, 3 the map alone (Controles; never part of the walk). */
export type Step = 1 | 2 | 3;
export const ALL_STEPS: readonly Step[] = [1, 2];

export interface Walkthrough {
  readonly steps: readonly Step[];
  readonly step: Step;
  /** 0-based place of `step` in `steps`. */
  readonly index: number;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  next(): boolean;
  back(): boolean;
}

export function createWalkthrough(steps: readonly Step[] = ALL_STEPS, onChange?: (step: Step) => void): Walkthrough {
  if (steps.length === 0) throw new Error("a walkthrough needs at least one step");
  let index = 0;
  const move = (to: number) => {
    if (to < 0 || to >= steps.length) return false;
    index = to;
    onChange?.(steps[index]!);
    return true;
  };
  return {
    steps,
    get step() {
      return steps[index]!;
    },
    get index() {
      return index;
    },
    get isFirst() {
      return index === 0;
    },
    get isLast() {
      return index === steps.length - 1;
    },
    next: () => move(index + 1),
    back: () => move(index - 1),
  };
}

/** Where focus goes on Tab (or Shift+Tab) inside a dialog of `count` focusable things, wrapping at both ends. */
export function nextTabIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
}

/* ---- the panel ---- */

export type OnboardingStrings = ControllerMapStrings &
  Pick<
    Strings,
    | "intro"
    | "top.pick"
    | "onb.1.title"
    | "onb.1.sub"
    | "onb.2.title"
    | "onb.2.sub"
    | "onb.3.title"
    | "onb.3.sub"
    | "onb.3.body"
    | "onb.4.title"
    | "onb.4.body"
    | "onb.pad.found"
    | "onb.listen"
    | "onb.next"
    | "onb.skip"
    | "onb.back"
    | "onb.close"
    | "onb.cancel"
    | "onb.reset"
    | "onb.replay"
    | "onb.open"
    | "onb.once"
    | "onb.steps"
    | "onb.step"
    | "onb.tabs"
    | "name.default"
    | "remap.reserved"
    | "remap.dup"
    | "remap.swap"
    | "remap.keep"
  >;

export type OnboardingDone = "pick" | "skip" | "close";

export interface OnboardingOptions {
  /** The empty `#v-onboarding` section. */
  root: HTMLElement;
  /** Where the keyboard goes back to when the panel is put away; defaults to whatever has focus when it is mounted. */
  opener?: HTMLElement | null;
  t: OnboardingStrings;
  store?: DeviceStore;
  /** Defaults to both screens; `[3]` is the map alone, reopened from Controles. */
  steps?: readonly Step[];
  /**
   * The walkthrough is being shown AGAIN (the top bar's "Ver a recepção de novo", Controles, `?welcome=1`), not for
   * the first time: finishing it writes no flag and the one-time "isso aparece só na primeira vez" line is not drawn.
   */
  replay?: boolean;
  platform?: Platform;
  /** The keys in force (from the saved preferences); defaults when absent. */
  keymaps?: Keymaps;
  /** A key was rebound or reset: persist it, hand it to the runtime. */
  onKeymap?: (platform: Platform, map: Readonly<Record<string, string>>) => void;
  /** The big button of the second screen was pressed: open the host's picker (called right after `onDone("pick")`). */
  onPick: () => void;
  /** The panel is finished with, and why. The caller moves to another screen. */
  onDone: (reason: OnboardingDone) => void;
  /**
   * "Ver a recepção de novo": the map alone (`steps: [3]`) offers to walk through the welcome again. The panel is
   * torn down first, then this is called to mount the full walkthrough. Absent: the button is not drawn.
   */
  onReplay?: () => void;
  /** For tests and for hosts without the Gamepad API. */
  gamepad?: GamepadWatcher;
}

export interface Onboarding {
  readonly walkthrough: Walkthrough;
  readonly remap: RemapSession;
  /**
   * Puts the keyboard in the dialog (on the step's title). Mounting does it too, but a section that is still
   * `hidden` cannot take focus: a caller that shows the section AFTER mounting calls this once it is up.
   */
  focus(): void;
  destroy(): void;
}

const PLATFORM_NAMES: Readonly<Record<Platform, string>> = { nes: "NES", snes: "SNES", gb: "Game Boy", gba: "GBA" };

export function mountOnboarding(options: OnboardingOptions): Onboarding {
  const { root, t } = options;
  const single = options.steps !== undefined && options.steps.length === 1;
  const walkthrough = createWalkthrough(options.steps ?? ALL_STEPS, () => {
    // moving on ends any listening: what was bound stays, the rest is dropped
    remap.cancel();
    renderStep(true);
  });

  let platform: Platform = options.platform ?? "nes";
  let glow: ReadonlySet<PadButton> = new Set();
  let padName: string | null = null;
  let map: ControllerMap | null = null;
  const previouslyFocused = options.opener !== undefined ? options.opener : (document.activeElement as HTMLElement | null);

  const remap = createRemapSession({
    platform,
    maps: options.keymaps ?? defaultKeymaps(),
    onChange: (state) => syncControls(state),
    onMap: (p, m) => options.onKeymap?.(p, m),
  });

  const watcher =
    options.gamepad ??
    createGamepadWatcher({
      platform: () => remap.state.platform,
      onFound: (name) => {
        padName = name;
        syncPad();
      },
      onLost: () => {
        padName = null;
        glow = new Set();
        map?.update({ glow });
        syncPad();
      },
      onHeld: (held) => {
        glow = held;
        map?.update({ glow });
      },
    });

  /* the frame of the panel, built once */
  // the sign over the door: the pixel art box (neon-sign.webp) with the house name lit inside its frame
  const neon = h("div", { class: "loc-onb-sign", "aria-hidden": "true" }, h("div", { class: "loc-onb-neon" }, "LOCADORA"));
  const open = h("div", { class: "loc-onb-open", "aria-hidden": "true" }, t["onb.open"]);
  const stepList = h("ol", { class: "loc-onb-steps", "aria-label": t["onb.steps"] });
  const side = h("aside", { class: "loc-onb-side" }, neon, open, stepList, h("span", { class: "loc-onb-rack", "aria-hidden": "true" }));
  // a replay is not the first time, so the line that says "this only shows the first time" would be wrong
  if (!options.replay) side.append(h("p", { class: "loc-onb-once" }, t["onb.once"]));

  const eyebrow = h("div", { class: "loc-onb-eyebrow" });
  const title = h("h2", { class: "loc-onb-title", id: "onb-title", tabindex: -1 });
  const lead = h("p", { class: "loc-onb-lead" });
  const content = h("div", { class: "loc-onb-content" });
  const progress = h("div", { class: "loc-onb-progress", "aria-hidden": "true" });
  const skipButton = h("button", { type: "button", class: "loc-onb-btn loc-onb-btn-ghost" }, t["onb.skip"]);
  const backButton = h("button", { type: "button", class: "loc-onb-btn loc-onb-btn-quiet" }, t["onb.back"]);
  const nextButton = h("button", { type: "button", class: "loc-onb-btn loc-onb-btn-primary" }, t["onb.next"]);
  const closeButton = h("button", { type: "button", class: "loc-onb-btn loc-onb-btn-primary" }, t["onb.close"]);
  const replayButton = h("button", { type: "button", class: "loc-onb-btn loc-onb-btn-quiet loc-onb-replay" }, t["onb.replay"]);
  const foot = h("footer", { class: "loc-onb-foot" }, progress, replayButton, h("span", { class: "loc-onb-spacer" }), skipButton, backButton, nextButton, closeButton);
  const main = h("div", { class: "loc-onb-main" }, h("header", {}, eyebrow, title, lead), content, foot);
  const panel = h("div", { class: "loc-onb-panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "onb-title" }, side, main);
  root.replaceChildren(panel);

  /* the map's own pieces, rebuilt each time it is shown */
  let tabs: HTMLButtonElement[] = [];
  let padPill: HTMLElement | null = null;
  let listenLine: HTMLElement | null = null;
  let noteLine: HTMLElement | null = null;
  let cancelButton: HTMLButtonElement | null = null;
  let swapButton: HTMLButtonElement | null = null;
  let keepButton: HTMLButtonElement | null = null;
  let resetButton: HTMLButtonElement | null = null;

  function buttonName(button: PadButton): string {
    if (DPAD.includes(button)) return t[`pad.${button}` as "pad.up"];
    if (button === "select") return "Select";
    if (button === "start") return "Start";
    return button.toUpperCase();
  }

  function syncPad() {
    if (!padPill) return;
    padPill.hidden = padName === null;
    if (padName !== null) padPill.title = padName;
  }

  function syncControls(state: RemapState) {
    platform = state.platform;
    map?.update({ platform: state.platform, mapping: state.maps[state.platform], listening: state.queue, glow });
    for (const tab of tabs) {
      const selected = tab.dataset.p === state.platform;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    const live = state.queue[0];
    if (listenLine) listenLine.textContent = live && !state.pending ? fill(t["onb.listen"], { button: buttonName(live) }) : "";
    if (noteLine) {
      const note = state.note;
      noteLine.textContent =
        note === null
          ? ""
          : note.kind === "reserved"
            ? t["remap.reserved"]
            : fill(t["remap.dup"], { key: keyLabel(note.code), button: buttonName(note.other) });
    }
    if (cancelButton) cancelButton.hidden = state.queue.length === 0 || state.pending !== null;
    if (swapButton) swapButton.hidden = state.pending === null;
    if (keepButton) keepButton.hidden = state.pending === null;
    if (state.pending !== null) swapButton?.focus();
  }

  function focusLive() {
    const group = remap.state.queue[0];
    const target = group ? (DPAD.includes(group) ? "dpad" : group) : null;
    if (target) map?.focusGroup(target);
  }

  function buildControls(): HTMLElement {
    const tablist = h("div", { class: "loc-onb-tabs", role: "tablist", "aria-label": t["onb.tabs"] });
    tabs = PLATFORMS.map((p) => {
      const tab = h(
        "button",
        { type: "button", class: "loc-onb-tab", role: "tab", "data-p": p, "aria-selected": "false", tabindex: -1 },
        PLATFORM_NAMES[p],
      );
      tab.addEventListener("click", () => remap.setPlatform(p));
      return tab;
    });
    tablist.append(...tabs);
    tablist.addEventListener("keydown", (event) => {
      const at = PLATFORMS.indexOf(remap.state.platform);
      const to =
        event.key === "ArrowRight" ? (at + 1) % PLATFORMS.length
        : event.key === "ArrowLeft" ? (at - 1 + PLATFORMS.length) % PLATFORMS.length
        : event.key === "Home" ? 0
        : event.key === "End" ? PLATFORMS.length - 1
        : -1;
      if (to < 0) return;
      event.preventDefault();
      remap.setPlatform(PLATFORMS[to]!);
      tabs[to]?.focus();
    });
    padPill = h("span", { class: "loc-onb-pad", role: "status", hidden: true }, h("span", { class: "loc-onb-dot", "aria-hidden": "true" }), t["onb.pad.found"]);
    tablist.append(padPill);

    map = createControllerMap({
      t,
      platform: remap.state.platform,
      mapping: remap.state.maps[remap.state.platform],
      listening: [],
      glow,
      onRemap: (buttons) => {
        remap.begin(buttons);
        focusLive();
      },
    });

    listenLine = h("p", { class: "loc-onb-listen", role: "status", "aria-live": "polite" });
    noteLine = h("p", { class: "loc-onb-note", role: "alert" });
    cancelButton = h("button", { type: "button", class: "loc-onb-btn loc-onb-btn-ghost loc-onb-btn-sm", hidden: true }, t["onb.cancel"] + " ", h("kbd", {}, "Esc"));
    swapButton = h("button", { type: "button", class: "loc-onb-btn loc-onb-btn-primary loc-onb-btn-sm", hidden: true }, t["remap.swap"]);
    keepButton = h("button", { type: "button", class: "loc-onb-btn loc-onb-btn-quiet loc-onb-btn-sm", hidden: true }, t["remap.keep"]);
    resetButton = h("button", { type: "button", class: "loc-onb-btn loc-onb-btn-quiet loc-onb-btn-sm" }, t["onb.reset"]);
    cancelButton.addEventListener("click", () => {
      remap.cancel();
    });
    swapButton.addEventListener("click", () => {
      remap.confirmSwap();
      focusLive();
    });
    keepButton.addEventListener("click", () => {
      remap.declineSwap();
      focusLive();
    });
    resetButton.addEventListener("click", () => remap.reset());

    const bar = h(
      "div",
      { class: "loc-onb-bar" },
      h("div", { class: "loc-onb-bar-text" }, listenLine, noteLine),
      h("div", { class: "loc-onb-bar-actions" }, cancelButton, swapButton, keepButton, resetButton),
    );
    // the map's own box: on a wide panel it is sized by the room the step leaves, so the controller fills it
    const stage = h("div", { class: "loc-onb-stage" }, h("div", { class: "loc-onb-mapbox" }, map.element), bar);
    const wrapper = h("div", { class: "loc-onb-controls" }, tablist, stage);
    syncControls(remap.state);
    return wrapper;
  }

  /**
   * Step 1: the shop on its street at dusk (street-dusk.webp), and the place is on: the sign powers up and then
   * hums, the TV in the window flickers, the street lamp and the light spilling out of the door breathe. Every one
   * of those is a lit copy of the picture's own pixels (or a glow) over the spot, in the picture's coordinates.
   */
  function buildHero(): HTMLElement {
    const fx = (name: string) => h("span", { class: `loc-onb-fx loc-onb-fx-${name}` });
    return h(
      "div",
      { class: "loc-onb-hero", "aria-hidden": "true" },
      h("div", { class: "loc-onb-scene loc-onb-street" }, fx("lamp"), fx("spill"), fx("tv"), fx("halo"), fx("sign"), fx("star1"), fx("star2"), fx("star3")),
    );
  }

  /**
   * The console (console.webp) with a blank cartridge (cart-blank.webp) sliding down into its open slot over the
   * big button, which takes the console's glow; then it rises out and does it again. Still, with reduced motion:
   * the cartridge in the slot, the light on. Beside the map on a wide pane, under it on a narrow one.
   */
  function buildPick(): HTMLElement {
    const button = h("button", { type: "button", class: "loc-onb-btn loc-onb-btn-primary loc-onb-btn-big loc-onb-pick-go" }, t["top.pick"]);
    button.addEventListener("click", () => finish("pick"));
    return h(
      "section",
      { class: "loc-onb-pick", "aria-labelledby": "onb-pick-title" },
      h("span", { class: "loc-onb-backdrop loc-onb-backdrop-corner", "aria-hidden": "true" }),
      createCartridgeScene({ title: fill(t["name.default"], { n: 1 }), platform: "nes" }, "loc-onb-slot loc-ins-holder"),
      h(
        "div",
        { class: "loc-onb-pick-text" },
        h("h3", { class: "loc-onb-pick-title", id: "onb-pick-title" }, t["onb.4.title"]),
        h("p", { class: "loc-onb-pick-body" }, t["onb.4.body"]),
        button,
      ),
    );
  }

  /** The second screen: the controller map, and the first cartridge to put in the console. */
  function buildSetup(): HTMLElement {
    return h("div", { class: "loc-onb-setup" }, buildControls(), buildPick());
  }

  const COPY: Readonly<Record<Step, { title: keyof OnboardingStrings; lead: keyof OnboardingStrings; sub: keyof OnboardingStrings }>> = {
    1: { title: "onb.1.title", lead: "intro", sub: "onb.1.sub" },
    2: { title: "onb.2.title", lead: "onb.3.body", sub: "onb.2.sub" },
    3: { title: "onb.3.title", lead: "onb.3.body", sub: "onb.3.sub" },
  };

  function renderRail() {
    const current = walkthrough.step;
    stepList.replaceChildren(
      ...ALL_STEPS.map((step) => {
        const item = h(
          "li",
          { class: step < current ? "is-done" : "", "aria-current": step === current ? "step" : undefined },
          h("span", { class: "loc-onb-n" }, String(step)),
          h("span", {}, h("b", {}, t[COPY[step].title]), h("small", {}, t[COPY[step].sub])),
        );
        return item;
      }),
    );
    progress.replaceChildren(...walkthrough.steps.map((_, i) => h("i", { class: i <= walkthrough.index ? "on" : "" })));
  }

  function renderStep(moveFocus: boolean) {
    const step = walkthrough.step;
    tabs = [];
    padPill = listenLine = noteLine = cancelButton = swapButton = keepButton = resetButton = null;
    map = null;
    root.dataset.step = String(step);
    eyebrow.textContent = fill(t["onb.step"], { n: walkthrough.index + 1, total: walkthrough.steps.length });
    eyebrow.hidden = single;
    title.textContent = t[COPY[step].title];
    lead.textContent = t[COPY[step].lead];
    content.replaceChildren(step === 1 ? buildHero() : step === 2 ? buildSetup() : buildControls());
    side.hidden = single;
    renderRail();
    skipButton.hidden = single;
    backButton.hidden = single || walkthrough.isFirst;
    nextButton.hidden = single || walkthrough.isLast;
    closeButton.hidden = !single;
    // only the map on its own (Controles) offers to show the welcome again; the welcome itself has no use for it
    replayButton.hidden = !(single && options.onReplay);
    progress.hidden = single;
    if (step !== 1) watcher.start();
    else watcher.stop();
    if (moveFocus) title.focus();
  }

  function finish(reason: OnboardingDone) {
    if (!single && !options.replay) void markOnboardingSeen(options.store);
    destroy();
    options.onDone(reason);
    if (reason === "pick") options.onPick();
  }

  skipButton.addEventListener("click", () => finish("skip"));
  backButton.addEventListener("click", () => walkthrough.back());
  nextButton.addEventListener("click", () => walkthrough.next());
  closeButton.addEventListener("click", () => finish("close"));
  replayButton.addEventListener("click", () => {
    destroy();
    options.onReplay?.();
  });

  /** Focusable things inside the panel, in tab order, for the wrap. */
  function focusables(): HTMLElement[] {
    const found = panel.querySelectorAll<HTMLElement>('button, [tabindex="0"]');
    return [...found].filter((node) => !node.closest("[hidden]") && !(node as HTMLButtonElement).disabled && node.tabIndex >= 0);
  }

  function onKey(event: KeyboardEvent) {
    const state = remap.state;
    const listening = walkthrough.step !== 1 && state.queue.length > 0;
    if (listening) {
      if (event.code === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        remap.cancel();
        focusLive();
        return;
      }
      if (state.pending === null && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // every key is the answer while listening: Tab, F1 and Esc included, so none of them also act
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) remap.press(event.code);
        return;
      }
    }
    if (event.code === "Escape" && !event.defaultPrevented) {
      // Escape is the way out of both: the map alone closes, the walkthrough is skipped (it stays reachable from Controles)
      event.preventDefault();
      event.stopPropagation();
      finish(single ? "close" : "skip");
      return;
    }
    if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const order = focusables();
      if (order.length === 0) return;
      const at = order.indexOf(document.activeElement as HTMLElement);
      // the browser's own order is right inside the list; the two ends wrap, and the title (not in the list) enters it
      if (at === -1 || (event.shiftKey && at === 0) || (!event.shiftKey && at === order.length - 1)) {
        event.preventDefault();
        order[nextTabIndex(at, order.length, event.shiftKey)]?.focus();
      }
    }
  }

  document.addEventListener("keydown", onKey, true);

  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    document.removeEventListener("keydown", onKey, true);
    watcher.stop();
    remap.cancel();
    root.replaceChildren();
    delete root.dataset.step;
    if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
  }

  renderStep(true);

  return { walkthrough, remap, focus: () => title.focus(), destroy };
}
