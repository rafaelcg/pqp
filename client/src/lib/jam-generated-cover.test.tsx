// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COVER_TOKEN, generatedCoverSpec, JamGeneratedCover } from "./jam-generated-cover";

const ID_A = "0b8f2c1e-4d5a-4e6f-8a7b-1c2d3e4f5a6b";
const ID_B = "7a1d3b2c-9e8f-4a5b-8c6d-0e1f2a3b4c5d";

describe("the cover a song has when nobody picked one", () => {
  it("is the same for the same song, however it is asked", () => {
    expect(generatedCoverSpec(ID_A, ["guitar", "bass"])).toEqual(generatedCoverSpec(ID_A, ["bass", "guitar", "guitar"]));
    expect(generatedCoverSpec(ID_A)).toEqual(generatedCoverSpec(ID_A));
  });

  it("pins one song's picture, so a change of the generator is a decision and not an accident", () => {
    expect(generatedCoverSpec(ID_A, ["guitar", "bass", "drums"])).toMatchInlineSnapshot(`
      {
        "ground": "guitar",
        "shapes": [
          {
            "color": "drums",
            "kind": "quarter",
            "size": 27,
            "turn": 270,
            "x": 18,
            "y": 20,
          },
          {
            "color": "bass",
            "kind": "quarter",
            "size": 39,
            "turn": 270,
            "x": 22,
            "y": 62,
          },
          {
            "color": "bass",
            "kind": "bar",
            "size": 32,
            "turn": 0,
            "x": 64,
            "y": 16,
          },
        ],
      }
    `);
  });

  it("tells most songs apart", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 60; index += 1) {
      seen.add(JSON.stringify(generatedCoverSpec(`song-${index}`, ["guitar", "bass", "vocals"])));
    }
    expect(seen.size).toBeGreaterThan(50);
  });

  it("is always composed: three shapes inside the square, a ground and nothing else", () => {
    for (let index = 0; index < 200; index += 1) {
      const spec = generatedCoverSpec(`id-${index}`, index % 3 === 0 ? [] : ["drums", "keys", "other", "vocals"].slice(0, 1 + (index % 4)));
      expect(spec.shapes).toHaveLength(3);
      for (const shape of spec.shapes) {
        expect(shape.x).toBeGreaterThanOrEqual(0);
        expect(shape.y).toBeGreaterThanOrEqual(0);
        expect(shape.size).toBeGreaterThanOrEqual(26);
        expect(shape.size).toBeLessThan(48);
      }
    }
  });

  it("uses only the instruments on the song, and the dark ink when one instrument leaves nothing else", () => {
    for (let index = 0; index < 100; index += 1) {
      const solo = generatedCoverSpec(`solo-${index}`, ["bass"]);
      expect(solo.ground).toBe("bass");
      expect(new Set(solo.shapes.map((shape) => shape.color))).toEqual(new Set(["ink"]));
      const duo = generatedCoverSpec(`duo-${index}`, ["bass", "keys"]);
      const allowed = new Set(["bass", "keys", "ink"]);
      expect(allowed.has(duo.ground)).toBe(true);
      for (const shape of duo.shapes) expect(allowed.has(shape.color)).toBe(true);
      // a shape never sits in the ground's own colour: it would vanish
      for (const shape of [...solo.shapes, ...duo.shapes]) {
        expect(shape.color).not.toBe(solo.shapes.includes(shape) ? solo.ground : duo.ground);
      }
    }
  });

  it("with no instruments known, the id picks the band, and an unknown instrument reads as `other`", () => {
    const grounds = new Set(Array.from({ length: 80 }, (_, index) => generatedCoverSpec(`none-${index}`).ground));
    expect(grounds.size).toBeGreaterThan(3);
    expect(generatedCoverSpec(ID_B, ["theremin"]).ground).toBe("other");
  });

  it("draws flat opaque shapes in role tokens only: no literal colour, no gradient, no opacity", () => {
    const html = renderToStaticMarkup(<JamGeneratedCover songId={ID_A} instruments={["guitar", "bass", "drums", "vocals"]} />);
    const fills = [...html.matchAll(/fill="([^"]+)"/g)].map((match) => match[1]!);
    expect(fills.length).toBe(4);
    for (const fill of fills) expect(Object.values(COVER_TOKEN)).toContain(fill);
    expect(html).not.toMatch(/gradient|opacity|#[0-9a-f]{3,6}|rgb|oklch|filter|blur/i);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("data-jam-generated-cover");
  });
});
