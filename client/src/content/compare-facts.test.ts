import { describe, expect, it } from "vitest";
import {
  FACTS,
  FACTS_CHECKED,
  MATRIX_FEATURES,
  NOT_APPLICABLE,
  TELA_SOURCES,
  VS_DISCORD_FEATURES,
  factFor,
  formatCheckedDate,
  sourceLabel,
  type CompareFeature,
  type CompareProduct,
} from "./compare-facts";

const LOCALES = ["pt-BR", "en", "es"] as const;

describe("the comparison facts", () => {
  it("gives every fact at least one https source and a real checked date", () => {
    for (const fact of FACTS) {
      const label = `${fact.product}.${fact.feature}`;
      expect(fact.sources.length, `${label} has no source`).toBeGreaterThan(0);
      for (const url of fact.sources) {
        expect(url, `${label} source`).toMatch(/^https:\/\/[^\s]+$/);
      }
      expect(fact.checked, `${label} checked`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(fact.checked)), `${label} checked`).toBe(false);
      expect(fact.checked <= FACTS_CHECKED, `${label} checked after the sheet's date`).toBe(true);
    }
  });

  it("writes every value in all three languages, without an em dash or a 'você'", () => {
    for (const fact of FACTS) {
      for (const locale of LOCALES) {
        const text = fact.value[locale];
        const label = `${fact.product}.${fact.feature} ${locale}`;
        expect(text.trim().length, label).toBeGreaterThan(0);
        expect(text, label).not.toContain("\u2014");
        if (locale === "pt-BR") {
          expect(text, label).not.toMatch(/\bvoc[eê](?!s)/i);
        }
      }
    }
  });

  it("never talks about another company's troubles", () => {
    const banned =
      /anpd|suspen|\bvpn\b|banid|banned|\bban\b|\bfines?\b|lawsuit|\bmulta\b|\bprocesso\b|\bdemanda\b/i;
    for (const fact of FACTS) {
      for (const locale of LOCALES) {
        expect(fact.value[locale], `${fact.product}.${fact.feature} ${locale}`).not.toMatch(banned);
      }
    }
  });

  it("says 'not verified' in words where a status is unknown", () => {
    const words = {
      "pt-BR": /verific/i,
      en: /not verified|did not verify|found no|not found/i,
      es: /verific|encontramos/i,
    } as const;
    for (const fact of FACTS.filter((f) => f.status === "unknown")) {
      for (const locale of LOCALES) {
        expect(fact.value[locale], `${fact.product}.${fact.feature} ${locale}`).toMatch(words[locale]);
      }
    }
  });

  it("has exactly one fact per product and feature, and none missing", () => {
    const seen = new Set<string>();
    for (const fact of FACTS) {
      const key = `${fact.product}.${fact.feature}`;
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.add(key);
    }
    const products = [...new Set(FACTS.map((f) => f.product))] as CompareProduct[];
    expect(products).toContain("pqp");
    expect(products).toContain("discord");
    for (const product of products) {
      const na = NOT_APPLICABLE[product] ?? [];
      const wanted = new Set<CompareFeature>(
        product === "pqp" || product === "discord"
          ? [...MATRIX_FEATURES, ...VS_DISCORD_FEATURES]
          : MATRIX_FEATURES,
      );
      for (const feature of wanted) {
        if (na.includes(feature)) {
          expect(factFor(product, feature), `${product}.${feature} is not applicable`).toBeUndefined();
        } else {
          expect(factFor(product, feature), `${product}.${feature} missing`).toBeDefined();
        }
      }
    }
  });

  it("sources every card on /tela", () => {
    for (const [id, urls] of Object.entries(TELA_SOURCES)) {
      expect(urls.length, id).toBeGreaterThan(0);
      for (const url of urls) {
        expect(url, id).toMatch(/^https:\/\//);
      }
    }
  });

  it("formats the date for a reader and labels a source by its host", () => {
    expect(formatCheckedDate("2026-10-16", "en")).toBe("October 16, 2026");
    expect(formatCheckedDate("2026-10-16", "pt-BR")).toBe("16 de outubro de 2026");
    expect(formatCheckedDate("2026-10-16", "es")).toBe("16 de octubre de 2026");
    expect(sourceLabel("https://www.example.com/a?b=1")).toBe("example.com");
  });
});
