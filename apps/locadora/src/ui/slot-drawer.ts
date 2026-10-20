/**
 * The saves drawer (mock 3, SPEC 4.5 and 14): the battery-save line, the
 * autosave and four slots with their thumbnails, the autosave switch and the
 * way to take the saves to another device.
 *
 * Plain DOM, keyboard first: Tab walks every control in reading order, the
 * slot names also answer ArrowUp and ArrowDown, the overflow menu is a real
 * `menu` (Enter or ArrowDown opens it, Escape closes it and gives the focus
 * back), and Escape on the drawer closes it and returns the focus to whatever
 * opened it. Nothing here moves without `prefers-reduced-motion` allowing it
 * (slots.css).
 *
 * It holds no save logic: it draws the `SlotInfo[]` it is given and reports
 * what a person chose. `update()` redraws from new data and keeps the focus on
 * the same control.
 */
import type { Strings } from "../i18n";
import type { ManualSlot, SlotId, SlotInfo } from "../saves";
import { fill, h } from "./dom";

export type SlotDrawerStrings = Pick<
  Strings,
  | "saves.title"
  | "saves.close"
  | "saves.auto"
  | "saves.slot"
  | "saves.autoHint"
  | "saves.autoEmpty"
  | "saves.saveHere"
  | "saves.loadAria"
  | "saves.saveAria"
  | "saves.more"
  | "saves.delete"
  | "saves.originLocal"
  | "saves.originPhone"
  | "saves.tryAnyway"
  | "saves.autoSwitch"
  | "saves.sramAt"
  | "saves.emptyThumb"
  | "saves.usage"
  | "saves.sram"
  | "saves.empty"
  | "saves.oldCore"
  | "hud.load"
  | "export.title"
  | "sync.chip"
  | "sync.chipBusy"
  | "sync.chipError"
  | "sync.chipReadOnly"
  | "sync.chipNoStore"
  | "sync.noteUnreachable"
  | "sync.noteNoStore"
  | "sync.note"
  | "sync.noteReadOnly"
  | "sync.usage"
  | "sync.clear"
  | "sync.clearAsk"
  | "sync.clearYes"
  | "sync.clearNo"
  | "sync.from.computer"
  | "sync.from.tablet"
>;

/** Saves na conta, as the drawer shows it: only passed while `locadora_save_sync` answers for this session. */
export interface DrawerSync {
  state: "idle" | "busy" | "error";
  /** The flag went off: what is on the account can still come back, nothing new goes. */
  readOnly: boolean;
  used: number;
  cap: number;
  /**
   * The server has Saves na conta on and it is not working here: the account did not answer, or this browser keeps
   * nothing between visits. The chip and its note say so, and nothing about the account's contents is drawn.
   */
  problem?: "unreachable" | "no-store";
}

export interface SlotDrawerState {
  slots: SlotInfo[];
  /** The slot F2 writes to. */
  current: ManualSlot;
  /** When the battery save was last written, or null before the first time. */
  sramSavedAt?: number | null;
  /**
   * The game has a battery save of its own. The "kept every 30 seconds" line is only true for such a game, so it is
   * drawn only then; left out, it is drawn (a caller that does not know keeps the old behaviour).
   */
  battery?: boolean;
  autosave: boolean;
  /** The "na tua conta" chip, the line that says what goes, the account's usage and "Apagar tudo da conta". */
  sync?: DrawerSync | null;
}

export interface SlotDrawerOptions extends SlotDrawerState {
  t: SlotDrawerStrings;
  /** BCP 47, for relative times and sizes. */
  locale: string;
  now?: () => number;
  onLoad: (slot: SlotId, options: { force: boolean }) => void;
  onSave: (slot: ManualSlot) => void;
  onSelect: (slot: ManualSlot) => void;
  onDelete: (slot: SlotId) => void;
  onToggleAutosave: (on: boolean) => void;
  /** Left out until the export exists (L9): without it the footer draws no link, never a dead one. */
  onExport?: () => void;
  /** "Apagar tudo da conta", after the person confirmed it in the drawer. Resolves to whether it worked. */
  onClearAccount?: () => Promise<boolean>;
  /** Called after the drawer closes itself (Escape or its own button). */
  onClose?: () => void;
}

export interface SlotDrawer {
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  update(state: Partial<SlotDrawerState>): void;
  destroy(): void;
}

/* ---- pure helpers ---- */

/** "há 3 minutos", "agora", or a short date past a week. */
export function formatAgo(then: number, now: number, locale: string): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (seconds < 5) return rtf.format(0, "second");
  if (seconds < 60) return rtf.format(-seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 7) return rtf.format(-days, "day");
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(then);
}

export function formatBytes(bytes: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 });
  return `${number.format(value)} ${units[unit]}`;
}

/** What a slot is called to a person and to a screen reader. */
export function slotName(slot: SlotId, t: Pick<SlotDrawerStrings, "saves.auto" | "saves.slot">): string {
  return slot === "auto" ? t["saves.auto"] : fill(t["saves.slot"], { n: slot });
}

/* ---- the drawer ---- */

let drawerCount = 0;

export function createSlotDrawer(options: SlotDrawerOptions): SlotDrawer {
  const { t, locale } = options;
  const now = options.now ?? Date.now;
  let state: SlotDrawerState = {
    slots: options.slots,
    current: options.current,
    sramSavedAt: options.sramSavedAt ?? null,
    ...(options.battery !== undefined ? { battery: options.battery } : {}),
    autosave: options.autosave,
    sync: options.sync ?? null,
  };
  let isOpen = false;
  let opener: Element | null = null;
  let menuFor: SlotId | null = null;
  /** "Apagar tudo da conta" asked once: the second step is on screen. */
  let confirmingClear = false;
  let clearing = false;
  let thumbUrls: string[] = [];

  const headingId = `loc-slots-title-${++drawerCount}`;
  const root = h("aside", { class: "loc-slots-drawer", "aria-labelledby": headingId, hidden: true });

  function revokeThumbs() {
    if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      for (const url of thumbUrls) URL.revokeObjectURL(url);
    }
    thumbUrls = [];
  }

  function thumbUrl(bytes: Uint8Array): string | null {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
    thumbUrls.push(url);
    return url;
  }

  function row(info: SlotInfo): HTMLElement {
    const manual = info.slot !== "auto";
    const name = slotName(info.slot, t);
    const selected = manual && info.slot === state.current;
    const key = info.slot === "auto" ? "AUTO" : String(info.slot);

    const url = info.thumb ? thumbUrl(info.thumb) : null;
    const thumb = h(
      "div",
      { class: "loc-slot-thumb", "data-empty": info.empty || undefined },
      url ? h("img", { src: url, alt: "", width: 160, loading: "lazy", decoding: "async" }) : null,
      info.empty ? h("span", { class: "loc-slot-vazio" }, t["saves.emptyThumb"]) : null,
      info.empty ? null : h("span", { class: "loc-slot-key", "aria-hidden": "true" }, key),
    );

    const title = manual
      ? h(
          "button",
          { type: "button", class: "loc-slot-pick", "aria-pressed": String(selected), "data-focus": `pick:${info.slot}` },
          name,
        )
      : h("span", { class: "loc-slot-name" }, name);

    let detail: string;
    if (info.empty) detail = info.slot === "auto" ? t["saves.autoEmpty"] : t["saves.empty"];
    else {
      const ago = info.savedAt === null ? "" : formatAgo(info.savedAt, now(), locale);
      const where =
        info.origin === "phone"
          ? t["saves.originPhone"]
          : info.origin === "computer"
            ? t["sync.from.computer"]
            : info.origin === "tablet"
              ? t["sync.from.tablet"]
              : t["saves.originLocal"];
      detail = [ago, info.slot === "auto" ? t["saves.autoHint"] : where].filter(Boolean).join(" · ");
    }

    const actions = h("div", { class: "loc-slot-actions" });
    const mismatch = !info.empty && info.sameConsole === false;
    if (!info.empty) {
      const load = h(
        "button",
        {
          type: "button",
          class: mismatch ? "loc-mini" : "loc-mini loc-mini-go",
          "aria-label": fill(t["saves.loadAria"], { name }),
          "data-focus": `load:${info.slot}`,
        },
        mismatch ? t["saves.tryAnyway"] : t["hud.load"],
      );
      load.addEventListener("click", () => options.onLoad(info.slot, { force: mismatch }));
      actions.append(load);
    }
    if (manual) {
      const save = h(
        "button",
        { type: "button", class: "loc-mini", "aria-label": fill(t["saves.saveAria"], { name }), "data-focus": `save:${info.slot}` },
        t["saves.saveHere"],
      );
      save.addEventListener("click", () => options.onSave(info.slot as ManualSlot));
      actions.append(save);
    }
    if (!info.empty) actions.append(overflow(info.slot, name));

    const li = h(
      "li",
      { class: "loc-slot", "data-slot": String(info.slot), "data-selected": selected || undefined, "aria-current": selected ? "true" : undefined },
      thumb,
      h(
        "div",
        { class: "loc-slot-body" },
        title,
        h("small", { class: "loc-slot-detail" }, detail),
        mismatch ? h("small", { class: "loc-slot-warn", role: "note" }, t["saves.oldCore"]) : null,
        actions,
      ),
    );
    if (manual) {
      li.querySelector<HTMLButtonElement>(".loc-slot-pick")!.addEventListener("click", () => options.onSelect(info.slot as ManualSlot));
    }
    return li;
  }

  function overflow(slot: SlotId, name: string): HTMLElement {
    const opened = menuFor === slot;
    const more = h(
      "button",
      {
        type: "button",
        class: "loc-mini loc-slot-more",
        "aria-haspopup": "menu",
        "aria-expanded": String(opened),
        "aria-label": fill(t["saves.more"], { name }),
        "data-focus": `more:${slot}`,
      },
      "⋯",
    );
    more.addEventListener("click", () => toggleMenu(slot));
    more.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" && menuFor !== slot) {
        event.preventDefault();
        toggleMenu(slot);
      }
    });
    const wrap = h("div", { class: "loc-slot-menu-wrap" }, more);
    if (opened) {
      const remove = h("button", { type: "button", class: "loc-menu-delete", role: "menuitem", "data-focus": `delete:${slot}` }, t["saves.delete"]);
      remove.addEventListener("click", () => {
        menuFor = null;
        options.onDelete(slot);
      });
      wrap.append(h("div", { class: "loc-slot-menu", role: "menu", "aria-label": fill(t["saves.more"], { name }) }, remove));
    }
    return wrap;
  }

  function toggleMenu(slot: SlotId) {
    menuFor = menuFor === slot ? null : slot;
    render(menuFor ? `delete:${slot}` : `more:${slot}`);
  }

  function used(): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    for (const slot of state.slots) {
      if (slot.empty) continue;
      count += 1;
      bytes += slot.size;
    }
    return { count, bytes };
  }

  function render(focusKey?: string) {
    const active = document.activeElement;
    const keep = focusKey ?? (active instanceof HTMLElement && root.contains(active) ? active.getAttribute("data-focus") : null);
    revokeThumbs();

    const close = h("button", { type: "button", class: "loc-slots-close", "aria-label": t["saves.close"], "data-focus": "close" }, "✕");
    close.addEventListener("click", () => closeDrawer(true));

    const sram = h(
      "p",
      { class: "loc-slots-sram" },
      h("span", { class: "loc-slots-tick", "aria-hidden": "true" }, "✓"),
      h(
        "span",
        {},
        t["saves.sram"],
        state.sramSavedAt ? h("small", {}, fill(t["saves.sramAt"], { ago: formatAgo(state.sramSavedAt, now(), locale) })) : null,
      ),
    );

    const list = h("ol", { class: "loc-slots-list" });
    for (const info of state.slots) list.append(row(info));

    const switchButton = h(
      "button",
      {
        type: "button",
        class: "loc-switch",
        role: "switch",
        "aria-checked": String(state.autosave),
        "aria-label": t["saves.autoSwitch"],
        "data-focus": "autosave",
      },
      h("span", { class: "loc-switch-knob", "aria-hidden": "true" }),
    );
    switchButton.addEventListener("click", () => options.onToggleAutosave(!state.autosave));

    const exportButton = options.onExport
      ? h("button", { type: "button", class: "loc-link", "data-focus": "export" }, t["export.title"])
      : null;
    exportButton?.addEventListener("click", () => options.onExport?.());

    const { count, bytes } = used();
    const sync = state.sync ?? null;
    const chipText = !sync
      ? null
      : sync.problem
        ? sync.problem === "no-store"
          ? t["sync.chipNoStore"]
          : t["sync.chipError"]
        : sync.readOnly
        ? t["sync.chipReadOnly"]
        : sync.state === "busy"
          ? t["sync.chipBusy"]
          : sync.state === "error"
            ? t["sync.chipError"]
            : t["sync.chip"];
    root.replaceChildren(
      h(
        "div",
        { class: "loc-slots-head" },
        h("h2", { id: headingId }, t["saves.title"]),
        sync
          ? h(
              "span",
              { class: "loc-slots-chip", "data-state": sync.problem ? "error" : sync.readOnly ? "read-only" : sync.state, role: "status" },
              h("span", { class: "loc-slots-chip-dot", "aria-hidden": "true" }),
              chipText,
            )
          : null,
        close,
        // what goes to the account, said where the chip is: one short line under the title, not a box over the list
        sync
          ? h(
              "p",
              { class: "loc-slots-sync-note" },
              sync.problem
                ? sync.problem === "no-store"
                  ? t["sync.noteNoStore"]
                  : t["sync.noteUnreachable"]
                : sync.readOnly
                  ? t["sync.noteReadOnly"]
                  : t["sync.note"],
            )
          : null,
      ),
      ...(state.battery === false ? [] : [sram]),
      list,
      h(
        "div",
        { class: "loc-slots-foot" },
        h("div", { class: "loc-slots-row" }, h("span", {}, t["saves.autoSwitch"]), switchButton),
        h(
          "div",
          { class: "loc-slots-row" },
          h("span", {}, fill(t["saves.usage"], { n: count, used: formatBytes(bytes, locale) })),
          exportButton,
        ),
        ...(sync && !sync.problem ? syncRows(sync) : []),
      ),
    );

    if (keep && isOpen) {
      const again = [...root.querySelectorAll<HTMLElement>("[data-focus]")].find((node) => node.getAttribute("data-focus") === keep);
      again?.focus();
    }
  }

  /** What the account holds and the way to take it all back off; the second step asks before anything goes. */
  function syncRows(sync: DrawerSync): HTMLElement[] {
    const usage = h(
      "span",
      { class: "loc-slots-sync-usage" },
      fill(t["sync.usage"], { used: formatBytes(sync.used, locale), cap: formatBytes(sync.cap, locale) }),
    );
    if (!options.onClearAccount) return [h("div", { class: "loc-slots-row" }, usage)];
    if (!confirmingClear) {
      const ask = h("button", { type: "button", class: "loc-link loc-slots-clear", "data-focus": "sync-clear" }, t["sync.clear"]);
      ask.addEventListener("click", () => {
        confirmingClear = true;
        render("sync-clear-no");
      });
      return [h("div", { class: "loc-slots-row" }, usage, ask)];
    }
    const yes = h(
      "button",
      { type: "button", class: "loc-mini loc-mini-danger", "data-focus": "sync-clear-yes", disabled: clearing || undefined },
      t["sync.clearYes"],
    );
    const no = h("button", { type: "button", class: "loc-mini", "data-focus": "sync-clear-no" }, t["sync.clearNo"]);
    yes.addEventListener("click", () => {
      if (clearing) return;
      clearing = true;
      render("sync-clear-yes");
      void options.onClearAccount!().finally(() => {
        clearing = false;
        confirmingClear = false;
        render("sync-clear");
      });
    });
    no.addEventListener("click", () => {
      confirmingClear = false;
      render("sync-clear");
    });
    return [
      h(
        "div",
        { class: "loc-slots-confirm", role: "group", "aria-label": t["sync.clear"] },
        h("p", {}, t["sync.clearAsk"]),
        h("div", { class: "loc-slots-row" }, usage, h("span", { class: "loc-slots-confirm-actions" }, no, yes)),
      ),
    ];
  }

  function focusables(): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>("button")].filter((node) => !node.hasAttribute("disabled"));
  }

  root.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (event.key === "Escape") {
      event.preventDefault();
      // the page's own Escape (leave full screen) must not also run
      event.stopPropagation();
      if (menuFor !== null) {
        const slot = menuFor;
        menuFor = null;
        render(`more:${slot}`);
      } else {
        closeDrawer(true);
      }
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && target.classList.contains("loc-slot-pick")) {
      const picks = [...root.querySelectorAll<HTMLElement>(".loc-slot-pick")];
      const at = picks.indexOf(target);
      const next = picks[(at + (event.key === "ArrowDown" ? 1 : -1) + picks.length) % picks.length];
      event.preventDefault();
      next?.focus();
      return;
    }
    if (menuFor !== null && target.getAttribute("role") === "menuitem" && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      // one item today; the menu keeps the focus on it
      event.preventDefault();
    }
  });

  const outside = (event: Event) => {
    if (menuFor === null) return;
    if (event.target instanceof Node && !(event.target as Element).closest?.(".loc-slot-menu-wrap")) {
      menuFor = null;
      render();
    }
  };

  function openDrawer() {
    if (isOpen) return;
    isOpen = true;
    opener = document.activeElement;
    root.hidden = false;
    document.addEventListener("pointerdown", outside, true);
    render();
    const first = root.querySelector<HTMLElement>(`[data-focus="pick:${state.current}"]`) ?? focusables()[0];
    first?.focus();
  }

  function closeDrawer(notify: boolean) {
    if (!isOpen) return;
    isOpen = false;
    menuFor = null;
    confirmingClear = false;
    root.hidden = true;
    document.removeEventListener("pointerdown", outside, true);
    revokeThumbs();
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    opener = null;
    if (notify) options.onClose?.();
  }

  return {
    element: root,
    get isOpen() {
      return isOpen;
    },
    open: openDrawer,
    close: () => closeDrawer(false),
    toggle() {
      if (isOpen) closeDrawer(true);
      else openDrawer();
    },
    update(next) {
      state = { ...state, ...next };
      // closed, there is nothing to keep fresh: opening draws it
      if (isOpen) render();
    },
    destroy() {
      document.removeEventListener("pointerdown", outside, true);
      revokeThumbs();
      root.remove();
    },
  };
}
