import { describe, expect, it } from "vitest";
import { validateAppManifest, type AppManifest } from "./manifest.js";
import { readFixture } from "./manifest-fixtures.fixture.js";
import { formatAppPresence, resolveAppLocale, resolveAppPresence } from "./presence.js";

const TEMPLATE = "{name} tá na Locadora";

// Written as code points: the characters themselves are invisible in a diff.
const RLO = String.fromCharCode(0x202e);
const PDF = String.fromCharCode(0x202c);
const LRI = String.fromCharCode(0x2066);
const RLI = String.fromCharCode(0x2067);
const FSI = String.fromCharCode(0x2068);
const PDI = String.fromCharCode(0x2069);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

describe("formatAppPresence", () => {
  it("puts the name in the placeholder", () => {
    expect(formatAppPresence(TEMPLATE, "Raf")).toBe("Raf tá na Locadora");
  });

  it("keeps replacement patterns in a name literal", () => {
    expect(formatAppPresence(TEMPLATE, "$&")).toBe("$& tá na Locadora");
    expect(formatAppPresence(TEMPLATE, "$1")).toBe("$1 tá na Locadora");
    expect(formatAppPresence(TEMPLATE, "a$'b$`c$$")).toBe("a$'b$`c$$ tá na Locadora");
  });

  it("does not substitute again inside a name", () => {
    expect(formatAppPresence(TEMPLATE, "{name}")).toBe("{name} tá na Locadora");
    expect(formatAppPresence(TEMPLATE, "x{name}y")).toBe("x{name}y tá na Locadora");
  });

  it("strips bidi override and isolate characters", () => {
    const rlo = `${RLO}evil${PDF}`;
    expect(formatAppPresence(TEMPLATE, rlo)).toBe("evil tá na Locadora");
    expect(formatAppPresence(TEMPLATE, `${LRI}a${RLI}b${FSI}c${PDI}`)).toBe("abc tá na Locadora");
  });

  it("strips C0 and C1 control characters", () => {
    expect(formatAppPresence(TEMPLATE, "a\u0000b\u001Fc\u007Fd\u0085e\u009Ff")).toBe("abcdef tá na Locadora");
    expect(formatAppPresence(TEMPLATE, "a\nb\r\tc")).toBe("abc tá na Locadora");
  });

  it("strips the Unicode line and paragraph separators", () => {
    expect(formatAppPresence(TEMPLATE, `a${LS}b${PS}c`)).toBe("abc tá na Locadora");
  });

  it("trims whitespace", () => {
    expect(formatAppPresence(TEMPLATE, "   Raf  ")).toBe("Raf tá na Locadora");
  });

  it("caps a long name at 32 with a trailing ellipsis", () => {
    const out = formatAppPresence(TEMPLATE, "x".repeat(80));
    expect(out).toBe(`${"x".repeat(31)}… tá na Locadora`);
    expect(Array.from(out.split(" ")[0]!)).toHaveLength(32);
  });

  it("leaves a name of exactly the limit alone", () => {
    expect(formatAppPresence(TEMPLATE, "y".repeat(32))).toBe(`${"y".repeat(32)} tá na Locadora`);
  });

  it("counts code points, not UTF-16 units, so it never splits a pair", () => {
    const out = formatAppPresence(TEMPLATE, "\u{1F600}".repeat(40), { maxNameLength: 5 });
    expect(out).toBe(`${"\u{1F600}".repeat(4)}… tá na Locadora`);
  });

  it("honours maxNameLength", () => {
    expect(formatAppPresence(TEMPLATE, "abcdefghij", { maxNameLength: 4 })).toBe("abc… tá na Locadora");
  });

  it("falls back to ? for an empty name", () => {
    expect(formatAppPresence(TEMPLATE, "")).toBe("? tá na Locadora");
  });

  it("falls back for a name of only control characters", () => {
    expect(formatAppPresence(TEMPLATE, `\u0000\u0007${RLO}${LRI}`)).toBe("? tá na Locadora");
  });

  it("uses a caller supplied fallback name", () => {
    expect(formatAppPresence(TEMPLATE, "  ", { fallbackName: "Alguém" })).toBe("Alguém tá na Locadora");
  });

  it("returns a template with no placeholder unchanged", () => {
    expect(formatAppPresence("Na Locadora", "Raf")).toBe("Na Locadora");
  });

  it("only fills the first placeholder", () => {
    expect(formatAppPresence("{name} e {name}", "Raf")).toBe("Raf e {name}");
  });
});

describe("resolveAppLocale", () => {
  it.each([
    ["pt-BR", "pt-BR"],
    ["pt-br", "pt-BR"],
    ["pt_BR", "pt-BR"],
    ["pt", "pt-BR"],
    ["pt-PT", "pt-BR"],
    ["es", "es"],
    ["es-MX", "es"],
    ["es-AR", "es"],
    ["en", "en"],
    ["en-GB", "en"],
    ["en-US", "en"],
    ["fr", "en"],
    ["", "en"],
    ["zh-Hans", "en"],
  ])("%s resolves to %s", (input, expected) => {
    expect(resolveAppLocale(input)).toBe(expected);
  });
});

describe("resolveAppPresence", () => {
  const result = validateAppManifest(readFixture("valid-locadora"));
  if (!result.ok) throw new Error("fixture must be valid");
  const manifest: AppManifest = result.manifest;

  it("reads the exact locale", () => {
    expect(resolveAppPresence(manifest, "pt-BR", "Raf")).toEqual({
      phrase: "Raf tá na Locadora",
      short: "Na Locadora",
    });
    expect(resolveAppPresence(manifest, "en", "Raf")).toEqual({
      phrase: "Raf is at the Locadora",
      short: "At the Locadora",
    });
    expect(resolveAppPresence(manifest, "es", "Raf")).toEqual({
      phrase: "Raf está en la Locadora",
      short: "En la Locadora",
    });
  });

  it("falls back to the base language", () => {
    expect(resolveAppPresence(manifest, "pt-PT", "Raf").short).toBe("Na Locadora");
    expect(resolveAppPresence(manifest, "es-MX", "Raf").short).toBe("En la Locadora");
    expect(resolveAppPresence(manifest, "en-GB", "Raf").short).toBe("At the Locadora");
  });

  it("falls back to English for any other language", () => {
    expect(resolveAppPresence(manifest, "ja", "Raf")).toEqual({
      phrase: "Raf is at the Locadora",
      short: "At the Locadora",
    });
  });

  it("falls back to English for a key a locale lacks", () => {
    const partial: AppManifest = JSON.parse(JSON.stringify(manifest));
    delete partial.i18n.es["presence.short"];
    expect(resolveAppPresence(partial, "es", "Raf").short).toBe("At the Locadora");
  });

  it("cleans the name like formatAppPresence", () => {
    expect(resolveAppPresence(manifest, "en", `${RLO}evil$&`).phrase).toBe("evil$& is at the Locadora");
  });
});
