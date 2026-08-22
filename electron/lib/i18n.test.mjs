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
