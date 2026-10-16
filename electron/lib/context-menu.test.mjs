import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const {
  MAX_SUGGESTIONS,
  buildContextMenuTemplate,
  spellcheckLanguagesFor,
} = require("./context-menu.js");

const t = (key) => key;

function actionsLog() {
  const calls = [];
  return {
    calls,
    actions: {
      replaceMisspelling: (w) => calls.push(`replace:${w}`),
      addToDictionary: (w) => calls.push(`add:${w}`),
    },
  };
}

const ALL = {
  canUndo: true,
  canRedo: false,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canSelectAll: true,
};

const labels = (tpl) => tpl.map((i) => i.label ?? i.type);

describe("buildContextMenuTemplate: a misspelled word", () => {
  const params = {
    isEditable: true,
    misspelledWord: "voce",
    dictionarySuggestions: ["você", "voz", "vocês"],
    editFlags: ALL,
  };

  it("leads with the suggestions, then Add to dictionary, then the edit items", () => {
    const { actions } = actionsLog();
    const tpl = buildContextMenuTemplate(params, t, actions);
    assert.deepEqual(labels(tpl), [
      "você",
      "voz",
      "vocês",
      "contextMenu.addToDictionary",
      "separator",
      "contextMenu.undo",
      "contextMenu.redo",
      "separator",
      "contextMenu.cut",
      "contextMenu.copy",
      "contextMenu.paste",
      "contextMenu.selectAll",
    ]);
  });

  it("a suggestion replaces the word, Add to dictionary adds the misspelled one", () => {
    const { calls, actions } = actionsLog();
    const tpl = buildContextMenuTemplate(params, t, actions);
    tpl[1].click();
    tpl.find((i) => i.label === "contextMenu.addToDictionary").click();
    assert.deepEqual(calls, ["replace:voz", "add:voce"]);
  });

  it("caps the suggestions", () => {
    const { actions } = actionsLog();
    const many = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const tpl = buildContextMenuTemplate(
      { ...params, dictionarySuggestions: many },
      t,
      actions,
    );
    const shown = tpl.filter((i) => /^s\d+$/.test(i.label ?? ""));
    assert.equal(shown.length, MAX_SUGGESTIONS);
    assert.deepEqual(
      shown.map((i) => i.label),
      many.slice(0, MAX_SUGGESTIONS),
    );
  });

  it("says so when there is nothing to suggest, and still offers the dictionary", () => {
    const { actions } = actionsLog();
    const tpl = buildContextMenuTemplate(
      { ...params, dictionarySuggestions: [] },
      t,
      actions,
    );
    assert.equal(tpl[0].label, "contextMenu.noSuggestions");
    assert.equal(tpl[0].enabled, false);
    assert.equal(tpl[0].click, undefined);
    assert.equal(tpl[1].label, "contextMenu.addToDictionary");
  });

  it("ignores empty or non-string suggestions", () => {
    const { actions } = actionsLog();
    const tpl = buildContextMenuTemplate(
      { ...params, dictionarySuggestions: ["", "  ", 5, "ok"] },
      t,
      actions,
    );
    assert.equal(tpl[0].label, "ok");
    assert.equal(tpl[1].label, "contextMenu.addToDictionary");
  });

  it("offers no spelling items outside an editable field", () => {
    const { actions } = actionsLog();
    const tpl = buildContextMenuTemplate({ ...params, isEditable: false }, t, actions);
    assert.deepEqual(tpl, []);
  });
});

describe("buildContextMenuTemplate: editable and selection", () => {
  it("an editable field with no typo gets the standard edit items, enabled by the flags", () => {
    const { actions } = actionsLog();
    const tpl = buildContextMenuTemplate(
      { isEditable: true, misspelledWord: "", editFlags: { ...ALL, canCut: false } },
      t,
      actions,
    );
    assert.deepEqual(
      tpl.filter((i) => i.role).map((i) => [i.role, i.enabled]),
      [
        ["undo", true],
        ["redo", false],
        ["cut", false],
        ["copy", true],
        ["paste", true],
        ["selectAll", true],
      ],
    );
  });

  it("selected text outside a field offers Copy only", () => {
    const { actions } = actionsLog();
    const tpl = buildContextMenuTemplate(
      { isEditable: false, selectionText: "texto", editFlags: ALL },
      t,
      actions,
    );
    assert.deepEqual(tpl, [{ label: "contextMenu.copy", role: "copy" }]);
  });

  it("anything else is no menu at all, so links and images keep their behaviour", () => {
    const { actions } = actionsLog();
    assert.deepEqual(buildContextMenuTemplate({}, t, actions), []);
    assert.deepEqual(buildContextMenuTemplate(undefined, t, actions), []);
    assert.deepEqual(
      buildContextMenuTemplate(
        { isEditable: false, linkURL: "https://pqp.gg", srcURL: "x.png", selectionText: " " },
        t,
        actions,
      ),
      [],
    );
  });
});

describe("spellcheckLanguagesFor", () => {
  const AVAILABLE = ["en-US", "pt-BR", "pt-PT", "es-ES", "es-419", "es-MX", "de"];

  it("follows the app language, with English as the second dictionary", () => {
    assert.deepEqual(spellcheckLanguagesFor("pt-BR", AVAILABLE), ["pt-BR", "en-US"]);
    assert.deepEqual(spellcheckLanguagesFor("en", AVAILABLE), ["en-US"]);
  });

  it("keeps one Spanish dictionary, the Latin American one first", () => {
    assert.deepEqual(spellcheckLanguagesFor("es", AVAILABLE), ["es-419", "en-US"]);
    assert.deepEqual(spellcheckLanguagesFor("es", ["es-ES", "en-US"]), ["es-ES", "en-US"]);
  });

  it("drops dictionaries this Chromium does not have", () => {
    assert.deepEqual(spellcheckLanguagesFor("pt-BR", ["en-US"]), ["en-US"]);
    assert.deepEqual(spellcheckLanguagesFor("pt-BR", []), []);
    assert.deepEqual(spellcheckLanguagesFor("pt-BR", undefined), []);
  });

  it("treats an unknown language as English", () => {
    assert.deepEqual(spellcheckLanguagesFor("fr", AVAILABLE), ["en-US"]);
  });
});

describe("locale strings", () => {
  const keys = [
    "contextMenu.undo",
    "contextMenu.redo",
    "contextMenu.cut",
    "contextMenu.copy",
    "contextMenu.paste",
    "contextMenu.selectAll",
    "contextMenu.addToDictionary",
    "contextMenu.noSuggestions",
  ];
  for (const locale of ["en", "pt-BR", "es"]) {
    it(`${locale} has every context menu string, with no em dash and no "voce"`, () => {
      const bundle = JSON.parse(
        readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), "utf8"),
      );
      for (const key of keys) {
        assert.equal(typeof bundle[key], "string", `${locale} missing ${key}`);
        assert.ok(bundle[key].trim() !== "");
        assert.ok(!bundle[key].includes("—"));
        assert.ok(!/\bvoc[eê]\b/i.test(bundle[key]));
      }
    });
  }
});
