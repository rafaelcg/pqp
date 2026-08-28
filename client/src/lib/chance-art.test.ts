import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["S", "H", "D", "C"];
const D6 = [1, 2, 3, 4, 5, 6];
const POLYHEDRAL = [4, 8, 10, 12, 20, 100];

describe("chance art files", () => {
  it("has a PNG for every protocol card code", () => {
    const dir = path.resolve(import.meta.dirname, "../assets/chance/cards");
    const files = new Set(readdirSync(dir));
    for (const rank of RANKS) {
      for (const suit of SUITS) {
        expect(files.has(`${rank}${suit}.png`), `${rank}${suit}`).toBe(true);
      }
    }
    expect(files.size).toBe(52);
  });

  it("has Firkin d6 faces and a body for every other roll face", () => {
    const dir = path.resolve(import.meta.dirname, "../assets/chance/dice");
    const files = new Set(readdirSync(dir));
    for (const face of D6) {
      expect(files.has(`d6-${face}.svg`)).toBe(true);
    }
    for (const sides of POLYHEDRAL) {
      expect(files.has(`d${sides}.svg`)).toBe(true);
    }
  });
});
