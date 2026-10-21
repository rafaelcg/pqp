/**
 * The HUD (SPEC 4.4 and 4.6 of the locadora-ux-pass, mocks 3 and 4): the glass
 * over the stage that holds the title, the screen and CRT pills, the bar of
 * buttons with their key hints, the pause overlay, the turbo flag, the toasts
 * and the toasts that carry feedback (saved, loaded, turbo at 1x).
 *
 * What it owns: when it shows and fades, pause, turbo (hold, toggle, ratio),
 * the slot picker's number, the screen menu's mounting and the stage wiring,
 * the shortcuts (`shortcuts.ts`). What it only asks for, through `onAction`:
 * save, load, the saves drawer, the controls, sound and full screen, eject.
 * Those belong to the saves module and to `main.ts`, which know the store and
 * the host; the HUD has no business knowing either.
 *
 * Visibility is one attribute, `data-hud="visible|hidden"`, on the host. It
 * fades by opacity and never by `visibility` or `hidden`, because Tab from the
 * game must still reach a faded button (and reveal the HUD by focusing it).
 */
import type { Strings } from "./i18n";
import type { EmulatorRuntime, Turbo } from "./runtime";
import { installShortcuts, isTextTarget, type Shortcut } from "./shortcuts";
import { formatFactor, hasTvAspect, type Stage, type StageSettings } from "./stage";
import { clampTurboRatio, DEFAULT_TURBO_RATIO, formatRatio, isIdleRatio, ratioForKey, turboPopoverModel } from "./turbo";
import { fill, h } from "./ui/dom";
import { createScreenMenu, type ScreenMenu, type ScreenMenuChange, type ScreenMenuState } from "./ui/screen-menu";
import { createToaster, type Toaster, type ToastAction } from "./ui/toast";

/** The HUD fades this long after the last activity (SPEC 4.4, 7). */
export const IDLE_MS = 2500;
/** While something holds the HUD up, how often it is asked again whether that is still so. */
export const HOLD_POLL_MS = 500;
/** A press on Turbo held this long opens the ratio menu. */
export const LONG_PRESS_MS = 450;
/** How often the play time on the title chip is redrawn. */
export const PLAY_TIME_REFRESH_MS = 15_000;
export const SLOT_COUNT = 4;
export { DEFAULT_TURBO_RATIO };

/** What the HUD asks its owner to do. The slot is the picker's current one. */
export type HudAction = "save" | "load" | "saves" | "controls" | "sound" | "fullscreen" | "eject" | "share";

/**
 * The share control, which the HUD only draws: whether sharing is offered at all is the page's to know (src/share.ts).
 * `null` is "not offered": no pill, nothing to press, nothing that does nothing.
 */
export type HudShare = { on: boolean; busy: boolean } | null;

export interface HudInfo {
  title: string;
  /** The console's name, as the person reads it ("Game Boy Advance"). */
  console: string;
  /** A small picture of the box, if the caller has one. */
  art?: Node;
}

export type HudRuntime = Pick<EmulatorRuntime, "pause" | "setTurbo" | "setKeyboard">;
export type HudStage = Pick<Stage, "settings" | "layout" | "update" | "onChange" | "setFullscreen">;

export interface HudOptions {
  /** The positioned stage element (`#stage`): the HUD is laid over it. */
  host: HTMLElement;
  t: Strings;
  runtime: HudRuntime;
  stage: HudStage;
  info?: HudInfo;
  /** The picker's starting slot, 1 to `SLOT_COUNT`. */
  slot?: number;
  onAction: (action: HudAction, slot: number) => void;
  onSlotChange?: (slot: number) => void;
  onPausedChange?: (paused: boolean) => void;
  /** 0 when turbo is off, else the ratio in force. */
  onTurboChange?: (turbo: Turbo) => void;
  /** The speed the turbo starts at (the person's saved one), 1 to 10; anything else is the default. */
  turboRatio?: number;
  /** The person moved the speed: the owner keeps it. Called with the snapped ratio, not with the turbo's on or off. */
  onTurboRatioChange?: (ratio: number) => void;
  /** The language's tag ("pt-BR"), for the decimal mark of "3,8x". Absent: plain digits. */
  locale?: string;
  /** Milliseconds, for the play time. Defaults to `Date.now`. */
  now?: () => number;
  /** False to leave the keys alone (a caller that installs `installShortcuts` itself). */
  shortcuts?: boolean;
  /** The game's own element: Tab pressed there walks into the HUD (the emulator would otherwise swallow it). */
  game?: HTMLElement;
  /** Puts the keyboard back on the game: Escape inside the HUD, and Tab past its last button. */
  focusGame?: () => void;
}

export interface Hud {
  readonly element: HTMLElement;
  readonly paused: boolean;
  /** 0 when off, else the ratio in force. */
  readonly turbo: Turbo;
  /** The speed turbo runs at when it is on, 1 to 10. At 1x it does nothing. */
  readonly turboRatio: number;
  readonly slot: number;
  readonly screenMenu: ScreenMenu;
  readonly toaster: Toaster;
  /** The stage is on screen (true) or not: shortcuts, fading and the play clock follow. */
  setActive(active: boolean): void;
  setInfo(info: HudInfo): void;
  setSlot(slot: number): void;
  setPaused(paused: boolean): void;
  togglePause(): void;
  /** Snaps to half steps and holds between 1 and 10; applied at once when turbo is on. */
  setTurboRatio(ratio: number): void;
  toggleTurbo(): void;
  setMuted(muted: boolean): void;
  /** Draws (or removes, with `null`) the pill that shares the pane. Pressing it asks the owner for the `"share"` action. */
  setShare(share: HudShare): void;
  /** Tell the HUD the room is (or is not) full screen; also tells the stage. */
  setFullscreen(full: boolean): void;
  /** While the saves drawer is open the HUD does not fade. */
  setDrawerOpen(open: boolean): void;
  /** Redraw the screen pill and menu from the stage (call from the stage's `onLayout`). */
  syncStage(): void;
  /** Show the HUD and start the idle clock over. */
  wake(): void;
  /** "Tri! Salvo no slot 2." with an optional Desfazer. */
  notifySaved(slot: number, undo?: () => void): void;
  notifyLoaded(slot: number): void;
  toast(text: string, action?: ToastAction): void;
  destroy(): void;
}

/** "1h12" from 4320 seconds, "12 min" from 720, "0 min" under a minute. */
export function formatPlayTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  return `${hours}h${String(total % 60).padStart(2, "0")}`;
}

/** The slot after (`step` 1) or before (`step` -1), wrapping 1..SLOT_COUNT. */
export function stepSlot(slot: number, step: 1 | -1): number {
  return ((slot - 1 + step + SLOT_COUNT) % SLOT_COUNT) + 1;
}

const ICONS = {
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/></svg>',
  load: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 4v5h5"/></svg>',
  saves:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="8" height="7" rx="1"/><rect x="13" y="4" width="8" height="7" rx="1"/><rect x="3" y="13" width="8" height="7" rx="1"/><rect x="13" y="13" width="8" height="7" rx="1"/></svg>',
  turbo: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5v14l8-7zM12 5v14l8-7z"/></svg>',
  screen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8"/></svg>',
  controls:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 11h4M8 9v4M15 12h.01M18 10h.01"/><rect x="2" y="6" width="20" height="12" rx="6"/></svg>',
  sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6"/></svg>',
  muted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>',
  full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  exitFull: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
  eject: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4l8 10H4z"/><path d="M4 19h16"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',} as const;

/**
 * Room the bar wants at each side of it. When the full bar does not fit the stage (a docked drawer at 900 px, any
 * phone), it collapses to its five main buttons and an overflow menu (SPEC 13) instead of scrolling sideways.
 */
export const BAR_MARGIN = 16;

type IconName = keyof typeof ICONS;

/** The icons are fixed strings above, never anything a person typed. */
function icon(name: IconName): Element {
  const template = document.createElement("template");
  template.innerHTML = ICONS[name];
  const svg = template.content.firstElementChild as Element;
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  return svg;
}

interface BarButton {
  button: HTMLButtonElement;
  /** Swap what the button says and shows; `aria` is the whole accessible name, key included. */
  set(parts: { label?: string; aria?: string; icon?: IconName }): void;
}

function barButton(config: { action: string; icon: IconName; label: string; aria: string; kbd?: string; primary?: boolean }): BarButton {
  const label = h("span", { class: "loc-hb-label" }, config.label);
  const kbd = config.kbd ? h("kbd", { "aria-hidden": "true" }, config.kbd) : null;
  let glyph = icon(config.icon);
  const button = h(
    "button",
    {
      type: "button",
      class: config.primary ? "loc-hb loc-hb-primary" : "loc-hb",
      "data-action": config.action,
      "aria-label": config.aria,
    },
    kbd,
    glyph,
    label,
  );
  return {
    button,
    set(parts) {
      if (parts.label !== undefined) label.textContent = parts.label;
      if (parts.aria !== undefined) button.setAttribute("aria-label", parts.aria);
      if (parts.icon) {
        const next = icon(parts.icon);
        glyph.replaceWith(next);
        glyph = next;
      }
    },
  };
}

function pill(config: { action: string; label: string; aria: string }): HTMLButtonElement {
  return h("button", { type: "button", class: "loc-pill", "data-action": config.action, "aria-label": config.aria }, config.label);
}

export function createHud(options: HudOptions): Hud {
  const { host, t, runtime, stage } = options;
  const doc = host.ownerDocument;
  const now = options.now ?? (() => Date.now());
  const gameElement = options.game ?? null;

  // ---- state ----
  let active = true;
  let paused = false;
  let toggled = false;
  let held = false;
  let ratio = clampTurboRatio(options.turboRatio);
  let appliedTurbo: Turbo = 0;
  let slot = clampSlot(options.slot ?? 1);
  let muted = false;
  let fullscreen = false;
  let drawerOpen = false;
  /** Parts of the HUD a mouse is over. Touch never counts: a tap would leave it "hovering" for good. */
  const hovered = new Set<HTMLElement>();
  let info: HudInfo | undefined = options.info;
  let playedMs = 0;
  let since: number | null = null;
  let destroyed = false;

  function clampSlot(n: number): number {
    return Math.min(SLOT_COUNT, Math.max(1, Math.floor(n) || 1));
  }

  // ---- the toasts, the pause overlay and the flag: always there, never faded ----
  const toaster = createToaster();
  toaster.element.classList.add("loc-hud-toasts");

  const resumeButton = h("button", { type: "button", class: "loc-pause-resume" }, t["hud.resume"]);
  resumeButton.setAttribute("aria-label", `${t["hud.resume"]}, P`);
  const pauseOverlay = h(
    "div",
    { class: "loc-pause", role: "status", hidden: true },
    h("div", { class: "loc-pause-card" }, h("p", { class: "loc-pause-title" }, t.paused), resumeButton),
  );

  const turboFlag = h("span", { class: "loc-turbo-flag", "aria-hidden": "true", hidden: true });

  // ---- the top row ----
  const titleText = h("b", {}, "");
  const subText = h("small", {}, "");
  const artSlot = h("span", { class: "loc-hud-art", "aria-hidden": "true" });
  const titleChip = h("div", { class: "loc-hud-chip" }, artSlot, h("span", { class: "loc-hud-title" }, titleText, subText));

  const turboPill = pill({ action: "turbo-pill", label: "", aria: "" });
  turboPill.classList.add("loc-pill-turbo");
  turboPill.hidden = true;
  const screenPill = pill({ action: "screen-pill", label: "", aria: "" });
  screenPill.classList.add("loc-pill-screen");
  screenPill.setAttribute("aria-haspopup", "menu");
  screenPill.setAttribute("aria-expanded", "false");
  const crtPill = pill({ action: "crt", label: "CRT", aria: t["screen.crt"] });
  crtPill.setAttribute("aria-pressed", "false");
  const exitPill = h(
    "button",
    { type: "button", class: "loc-pill loc-pill-exit", "data-action": "exit-fullscreen", "aria-label": `${t.exitFullscreen}, Esc`, hidden: true },
    t["hud.exit"],
    " ",
    h("kbd", { "aria-hidden": "true" }, "Esc"),
  );

  // the share control lives with the other chips of the top row, never over the bar: it was drawn on top of it once
  const sharePill = pill({ action: "share", label: t.share, aria: t.share });
  sharePill.classList.add("loc-pill-share");
  sharePill.setAttribute("aria-pressed", "false");
  sharePill.hidden = true;
  const top = h("div", { class: "loc-hud-top" }, titleChip, h("span", { class: "loc-hud-spacer" }), turboPill, sharePill, screenPill, crtPill, exitPill);

  // ---- the bar ----
  const pauseBtn = barButton({ action: "pause", icon: "pause", label: t["hud.pause"], aria: `${t["hud.pause"]}, P`, kbd: "P" });
  const saveBtn = barButton({ action: "save", icon: "save", label: t["hud.save"], aria: "", kbd: "F2", primary: true });
  const slotText = h("span", { class: "loc-slot-text", "aria-live": "polite" }, "");
  const slotPrev = h("button", { type: "button", class: "loc-slot-step", "data-action": "slot-prev" }, "‹");
  const slotNext = h("button", { type: "button", class: "loc-slot-step", "data-action": "slot-next" }, "›");
  const slotPick = h("div", { class: "loc-slotpick", role: "group", "aria-label": t["hud.slotCurrent"] }, slotPrev, slotText, slotNext);
  const loadBtn = barButton({ action: "load", icon: "load", label: t["hud.load"], aria: "", kbd: "F4" });
  const savesBtn = barButton({ action: "saves", icon: "saves", label: t["hud.saves"], aria: `${t["hud.savesAria"]}, F6`, kbd: "F6" });
  const turboBtn = barButton({ action: "turbo", icon: "turbo", label: t["hud.turbo"], aria: t["hud.turboAria"], kbd: "␣" });
  turboBtn.button.setAttribute("aria-pressed", "false");
  turboBtn.button.setAttribute("aria-haspopup", "dialog");
  turboBtn.button.setAttribute("aria-expanded", "false");
  // the little chevron beside Turbo: the visible way to the speed popover (a long press and the context menu are the others)
  const turboCaret = h("button", {
    type: "button",
    class: "loc-hb-caret",
    "data-action": "turbo-caret",
    "aria-label": t["hud.turboCaret"],
    "aria-haspopup": "dialog",
    "aria-expanded": "false",
  });
  turboCaret.append(icon("caret"));
  const turboSplit = h("span", { class: "loc-hb-split" }, turboBtn.button, turboCaret);
  // on the short bar there is no room for the chevron: the speed lives in "Mais", which opens the same popover
  const speedBtn = barButton({
    action: "turbo-speed",
    icon: "turbo",
    label: t["hud.turboMenu"],
    aria: t["hud.turboCaret"],
    kbd: `${formatRatio(ratio, options.locale)}x`,
  });
  speedBtn.button.setAttribute("aria-haspopup", "dialog");
  const screenBtn = barButton({ action: "screen", icon: "screen", label: t["hud.screen"], aria: t["hud.screen"] });
  screenBtn.button.setAttribute("aria-haspopup", "menu");
  screenBtn.button.setAttribute("aria-expanded", "false");
  const controlsBtn = barButton({ action: "controls", icon: "controls", label: t["hud.controls"], aria: `${t["hud.controls"]}, F1`, kbd: "F1" });
  const soundBtn = barButton({ action: "sound", icon: "sound", label: t["hud.sound"], aria: `${t["hud.mute"]}, M`, kbd: "M" });
  const fullBtn = barButton({ action: "fullscreen", icon: "full", label: t["hud.full"], aria: t["hud.fullAria"], kbd: "F" });
  // the one place that says a double click on the picture is full screen too: the hover text and the spoken name
  fullBtn.button.title = t["hud.fullAria"];
  const ejectBtn = barButton({ action: "eject", icon: "eject", label: t["hud.eject"], aria: `${t["hud.ejectAria"]}, F8`, kbd: "F8" });

  // the overflow menu: a disclosure (a button that shows a group of buttons), not a role=menu, because what is in it
  // are the bar's own buttons, which keep being buttons
  const moreBtn = barButton({ action: "more", icon: "more", label: t["hud.more"], aria: t["hud.moreAria"] });
  moreBtn.button.setAttribute("aria-expanded", "false");
  moreBtn.button.setAttribute("aria-controls", "loc-hud-more");
  const moreMenu = h("div", { class: "loc-more-menu", id: "loc-hud-more", role: "group", "aria-label": t["hud.moreAria"], hidden: true });
  const moreWrap = h("div", { class: "loc-hb-more", hidden: true }, moreBtn.button, moreMenu);

  const sep = () => h("span", { class: "loc-hud-sep", "aria-hidden": "true" });
  /** The buttons that go into the overflow menu when the bar is short on room. */
  const secondary: HTMLElement[] = [slotPick, savesBtn.button, speedBtn.button, screenBtn.button, controlsBtn.button, soundBtn.button, fullBtn.button];
  const wideBar = [
    pauseBtn.button,
    sep(),
    saveBtn.button,
    slotPick,
    loadBtn.button,
    savesBtn.button,
    sep(),
    turboSplit,
    screenBtn.button,
    controlsBtn.button,
    soundBtn.button,
    fullBtn.button,
    sep(),
    ejectBtn.button,
  ];
  const compactBar = [pauseBtn.button, saveBtn.button, loadBtn.button, turboBtn.button, moreWrap, ejectBtn.button];
  const bar = h("nav", { class: "loc-hud-bar", "aria-label": t["hud.barLabel"] }, ...wideBar, moreWrap);

  // ---- the screen menu (L1) and the turbo ratio menu ----
  const screenMenu = createScreenMenu({
    t,
    ...screenState(),
    onChange: (change: ScreenMenuChange) => {
      stage.update(change satisfies Partial<StageSettings>);
      syncStage();
    },
    onClose: () => {
      syncMenuFlags();
      wake();
    },
  });

  // the turbo popover: a live readout, a slider from 1x to 10x in half steps, the quick picks, and a note about the sound
  const initialModel = turboPopoverModel(ratio, t, options.locale);
  const turboReadout = h("output", { class: "loc-turbo-readout", "aria-hidden": "true" }, initialModel.readout);
  const turboSlider = h("input", {
    type: "range",
    class: "loc-turbo-slider",
    min: 1,
    max: 10,
    step: 0.5,
    value: ratio,
    "aria-label": t["hud.turboSlider"],
    "data-action": "turbo-slider",
  });
  const turboChips = initialModel.presets.map((preset) => {
    const chip = h("button", { type: "button", class: "loc-turbo-chip", "data-ratio": preset.ratio, "aria-pressed": "false" }, preset.label);
    chip.addEventListener("click", () => setTurboRatio(preset.ratio));
    return chip;
  });
  const turboNote = h(
    "p",
    { class: "loc-turbo-note", "data-on": "false", "aria-hidden": "true" },
    icon("muted"),
    h("span", {}, fill(t["hud.turboMute"], { n: 3 })),
  );
  const turboMenu = h(
    "div",
    { class: "loc-menu loc-turbo-menu", role: "dialog", "aria-label": t["hud.turboMenu"], hidden: true },
    h("div", { class: "loc-turbo-head" }, h("span", { class: "loc-turbo-title" }, t["hud.turbo"]), turboReadout),
    turboSlider,
    h("div", { class: "loc-turbo-scale", "aria-hidden": "true" }, h("span", {}, initialModel.minLabel), h("span", {}, initialModel.maxLabel)),
    h("div", { class: "loc-turbo-chips", role: "group", "aria-label": t["hud.turboPresets"] }, ...turboChips),
    turboNote,
  );
  let turboMenuOpen = false;
  /** The button or chevron that opened the popover, so closing it puts the focus back where it came from. */
  let turboOpener: HTMLElement = turboBtn.button;

  const root = h("div", { class: "loc-hud", "data-hud": "visible" }, top, screenMenu.element, turboMenu, bar);

  host.classList.add("loc-hud-host");
  host.dataset.hud = "visible";
  host.append(turboFlag, pauseOverlay, root, toaster.element);

  // ---- menus that open over the bar sit at the button that opened them ----
  /**
   * Places `menu` (already shown, so it has a size) at `anchor`: above it for a button on the bar, below it for a
   * pill in the top row, centred on it and kept inside the stage. The old fixed corner put a menu opened from the
   * bar at the far top right.
   */
  function anchorMenu(menu: HTMLElement, anchor: HTMLElement, where: "above" | "below") {
    const room = root.getBoundingClientRect();
    const at = anchor.getBoundingClientRect();
    const width = menu.offsetWidth || 0;
    const left = Math.max(8, Math.min(at.left - room.left + at.width / 2 - width / 2, Math.max(8, room.width - width - 8)));
    menu.style.left = `${left}px`;
    menu.style.right = "auto";
    menu.style.marginInline = "0";
    if (where === "above") {
      const bottom = room.bottom - at.top + 10;
      menu.style.top = "auto";
      menu.style.bottom = `${bottom}px`;
      menu.style.maxHeight = `${Math.max(120, room.height - bottom - 8)}px`;
    } else {
      const topPx = at.bottom - room.top + 8;
      menu.style.bottom = "auto";
      menu.style.top = `${topPx}px`;
      menu.style.maxHeight = `${Math.max(120, room.height - topPx - 8)}px`;
    }
  }

  // ---- the bar's two shapes: the whole bar, or five buttons and "Mais" (SPEC 13) ----
  let compact = false;
  let moreOpen = false;
  /** How wide the whole bar wanted to be the last time it was measured, to know when it fits again. */
  let wideNeeded = 0;

  function closeMore(refocus: boolean) {
    if (!moreOpen) return;
    moreOpen = false;
    moreMenu.hidden = true;
    moreBtn.button.setAttribute("aria-expanded", "false");
    doc.removeEventListener("pointerdown", outsideMore, true);
    if (refocus) moreBtn.button.focus();
    wake();
  }

  function openMore() {
    if (moreOpen) return;
    screenMenu.close();
    closeTurboMenu(false);
    moreOpen = true;
    moreMenu.hidden = false;
    moreBtn.button.setAttribute("aria-expanded", "true");
    doc.addEventListener("pointerdown", outsideMore, true);
    fitMore();
    const first = moreMenu.querySelector<HTMLElement>("button:not([hidden])");
    first?.focus();
    wake();
  }

  /** The menu hangs from the "Mais" button's right edge; on a very narrow stage that would be past the left edge, so it slides back in. */
  function fitMore() {
    moreMenu.style.right = "";
    const room = host.getBoundingClientRect();
    const at = moreMenu.getBoundingClientRect();
    if (at.width === 0) return;
    const shift = room.left + 8 - at.left;
    if (shift > 0) moreMenu.style.right = `${-6 - shift}px`;
  }

  function outsideMore(event: Event) {
    if (event.target instanceof Node && !moreWrap.contains(event.target)) closeMore(false);
  }

  function setCompact(next: boolean) {
    if (next === compact) return;
    const focused = doc.activeElement as HTMLElement | null;
    const hadFocus = !!focused && root.contains(focused);
    closeMore(false);
    // the popover hangs from a button that is about to change place
    closeTurboMenu(false);
    compact = next;
    if (compact) {
      bar.replaceChildren(...compactBar);
      moreMenu.replaceChildren(...secondary);
    } else {
      moreMenu.replaceChildren();
      // Turbo goes back beside its chevron
      turboSplit.prepend(turboBtn.button);
      bar.replaceChildren(...wideBar, moreWrap);
    }
    moreWrap.hidden = !compact;
    bar.dataset.compact = String(compact);
    // moving a node blurs it: a focused button that went into the menu leaves the focus on "Mais"
    if (hadFocus && focused) {
      if (!focused.isConnected || focused.closest("[hidden]")) moreBtn.button.focus();
      else focused.focus();
    }
  }

  /** Whole bar when it fits, the short one when it would scroll. Unmeasured (not laid out) leaves it as it is. */
  function syncBarLayout() {
    if (destroyed) return;
    const width = host.clientWidth;
    if (width === 0) return;
    if (compact && wideNeeded > 0 && width >= wideNeeded + BAR_MARGIN) setCompact(false);
    if (!compact) {
      const needed = bar.scrollWidth;
      if (needed > 0) wideNeeded = needed;
      if (needed > width - BAR_MARGIN) setCompact(true);
    }
  }

  // ---- rendering ----
  function updateInfo() {
    titleText.textContent = info?.title ?? "";
    const time = fill(t["hud.played"], { time: formatPlayTime(playSeconds()) });
    subText.textContent = info?.console ? `${info.console} · ${time}` : time;
    artSlot.replaceChildren(...(info?.art ? [info.art] : []));
    artSlot.hidden = !info?.art;
    titleChip.hidden = !info;
  }

  function playSeconds(): number {
    return (playedMs + (since === null ? 0 : now() - since)) / 1000;
  }

  function syncClock() {
    const running = active && !paused && !destroyed;
    if (running && since === null) since = now();
    if (!running && since !== null) {
      playedMs += now() - since;
      since = null;
    }
  }

  /** 0 when off, else the speed. At 1x a switched-on turbo still runs nothing: there is nothing to run. */
  function effectiveTurbo(): Turbo {
    return (toggled || held) && !isIdleRatio(ratio) ? ratio : 0;
  }

  function renderTurbo() {
    const turbo = effectiveTurbo();
    const on = turbo !== 0;
    const model = turboPopoverModel(ratio, t, options.locale);
    turboBtn.button.setAttribute("aria-pressed", String(on));
    // at 1x the button says it would do nothing, instead of looking like a turbo that is simply not on
    turboBtn.button.setAttribute("aria-label", model.idle ? t["hud.turboAria1x"] : t["hud.turboAria"]);
    turboBtn.button.dataset.idle = String(model.idle);
    turboPill.hidden = !on;
    turboFlag.hidden = !on;
    // the pill is hidden while off, but it never has an empty name
    const pillText = fill(t["hud.turboPill"], { n: formatRatio(ratio, options.locale) });
    turboPill.textContent = `▸▸ ${pillText}`;
    turboPill.setAttribute("aria-label", `${pillText}, T`);
    turboFlag.textContent = `▸▸ ${model.readout}`;
    // the popover, and the short bar's way to it
    const speedKbd = speedBtn.button.querySelector("kbd");
    if (speedKbd) speedKbd.textContent = model.readout;
    turboReadout.textContent = model.readout;
    if (Number(turboSlider.value) !== model.ratio) turboSlider.value = String(model.ratio);
    turboSlider.setAttribute("aria-valuetext", model.valueText);
    turboSlider.style.setProperty("--loc-turbo-fill", `${model.percent}%`);
    for (const chip of turboChips) chip.setAttribute("aria-pressed", String(Number(chip.dataset.ratio) === model.ratio));
    turboNote.dataset.on = String(model.silent);
    turboNote.setAttribute("aria-hidden", String(!model.silent));
    turboMenu.dataset.idle = String(model.idle);
  }

  function applyTurbo() {
    const turbo = effectiveTurbo();
    renderTurbo();
    if (turbo === appliedTurbo) return;
    appliedTurbo = turbo;
    runtime.setTurbo(turbo);
    options.onTurboChange?.(turbo);
  }

  /** Turbo was asked for at 1x: nothing runs, and the person is told why, with a way to the slider. */
  function notifyIdleTurbo() {
    toaster.show({ text: t["toast.turbo1x"], action: { label: t["toast.turbo1xAction"], run: () => openTurboMenu(turboBtn.button) } });
  }

  function renderSlot() {
    slotText.textContent = fill(t["hud.slot"], { n: slot });
    saveBtn.set({ aria: `${fill(t["hud.saveSlot"], { n: slot })}, F2` });
    loadBtn.set({ aria: `${fill(t["hud.loadSlot"], { n: slot })}, F4` });
    slotPrev.setAttribute("aria-label", `${t["hud.slotPrev"]}, Shift+F3`);
    slotNext.setAttribute("aria-label", `${t["hud.slotNext"]}, F3`);
  }

  function renderPaused() {
    pauseBtn.set(
      paused
        ? { label: t["hud.resume"], aria: `${t["hud.resume"]}, P`, icon: "play" }
        : { label: t["hud.pause"], aria: `${t["hud.pause"]}, P`, icon: "pause" },
    );
    pauseOverlay.hidden = !paused;
    host.dataset.paused = String(paused);
  }

  function renderSound() {
    soundBtn.set({ aria: `${muted ? t["hud.unmute"] : t["hud.mute"]}, M`, icon: muted ? "muted" : "sound" });
  }

  function renderFullscreen() {
    fullBtn.set({
      label: fullscreen ? t.exitFullscreen : t["hud.full"],
      aria: fullscreen ? `${t.exitFullscreen}, F` : t["hud.fullAria"],
      icon: fullscreen ? "exitFull" : "full",
    });
    fullBtn.button.title = fullscreen ? `${t.exitFullscreen}, F` : t["hud.fullAria"];
    exitPill.hidden = !fullscreen;
    host.dataset.fs = String(fullscreen);
    // "Tela cheia" and "Sair da tela cheia" are not the same width
    syncBarLayout();
  }

  // ---- the stage ----
  function screenState(): ScreenMenuState {
    const settings = stage.settings;
    const layout = stage.layout;
    return {
      scale: layout?.scaleMode ?? settings.scale ?? (fullscreen ? "pixel" : "fit"),
      aspect: settings.aspect,
      crt: settings.crt,
      ambient: settings.ambient,
      bezel: settings.bezel,
      intScale: layout ? layout.integerScale : null,
      locale: options.locale,
      tvAvailable: layout ? hasTvAspect(layout.system) : true,
    };
  }

  function syncStage() {
    if (destroyed) return;
    screenMenu.update(screenState());
    const layout = stage.layout;
    const applied = layout?.applied ?? screenState().scale;
    const name = applied === "pixel" ? t["screen.pixel"] : t["screen.fit"];
    let text = name;
    if (layout && layout.cssScale > 0) {
      // pixel perfect says the whole number of DEVICE pixels per game pixel (the real factor, 7x on a 2x screen);
      // fit says what it came to in CSS pixels, with the language's own decimal mark
      const k = applied === "pixel" ? formatFactor(layout.scale, options.locale, 0) : formatFactor(layout.cssScale, options.locale, 1);
      text = `${name} · ${k}x`;
    }
    screenPill.textContent = text;
    screenPill.setAttribute("aria-label", `${t["hud.screen"]}: ${text}`);
    const crt = stage.settings.crt;
    crtPill.setAttribute("aria-pressed", String(crt));
  }

  function syncMenuFlags() {
    const open = screenMenu.isOpen;
    for (const node of [screenPill, screenBtn.button]) node.setAttribute("aria-expanded", String(open));
    for (const node of [turboBtn.button, turboCaret]) node.setAttribute("aria-expanded", String(turboMenuOpen));
  }

  // ---- fading ----
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function focusInside(): boolean {
    const focused = doc.activeElement;
    // a focused element that has since been hidden (a closed menu) holds nothing
    if (!focused || focused.closest("[hidden]")) return false;
    return (root.contains(focused) || toaster.element.contains(focused) || pauseOverlay.contains(focused));
  }

  /** Something that keeps the HUD up whatever the clock says. */
  function holds(): boolean {
    return focusInside() || [...hovered].some((node) => !node.hidden) || screenMenu.isOpen || turboMenuOpen || moreOpen || drawerOpen || paused;
  }

  function setVisible(visible: boolean) {
    const value = visible ? "visible" : "hidden";
    root.dataset.hud = value;
    host.dataset.hud = value;
  }

  /**
   * The clock is "2.5 s since the last activity or the last moment something held the HUD up".
   * Releases wake it explicitly (focus out, a menu closing, the drawer), and the poll while
   * held is the net under the ones nobody thought of, so the HUD can never stay up for good.
   */
  let quietSince = Date.now();

  function fade() {
    idleTimer = undefined;
    if (destroyed || !active) return;
    const at = Date.now();
    if (holds()) {
      quietSince = at;
      idleTimer = setTimeout(fade, HOLD_POLL_MS);
      return;
    }
    const wait = quietSince + IDLE_MS - at;
    if (wait > 0) {
      idleTimer = setTimeout(fade, wait);
      return;
    }
    setVisible(false);
  }

  function wake() {
    if (destroyed || !active) return;
    quietSince = Date.now();
    setVisible(true);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(fade, IDLE_MS);
  }

  // ---- actions ----
  function setPaused(next: boolean) {
    if (next === paused) return;
    paused = next;
    runtime.pause(paused);
    syncClock();
    renderPaused();
    updateInfo();
    options.onPausedChange?.(paused);
    wake();
  }

  function setTurboRatio(next: number) {
    const snapped = clampTurboRatio(next);
    if (snapped === ratio) return;
    ratio = snapped;
    // applied live when turbo is on: the runtime goes off, then the new ratio, then on, so speeds never stack
    applyTurbo();
    options.onTurboRatioChange?.(ratio);
    wake();
  }

  function toggleTurbo() {
    if (!toggled && isIdleRatio(ratio)) {
      notifyIdleTurbo();
      return;
    }
    toggled = !toggled;
    applyTurbo();
  }

  function setSlot(next: number) {
    const clamped = clampSlot(next);
    if (clamped === slot) return;
    slot = clamped;
    renderSlot();
    options.onSlotChange?.(slot);
  }

  function ask(action: HudAction) {
    options.onAction(action, slot);
  }

  function openTurboMenu(opener: HTMLElement = turboBtn.button) {
    turboOpener = opener;
    if (turboMenuOpen) {
      anchorMenu(turboMenu, turboOpener, "above");
      return;
    }
    screenMenu.close();
    closeMore(false);
    turboMenuOpen = true;
    turboMenu.hidden = false;
    anchorMenu(turboMenu, turboOpener, "above");
    syncMenuFlags();
    renderTurbo();
    turboSlider.focus({ preventScroll: true });
    doc.addEventListener("pointerdown", outsideTurbo, true);
    doc.addEventListener("keydown", escapeTurbo, true);
    wake();
  }

  function closeTurboMenu(refocus: boolean) {
    if (!turboMenuOpen) return;
    turboMenuOpen = false;
    turboMenu.hidden = true;
    doc.removeEventListener("pointerdown", outsideTurbo, true);
    doc.removeEventListener("keydown", escapeTurbo, true);
    // a switched-on turbo at 1x is nothing: leaving it armed would start the next speed change running by itself
    if (isIdleRatio(ratio) && toggled) {
      toggled = false;
      applyTurbo();
    }
    syncMenuFlags();
    if (refocus) turboOpener.focus();
    wake();
  }

  function toggleTurboMenu(opener: HTMLElement) {
    if (turboMenuOpen && turboOpener === opener) closeTurboMenu(false);
    else openTurboMenu(opener);
  }

  /** What Tab can reach inside the popover, in order: the slider, then the quick picks. */
  function turboFocusables(): HTMLElement[] {
    return [turboSlider, ...turboChips];
  }

  /** Escape with the focus elsewhere (a click on Turbo leaves it on the page) still puts the popover away; inside it, the popover's own handler gives the focus back. */
  function escapeTurbo(event: KeyboardEvent) {
    if (event.key !== "Escape" || (event.target instanceof Node && turboMenu.contains(event.target))) return;
    closeTurboMenu(false);
  }

  function outsideTurbo(event: Event) {
    const target = event.target;
    if (target instanceof Node && !turboMenu.contains(target) && !turboBtn.button.contains(target) && !turboCaret.contains(target)) closeTurboMenu(false);
  }

  /** Where the screen menu was last opened from, so a resize keeps it there. */
  let screenOpener: { node: HTMLElement; where: "above" | "below" } | null = null;

  /** `from` is the button or pill that was pressed; one inside the overflow menu hands over to "Mais", which stays visible. */
  function toggleScreenMenu(from: HTMLElement, where: "above" | "below") {
    const inMore = moreMenu.contains(from);
    if (inMore) closeMore(true);
    closeTurboMenu(false);
    syncStage();
    screenMenu.toggle();
    if (screenMenu.isOpen) {
      screenOpener = { node: inMore ? moreBtn.button : from, where: inMore ? "above" : where };
      anchorMenu(screenMenu.element, screenOpener.node, screenOpener.where);
    } else {
      screenOpener = null;
    }
    syncMenuFlags();
    wake();
  }

  function handleShortcut(shortcut: Shortcut) {
    if (shortcut.action === "turbo-hold") {
      held = shortcut.phase === "down";
      if (held && isIdleRatio(ratio)) notifyIdleTurbo();
      applyTurbo();
      return;
    }
    wake();
    switch (shortcut.action) {
      case "pause":
        setPaused(!paused);
        break;
      case "save":
        ask("save");
        break;
      case "slot-next":
        setSlot(stepSlot(slot, 1));
        break;
      case "slot-prev":
        setSlot(stepSlot(slot, -1));
        break;
      case "load":
        ask("load");
        break;
      case "saves":
        ask("saves");
        break;
      case "turbo-toggle":
        toggleTurbo();
        break;
      case "controls":
        ask("controls");
        break;
      case "sound":
        ask("sound");
        break;
      case "fullscreen":
        ask("fullscreen");
        break;
      case "eject":
        ask("eject");
        break;
      default:
    }
  }

  // ---- wiring: the buttons ----
  /** A mouse or touch click leaves the button focused, which would eat the next Space; a keyboard click (detail 0) keeps it. */
  function onPress(button: HTMLElement, run: () => void) {
    button.addEventListener("click", (event) => {
      run();
      if (event.detail > 0 && doc.activeElement === button) button.blur();
    });
  }

  onPress(pauseBtn.button, () => setPaused(!paused));
  onPress(resumeButton, () => setPaused(false));
  onPress(saveBtn.button, () => ask("save"));
  onPress(loadBtn.button, () => ask("load"));
  onPress(savesBtn.button, () => ask("saves"));
  onPress(controlsBtn.button, () => ask("controls"));
  onPress(soundBtn.button, () => ask("sound"));
  onPress(fullBtn.button, () => ask("fullscreen"));
  onPress(exitPill, () => ask("fullscreen"));
  onPress(sharePill, () => {
    if (sharePill.getAttribute("aria-disabled") !== "true") ask("share");
  });
  onPress(ejectBtn.button, () => ask("eject"));
  onPress(slotPrev, () => setSlot(stepSlot(slot, -1)));
  onPress(slotNext, () => setSlot(stepSlot(slot, 1)));
  onPress(screenBtn.button, () => toggleScreenMenu(screenBtn.button, "above"));
  onPress(screenPill, () => toggleScreenMenu(screenPill, "below"));
  onPress(crtPill, () => {
    stage.update({ crt: !stage.settings.crt });
    syncStage();
  });
  onPress(turboPill, toggleTurbo);
  // inside "Mais": the overflow menu hands over to the popover, which hangs from "Mais" (still on screen) and gives the focus back to it
  onPress(speedBtn.button, () => {
    closeMore(false);
    openTurboMenu(moreBtn.button);
  });

  moreBtn.button.addEventListener("click", () => (moreOpen ? closeMore(false) : openMore()));
  moreBtn.button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp" && !moreOpen) {
      event.preventDefault();
      openMore();
    }
  });
  moreWrap.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && moreOpen) {
      // the page's own Escape (leave full screen) must not also run
      event.preventDefault();
      event.stopPropagation();
      closeMore(true);
    }
  });
  moreWrap.addEventListener("focusout", (event) => {
    const next = (event as FocusEvent).relatedTarget;
    if (moreOpen && next instanceof Node && !moreWrap.contains(next)) closeMore(false);
  });
  // a press on one of the menu's buttons runs it and puts the menu away, but the slot steps stay for another press
  moreMenu.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("button") : null;
    if (!target || target.classList.contains("loc-slot-step") || target.dataset.action === "screen" || target.dataset.action === "turbo-speed") return;
    // the toggles (sound, full screen) leave the focus where it was; the rest open something that takes it
    closeMore(target.dataset.action === "sound" || target.dataset.action === "fullscreen");
  });

  // Turbo: a click toggles, a long press (or the context menu, or an arrow key) picks the ratio.
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let longPressed = false;
  const endPress = () => {
    clearTimeout(pressTimer);
    pressTimer = undefined;
  };
  turboBtn.button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    longPressed = false;
    endPress();
    pressTimer = setTimeout(() => {
      pressTimer = undefined;
      longPressed = true;
      openTurboMenu(turboBtn.button);
    }, LONG_PRESS_MS);
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) turboBtn.button.addEventListener(type, endPress);
  turboBtn.button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openTurboMenu(turboBtn.button);
  });
  turboCaret.addEventListener("click", (event) => {
    toggleTurboMenu(turboCaret);
    // a pointer click that closed the popover leaves the chevron focused, which would eat the next Space
    if (event.detail > 0 && !turboMenuOpen && doc.activeElement === turboCaret) turboCaret.blur();
  });
  turboCaret.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp" && !turboMenuOpen) {
      event.preventDefault();
      openTurboMenu(turboCaret);
    }
  });
  turboBtn.button.addEventListener("click", (event) => {
    if (longPressed) {
      // the press that opened the menu is not also a toggle
      longPressed = false;
      return;
    }
    toggleTurbo();
    if (event.detail > 0 && doc.activeElement === turboBtn.button) turboBtn.button.blur();
  });
  turboBtn.button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ContextMenu") {
      event.preventDefault();
      openTurboMenu(turboBtn.button);
    }
  });
  // the slider: the browser's own arrows are taken over so every browser steps the same way (and the game never sees them)
  turboSlider.addEventListener("input", () => setTurboRatio(Number(turboSlider.value)));
  turboSlider.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const next = ratioForKey(ratio, event.key);
    if (next === null) return;
    event.preventDefault();
    setTurboRatio(next);
  });
  turboMenu.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "Escape":
        // the page's own Escape (leave full screen) must not also run
        event.preventDefault();
        event.stopPropagation();
        closeTurboMenu(true);
        break;
      case "Tab": {
        // inside the popover the browser's order is right; past either end the popover goes away and the keyboard with it
        const order = turboFocusables();
        const at = order.indexOf(doc.activeElement as HTMLElement);
        if ((event.shiftKey && at <= 0) || (!event.shiftKey && at === order.length - 1)) {
          event.preventDefault();
          event.stopPropagation();
          closeTurboMenu(true);
        }
        break;
      }
      default:
    }
  });

  // ---- wiring: when the HUD shows ----
  const hoverable = [top, bar, screenMenu.element, turboMenu] as const;
  for (const node of hoverable) {
    node.addEventListener("pointerenter", (event) => {
      if ((event as PointerEvent).pointerType !== "touch") hovered.add(node);
      wake();
    });
    node.addEventListener("pointerleave", () => {
      hovered.delete(node);
      wake();
    });
  }
  /**
   * A double click on the picture (or the black around it) is full screen, both ways: the same request as the
   * button and F. One on a control of the HUD, a menu, the pause card or a toast belongs to that control.
   */
  const CONTROL_SELECTOR =
    "button, a, input, select, textarea, label, [role='menu'], [role='menuitem'], [role='dialog'], .loc-menu, .loc-pause, .loc-hud-toasts, .loc-hud-chip";
  function isControlTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    const control = target.closest(CONTROL_SELECTOR);
    return control !== null && host.contains(control);
  }
  const onDoubleClick = (event: MouseEvent) => {
    if (!active || destroyed || event.button !== 0 || isControlTarget(event.target)) return;
    event.preventDefault();
    ask("fullscreen");
  };
  host.addEventListener("dblclick", onDoubleClick);
  // the second press of a double click would select the words of the HUD next to it
  const onMouseDown = (event: MouseEvent) => {
    if (event.detail > 1 && !isControlTarget(event.target)) event.preventDefault();
  };
  host.addEventListener("mousedown", onMouseDown);

  /**
   * The pointer is over what it moves on. A press of Tela cheia moves the bar out from under the pointer and the
   * browser never says `pointerleave` (the frame changed size under it), so the bar stayed "hovered" and the HUD
   * never faded in full screen. Every move says again what the pointer is over.
   */
  const onActivity = (event: Event) => {
    if (event.type === "pointermove" && (event as PointerEvent).pointerType !== "touch") {
      const under = event.target instanceof Node ? event.target : null;
      for (const node of hoverable) {
        if (under && node.contains(under)) hovered.add(node);
        else hovered.delete(node);
      }
    }
    wake();
  };
  const activityEvents = ["pointermove", "pointerdown", "touchstart"] as const;
  for (const type of activityEvents) host.addEventListener(type, onActivity, { passive: true });
  root.addEventListener("focusin", onActivity);
  root.addEventListener("focusout", onActivity);
  /** What Tab can land on inside the HUD, in tab order (a closed menu's items are `hidden`, the ratio items sit at -1). */
  function focusables(): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>("button")].filter(
      (node) => !node.closest("[hidden]") && !(node as HTMLButtonElement).disabled && node.tabIndex >= 0,
    );
  }

  /** Where Tab leaves the game: on the first button of the bar, or on the last one with Shift. */
  function enterFromGame(backwards: boolean) {
    const buttons = focusables().filter((node) => bar.contains(node));
    const target = backwards ? buttons[buttons.length - 1] : buttons[0];
    wake();
    target?.focus({ preventScroll: true });
  }

  /** Is this key press headed for the game (or the page behind it), as opposed to a control that has focus? */
  function fromGame(target: EventTarget | null): boolean {
    if (!(target instanceof Node)) return true;
    if (target === doc.body || target === doc.documentElement || target === host) return true;
    return gameElement !== null && gameElement.contains(target);
  }

  const onTab = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || !active || destroyed || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTextTarget(event.target)) return;
    const target = event.target as Node | null;
    if (root.contains(target)) {
      // inside the HUD the browser's own order is right; the two ends hand the keyboard back to the game
      const order = focusables();
      const at = order.indexOf(doc.activeElement as HTMLElement);
      const leaving = (event.shiftKey && at === 0) || (!event.shiftKey && at === order.length - 1);
      if (leaving && order.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        returnToGame();
      } else {
        wake();
      }
      return;
    }
    if (!fromGame(event.target)) return;
    // EmulatorJS takes every key for the game, Tab included, and cancels it: so Tab is taken here first and walked in
    event.preventDefault();
    event.stopPropagation();
    enterFromGame(event.shiftKey);
  };
  doc.addEventListener("keydown", onTab, true);

  /** Escape inside the HUD (not one a menu already took) puts the keyboard back on the game. */
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !active) return;
    event.preventDefault();
    event.stopPropagation();
    returnToGame();
  });

  function returnToGame() {
    // blur first: a faded HUD must not keep a hold on the focus it has just given up
    if (doc.activeElement instanceof HTMLElement && root.contains(doc.activeElement)) doc.activeElement.blur();
    options.focusGame?.();
    wake();
  }

  stage.onChange(() => syncStage());
  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          syncBarLayout();
          syncStage();
          // a menu that is open follows its button when the room changes shape
          if (screenOpener && screenMenu.isOpen) anchorMenu(screenMenu.element, screenOpener.node, screenOpener.where);
          if (turboMenuOpen) anchorMenu(turboMenu, turboOpener, "above");
        });
  resizeObserver?.observe(host);

  const uninstallShortcuts =
    options.shortcuts === false ? () => {} : installShortcuts({ target: doc, onShortcut: handleShortcut, enabled: () => active && !destroyed, runtime });

  const clockTimer = setInterval(() => {
    if (active && !paused) updateInfo();
  }, PLAY_TIME_REFRESH_MS);

  // ---- first paint ----
  renderSlot();
  renderPaused();
  renderSound();
  renderFullscreen();
  renderTurbo();
  updateInfo();
  syncStage();
  syncClock();
  wake();

  return {
    element: root,
    get paused() {
      return paused;
    },
    get turbo() {
      return effectiveTurbo();
    },
    get turboRatio() {
      return ratio;
    },
    get slot() {
      return slot;
    },
    screenMenu,
    toaster,
    setActive(next) {
      if (next === active || destroyed) return;
      active = next;
      syncClock();
      if (active) {
        wake();
        return;
      }
      clearTimeout(idleTimer);
      held = false;
      screenMenu.close();
      closeTurboMenu(false);
      closeMore(false);
      applyTurbo();
    },
    setInfo(next) {
      info = next;
      updateInfo();
    },
    setSlot,
    setPaused,
    togglePause: () => setPaused(!paused),
    setTurboRatio,
    toggleTurbo,
    setMuted(next) {
      muted = next;
      renderSound();
    },
    setShare(share) {
      sharePill.hidden = share === null;
      if (share === null) top.removeAttribute("data-share");
      else top.setAttribute("data-share", "");
      if (share === null) return;
      sharePill.textContent = share.on ? t["hud.sharingPill"] : t.share;
      sharePill.setAttribute("aria-label", share.on ? t.shareStop : t.share);
      sharePill.setAttribute("aria-pressed", String(share.on));
      // busy keeps the focus (a disabled button would drop it) and ignores a second press while the first is asked
      if (share.busy) sharePill.setAttribute("aria-disabled", "true");
      else sharePill.removeAttribute("aria-disabled");
    },
    setFullscreen(full) {
      if (full === fullscreen) return;
      fullscreen = full;
      // the room changed under the pointer, and no `pointerleave` comes for it: the next move says what it is over
      hovered.clear();
      stage.setFullscreen(full);
      renderFullscreen();
      syncStage();
      wake();
    },
    setDrawerOpen(open) {
      drawerOpen = open;
      wake();
    },
    syncStage,
    wake,
    notifySaved(n, undo) {
      toaster.show({ text: fill(t["toast.saved"], { n }), action: undo ? { label: t["toast.undo"], run: undo } : undefined });
    },
    notifyLoaded(n) {
      toaster.show({ text: fill(t["toast.loaded"], { n }) });
    },
    toast(text, action) {
      toaster.show({ text, action });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      uninstallShortcuts();
      clearInterval(clockTimer);
      clearTimeout(idleTimer);
      endPress();
      resizeObserver?.disconnect();
      doc.removeEventListener("keydown", onTab, true);
      doc.removeEventListener("pointerdown", outsideTurbo, true);
      doc.removeEventListener("keydown", escapeTurbo, true);
      doc.removeEventListener("pointerdown", outsideMore, true);
      for (const type of activityEvents) host.removeEventListener(type, onActivity);
      host.removeEventListener("dblclick", onDoubleClick);
      host.removeEventListener("mousedown", onMouseDown);
      held = false;
      toggled = false;
      applyTurbo();
      screenMenu.destroy();
      toaster.destroy();
      for (const node of [root, pauseOverlay, turboFlag]) node.remove();
      host.classList.remove("loc-hud-host");
      delete host.dataset.hud;
      delete host.dataset.paused;
      delete host.dataset.fs;
    },
  };
}
