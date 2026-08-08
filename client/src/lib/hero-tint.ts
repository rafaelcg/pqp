import type { CSSProperties } from "react";

/**
 * A stable hue for something that has no picture, and the wash built from it.
 *
 * WHAT THIS IS FOR. Three surfaces in this product draw a coloured field behind
 * a name — the directory card, the public profile's banner zone, the public
 * community's hero — and all three have the same problem: the overwhelming
 * majority of subjects will never upload an image, and a page whose top third
 * is a grey rectangle is a page nobody screenshots. Hashing an identifier into
 * a hue gives every subject its own field, stable across loads, pages and
 * devices, and turns "no banner" from a hole into a design.
 *
 * DELIBERATELY A HUE ONLY. Chroma and lightness are fixed in the token layer
 * (`--hero-tint-near` / `--hero-tint-far` in index.css), so every generated
 * field sits at one depth, none of them can outshout the accent, and none can
 * fail contrast against the text on top. This module produces a NUMBER and a
 * style object naming custom properties; it never names a colour, which is what
 * keeps the bench's leak ratchet at zero.
 *
 * THE SECOND HUE IS DERIVED, NOT HASHED. A gradient between two independently
 * hashed hues is occasionally a mud-coloured accident; a fixed offset means the
 * pair is always a related sweep, and 130° is far enough apart to read as two
 * colours rather than as a lighting artefact.
 */

/** How far the far end of the gradient sits from the near end, in degrees. */
const HUE_SPREAD = 130;

/**
 * A seed string as a hue in [0, 360).
 *
 * A classic 31-multiplier string hash; the mask keeps it inside 32 bits rather
 * than drifting into float territory on a long id. `codePointAt` rather than
 * `charCodeAt` so a name that starts with an emoji hashes as one character.
 */
export function heroHue(seed: string): number {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) & 0xffffffff;
  }
  return Math.abs(hash) % 360;
}

/**
 * The inline style a generated field wants: two hues and two strengths, read by
 * the `--hero-tint-*` tokens, plus the gradient that composes them.
 *
 * `strength` is the near end's mix percentage. The far end is deliberately
 * weaker — a gradient that is equally saturated at both ends reads as a flat
 * fill with a colour cast rather than as light falling across something.
 */
export function heroTintStyle(
  hue: number,
  strength: number,
  angle = "135deg",
): CSSProperties {
  return {
    "--hero-hue": String(hue),
    "--hero-hue-far": String((hue + HUE_SPREAD) % 360),
    "--hero-tint-strength": `${strength}%`,
    "--hero-tint-strength-far": `${Math.round(strength * 0.7)}%`,
    backgroundImage: `linear-gradient(${angle}, var(--hero-tint-near), var(--hero-tint-far))`,
  } as CSSProperties;
}

/**
 * The initials a subject with no picture falls back to.
 *
 * First character of the first two words — "Eu odeio acordar cedo" reads as
 * "EO", which is more distinguishable at a glance than a single letter and is
 * how the server rail already draws a serverless avatar. `Array.from` rather
 * than indexing, because a name that starts with an emoji is a surrogate pair
 * and `name[0]` on one of those is half a character.
 */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toUpperCase();
}
