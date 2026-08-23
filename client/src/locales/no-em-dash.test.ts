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

  it("catches one if it comes back", () => {
    // Guards the guard: an assertion that only ever sees clean input is not
    // evidence that it would notice dirty input.
    expect(offences({ "a.key": "before — after" })).toHaveLength(1);
    expect(offences({ "a.key": "push-to-talk stays" })).toEqual([]);
  });
});
