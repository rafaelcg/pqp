import { describe, expect, it } from "vitest";
import { artCells } from "./art-cells";

const part = (instrument: string, name = "Ana") =>
  ({ instrument, person: { name, handle: null, avatarUrl: null }, hasVideo: false }) as never;

describe("artCells", () => {
  it("is every part, then the squares for what is missing", () => {
    const { cells, extra } = artCells(
      { coverUrl: null, parts: [part("drums"), part("vocals")], needs: ["bass"] },
      4,
    );
    expect(cells.map((c) => c.kind)).toEqual(["part", "part", "need"]);
    expect(extra).toBe(0);
  });

  it("puts a cover first", () => {
    const { cells } = artCells({ coverUrl: "https://x/c.jpg", parts: [part("drums")], needs: [] }, 4);
    expect(cells.map((c) => c.kind)).toEqual(["cover", "part"]);
  });

  it("keeps the dashed square when there are too many parts, and counts the rest", () => {
    const parts = ["drums", "guitar", "vocals", "keys", "other"].map((i) => part(i));
    const { cells, extra } = artCells({ coverUrl: null, parts, needs: ["bass"] }, 4);
    expect(cells).toHaveLength(4);
    expect(cells.at(-1)).toMatchObject({ kind: "need", instrument: "bass" });
    expect(extra).toBe(2);
  });

  it("shows one dashed square per instrument asked for, at most two", () => {
    const { cells } = artCells(
      { coverUrl: null, parts: [part("drums")], needs: ["bass", "keys", "vocals"] },
      4,
    );
    expect(cells.filter((c) => c.kind === "need")).toHaveLength(2);
  });

  it("is empty for a song with nothing to show and never throws on an unknown instrument", () => {
    expect(artCells({ coverUrl: null, parts: [], needs: [] }, 4)).toEqual({ cells: [], extra: 0 });
    const { cells } = artCells({ coverUrl: null, parts: [part("theremin")], needs: [] }, 4);
    expect(cells[0]).toMatchObject({ instrument: "other" });
  });
});
