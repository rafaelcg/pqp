/**
 * The "Exportar pra arquivo" dialog (SPEC 11). It is a FILE, not a sync: the name, the one-line lead and the two
 * choices all say so, because "Levar pra outro aparelho" read as a cloud feature once Saves na conta existed.
 * Two jobs, one sheet:
 *
 *  - export: a clear two-way choice, "Só os saves" (small, safe, the default without an account) and "Fita e
 *    saves" (the big file, the game goes along; the default when saves already follow the account, because then
 *    the cartridge is the only thing a file is still needed for), each with a size hint read from the store's
 *    listing. "Salvar o arquivo" builds the `.locadora` zip and hands the bytes to the host through `saveLocal`.
 *    This module never reaches for the host itself. Nothing is uploaded, and the sheet says so.
 *  - import: "Importar de um arquivo" at the foot of the same sheet asks the host's picker (`pickBundle`); given
 *    the bytes, it checks the bundle, shows what it would bring, and asks which side wins when a save slot
 *    already exists here with different bytes. Keep what is here is the default.
 *
 * Plain DOM like the rest of the frame: Escape closes, focus goes back to whatever
 * opened it, copy goes through `textContent` (never markup).
 */
import { applyImport, BUNDLE_EXT, estimateBundle, exportBundle, planImport, readBundle, type CollisionChoice, type ImportPlan } from "../bundle";
import type { Strings } from "../i18n";
import { formatBytes } from "../library";
import type { DeviceStore } from "../store";
import { fill, h } from "./dom";

export type ExportDialogStrings = Pick<
  Strings,
  | "export.title"
  | "export.lead"
  | "export.choose"
  | "export.choice.saves"
  | "export.choice.savesHint"
  | "export.choice.all"
  | "export.choice.allHint"
  | "export.size"
  | "export.sizeNone"
  | "export.cloud"
  | "export.noCloud"
  | "export.privacy"
  | "export.save"
  | "export.importLead"
  | "export.importButton"
  | "export.importNotFile"
  | "export.close"
  | "export.empty"
  | "export.failed"
  | "export.tooBig"
  | "export.done"
  | "import.title"
  | "import.games"
  | "import.saves"
  | "import.collision"
  | "import.keep"
  | "import.replace"
  | "import.apply"
  | "import.cancel"
  | "import.missingFile"
  | "import.notBundle"
  | "import.tooBig"
  | "import.full"
  | "import.done"
  | "import.failed"
>;

export interface ExportDialogOptions {
  t: ExportDialogStrings;
  store: DeviceStore;
  /** The host's `files.saveLocal`, passed in. The person names the file there. */
  saveLocal: (bytes: Uint8Array, ext: string) => Promise<unknown>;
  /** Told how many games came in, so the shelf can redraw. */
  onImported?: (games: number) => void;
  /**
   * Whether the saves already follow the account (Saves na conta is on and answering). Asked each time the sheet
   * opens: with it, the file is only needed for the cartridge and "Fita e saves" is the default; without it the
   * sheet says the file is the only way to carry the saves.
   */
  savesOnAccount?: () => boolean;
  /**
   * "Importar de um arquivo": the host's picker, asked for a `.locadora` file. `bundle` carries its bytes,
   * `cancelled` is a person who changed their mind, `other` is a file that is not a bundle (a game, say).
   */
  pickBundle?: () => Promise<{ kind: "bundle"; bytes: Uint8Array } | { kind: "cancelled" } | { kind: "other" }>;
  /** Where the sheet is appended. Defaults to `document.body`. */
  root?: HTMLElement;
}

export interface ExportDialog {
  readonly element: HTMLElement;
  openExport(): void;
  /** Reads the bundle, plans the import and shows it; nothing is written until the person says so. */
  openImport(bytes: Uint8Array): Promise<void>;
  close(): void;
}

let sequence = 0;

export function createExportDialog(options: ExportDialogOptions): ExportDialog {
  const { t, store, saveLocal } = options;
  const id = `loc-export-${++sequence}`;
  const title = h("h2", { id: `${id}-title`, class: "loc-export__title" }, "");
  const body = h("div", { class: "loc-export__body" });
  const closeButton = h("button", { type: "button", class: "loc-button" }, t["export.close"]);
  const element = h(
    "section",
    { class: "loc-export", role: "dialog", "aria-modal": "true", "aria-labelledby": `${id}-title`, hidden: true },
    h("div", { class: "loc-export__head" }, title, closeButton),
    body,
  );
  let returnTo: HTMLElement | null = null;

  /**
   * While the sheet is up the keys are its own: Escape closes it (wherever the focus fell, a disabled or replaced
   * button drops it to the page) and Tab stays inside, so neither reaches the game or the shelf behind.
   */
  function onDocumentKey(event: KeyboardEvent): void {
    if (element.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const inside = [...element.querySelectorAll<HTMLElement>("button, input, [tabindex]")].filter(
      (node) => !node.hasAttribute("disabled") && node.tabIndex >= 0 && !node.hidden,
    );
    if (inside.length === 0) return;
    const first = inside[0] as HTMLElement;
    const last = inside[inside.length - 1] as HTMLElement;
    const active = document.activeElement;
    if (!(active instanceof Node) || !element.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function close(): void {
    document.removeEventListener("keydown", onDocumentKey, true);
    element.hidden = true;
    body.replaceChildren();
    returnTo?.focus();
    returnTo = null;
  }

  function show(heading: string): void {
    if (element.hidden) {
      returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.addEventListener("keydown", onDocumentKey, true);
    }
    title.textContent = heading;
    body.replaceChildren();
    element.hidden = false;
  }

  function message(text: string): HTMLElement {
    const node = h("p", { class: "loc-export__note", role: "status" }, text);
    body.append(node);
    return node;
  }

  function buttons(...nodes: HTMLElement[]): void {
    body.append(h("div", { class: "loc-export__actions" }, ...nodes));
  }

  closeButton.addEventListener("click", close);
  // every other key typed in the sheet stays in the sheet: the game behind it listens to the document
  element.addEventListener("keydown", (event) => event.stopPropagation());

  function openExport(): void {
    show(t["export.title"]);
    const onAccount = options.savesOnAccount?.() === true;
    const group = `${id}-what`;
    // two choices, as radios: a file is "only the saves" or "the cartridge too", never a box to find and tick
    const choiceSaves = h("input", { type: "radio", name: group, value: "saves", id: `${id}-saves`, "aria-describedby": `${id}-saves-hint` });
    const choiceAll = h("input", { type: "radio", name: group, value: "all", id: `${id}-all`, "aria-describedby": `${id}-all-hint` });
    const savesHint = h("span", { class: "loc-export__hint", id: `${id}-saves-hint` }, fill(t["export.choice.savesHint"], { size: "" }).trim());
    const allHint = h("span", { class: "loc-export__hint", id: `${id}-all-hint` }, fill(t["export.choice.allHint"], { size: "" }).trim());
    const card = (input: HTMLInputElement, name: string, hint: HTMLElement) =>
      h("label", { class: "loc-export__choice", for: input.id }, input, h("span", { class: "loc-export__choice-text" }, h("strong", {}, name), hint));
    (onAccount ? choiceAll : choiceSaves).checked = true;
    const save = h("button", { type: "button", class: "loc-button loc-button--primary" }, t["export.save"]);
    body.append(
      h("p", { class: "loc-export__lead" }, t["export.lead"]),
      h(
        "div",
        { class: "loc-export__choices", role: "radiogroup", "aria-label": t["export.choose"] },
        card(choiceSaves, t["export.choice.saves"], savesHint),
        card(choiceAll, t["export.choice.all"], allHint),
      ),
      h("p", { class: `loc-export__cloud${onAccount ? " loc-export__cloud--on" : ""}`, "data-cloud": onAccount ? "on" : "off" }, onAccount ? t["export.cloud"] : t["export.noCloud"]),
      h("p", { class: "loc-export__note" }, t["export.privacy"]),
    );
    buttons(save);
    if (options.pickBundle) body.append(importRow());

    // the size hints come from the store's listing, a moment after the sheet is up; the sentence is complete without them
    void estimateBundle(store)
      .then((size) => {
        if (element.hidden || !body.contains(savesHint)) return;
        const line = (key: "export.choice.savesHint" | "export.choice.allHint", bytes: number) =>
          fill(t[key], { size: bytes > 0 ? fill(t["export.size"], { size: formatBytes(bytes) }) : t["export.sizeNone"] }).trim();
        savesHint.textContent = line("export.choice.savesHint", size.saves);
        allHint.textContent = line("export.choice.allHint", size.withRom);
      })
      .catch(() => undefined);

    // aria-disabled, not `disabled`: a disabled button that has the focus drops it to the page
    let working = false;
    save.addEventListener("click", async () => {
      if (working) return;
      working = true;
      save.setAttribute("aria-disabled", "true");
      body.querySelector(".loc-export__note[role=status]")?.remove();
      const done = (text: string) => {
        message(text);
        save.removeAttribute("aria-disabled");
        working = false;
      };
      const result = await exportBundle(store, { withRom: choiceAll.checked }).catch(() => null);
      if (!result) return done(t["export.failed"]);
      if (!result.ok) return done(result.reason === "empty" ? t["export.empty"] : t["export.tooBig"]);
      try {
        await saveLocal(result.bytes, BUNDLE_EXT);
        done(t["export.done"]);
      } catch {
        done(t["export.failed"]);
      }
    });
    (onAccount ? choiceAll : choiceSaves).focus();
  }

  /** "Importar de um arquivo": the other half of the same sheet, named the same way. */
  function importRow(): HTMLElement {
    const pick = h("button", { type: "button", class: "loc-button loc-export__import" }, t["export.importButton"]);
    let asking = false;
    pick.addEventListener("click", async () => {
      if (asking || !options.pickBundle) return;
      asking = true;
      pick.setAttribute("aria-disabled", "true");
      try {
        const picked = await options.pickBundle();
        if (picked.kind === "bundle") await openImport(picked.bytes);
        else if (picked.kind === "other") {
          body.querySelector(".loc-export__note[role=status]")?.remove();
          message(t["export.importNotFile"]);
        }
      } catch {
        message(t["import.failed"]);
      } finally {
        asking = false;
        pick.removeAttribute("aria-disabled");
      }
    });
    return h("div", { class: "loc-export__import-row" }, h("p", { class: "loc-export__note" }, t["export.importLead"]), pick);
  }

  async function openImport(bytes: Uint8Array): Promise<void> {
    show(t["import.title"]);
    const read = readBundle(bytes);
    if (!read.ok) {
      message(read.reason === "too-large" ? t["import.tooBig"] : t["import.notBundle"]);
      buttons(closeButton);
      return;
    }
    let plan: ImportPlan;
    try {
      plan = await planImport(store, read.bundle);
    } catch {
      message(t["import.failed"]);
      buttons(closeButton);
      return;
    }
    const saves = plan.games.reduce((sum, g) => sum + g.saves, 0);
    body.append(
      h("p", { class: "loc-export__note" }, fill(t["import.games"], { n: plan.games.length })),
      h("p", { class: "loc-export__note" }, fill(t["import.saves"], { n: saves })),
    );
    const missing = plan.games.filter((g) => g.missingFile).length;
    if (missing > 0) message(fill(t["import.missingFile"], { n: missing }));

    let choice: CollisionChoice = "keep";
    if (plan.conflicts > 0) {
      const group = `${id}-collision`;
      const keep = h("input", { type: "radio", name: group, value: "keep", id: `${id}-keep`, checked: true });
      const replace = h("input", { type: "radio", name: group, value: "replace", id: `${id}-replace` });
      keep.addEventListener("change", () => (choice = "keep"));
      replace.addEventListener("change", () => (choice = "replace"));
      body.append(
        h("p", { class: "loc-export__note" }, fill(t["import.collision"], { n: plan.conflicts })),
        h("label", { class: "loc-export__check", for: `${id}-keep` }, keep, " ", t["import.keep"]),
        h("label", { class: "loc-export__check", for: `${id}-replace` }, replace, " ", t["import.replace"]),
      );
    }

    const apply = h("button", { type: "button", class: "loc-button loc-button--primary" }, t["import.apply"]);
    const cancel = h("button", { type: "button", class: "loc-button" }, t["import.cancel"]);
    cancel.addEventListener("click", close);
    buttons(apply, cancel);
    let applying = false;
    apply.addEventListener("click", async () => {
      if (applying) return;
      applying = true;
      apply.setAttribute("aria-disabled", "true");
      const result = await applyImport(store, plan, choice).catch(() => ({ ok: false as const, reason: "failed" as const }));
      body.replaceChildren();
      if (result.ok) {
        message(fill(t["import.done"], { n: result.games }));
        options.onImported?.(result.games);
        buttons(closeButton);
      } else {
        message(result.reason === "full" ? t["import.full"] : t["import.failed"]);
        buttons(closeButton);
      }
      // the buttons the person pressed are gone: the sheet's way out takes the focus
      closeButton.focus();
    });
    apply.focus();
  }

  (options.root ?? document.body).append(element);

  return {
    element,
    openExport,
    openImport,
    close,
  };
}
