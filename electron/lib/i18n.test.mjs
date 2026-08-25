import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadLocale, saveLocale, normalize } = require("./locale-state.js");
const { t, setLanguage } = require("./i18n.js");

test("normalize maps OS and saved values the same way as the client", () => {
  assert.equal(normalize("pt-BR"), "pt-BR");
  assert.equal(normalize("pt"), "pt-BR");
  assert.equal(normalize("pt-PT"), "pt-BR");
  assert.equal(normalize("en-US"), "en");
  assert.equal(normalize("de"), null);
});

test("loadLocale prefers the saved file over the OS", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pqp-locale-"));
  saveLocale(dir, "pt-BR");
  assert.equal(loadLocale(dir, "en-US"), "pt-BR");
});

test("malformed locale.json falls back to the OS mapping", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pqp-locale-"));
  fs.writeFileSync(path.join(dir, "locale.json"), "{not json");
  assert.equal(loadLocale(dir, "pt-BR"), "pt-BR");
});

test("string lookup uses {name} interpolation", () => {
  setLanguage("en");
  assert.equal(t("updater.message", { version: "1.2.3" }), "pqp 1.2.3 is ready to install.");
  setLanguage("pt-BR");
  assert.equal(
    t("updater.message", { version: "1.2.3" }),
    "O pqp 1.2.3 está pronto para instalar.",
  );
  setLanguage("en");
});

test("changing language updates menu copy the way an IPC rebuild would", () => {
  setLanguage("en");
  assert.equal(t("menu.edit"), "Edit");
  setLanguage("pt-BR");
  assert.equal(t("menu.edit"), "Editar");
  setLanguage("en");
});

test("every English string has a Portuguese one", () => {
  // The picker's copy is the reason this exists: it is a whole screen of new
  // strings in a bundle nothing type-checks, and a missing key there falls
  // back to English inside an otherwise Portuguese window.
  const en = JSON.parse(
    fs.readFileSync(new URL("../locales/en.json", import.meta.url), "utf8"),
  );
  const pt = JSON.parse(
    fs.readFileSync(new URL("../locales/pt-BR.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(
    Object.keys(en).filter((key) => !(key in pt)),
    [],
  );
  assert.deepEqual(
    Object.keys(pt).filter((key) => !(key in en)),
    [],
  );
});

test("shell copy uses no em dashes", () => {
  for (const file of ["../locales/en.json", "../locales/pt-BR.json"]) {
    const bundle = JSON.parse(fs.readFileSync(new URL(file, import.meta.url), "utf8"));
    for (const [key, value] of Object.entries(bundle)) {
      assert.doesNotMatch(value, /—/, `${key} contains an em dash`);
    }
  }
});

test("the share picker names an unnamed screen in the chosen language", () => {
  // The end-to-end of the labelling: real bundles, real interpolation, real
  // single-brace prefix. A `{index}` left literal on a tile is the failure this
  // catches, and no display is needed to catch it.
  const { normalizeSources, labelSources } = require("./display-sources.js");
  const sources = normalizeSources([
    { id: "screen:0:0", name: "" },
    { id: "screen:1:0", name: "" },
    { id: "window:9:0", name: "" },
  ]);

  setLanguage("en");
  assert.deepEqual(
    labelSources(sources, t).map((s) => s.label),
    ["Screen 1", "Screen 2", "Untitled window"],
  );

  setLanguage("pt-BR");
  assert.deepEqual(
    labelSources(sources, t).map((s) => s.label),
    ["Tela 1", "Tela 2", "Janela sem título"],
  );
  setLanguage("en");
});

test("desktop copy never says browser or navegador", () => {
  const en = JSON.parse(
    fs.readFileSync(new URL("../locales/en.json", import.meta.url), "utf8"),
  );
  const pt = JSON.parse(
    fs.readFileSync(new URL("../locales/pt-BR.json", import.meta.url), "utf8"),
  );
  for (const [key, value] of Object.entries({ ...en, ...pt })) {
    assert.doesNotMatch(
      value.toLowerCase(),
      /navegador|browser/,
      `${key} mentions a browser in the Electron shell`,
    );
  }
});
