// The module's own source, through Vite's `?raw`, the way
// `marketing-meta.test.ts` reads index.html: the client's tsconfig has no Node
// types and this suite has no business being the file that needs them.
import SOURCE from "./cracha-face.ts?raw";
import { describe, expect, it } from "vitest";

/**
 * The rule this module lives under, asserted rather than promised.
 *
 * Two bugs and a failed build came out of colour handling here. Building
 * translucency by string concatenation produced an invalid colour that
 * `addColorStop` rejected, taking the page down through the error boundary.
 * Hardcoding the palette to work around that then tripped the repository's
 * token-leak ratchet, which exists precisely to stop a colour drifting away
 * from the token layer.
 *
 * The resolution was for this file to hold no colour value at all: it paints
 * only with strings its caller read from the live stylesheet. One convenient
 * constant undoes that by accident, so it is checked here as well as in
 * `bench/theme-tokens.mjs`, where the same failure arrives as a red build and
 * is easier to misread as unrelated.
 */
describe("cracha-face", () => {
  it("contains no colour literal of any kind", () => {
    // The bench's own pattern, so the two cannot disagree about what counts.
    const literal =
      /(?:oklch|rgba?|hsla?)\([^)]*\)|(?<![\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
    expect(SOURCE.match(literal)).toBeNull();
  });
});
