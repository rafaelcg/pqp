/**
 * Tua prateleira (mock 1, SPEC 4.1 and 8): the boxes in rows on a plank, filter
 * chips with counts, a sort, and the Ficha of the selected box drawn at the end
 * of its row.
 *
 * It is one tab stop (roving tabindex) over a grid of boxes: arrows move, Home
 * and End go to the row's ends (with Ctrl, the shelf's), Enter plays, Space or a
 * click opens the Ficha, Delete asks to remove (the question is the Ficha's own,
 * with "Deixar aí" focused), Escape closes the Ficha. The last cell of the grid is
 * "Botar outra fita".
 *
 * Three states: `ready` with cartridges, `ready` and empty (a dashed slot, the
 * line, the primary button), and `unavailable` (the device cannot keep anything:
 * one line and the picker, the app behaves as it did before the shelf).
 *
 * The top half of the file is pure (rows, columns, focus moves, what is visible)
 * and is what the tests pin; `createShelf` is the DOM around it. Nothing here
 * touches the store: the caller reacts to `onRemove` and friends, then calls
 * `update({ items })`.
 */
import type { Strings } from "../i18n";
import {
  filterItems,
  groupCounts,
  sortItems,
  usageLevel,
  CONSOLE_GROUP_NAMES,
  type LibraryItem,
  type ShelfFilter,
  type ShelfSort,
} from "../library";
import type { StoreUsage } from "../store";
import { h } from "./dom";
import { createFicha, type Ficha, type FichaMode, type FichaStrings } from "./ficha";
import { createGameBox, type GameBoxStrings } from "./game-box";
import { icon } from "./top-bar";

/* ---- pure: geometry and focus ---- */

/**
 * The widest cartridge (NES, SNES) sets the cell; a row's gap and side padding are the CSS's (`--loc-cell`,
 * `--loc-row-gap`, `--loc-row-pad` on `.loc-rack`, which a wide pane raises), kept here as the defaults.
 */
export const CELL_WIDTH = 150;
export const ROW_GAP = 18;
export const ROW_PAD = 16;

/** How many cells fit a rack `width` px wide (never fewer than one). */
export function columnsFor(width: number, cell = CELL_WIDTH, gap = ROW_GAP, pad = ROW_PAD): number {
  const inner = width - pad * 2;
  return Math.max(1, Math.floor((inner + gap) / (cell + gap)));
}

/** The free spots drawn after the last cell of a row, to the end of the plank: scenery, never more than four. */
export function trailingSpots(cellsInLastRow: number, cols: number): number {
  return Math.max(0, Math.min(4, cols - cellsInLastRow));
}

export function chunkRows<T>(cells: readonly T[], cols: number): T[][] {
  const size = Math.max(1, Math.floor(cols));
  const rows: T[][] = [];
  for (let i = 0; i < cells.length; i += size) rows.push(cells.slice(i, i + size));
  return rows;
}

/** The index of the last cell in the row `index` is on: where the Ficha goes. */
export function rowEnd(index: number, cols: number, count: number): number {
  return Math.min(count - 1, (Math.floor(index / cols) + 1) * cols - 1);
}

export type NavKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";

export function isNavKey(key: string): key is NavKey {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown" || key === "Home" || key === "End";
}

/**
 * Where focus goes from `index` in a grid of `count` cells, `cols` wide, filled row by row.
 * No wrapping. Down from a short last row's neighbour lands on the last cell instead of nowhere.
 * Home and End are the row's ends; with `ctrl` they are the shelf's.
 */
export function moveFocus(index: number, key: NavKey, cols: number, count: number, ctrl = false): number {
  if (count <= 0) return 0;
  const i = Math.min(Math.max(index, 0), count - 1);
  const c = Math.max(1, Math.floor(cols));
  const lastRow = Math.floor((count - 1) / c);
  const row = Math.floor(i / c);
  switch (key) {
    case "ArrowLeft":
      return Math.max(0, i - 1);
    case "ArrowRight":
      return Math.min(count - 1, i + 1);
    case "ArrowUp":
      return i - c >= 0 ? i - c : i;
    case "ArrowDown":
      if (i + c < count) return i + c;
      return row < lastRow ? count - 1 : i;
    case "Home":
      return ctrl ? 0 : row * c;
    case "End":
      return ctrl ? count - 1 : Math.min(count - 1, row * c + c - 1);
  }
}

/* ---- pure: what to show ---- */

export type ShelfStorage = "ready" | "unavailable";
export type ShelfMode = "unavailable" | "empty" | "list";

export function shelfMode(storage: ShelfStorage, itemCount: number): ShelfMode {
  if (storage === "unavailable") return "unavailable";
  return itemCount === 0 ? "empty" : "list";
}

/** A filter that has no cartridge left (the last one was removed) falls back to everything. */
export function resolveFilter(items: readonly LibraryItem[], filter: ShelfFilter): ShelfFilter {
  if (filter === "all") return "all";
  return groupCounts(items).some((g) => g.group === filter) ? filter : "all";
}

export function visibleItems(items: readonly LibraryItem[], filter: ShelfFilter, sort: ShelfSort): LibraryItem[] {
  return sortItems(filterItems(items, resolveFilter(items, filter)), sort);
}

export interface ChipModel {
  id: ShelfFilter;
  label: string;
  count: number;
}

/** "Tudo" and one chip per console that has a cartridge, with counts. */
export function chipModels(items: readonly LibraryItem[], allLabel: string): ChipModel[] {
  return [
    { id: "all", label: allLabel, count: items.length },
    ...groupCounts(items).map((g) => ({ id: g.group as ShelfFilter, label: CONSOLE_GROUP_NAMES[g.group], count: g.count })),
  ];
}

/** After a removal focus goes to the next box, else the previous one, else nothing (the shelf's last cell). */
export function neighbourAfterRemoval(order: readonly string[], removed: string): string | undefined {
  const at = order.indexOf(removed);
  if (at < 0) return undefined;
  return order[at + 1] ?? order[at - 1];
}

/* ---- the DOM ---- */

export type ShelfStrings = FichaStrings &
  GameBoxStrings &
  Pick<
    Strings,
    | "shelf.title"
    | "shelf.empty"
    | "systems"
    | "shelf.noStorage"
    | "shelf.full"
    | "err.storage"
    | "shelf.filter"
    | "shelf.filter.all"
    | "shelf.sort"
    | "shelf.sort.recent"
    | "shelf.sort.name"
    | "shelf.sort.console"
    | "shelf.pickAnother"
    | "shelf.hint"
    | "top.pick"
  >;

export interface ShelfOptions {
  t: ShelfStrings;
  items: readonly LibraryItem[];
  storage: ShelfStorage;
  usage?: Pick<StoreUsage, "used" | "cap">;
  /**
   * The device just refused a cartridge for lack of room (it played, but it is not on this shelf). The line says so
   * whatever the meter reads, because a refusal is a fact and "almost full" is only a guess from the meter.
   */
  refused?: boolean;
  filter?: ShelfFilter;
  sort?: ShelfSort;
  selectedSha?: string;
  now?: () => number;
  onPlay: (item: LibraryItem) => void;
  onPick: () => void;
  onSaves: (item: LibraryItem) => void;
  /** A box with no game file ("falta a fita") was chosen: the caller opens the picker and attaches a file that matches. */
  onAttach?: (item: LibraryItem) => void;
  onRename: (item: LibraryItem, title: string) => void;
  /** Already confirmed in the Ficha; the caller deletes and then calls `update({ items })`. */
  onRemove: (item: LibraryItem) => void;
  onSelect?: (sha: string | undefined) => void;
  onFilter?: (filter: ShelfFilter) => void;
  onSort?: (sort: ShelfSort) => void;
}

export interface Shelf {
  readonly element: HTMLElement;
  update(patch: { items?: readonly LibraryItem[]; storage?: ShelfStorage; usage?: Pick<StoreUsage, "used" | "cap"> | null; refused?: boolean }): void;
  select(sha: string | undefined): void;
  /**
   * Focus a box (or, without a sha, the shelf's current stop). `preventScroll` leaves the page where it is: the shelf
   * drawn again after a game must show its top bar, not scroll down to the box that was played.
   */
  focus(sha?: string, options?: { preventScroll?: boolean }): void;
  destroy(): void;
}

const SORTS: readonly ShelfSort[] = ["recent", "name", "console"];
const GHOST = "ghost";
let shelfCount = 0;

export function createShelf(opts: ShelfOptions): Shelf {
  const { t } = opts;
  const uid = ++shelfCount;
  const now = opts.now ?? Date.now;

  let items = [...opts.items];
  let storage = opts.storage;
  let usage = opts.usage;
  let refused = opts.refused ?? false;
  let filter: ShelfFilter = opts.filter ?? "all";
  let sort: ShelfSort = opts.sort ?? "recent";
  let selected: string | undefined = opts.selectedSha;
  let fichaMode: FichaMode = "view";
  let rovingSha: string | undefined; // the box (or GHOST) that holds the one tab stop
  let pendingFocus: string | undefined; // focus this after the next draw
  let cols = 4;

  const headingId = `loc-shelf-heading-${uid}`;
  const heading = h("h2", { class: "loc-shelfview-title", id: headingId }, t["shelf.title"]);
  const chips = h("div", { class: "loc-chips", role: "group", "aria-label": t["shelf.filter"] });
  const sortSelect = h("select", { class: "loc-select", id: `loc-sort-${uid}` });
  for (const value of SORTS) sortSelect.append(h("option", { value }, t[`shelf.sort.${value}` as const]));
  sortSelect.value = sort;
  const sortLabel = h("label", { class: "loc-sort", for: sortSelect.id }, h("span", {}, t["shelf.sort"]), sortSelect);
  const head = h("div", { class: "loc-shelfview-head" }, heading, chips, sortLabel);
  const notice = h("p", { class: "loc-notice", role: "status" });
  const rack = h("div", { class: "loc-rack", role: "group", "aria-labelledby": headingId });
  const hint = h("p", { class: "loc-hint-line" }, t["shelf.hint"]);
  const element = h("section", { class: "loc-shelfview", "aria-labelledby": headingId }, head, notice, rack, hint);

  function pickButton(): HTMLButtonElement {
    const button = h("button", { type: "button", class: "loc-button" }, icon("cartridge", 18), h("span", {}, t["top.pick"]));
    button.addEventListener("click", () => opts.onPick());
    return button;
  }

  function currentVisible(): LibraryItem[] {
    return visibleItems(items, filter, sort);
  }

  function activeCellKey(): string | undefined {
    const active = document.activeElement as HTMLElement | null;
    if (!active || !rack.contains(active)) return undefined;
    const cell = active.closest<HTMLElement>("[data-cell]");
    return cell?.dataset.sha ?? (cell?.dataset.ghost !== undefined ? GHOST : undefined);
  }

  function chipsFor() {
    const models = chipModels(items, t["shelf.filter.all"]);
    const resolved = resolveFilter(items, filter);
    const hadFocus = chips.contains(document.activeElement);
    const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.filter;
    chips.replaceChildren(
      ...models.map((m) => {
        const chip = h(
          "button",
          { type: "button", class: "loc-chip", "aria-pressed": m.id === resolved ? "true" : "false", "data-filter": m.id },
          m.label,
          h("span", { class: "loc-chip-n" }, String(m.count)),
        );
        chip.addEventListener("click", () => {
          filter = m.id;
          if (selected && !currentVisible().some((i) => i.sha256 === selected)) closeFicha(false);
          drawHead();
          drawRack();
          opts.onFilter?.(filter);
        });
        return chip;
      }),
    );
    if (hadFocus && focusedId) chips.querySelector<HTMLElement>(`[data-filter="${focusedId}"]`)?.focus();
  }

  function drawHead() {
    const mode = shelfMode(storage, items.length);
    const showTools = mode === "list";
    chips.hidden = !showTools;
    sortLabel.hidden = !showTools;
    hint.hidden = mode !== "list";
    if (showTools) chipsFor();
    sortSelect.value = sort;
    // the three lines the Balcão can say about the shelf itself
    if (mode === "unavailable") {
      notice.textContent = t["shelf.noStorage"];
      notice.dataset.level = "info";
      notice.hidden = false;
    } else if (refused) {
      notice.textContent = t["err.storage"];
      notice.dataset.level = "warn";
      notice.hidden = false;
    } else if (usageLevel(usage) === "full") {
      notice.textContent = t["shelf.full"];
      notice.dataset.level = "warn";
      notice.hidden = false;
    } else {
      notice.textContent = "";
      notice.hidden = true;
    }
  }

  function closeFicha(render = true) {
    selected = undefined;
    fichaMode = "view";
    opts.onSelect?.(undefined);
    if (render) drawRack();
  }

  function selectBox(sha: string | undefined, mode: FichaMode = "view") {
    if (selected !== sha) opts.onSelect?.(sha);
    selected = sha;
    fichaMode = sha ? mode : "view";
  }

  /**
   * The cabinet stands at the foot of the Balcão (`margin-top: auto`): what is added inside it pushes what is above
   * it UP, so a Ficha opening under its row would slide the box just clicked out from under the pointer. When the
   * pane shows enough above the box, the Ficha rises ABOVE its row instead, and the page scrolls by however far the
   * row moved, so the box stays exactly where it was. Otherwise it goes under its row as before, and the cabinet
   * keeps the margin it had and grows downwards. Closed, the cabinet stands at the foot again.
   */
  let anchor: { top: number; above: number } | null = null;
  let marginNow = 0;
  function drawRack() {
    const scroller = element.parentElement;
    // the box with the Ficha, or (as it closes) the one that had it
    const key = selected ?? (rack.querySelector(".loc-ficha") ? rovingSha : undefined);
    const find = () => (key && key !== GHOST ? rack.querySelector<HTMLElement>(`[data-sha="${key}"]`) : null);
    const box = find();
    anchor = box && scroller && element.isConnected ? { top: box.getBoundingClientRect().top, above: box.getBoundingClientRect().top - scroller.getBoundingClientRect().top } : null;
    marginNow = element.isConnected ? Number.parseFloat(getComputedStyle(element).marginTop) || 0 : 0;
    drawRackRows();
    const open = rack.querySelector<HTMLElement>(".loc-ficha");
    if (!open || open.dataset.place === "above") element.style.removeProperty("margin-top");
    // the box keeps its place on the screen
    const after = find();
    if (anchor && after && scroller) {
      const moved = after.getBoundingClientRect().top - anchor.top;
      if (Math.abs(moved) > 0.5) scroller.scrollTop += moved;
    }
  }

  /** Where the Ficha just appended after its row goes: above the row when the pane shows room for it there, else under it. */
  function placeFicha(ficha: HTMLElement) {
    const row = ficha.previousElementSibling;
    const gap = Number.parseFloat(getComputedStyle(rack).rowGap) || 0;
    const need = ficha.offsetHeight + gap;
    if (row && anchor && need > gap && anchor.above >= need + 8) {
      rack.insertBefore(ficha, row);
      ficha.dataset.place = "above";
      return;
    }
    ficha.dataset.place = "below";
    if (element.isConnected && element.style.marginTop === "") element.style.marginTop = `${marginNow}px`;
  }

  function drawRackRows() {
    const mode = shelfMode(storage, items.length);
    const wanted = pendingFocus ?? activeCellKey();
    const inFicha = rack.querySelector(".loc-ficha")?.contains(document.activeElement) ?? false;
    const forced = pendingFocus;
    pendingFocus = undefined;
    rack.replaceChildren();

    if (mode === "unavailable") {
      rack.append(h("div", { class: "loc-row loc-empty", "data-empty": true }, h("div", { class: "loc-empty-text" }, pickButton())));
      return;
    }

    if (mode === "empty") {
      rack.append(
        h(
          "div",
          { class: "loc-row loc-empty", "data-empty": true },
          // the first free spot: a blank cartridge, a ghost of the tape to come
          h("div", { class: "loc-ghost", "aria-hidden": "true" }, h("span", { class: "loc-ghost-cart" }), h("span", { class: "loc-ghost-plus" }, icon("plus", 28))),
          h(
            "div",
            { class: "loc-empty-text" },
            h("p", { class: "loc-empty-line" }, t["shelf.empty"]),
            h("p", { class: "loc-empty-sub" }, t.systems),
            pickButton(),
          ),
          // the rest of the plank: spots for the tapes to come, fading out, scenery only
          h("div", { class: "loc-empty-spots", "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i")),
        ),
      );
      return;
    }

    const visible = currentVisible();
    if (selected && !visible.some((i) => i.sha256 === selected)) {
      selected = undefined;
      fichaMode = "view";
    }
    const count = visible.length + 1; // the last cell is "Botar outra fita"
    const keys = [...visible.map((i) => i.sha256), GHOST];
    let rovingIndex = keys.indexOf(forced ?? rovingSha ?? "");
    if (rovingIndex < 0) rovingIndex = Math.max(0, selected ? keys.indexOf(selected) : 0);
    rovingSha = keys[rovingIndex];
    const fichaId = `loc-ficha-${uid}`;

    const cells: HTMLElement[] = visible.map((item, index) =>
      createGameBox({ item, t, selected: item.sha256 === selected, tabIndex: index === rovingIndex ? 0 : -1, index, controls: fichaId }),
    );
    cells.push(
      h(
        "button",
        {
          type: "button",
          class: "loc-ghost loc-ghost-button",
          "data-cell": true,
          "data-ghost": true,
          "data-index": visible.length,
          tabindex: visible.length === rovingIndex ? 0 : -1,
        },
        h("span", { class: "loc-ghost-cart", "aria-hidden": "true" }),
        h("span", { class: "loc-ghost-plus" }, icon("plus", 28)),
        h("span", { class: "loc-ghost-text" }, t["shelf.pickAnother"]),
      ),
    );

    const selectedIndex = selected ? keys.indexOf(selected) : -1;
    const fichaRow = selectedIndex >= 0 ? Math.floor(rowEnd(selectedIndex, cols, count) / cols) : -1;
    let ficha: Ficha | undefined;
    const rows = chunkRows(cells, cols);
    rows.forEach((row, r) => {
      const rowEl = h("div", { class: "loc-row", role: "presentation" }, ...row.map((c) => h("div", { class: "loc-cell", role: "presentation" }, c)));
      // the last plank runs on past "Botar outra fita": its free spots, fading out, scenery and not cells
      if (r === rows.length - 1) {
        for (let i = 0; i < trailingSpots(row.length, cols); i++) rowEl.append(h("div", { class: "loc-spot", "aria-hidden": "true", "data-n": i + 1 }));
      }
      rowEl.style.setProperty("--cols", String(Math.max(1, cols)));
      rack.append(rowEl);
      if (r !== fichaRow) return;
      const item = visible[selectedIndex] as LibraryItem;
      ficha = createFicha({
        item,
        t,
        now: now(),
        id: fichaId,
        mode: fichaMode,
        onMode: (m) => {
          fichaMode = m;
        },
        onPlay: (it) => opts.onPlay(it),
        onSaves: (it) => opts.onSaves(it),
        onRename: (it, title) => {
          fichaMode = "view";
          pendingFocus = it.sha256;
          opts.onRename(it, title);
        },
        onRestoreFocus: () => focusCell(item.sha256),
        onRemove: (it) => {
          pendingFocus = neighbourAfterRemoval(
            visible.map((i) => i.sha256),
            it.sha256,
          ) ?? GHOST;
          rovingSha = pendingFocus;
          selected = undefined;
          fichaMode = "view";
          opts.onSelect?.(undefined);
          opts.onRemove(it);
        },
        onClose: () => {
          closeFicha();
          focusCell(item.sha256);
        },
      });
      rack.append(ficha.element);
      placeFicha(ficha.element);
    });

    // a box that merely had the focus before the redraw (a resize, a new column count) gets it back where it is: the
    // page must not scroll to it, or the shelf drawn again after a game would leave its top bar behind
    if (wanted !== undefined) focusCell(wanted, forced === undefined);
    else if (inFicha) ficha?.focusEntry();
  }

  /** Focus a cell by its sha (or GHOST), if it is drawn, and make it the one tab stop. */
  function focusCell(key: string, preventScroll = false) {
    const target = key === GHOST ? rack.querySelector<HTMLElement>("[data-ghost]") : rack.querySelector<HTMLElement>(`[data-sha="${key}"]`);
    if (!target) return;
    rovingSha = key;
    for (const cell of rack.querySelectorAll<HTMLElement>("[data-cell]")) cell.tabIndex = cell === target ? 0 : -1;
    target.focus(preventScroll ? { preventScroll: true } : undefined);
  }

  function itemFor(cell: HTMLElement): LibraryItem | undefined {
    const sha = cell.dataset.sha;
    return sha ? items.find((i) => i.sha256 === sha) : undefined;
  }

  /* ---- events, delegated on the rack ---- */

  rack.addEventListener("focusin", (event) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (!cell) return;
    rovingSha = cell.dataset.sha ?? GHOST;
    for (const other of rack.querySelectorAll<HTMLElement>("[data-cell]")) other.tabIndex = other === cell ? 0 : -1;
  });

  rack.addEventListener("click", (event) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (!cell || !rack.contains(cell)) return;
    if (cell.dataset.ghost !== undefined) {
      opts.onPick();
      return;
    }
    const sha = cell.dataset.sha as string;
    rovingSha = sha;
    const box = itemFor(cell);
    if (box && !box.hasFile) {
      // nothing to look at but a missing file: a click goes straight to finding it
      opts.onAttach?.(box);
      return;
    }
    if (selected === sha) closeFicha();
    else {
      selectBox(sha);
      pendingFocus = sha;
      drawRack();
    }
  });

  rack.addEventListener("dblclick", (event) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    const item = cell ? itemFor(cell) : undefined;
    // a click already asked for the file of a box that has none: a second one must not ask again
    if (item && item.hasFile) opts.onPlay(item);
  });

  rack.addEventListener("keydown", (event) => {
    // only the boxes themselves: a field or a button inside the Ficha keeps its own keys
    const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (!cell || event.target !== cell || event.altKey || event.metaKey) return;
    const index = Number(cell.dataset.index);
    const visible = currentVisible();
    const count = visible.length + 1;
    if (isNavKey(event.key)) {
      event.preventDefault();
      const next = moveFocus(index, event.key, cols, count, event.ctrlKey);
      const key = next >= visible.length ? GHOST : (visible[next] as LibraryItem).sha256;
      focusCell(key);
      return;
    }
    const item = itemFor(cell);
    if (event.key === "Enter") {
      event.preventDefault();
      if (item && !item.hasFile) opts.onAttach?.(item);
      else if (item) opts.onPlay(item);
      else opts.onPick();
    } else if (event.key === "Delete" && item) {
      event.preventDefault();
      selectBox(item.sha256, "confirm");
      pendingFocus = undefined;
      drawRack();
      rack.querySelector<HTMLElement>(".loc-ficha-confirm button")?.focus();
    } else if (event.key === "Escape" && selected) {
      event.preventDefault();
      const sha = selected;
      closeFicha();
      focusCell(sha);
    }
  });

  sortSelect.addEventListener("change", () => {
    sort = (SORTS.includes(sortSelect.value as ShelfSort) ? sortSelect.value : "recent") as ShelfSort;
    drawRack();
    opts.onSort?.(sort);
  });

  let observer: ResizeObserver | undefined;
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width <= 0) return; // hidden: keep what we had
      // the cell, the gap and the padding are the stylesheet's, which a wide pane raises
      const style = getComputedStyle(rack);
      const px = (name: string, fallback: number) => {
        const value = Number.parseFloat(style.getPropertyValue(name));
        return Number.isFinite(value) && value > 0 ? value : fallback;
      };
      const next = columnsFor(width, px("--loc-cell", CELL_WIDTH), px("--loc-row-gap", ROW_GAP), px("--loc-row-pad", ROW_PAD));
      if (next !== cols) {
        cols = next;
        drawRack();
      }
    });
    observer.observe(rack);
  }

  function drawAll() {
    drawHead();
    drawRack();
  }
  drawAll();

  return {
    element,
    update(patch) {
      if (patch.items) items = [...patch.items];
      if (patch.storage) storage = patch.storage;
      if ("usage" in patch) usage = patch.usage ?? undefined;
      if (patch.refused !== undefined) refused = patch.refused;
      if (selected && !items.some((i) => i.sha256 === selected)) {
        selected = undefined;
        fichaMode = "view";
      }
      drawAll();
    },
    select(sha) {
      selectBox(sha);
      drawRack();
    },
    focus(sha, options) {
      const keys = [...currentVisible().map((i) => i.sha256), GHOST];
      focusCell(sha && keys.includes(sha) ? sha : (rovingSha ?? keys[0] ?? GHOST), options?.preventScroll ?? false);
    },
    destroy() {
      observer?.disconnect();
    },
  };
}
