/**
 * The Ficha (mock 1, SPEC 4.1): the card of the selected cartridge, drawn at
 * the end of its row (never a popover over the neighbours). Jogar, Saves,
 * Renomear and Tirar da prateleira. Renaming and removing happen inside it:
 * a name field, and an inline "A fita e os saves dela somem deste aparelho"
 * with the safe answer (Deixar aí) focused first.
 *
 * `createNamePrompt` is the same field on its own, for the question asked once
 * after a NES file is picked (no title in its header): "Como chama essa fita?",
 * prefilled, skippable.
 *
 * The top half is plain logic; the DOM below only wires it.
 */
import { MAX_USER_TITLE, CONSOLE_NAMES, agoLine, displayTitle, formatBytes, formatPlaytime, sanitiseUserTitle, type LibraryItem } from "../library";
import type { Strings } from "../i18n";
import { fill, h } from "./dom";
import { createCartridge } from "./game-box";

export type FichaStrings = Pick<
  Strings,
  | "ficha.selected"
  | "ficha.play"
  | "hud.saves"
  | "ficha.rename"
  | "ficha.remove"
  | "ficha.remove.yes"
  | "ficha.remove.no"
  | "ficha.never"
  | "ficha.played"
  | "ficha.playedNow"
  | "ficha.playtime"
  | "shelf.remove.confirm"
  | "name.ask"
  | "name.save"
  | "onb.cancel"
>;

export type FichaMode = "view" | "rename" | "confirm";

/** The pills under the name: console, when it was played, how big, how long. Pure, so a test can read it. */
export function fichaFacts(item: LibraryItem, now: number, t: Pick<Strings, "ficha.never" | "ficha.played" | "ficha.playedNow" | "ficha.playtime">): string[] {
  const facts = [CONSOLE_NAMES[item.platform]];
  facts.push(item.lastPlayedAt === 0 ? t["ficha.never"] : agoLine(t["ficha.played"], t["ficha.playedNow"], item.lastPlayedAt, now));
  facts.push(formatBytes(item.bytes));
  if (item.playSeconds >= 30) facts.push(fill(t["ficha.playtime"], { time: formatPlaytime(item.playSeconds) }));
  return facts;
}

/** What a rename field's text turns into: the cleaned title, or null when it is blank or unchanged. */
export function renameOutcome(item: Pick<LibraryItem, "userTitle" | "headerTitle" | "platform">, typed: string): string | null {
  const next = sanitiseUserTitle(typed);
  if (next === "") return null;
  return next === displayTitle(item) ? null : next;
}

/* ---- the name field ---- */

export interface NamePromptOptions {
  t: Pick<Strings, "name.ask" | "name.save">;
  /** The text the field starts with, selected. */
  initial: string;
  /** The label of the way out: "Pular" after a pick, "Cancelar" when renaming. */
  skipLabel: string;
  onSubmit: (title: string) => void;
  onSkip: () => void;
}

export interface NamePrompt {
  /**
   * Not a `<form>` on purpose: the frame is sandboxed without `allow-forms`, so the browser blocks a form's submission
   * (Enter, or the button) before any `submit` event exists. The field answers Enter itself and the button is a button.
   */
  readonly element: HTMLElement;
  focus(): void;
}

let promptCount = 0;

export function createNamePrompt(opts: NamePromptOptions): NamePrompt {
  const id = `loc-name-${++promptCount}`;
  const input = h("input", {
    type: "text",
    class: "loc-input",
    id,
    value: opts.initial,
    maxlength: MAX_USER_TITLE,
    autocomplete: "off",
    spellcheck: "false",
  });
  const submit = h("button", { type: "button", class: "loc-button" }, opts.t["name.save"]);
  const skip = h("button", { type: "button", class: "loc-button loc-button-quiet" }, opts.skipLabel);
  const element = h(
    "div",
    { class: "loc-nameprompt", role: "group", "aria-labelledby": `${id}-label` },
    h("label", { class: "loc-nameprompt-label", id: `${id}-label`, for: id }, opts.t["name.ask"]),
    h("div", { class: "loc-nameprompt-row" }, input, submit, skip),
  );
  const commit = () => opts.onSubmit(input.value);
  submit.addEventListener("click", commit);
  skip.addEventListener("click", () => opts.onSkip());
  // keys typed here belong to the field: not to the shelf's shortcuts, not to a game
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      opts.onSkip();
    } else if (event.key === "Enter" && !event.isComposing) {
      // what a form would have done on Enter; a form cannot submit in this frame (see `NamePrompt`)
      event.preventDefault();
      commit();
    }
  });
  return {
    element,
    focus() {
      input.focus();
      input.select();
    },
  };
}

/* ---- the card ---- */

export interface FichaOptions {
  item: LibraryItem;
  t: FichaStrings;
  now: number;
  id: string;
  mode?: FichaMode;
  onPlay: (item: LibraryItem) => void;
  onSaves: (item: LibraryItem) => void;
  /** Called with the new title. */
  onRename: (item: LibraryItem, title: string) => void;
  onRemove: (item: LibraryItem) => void;
  /** Escape, or the way out of the card. */
  onClose: () => void;
  /** The card moved between its modes; the shelf keeps it across a redraw. */
  onMode?: (mode: FichaMode) => void;
  /**
   * The card was opened in `confirm` from outside (Delete on a box), so there is no button of its own to go back to
   * when the question is answered "no": the caller gives the keyboard back to whatever asked.
   */
  onRestoreFocus?: () => void;
}

export interface Ficha {
  readonly element: HTMLElement;
  /** Puts focus where the current mode wants it: the field, the safe answer, or Jogar. */
  focusEntry(): void;
}

export function createFicha(opts: FichaOptions): Ficha {
  const { item, t } = opts;
  let mode: FichaMode = opts.mode ?? "view";
  const title = displayTitle(item);
  /** Which button opened the mode the card is in, so closing it puts the keyboard back there; "outside" is the box. */
  let opener: "rename" | "remove" | "outside" = "outside";
  /** Which button of the view takes focus the next time it is drawn. */
  let viewFocus: "play" | "rename" | "remove" = "play";

  const heading = h("h3", { class: "loc-ficha-title" }, title);
  const facts = h("ul", { class: "loc-ficha-facts" }, ...fichaFacts(item, opts.now, t).map((f) => h("li", { class: "loc-fact" }, f)));
  const body = h("div", { class: "loc-ficha-body" });
  const element = h(
    "section",
    { class: "loc-ficha", id: opts.id, "aria-label": title, "data-mode": mode },
    // the cartridge again, at the head of its card: which tape this is, at a glance
    h("div", { class: "loc-ficha-cart" }, createCartridge(item)),
    h("div", { class: "loc-ficha-main" }, h("p", { class: "loc-eyebrow loc-ficha-eyebrow" }, t["ficha.selected"]), heading, facts, body),
  );

  let entry: () => void = () => undefined;

  function setMode(next: FichaMode) {
    mode = next;
    element.setAttribute("data-mode", mode);
    opts.onMode?.(mode);
    draw();
    entry();
  }

  /** Back to the view from rename or confirm (Escape, "Deixar aí", Cancelar): the keyboard goes where it came from. */
  function backToView() {
    const from = opener;
    opener = "outside";
    if (from === "outside") {
      viewFocus = "play";
      setMode("view");
      // the card was opened by a key on the box, not by one of its buttons
      opts.onRestoreFocus?.();
      return;
    }
    viewFocus = from;
    setMode("view");
  }

  function draw() {
    body.replaceChildren();
    if (mode === "rename") {
      const prompt = createNamePrompt({
        t,
        initial: title,
        skipLabel: t["onb.cancel"],
        onSubmit: (typed) => {
          const next = renameOutcome(item, typed);
          if (next === null) {
            backToView();
            return;
          }
          opts.onRename(item, next);
        },
        onSkip: backToView,
      });
      body.append(prompt.element);
      entry = () => prompt.focus();
    } else if (mode === "confirm") {
      const keep = h("button", { type: "button", class: "loc-button loc-button-quiet" }, t["ficha.remove.no"]);
      const yes = h("button", { type: "button", class: "loc-button loc-button-danger" }, t["ficha.remove.yes"]);
      keep.addEventListener("click", backToView);
      yes.addEventListener("click", () => opts.onRemove(item));
      body.append(
        h(
          "div",
          { class: "loc-ficha-confirm", role: "alertdialog", "aria-label": t["ficha.remove"], "aria-describedby": `${opts.id}-warn` },
          h("p", { id: `${opts.id}-warn`, class: "loc-ficha-warn" }, t["shelf.remove.confirm"]),
          h("div", { class: "loc-ficha-actions" }, keep, yes),
        ),
      );
      // the safe answer first: a stray Enter never deletes anything
      entry = () => keep.focus();
    } else {
      const play = h("button", { type: "button", class: "loc-button" }, t["ficha.play"]);
      const saves = h("button", { type: "button", class: "loc-button loc-button-quiet" }, t["hud.saves"]);
      const rename = h("button", { type: "button", class: "loc-button loc-button-quiet" }, t["ficha.rename"]);
      const remove = h("button", { type: "button", class: "loc-button loc-button-quiet loc-button-danger-text" }, t["ficha.remove"]);
      play.addEventListener("click", () => opts.onPlay(item));
      saves.addEventListener("click", () => opts.onSaves(item));
      rename.addEventListener("click", () => {
        opener = "rename";
        setMode("rename");
      });
      remove.addEventListener("click", () => {
        opener = "remove";
        setMode("confirm");
      });
      body.append(h("div", { class: "loc-ficha-actions" }, play, saves, rename, remove));
      const wanted = viewFocus === "rename" ? rename : viewFocus === "remove" ? remove : play;
      viewFocus = "play";
      entry = () => wanted.focus();
    }
  }
  draw();

  element.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (mode === "view") opts.onClose();
    else backToView();
  });

  return { element, focusEntry: () => entry() };
}
