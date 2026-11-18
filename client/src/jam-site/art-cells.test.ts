import { describe, expect, it } from "vitest";
import { artCells } from "./art-cells";

const part = (instrument: string, name = "Ana") =>
  ({ instrument, person: { name, handle: null, avatarUrl: null }, hasVideo: false }) as never;

describe("artCells", () => {
  it("is every part, then the squares for what is missing", () => {
    const cells = artCells({ parts: [part("drums"), part("vocals")], needs: ["bass"] }, 4);
    expect(cells.map((c) => c.kind)).toEqual(["part", "part", "need"]);
  });

  it("never makes the cover a square: it is not a part", () => {
    const cells = artCells({ coverUrl: "https://x/c.jpg", parts: [part("drums")], needs: [] } as never, 4);
    expect(cells.map((c) => c.kind)).toEqual(["part"]);
  });

  it("folds what does not fit into one +N square, keeping the dashed one", () => {
    const parts = ["drums", "guitar", "vocals", "keys", "other"].map((i) => part(i));
    const cells = artCells({ parts, needs: ["bass"] }, 4);
    expect(cells).toHaveLength(4);
    expect(cells.map((c) => c.kind)).toEqual(["part", "part", "need", "more"]);
    // five parts, two shown: three are behind the +N, and it says which instruments
    expect(cells.at(-1)).toEqual({ kind: "more", count: 3, instruments: ["vocals", "keys", "other"] });
  });

  it("counts a dashed square that did not fit with the rest", () => {
    const parts = ["drums", "guitar", "vocals"].map((i) => part(i));
    const cells = artCells({ parts, needs: ["bass", "keys"] }, 3);
    expect(cells).toHaveLength(3);
    expect(cells.at(-1)).toMatchObject({ kind: "more", count: 3 });
  });

  it("shows one dashed square per instrument asked for, at most two", () => {
    const cells = artCells({ parts: [part("drums")], needs: ["bass", "keys", "vocals"] }, 4);
    expect(cells.filter((c) => c.kind === "need")).toHaveLength(2);
  });

  it("is empty for a song with nothing to show and never throws on an unknown instrument", () => {
    expect(artCells({ parts: [], needs: [] }, 4)).toEqual([]);
    const cells = artCells({ parts: [part("theremin")], needs: [] }, 4);
    expect(cells[0]).toMatchObject({ instrument: "other" });
  });
});
