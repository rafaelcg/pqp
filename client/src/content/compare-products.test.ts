import { describe, expect, it } from "vitest";
import { MATRIX_FEATURES, factFor } from "./compare-facts";
import {
  COMPARE_PAGES,
  DISCORD_WHAT,
  MATRIX_PRODUCTS,
  PRODUCT_NAMES,
  WRITE_UPS,
  comparePath,
} from "./compare-products";

const LOCALES = ["pt-BR", "en", "es"] as const;

describe("the /compare product write-ups", () => {
  it("has a write-up, a name and a path for every product with a page", () => {
    expect(COMPARE_PAGES).toEqual(["stoat", "teamspeak", "slack"]);
    for (const product of COMPARE_PAGES) {
      expect(WRITE_UPS[product]).toBeDefined();
      expect(PRODUCT_NAMES[product].length).toBeGreaterThan(0);
      expect(comparePath(product)).toBe(`/compare/${product}`);
    }
    expect(comparePath("discord")).toBe("/vs-discord");
  });

  it("writes every paragraph in all three languages, sourced, without an em dash or a 'você'", () => {
    for (const product of COMPARE_PAGES) {
      const w = WRITE_UPS[product];
      expect(w.sources.length, product).toBeGreaterThan(0);
      for (const url of w.sources) expect(url, product).toMatch(/^https:\/\//);
      for (const field of ["what", "ahead", "different", "pickThem", "pickPqp"] as const) {
        for (const locale of LOCALES) {
          const text = w[field][locale];
          const label = `${product}.${field} ${locale}`;
          expect(text.trim().length, label).toBeGreaterThan(0);
          expect(text, label).not.toContain("—");
          if (locale === "pt-BR") expect(text, label).not.toMatch(/\bvoc[eê](?!s)/i);
        }
      }
    }
    for (const locale of LOCALES) {
      expect(DISCORD_WHAT[locale].length).toBeGreaterThan(0);
    }
  });

  it("sources the sentences about pqp as well as the ones about the other product", () => {
    for (const product of COMPARE_PAGES) {
      const own = WRITE_UPS[product].sources.filter(
        (url) => url.startsWith("https://pqp.gg") || url.startsWith("https://github.com/rafaelcg/pqp"),
      );
      expect(own.length, `${product} has no source for what it says about pqp`).toBeGreaterThan(0);
    }
  });

  it("covers every matrix cell for every column of the hub", () => {
    for (const product of MATRIX_PRODUCTS) {
      for (const feature of MATRIX_FEATURES) {
        const hasFact = factFor(product, feature) !== undefined;
        const notApplicable = product === "discord" && feature === "layoutImport";
        expect(hasFact || notApplicable, `${product}.${feature}`).toBe(true);
      }
    }
  });

  it("says pqp's limits on the hub's own matrix, not only its strengths", () => {
    // The brief for this page: layout import, watch party, open source and
    // free, with the cons included. A cons row that goes missing fails here.
    expect(factFor("pqp", "selfHost")!.value.en).toMatch(/Clerk/);
    expect(factFor("pqp", "ecosystem")!.value.en).toMatch(/No bot store/i);
    expect(factFor("pqp", "apps")!.value.en).toMatch(/beta/i);
    expect(factFor("pqp", "watchParty")!.value.en).toMatch(/early access/i);
  });
});
