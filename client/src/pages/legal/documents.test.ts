/**
 * Keeps the two languages of each legal page honest about each other.
 *
 * The failure this exists to prevent: somebody edits a clause in English, ships
 * it, and the Portuguese page keeps promising the old thing to the people the
 * Portuguese page is for. Nothing about a second file makes that visible on its
 * own — a translation is still valid TypeScript after its source moves. So the
 * checks below turn every kind of drift into a red test that names the section.
 */

import { describe, expect, it } from "vitest";
import { cookiesEn } from "./cookies.en";
import { cookiesPtBr } from "./cookies.pt-BR";
import type { LegalDocument } from "./document";
import { privacyEn } from "./privacy.en";
import { privacyPtBr } from "./privacy.pt-BR";
import { sectionFingerprint, sectionText } from "./source-rev";
import { termsEn } from "./terms.en";
import { termsPtBr } from "./terms.pt-BR";

const PAGES: { name: string; en: LegalDocument; ptBR: LegalDocument }[] = [
  { name: "terms", en: termsEn, ptBR: termsPtBr },
  { name: "privacy", en: privacyEn, ptBR: privacyPtBr },
  { name: "cookies", en: cookiesEn, ptBR: cookiesPtBr },
];

const ALL = PAGES.flatMap((page) => [
  { name: `${page.name} (en)`, doc: page.en },
  { name: `${page.name} (pt-BR)`, doc: page.ptBR },
]);

function documentText(doc: LegalDocument): string {
  return doc.sections.map((section) => sectionText(section)).join(" ");
}

/**
 * Article and statute references are the part of a policy that has to be
 * identical in both languages: a citation that drifts points at a different
 * rule. Only the numbers are compared — the subsection lists around them read
 * differently in Portuguese ("I and II" / "I e II") without meaning anything
 * different.
 */
function citations(doc: LegalDocument): Set<string> {
  const text = documentText(doc);
  const found = [
    ...text.matchAll(/\barts?\. \d+(?:\(\d+\))?|Lei nº [\d.]+\/\d{4}/g),
  ];
  return new Set(found.map((match) => match[0]));
}

describe.each(PAGES)("$name", ({ en, ptBR }) => {
  it("declares the same sections, in the same order", () => {
    expect(ptBR.sections.map((section) => section.id)).toEqual(
      en.sections.map((section) => section.id),
    );
  });

  it("routes to the same path", () => {
    expect(ptBR.path).toBe(en.path);
  });

  it("declares its own locale and a last-updated date", () => {
    expect(en.locale).toBe("en");
    expect(ptBR.locale).toBe("pt-BR");
    expect(en.updated).not.toBe("");
    expect(ptBR.updated).not.toBe("");
  });

  /**
   * The load-bearing check. `sourceRev` is a fingerprint of the English section
   * the translation was written against, so an edit to the English prose
   * invalidates it automatically — no discipline required from whoever made the
   * edit, which is the whole point. When this fails, re-read the Portuguese and
   * stamp the value printed in the message.
   */
  it.each(en.sections.map((section) => ({ id: section.id })))(
    "pt-BR $id was translated against the current English",
    ({ id }) => {
      const source = en.sections.find((section) => section.id === id)!;
      const translated = ptBR.sections.find((section) => section.id === id);
      expect(translated, `pt-BR is missing the "${id}" section`).toBeDefined();
      const expected = sectionFingerprint(source);
      expect(
        translated!.sourceRev,
        `The English "${id}" section has changed since it was translated. ` +
          `Re-read the Portuguese, then set sourceRev: "${expected}".`,
      ).toBe(expected);
    },
  );

  it("keeps every legal citation the English makes", () => {
    const fromPt = citations(ptBR);
    for (const citation of citations(en)) {
      expect(
        [...fromPt],
        `pt-BR dropped the citation "${citation}"`,
      ).toContain(citation);
    }
  });

  it("keeps the contact address reachable in both languages", () => {
    expect(documentText(en)).toContain("contato@pqp.gg");
    expect(documentText(ptBR)).toContain("contato@pqp.gg");
  });
});

describe.each(ALL)("$name", ({ doc }) => {
  it("has no unfilled placeholder tokens", () => {
    for (const section of doc.sections) {
      expect(
        sectionText(section),
        `"${section.id}" still has a {{PLACEHOLDER}}`,
      ).not.toMatch(/\{\{[A-Z_]+\}\}/);
    }
  });

  it("gives every section a unique id", () => {
    const ids = doc.sections.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the product name spelled pqp", () => {
    const text = documentText(doc);
    expect(text).toContain("pqp");
    expect(text).not.toMatch(/\bPQP\b/);
  });
});
