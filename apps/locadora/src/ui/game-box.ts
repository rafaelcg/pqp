/**
 * One box on the shelf: a cartridge (pixel art, `src/art/cart-*.webp`, tinted per console by shelf.css) with the
 * game's title set on its empty label, an optional sticker ("novo", "3 saves") and a button around it. The
 * cartridge is `aria-hidden`: the button's own label says what it is (title, console, sticker), read from the
 * item's metadata. Nothing on the label is invented: the title is the person's or the file header's, and there is
 * no picture of the game, because the shelf has none.
 *
 * Hover, focus and selection are CSS (`shelf.css`); this builds the node and
 * says which fields it carries (`data-sha`, `data-index`) for the grid around it.
 */
import { boxArtSvg } from "../boxart";
import { CART_BRAND, cartKind, fitLabel } from "../cart-label";
import type { Strings } from "../i18n";
import { CONSOLE_NAMES, displayTitle, manualSlots, type LibraryItem } from "../library";
import { fill, h } from "./dom";

export type GameBoxStrings = Pick<Strings, "box.new" | "box.saves.one" | "box.saves.other" | "box.missing">;

/** What a box's sticker is about: no game file (it wins), the person's saves, or a tape never played. */
export type StickerKind = "missing" | "saves" | "new";

/** "falta a fita" for a box with no game file, else "3 saves", "1 save", "novo" for a tape never played, or nothing. */
export function stickerFor(item: Pick<LibraryItem, "slots" | "lastPlayedAt"> & { hasFile?: boolean }, t: GameBoxStrings): string | undefined {
  if (item.hasFile === false) return t["box.missing"];
  const saves = manualSlots(item).length;
  if (saves > 0) return fill(saves === 1 ? t["box.saves.one"] : t["box.saves.other"], { n: saves });
  if (item.lastPlayedAt === 0) return t["box.new"];
  return undefined;
}

/** "Title, Console, sticker": the whole accessible name of a box. */
export function boxLabel(item: Pick<LibraryItem, "userTitle" | "headerTitle" | "platform" | "slots" | "lastPlayedAt"> & { hasFile?: boolean }, t: GameBoxStrings): string {
  const sticker = stickerFor(item, t);
  return [displayTitle(item), CONSOLE_NAMES[item.platform], sticker].filter(Boolean).join(", ");
}

/**
 * The cartridge alone, hidden from assistive tech: the sprite of its console, and the title fitted to the label
 * (`fitLabel`). The letter size goes in through the CSSOM (the frame's CSP forbids style attributes).
 */
export function createCartridge(item: Pick<LibraryItem, "userTitle" | "headerTitle" | "platform">): HTMLElement {
  const kind = cartKind(item.platform);
  const fit = fitLabel(displayTitle(item), kind);
  const title = h("span", { class: "loc-cart-title" }, ...fit.lines.map((line) => h("span", { class: "loc-cart-line" }, line)));
  title.style.setProperty("--fs", String(fit.size));
  // the label is the cream window alone: the console's name is printed on the frame around it (shelf.css)
  const label = h("span", { class: "loc-cart-label" }, title);
  return h(
    "span",
    { class: "loc-cart", "aria-hidden": "true", "data-kind": kind, "data-platform": item.platform },
    h("span", { class: "loc-cart-body" }),
    h("span", { class: kind === "console" ? "loc-cart-ribbon" : "loc-cart-brand" }, CART_BRAND[item.platform]),
    label,
  );
}

/** The generated cover, hidden from assistive tech: what the load overlay still draws (`game-session.ts`). */
export function createBoxArt(item: LibraryItem, width?: number): HTMLElement {
  const holder = h("span", { class: "loc-box-art", "aria-hidden": "true" });
  // boxArtSvg escapes the title; what it returns is markup of our own making
  holder.innerHTML = boxArtSvg(displayTitle(item), item.platform, width === undefined ? {} : { width });
  return holder;
}

export interface GameBoxOptions {
  item: LibraryItem;
  t: GameBoxStrings;
  /** The Ficha for this box is open. */
  selected: boolean;
  /** Roving tabindex: 0 for the one box in the tab order, -1 for the rest. */
  tabIndex: 0 | -1;
  index: number;
  /** The id of the Ficha it opens, for `aria-controls` while selected. */
  controls?: string;
}

export function createGameBox(opts: GameBoxOptions): HTMLButtonElement {
  const { item, t } = opts;
  const sticker = stickerFor(item, t);
  const kind: StickerKind = item.hasFile === false ? "missing" : item.lastPlayedAt === 0 && manualSlots(item).length === 0 ? "new" : "saves";
  const button = h(
    "button",
    {
      type: "button",
      class: "loc-box",
      "aria-label": boxLabel(item, t),
      "aria-expanded": opts.selected ? "true" : "false",
      "aria-controls": opts.selected ? opts.controls : undefined,
      tabindex: opts.tabIndex,
      "data-cell": true,
      "data-sha": item.sha256,
      "data-index": opts.index,
      "data-selected": opts.selected,
      "data-missing": item.hasFile === false ? "true" : undefined,
      "data-cart": cartKind(item.platform),
    },
    createCartridge(item),
    sticker ? h("span", { class: "loc-box-sticker", "aria-hidden": "true", "data-kind": kind }, sticker) : null,
  );
  return button;
}
