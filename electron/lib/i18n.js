const fs = require("node:fs");
const path = require("node:path");
const i18next = require("i18next");

function localesDir() {
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, "locales");
    if (fs.existsSync(packaged)) {
      return packaged;
    }
  }
  return path.join(__dirname, "../locales");
}

function readBundle(locale) {
  const file = path.join(localesDir(), `${locale}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

let initialized = false;

function ensureInit() {
  if (initialized) {
    return i18next;
  }
  const en = readBundle("en");
  let ptBR = {};
  try {
    ptBR = readBundle("pt-BR");
  } catch {
    // English-only until the Portuguese file is on disk.
  }
  i18next.init({
    lng: "en",
    fallbackLng: "en",
    initAsync: false,
    returnNull: false,
    returnEmptyString: false,
    keySeparator: false,
    nsSeparator: false,
    interpolation: {
      prefix: "{",
      suffix: "}",
      escapeValue: false,
    },
    resources: {
      en: { translation: en },
      "pt-BR": { translation: ptBR },
    },
  });
  initialized = true;
  return i18next;
}

function setLanguage(locale) {
  ensureInit();
  i18next.changeLanguage(locale === "pt-BR" ? "pt-BR" : "en");
}

function t(key, vars) {
  ensureInit();
  const result = i18next.t(key, vars);
  return typeof result === "string" ? result : String(result);
}

module.exports = {
  setLanguage,
  t,
  localesDir,
};
