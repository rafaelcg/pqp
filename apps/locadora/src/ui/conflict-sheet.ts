/**
 * The conflict sheet (SPEC 10, 14): one slot was saved here AND somewhere else
 * since the two last agreed, and the account will not let one overwrite the
 * other on its own. Both sides are drawn the same way, the picture, where it
 * was saved and how long ago, and the person picks: "Usar o do computador",
 * "Usar o deste celular", or, for a slot of the drawer with a free slot to
 * spare, "Guardar os dois" (the other one goes to that slot). The battery save
 * never offers "both" (a cartridge has one). "Decidir depois" keeps this
 * device's for now and asks again on the next save.
 *
 * A real dialog: labelled by its question, focus starts on the first choice,
 * Tab stays inside, Escape is "Decidir depois". Nothing moves without motion
 * allowed (flow.css).
 */
import type { Strings } from "../i18n";
import { formatAgo } from "../library";
import type { ConflictChoice, DeviceKind } from "../sync";
import { fill, h } from "./dom";

export type ConflictSheetStrings = Pick<
  Strings,
  | "sync.conflict"
  | "sync.conflictSram"
  | "sync.both"
  | "sync.bothFull"
  | "sync.later"
  | "sync.useRemote"
  | "sync.useLocal"
  | "sync.side"
  | "sync.from.computer"
  | "sync.from.phone"
  | "sync.from.tablet"
  | "sync.this.computer"
  | "sync.this.phone"
  | "sync.this.tablet"
  | "saves.slot"
  | "saves.auto"
>;

export interface ConflictSheetSide {
  savedAt: number;
  device: DeviceKind;
  thumbUrl?: string;
}

export interface ConflictSheetOptions {
  t: ConflictSheetStrings;
  /** What the question is about: the slot's name, or null for the battery save. */
  slotLabel: string | null;
  local: ConflictSheetSide;
  remote: ConflictSheetSide;
  /** "Guardar os dois" is on offer (a manual slot with a free one to put the other in). */
  both: "offer" | "full" | "none";
  now?: () => number;
  onChoose: (choice: ConflictChoice) => void;
}

export interface ConflictSheet {
  readonly element: HTMLElement;
  focus(): void;
  destroy(): void;
}

let sheets = 0;

export function deviceFrom(t: ConflictSheetStrings, device: DeviceKind): string {
  return t[`sync.from.${device}`];
}

export function deviceThis(t: ConflictSheetStrings, device: DeviceKind): string {
  return t[`sync.this.${device}`];
}

/** "Do computador · salvo há 20 min", with the first letter up. */
export function sideLine(t: ConflictSheetStrings, where: string, savedAt: number, now: number): string {
  const line = fill(t["sync.side"], { where, ago: formatAgo(savedAt, now) });
  return line.charAt(0).toUpperCase() + line.slice(1);
}

export function createConflictSheet(options: ConflictSheetOptions): ConflictSheet {
  const { t } = options;
  const now = options.now ?? Date.now;
  const titleId = `loc-conflict-title-${++sheets}`;
  let done = false;

  function choose(choice: ConflictChoice) {
    if (done) return;
    done = true;
    for (const button of element.querySelectorAll("button")) button.disabled = true;
    options.onChoose(choice);
  }

  function card(side: ConflictSheetSide, where: string, kind: "local" | "remote"): HTMLElement {
    return h(
      "figure",
      { class: "loc-conflict-card", "data-side": kind },
      h(
        "div",
        { class: "loc-conflict-thumb", "data-empty": side.thumbUrl ? undefined : true },
        side.thumbUrl ? h("img", { src: side.thumbUrl, alt: "", width: 160, decoding: "async" }) : null,
      ),
      h("figcaption", {}, sideLine(t, where, side.savedAt, now())),
    );
  }

  const remoteWhere = deviceFrom(t, options.remote.device);
  const localWhere = deviceThis(t, options.local.device);
  const useRemote = h("button", { type: "button", class: "loc-button", "data-choice": "remote" }, fill(t["sync.useRemote"], { from: remoteWhere }));
  const useLocal = h("button", { type: "button", class: "loc-button loc-button-quiet", "data-choice": "local" }, fill(t["sync.useLocal"], { this: localWhere }));
  useRemote.addEventListener("click", () => choose("remote"));
  useLocal.addEventListener("click", () => choose("local"));
  const actions: HTMLElement[] = [useRemote, useLocal];
  if (options.both === "offer") {
    const both = h("button", { type: "button", class: "loc-button loc-button-quiet", "data-choice": "both" }, t["sync.both"]);
    both.addEventListener("click", () => choose("both"));
    actions.push(both);
  }
  const later = h("button", { type: "button", class: "loc-link", "data-choice": "later" }, t["sync.later"]);
  later.addEventListener("click", () => choose("later"));

  const question = options.slotLabel === null ? t["sync.conflictSram"] : t["sync.conflict"];
  const element = h(
    "div",
    { class: "loc-conflict", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
    h(
      "div",
      { class: "loc-conflict-panel" },
      options.slotLabel ? h("p", { class: "loc-conflict-eyebrow" }, options.slotLabel) : null,
      h("h2", { class: "loc-conflict-title", id: titleId }, question),
      h("div", { class: "loc-conflict-cards" }, card(options.remote, remoteWhere, "remote"), card(options.local, localWhere, "local")),
      h("div", { class: "loc-conflict-actions" }, ...actions),
      options.both === "full" ? h("p", { class: "loc-conflict-note" }, t["sync.bothFull"]) : null,
      later,
    ),
  );

  element.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      choose("later");
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...element.querySelectorAll<HTMLElement>("button:not([disabled])")];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  return {
    element,
    focus: () => useRemote.focus({ preventScroll: true }),
    destroy: () => element.remove(),
  };
}
