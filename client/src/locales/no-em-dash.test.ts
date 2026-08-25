import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "./en/translation.json";
import ptBR from "./pt-BR/translation.json";

/**
 * No em dash reaches a user, in either language.
 *
 * WHY THIS IS A TEST AND NOT A STYLE NOTE. "No em dashes" is a standing rule
 * for this product's voice, and it had already been broken 184 times across the
 * two catalogues before anyone counted — including in `landing.pitch.body`, the
 * single most-read paragraph on the site. A rule nobody can enforce is a
 * preference, and a preference loses to whoever is typing that day.
 *
 * The en dash and the horizontal bar are here too. They are not the character
 * the rule names, but they are what a well-meaning search-and-replace reaches
 * for next, and they read identically at body size.
 *
 * A hyphen is fine and deliberately not matched: `push-to-talk` and
 * `peer-to-peer` are words, not punctuation.
 */
const BANNED: Record<string, string> = {
  "—": "em dash",
  "–": "en dash",
  "―": "horizontal bar",
};

function offences(catalogue: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(catalogue)) {
    if (typeof value !== "string") continue;
    for (const [char, name] of Object.entries(BANNED)) {
      if (value.includes(char)) {
        found.push(`${key} (${name}): ${value.slice(0, 80)}`);
      }
    }
  }
  return found;
}

describe("user-facing copy carries no dash punctuation", () => {
  it("pt-BR", () => {
    expect(offences(ptBR as Record<string, unknown>)).toEqual([]);
  });

  it("en", () => {
    expect(offences(en as Record<string, unknown>)).toEqual([]);
  });

  /**
   * The static head, which the catalogues do not reach.
   *
   * `client/index.html` carries the `<title>`, the Open Graph and Twitter
   * cards, and the JSON-LD description. That copy is not in either catalogue,
   * so this guard walked straight past it and it drifted: six user-facing em
   * dashes, including `og:title`, which is the line that renders on every link
   * card the project posts. It was live for as long as anybody had been
   * enforcing the rule everywhere else.
   *
   * The whole file is scanned rather than the user-facing attributes alone.
   * Parsing HTML to decide which strings a person will read is more ways to be
   * wrong than the thing is worth, and nothing in this file has a legitimate
   * use for the character, comments included.
   */
  it("the static head in index.html", () => {
    const html = readFileSync(
      fileURLToPath(new URL("../../index.html", import.meta.url)),
      "utf8",
    );
    const found = Object.entries(BANNED)
      .filter(([char]) => html.includes(char))
      .map(([, name]) => name);
    expect(found).toEqual([]);
  });

  it("catches one if it comes back", () => {
    // Guards the guard: an assertion that only ever sees clean input is not
    // evidence that it would notice dirty input.
    expect(offences({ "a.key": "before — after" })).toHaveLength(1);
    expect(offences({ "a.key": "push-to-talk stays" })).toEqual([]);
  });
});
