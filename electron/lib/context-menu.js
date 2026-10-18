/**
 * The right-click menu on text, as data (bug #123).
 *
 * Electron draws no context menu of its own: the page's `contextmenu` event
 * reaches the main process as `webContents` `context-menu` and nothing appears
 * unless we build it. So a misspelled word was underlined and a right-click on
 * it did nothing at all. This file owns what the menu says; main.js owns what a
 * click does (`replaceMisspelling`, `addWordToSpellCheckerDictionary`), passed
 * in as `actions` the way `lib/tray-menu.js` does.
 *
 * It only speaks for text: an editable field, a selection, a misspelled word.
 * A right-click on anything else returns an empty template and main.js shows no
 * menu, which is also why the app's own React context menus (messages, members,
 * the stories canvas) are untouched: they `preventDefault` the DOM event, and
 * Chromium then never asks the shell for a native one.
 *
 * Pure: no Electron import, so `node --test` can read the menu.
 */

/** Five is what Chrome shows; more is a list to read, not a fix to pick. */
const MAX_SUGGESTIONS = 5;

/**
 * @param {{
 *   misspelledWord?: string,
 *   dictionarySuggestions?: string[],
 *   isEditable?: boolean,
 *   selectionText?: string,
 *   editFlags?: {
 *     canUndo?: boolean, canRedo?: boolean, canCut?: boolean,
 *     canCopy?: boolean, canPaste?: boolean, canSelectAll?: boolean,
 *   },
 * }} params the `context-menu` event's params
 * @param {(key: string, vars?: object) => string} t
 * @param {{ replaceMisspelling(word: string): void, addToDictionary(word: string): void }} actions
 * @returns {Array<object>} a template `Menu.buildFromTemplate` accepts, or `[]`
 */
function buildContextMenuTemplate(params, t, actions) {
  const p = params || {};
  const flags = p.editFlags || {};
  const editable = p.isEditable === true;
  const word = typeof p.misspelledWord === "string" ? p.misspelledWord.trim() : "";
  const selection = typeof p.selectionText === "string" ? p.selectionText.trim() : "";

  /** @type {Array<object>} */
  const template = [];

  if (editable && word !== "") {
    const suggestions = (Array.isArray(p.dictionarySuggestions) ? p.dictionarySuggestions : [])
      .filter((s) => typeof s === "string" && s.trim() !== "")
      .slice(0, MAX_SUGGESTIONS);
    if (suggestions.length > 0) {
      for (const suggestion of suggestions) {
        template.push({
          label: suggestion,
          click: () => actions.replaceMisspelling(suggestion),
        });
      }
    } else {
      template.push({ label: t("contextMenu.noSuggestions"), enabled: false });
    }
    template.push({
      label: t("contextMenu.addToDictionary"),
      click: () => actions.addToDictionary(word),
    });
    template.push({ type: "separator" });
  }

  if (editable) {
    template.push(
      { label: t("contextMenu.undo"), role: "undo", enabled: flags.canUndo === true },
      { label: t("contextMenu.redo"), role: "redo", enabled: flags.canRedo === true },
      { type: "separator" },
      { label: t("contextMenu.cut"), role: "cut", enabled: flags.canCut === true },
      { label: t("contextMenu.copy"), role: "copy", enabled: flags.canCopy === true },
      { label: t("contextMenu.paste"), role: "paste", enabled: flags.canPaste === true },
      {
        label: t("contextMenu.selectAll"),
        role: "selectAll",
        enabled: flags.canSelectAll !== false,
      },
    );
  } else if (selection !== "") {
    template.push({ label: t("contextMenu.copy"), role: "copy" });
  }

  return template;
}

/**
 * Chromium dictionary names for each app language, best first. The second entry
 * is English on purpose: a chat between Brazilians is full of "lag", "stream"
 * and game names, and a word is only underlined when it is wrong in every
 * language listed, so the red squiggles stay on real typos. Spanish prefers the
 * Latin American dictionary (`es-419`) because that is who the app is for.
 */
const SPELLCHECK_PREFERENCES = {
  "pt-BR": ["pt-BR", "en-US"],
  es: ["es-419", "es-ES", "en-US"],
  en: ["en-US"],
};

/**
 * The spellchecker languages to set for an app language: the preference list
 * cut down to dictionaries this Chromium actually has (`session.
 * availableSpellCheckerLanguages`), so we never ask for one it cannot load. For
 * Spanish only the first Spanish dictionary that exists is kept, plus English.
 * Empty when none is known, in which case main.js leaves the OS default alone.
 *
 * @param {string} locale one of `en`, `pt-BR`, `es`
 * @param {readonly string[]} available
 * @returns {string[]}
 */
function spellcheckLanguagesFor(locale, available) {
  const wanted = SPELLCHECK_PREFERENCES[locale] || SPELLCHECK_PREFERENCES.en;
  const have = new Set(Array.isArray(available) ? available : []);
  const out = [];
  let spanishTaken = false;
  for (const code of wanted) {
    if (!have.has(code)) {
      continue;
    }
    const isSpanish = code.startsWith("es");
    if (isSpanish && spanishTaken) {
      continue;
    }
    spanishTaken = spanishTaken || isSpanish;
    out.push(code);
  }
  return out;
}

module.exports = {
  MAX_SUGGESTIONS,
  buildContextMenuTemplate,
  spellcheckLanguagesFor,
};
