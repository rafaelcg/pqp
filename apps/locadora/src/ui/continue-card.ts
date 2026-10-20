/**
 * "Continuar de onde parou" (mock 1, SPEC 4.1): the cartridge played last, its
 * title and console, when it was last autosaved and how many saves it has, a
 * primary Continuar and a quiet Escolher save, and the autosave's picture.
 *
 * The picture is on the screen of the shop's TV (`src/art/tv-crt.webp`), under
 * scan lines, with the game's cartridge leaning on the set. Only drawn with a
 * library that has been played; `pickContinue` chooses the item. The picture is
 * whatever URL the caller made from `thumb:<sha>:<slot>` (a blob URL, which the
 * frame's CSP allows); without one the TV shows its own idle screen.
 */
import type { Strings } from "../i18n";
import { agoLine, CONSOLE_NAMES, displayTitle, manualSlots, type LibraryItem } from "../library";
import { createCartridge } from "./game-box";
import { fill, h } from "./dom";
import { icon } from "./top-bar";

export type ContinueCardStrings = Pick<
  Strings,
  "continue.eyebrow" | "continue.saved" | "continue.savedNow" | "continue.badgeNow" | "continue.go" | "continue.pick" | "continue.badge" | "box.saves.one" | "box.saves.other" | "sync.badge"
>;

export interface AutosaveInfo {
  /** When the autosave was written. */
  at: number;
  /** A URL for its picture, if the caller has one. */
  thumbUrl?: string;
}

export interface ContinueCardOptions {
  item: LibraryItem;
  t: ContinueCardStrings;
  autosave?: AutosaveInfo;
  now: number;
  /** This game has saves on the account (Saves na conta): the line says so, so the cloud is not invisible before the game. */
  onAccount?: boolean;
  onContinue: (item: LibraryItem) => void;
  onPickSave: (item: LibraryItem) => void;
}

/** "Game Boy Advance · salvo sozinho há 2 h · 3 saves · na conta": the parts that exist, in order. */
export function continueLine(item: LibraryItem, autosave: AutosaveInfo | undefined, now: number, t: ContinueCardStrings, onAccount = false): string {
  const parts = [CONSOLE_NAMES[item.platform]];
  if (autosave) parts.push(agoLine(t["continue.saved"], t["continue.savedNow"], autosave.at, now));
  const saves = manualSlots(item).length;
  if (saves > 0) parts.push(fill(saves === 1 ? t["box.saves.one"] : t["box.saves.other"], { n: saves }));
  if (onAccount) parts.push(t["sync.badge"]);
  return parts.join(" · ");
}

/** The card, inside the `.loc-continue-host` that its container queries measure. */
export function createContinueCard(opts: ContinueCardOptions): HTMLElement {
  const { item, t } = opts;
  const title = displayTitle(item);
  const headingId = "loc-continue-title";

  const go = h("button", { type: "button", class: "loc-button" }, icon("play", 16), h("span", {}, t["continue.go"]));
  go.addEventListener("click", () => opts.onContinue(item));
  const actions = h("div", { class: "loc-continue-actions" }, go);
  if (item.slots.length > 0) {
    const pick = h("button", { type: "button", class: "loc-button loc-button-quiet" }, t["continue.pick"]);
    pick.addEventListener("click", () => opts.onPickSave(item));
    actions.append(pick);
  }

  // the TV: its own idle screen, or the autosave's picture on it; scan lines and the glass over either
  const screen = h("span", { class: "loc-tv-screen" });
  const tv = h("div", { class: "loc-continue-tv", "aria-hidden": "true" }, screen, h("span", { class: "loc-continue-cart" }, createCartridge(item)));
  const card = h(
    "article",
    { class: "loc-continue", "aria-labelledby": headingId },
    tv,
    h(
      "div",
      { class: "loc-continue-main" },
      h("p", { class: "loc-eyebrow" }, t["continue.eyebrow"]),
      // past 22 letters a name is set smaller (shelf.css), so it stays on two lines beside the TV
      h("h2", { class: "loc-continue-title", id: headingId, "data-length": [...title].length > 22 ? "long" : undefined }, title),
      h("p", { class: "loc-muted" }, continueLine(item, opts.autosave, opts.now, t, opts.onAccount === true)),
      actions,
    ),
  );

  if (opts.autosave?.thumbUrl) {
    const img = h("img", { class: "loc-continue-img", src: opts.autosave.thumbUrl, alt: "", width: 240, height: 160, decoding: "async" });
    screen.append(h("span", { class: "loc-continue-thumb" }, img));
    tv.append(h("span", { class: "loc-continue-badge" }, agoLine(t["continue.badge"], t["continue.badgeNow"], opts.autosave.at, opts.now)));
    card.setAttribute("data-thumb", "");
  }
  screen.append(h("span", { class: "loc-tv-glass" }));
  // the host is the size container: the card lays itself out by its own width, not the page's
  return h("div", { class: "loc-continue-host" }, card);
}
