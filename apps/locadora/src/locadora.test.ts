import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateAppManifest, type AppManifestSource } from "@pqp/shared";
import { BUTTONS, buildFilePaths, hexAccent } from "./emulator";
import { EMULATOR_LANGUAGE, pickLocale, STRINGS } from "./i18n";
import { ACCEPTED_EXTENSIONS, CORE_ASSETS, CORE_BY_EXTENSION, FRONTEND_FILE_NAMES, NOTICES_ASSET, coreForExtension } from "./systems";

const EM_DASH = String.fromCharCode(0x2014);
const source = JSON.parse(readFileSync(new URL("../manifest.source.json", import.meta.url), "utf8")) as AppManifestSource;

describe("Locadora strings", () => {
  const locales = Object.keys(STRINGS) as Array<keyof typeof STRINGS>;

  it("has the same keys in pt-BR, en and es, none empty", () => {
    expect([...locales].sort()).toEqual(["en", "es", "pt-BR"]);
    const keys = Object.keys(STRINGS["pt-BR"]).sort();
    for (const locale of locales) {
      expect(Object.keys(STRINGS[locale]).sort(), locale).toEqual(keys);
      for (const [key, value] of Object.entries(STRINGS[locale])) expect(value.length, `${locale}.${key}`).toBeGreaterThan(0);
    }
  });

  it("follows the copy rules: no em dash, no voce in pt-BR, no emoji", () => {
    for (const locale of locales) {
      for (const [key, value] of Object.entries(STRINGS[locale])) {
        expect(value.includes(EM_DASH), `${locale}.${key}`).toBe(false);
        expect(/\p{Extended_Pictographic}/u.test(value), `${locale}.${key}`).toBe(false);
      }
    }
    for (const value of Object.values(STRINGS["pt-BR"])) expect(/voc[eê]/i.test(value)).toBe(false);
  });

  it("is honest in all three languages: an emulator, no games provided, the file stays", () => {
    expect(STRINGS["pt-BR"].intro).toContain("só um emulador");
    expect(STRINGS["pt-BR"].intro).toContain("não fornece jogo nenhum");
    expect(STRINGS.en.intro).toContain("only an emulator");
    expect(STRINGS.en.intro).toContain("does not provide any game");
    expect(STRINGS.es.intro).toContain("solo un emulador");
    expect(STRINGS.es.intro).toContain("no proporciona ningún juego");
    expect(STRINGS["pt-BR"].privacy).toContain("nunca é enviado");
    expect(STRINGS.en.privacy).toContain("never sent");
    expect(STRINGS.es.privacy).toContain("Nunca se envía");
  });

  it("says nothing about where a game comes from: no store, download, rom or free-games talk", () => {
    const forbidden = /\b(roms?|download|baix|descarg|grátis|gratis|free|torrent|archive|abandon)/i;
    for (const locale of locales) {
      for (const [key, value] of Object.entries(STRINGS[locale])) expect(forbidden.test(value), `${locale}.${key}: ${value}`).toBe(false);
    }
  });

  it("picks a locale: exact, then base language, then English, and maps it to the emulator's own", () => {
    expect(pickLocale("pt-BR")).toBe("pt-BR");
    expect(pickLocale("pt-PT")).toBe("pt-BR");
    expect(pickLocale("es-MX")).toBe("es");
    expect(pickLocale("ja")).toBe("en");
    expect(EMULATOR_LANGUAGE).toEqual({ "pt-BR": "pt-BR", es: "es-ES", en: "en-US" });
  });
});

describe("Locadora's systems and its manifest", () => {
  const localFiles = source.capabilities.localFiles;

  it("accepts exactly the manifest's list, and each extension has a core", () => {
    expect(localFiles.allowed).toBe(true);
    const accept = localFiles.accept ?? [];
    expect([...accept].sort()).toEqual([...ACCEPTED_EXTENSIONS].sort());
    for (const ext of accept) expect(coreForExtension(ext), ext).not.toBeNull();
    expect(localFiles.maxBytes).toBe(32 * 1024 * 1024);
  });

  it("refuses everything else, archives included, and anything that merely looks like a property name", () => {
    for (const ext of [".zip", ".7z", ".sfc", ".md", ".bin", "", ".", "nes", ".NES", "__proto__", "constructor", "toString"]) {
      expect(coreForExtension(ext), ext).toBeNull();
    }
  });

  it("maps the two cores that ship, and only those", () => {
    expect(new Set(Object.values(CORE_BY_EXTENSION))).toEqual(new Set(["fceumm", "mgba"]));
    expect(coreForExtension(".nes")).toBe("fceumm");
    expect(["gb", "gbc", "gba"].every((e) => coreForExtension(`.${e}`) === "mgba")).toBe(true);
  });

  it("declares every file a core needs, and the notices the app shows, as assets of the manifest, and nothing else", () => {
    const declared = new Set((source.assets ?? []).map((asset) => asset.name));
    const needed = new Set([...Object.values(CORE_ASSETS).flatMap((names) => [names.data, names.report]), NOTICES_ASSET]);
    expect(declared).toEqual(needed);
    // the notices asset is the file the manifest's `license.notices` names
    expect(source.license.notices).toBe(NOTICES_ASSET);
    expect((source.assets ?? []).find((asset) => asset.name === NOTICES_ASSET)?.path).toBe(NOTICES_ASSET);
  });

  it("answers the file names the frontend asks for with the legacy build, by basename", () => {
    const paths = buildFilePaths("mgba", new ArrayBuffer(8), new ArrayBuffer(8));
    expect(Object.keys(paths).sort()).toEqual([FRONTEND_FILE_NAMES.mgba.data, FRONTEND_FILE_NAMES.mgba.report].sort());
    expect(Object.keys(paths)[0]).toMatch(/-legacy-wasm\.data$/);
    for (const url of Object.values(paths)) expect(url.startsWith("blob:")).toBe(true);
  });

  it("is the manifest the brief asks for (D14 and the S0 amendment)", () => {
    expect(validateAppManifest(source, { source: true }).ok).toBe(true);
    expect(source).toMatchObject({
      id: "pqp-locadora",
      publisher: "pqp",
      category: "emulator",
      players: { min: 1, max: 8, spectators: true },
      capabilities: { identity: "display", share: "pane", peer: "none" },
      sandbox: { wasm: true, blobWorkers: false, localBlobs: true },
      license: {
        spdx: "AGPL-3.0-only AND GPL-2.0-or-later AND MPL-2.0 AND GPL-3.0-only",
        notices: "notices.txt",
      },
      notice: "notice",
    });
    const i18n = source.i18n as Record<string, Record<string, string>>;
    expect(i18n["pt-BR"]).toMatchObject({ "presence.phrase": "{name} tá na Locadora", "presence.short": "Na Locadora" });
    expect(i18n.en).toMatchObject({ "presence.phrase": "{name} is at the Locadora", "presence.short": "At the Locadora" });
    expect(i18n.es).toMatchObject({ "presence.phrase": "{name} está en la Locadora", "presence.short": "En la Locadora" });
    for (const locale of ["pt-BR", "en", "es"]) expect(i18n[locale]!.name).toBe("Locadora");
  });
});

describe("the emulator's configuration", () => {
  it("keeps every button that would write, download or leave the frame off", () => {
    for (const key of [
      "saveState", "loadState", "quickSave", "quickLoad", "saveSavFiles", "loadSavFiles", "cacheManager",
      "screenRecord", "screenshot", "cheat", "netplay", "exitEmulation", "diskButton", "fullscreen",
    ] as const) {
      expect(BUTTONS[key], key).toBe(false);
    }
  });

  it("takes only a #rrggbb accent from the host's theme", () => {
    expect(hexAccent("#c8f55a")).toBe("#c8f55a");
    expect(hexAccent(" #C8F55A ")).toBe("#C8F55A");
    for (const bad of [undefined, "", "red", "oklch(0.9 0.2 120)", "#fff", "#c8f55a80", "url(x)"]) expect(hexAccent(bad)).toBeUndefined();
  });
});
