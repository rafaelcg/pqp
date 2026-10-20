import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EMULATOR_ALLOWLIST } from "./allowlist";
import { EMULATOR_ACCEPT, systemForFileName } from "./systems";

describe("the emulator room's allowlist", () => {
  it("is EMPTY: pqp provides no game, and an entry needs a human and the lawyer review first", () => {
    expect(EMULATOR_ALLOWLIST).toEqual([]);
  });

  it("says in the file itself what an entry must be", () => {
    const text = readFileSync(path.join(import.meta.dirname, "allowlist.ts"), "utf8");
    expect(text).toMatch(/Homebrew or public-domain titles ONLY/);
    expect(text).toMatch(/VERIFIED BY A HUMAN/);
    expect(text).toMatch(/docs\/EMULATOR_ROOM\.md/);
  });
});

describe("what the room accepts", () => {
  it("runs the extensions of the two shipped cores and nothing else", () => {
    expect(EMULATOR_ACCEPT).toBe(".nes,.gb,.gbc,.gba");
    expect(systemForFileName("a.nes")).toBe("nes");
    expect(systemForFileName("a.GBA")).toBe("gba");
    expect(systemForFileName("a.gb")).toBe("gb");
    expect(systemForFileName("a.gbc")).toBe("gbc");
  });

  it("refuses the systems whose cores were refused for their license, archives and discs", () => {
    for (const name of [
      "a.sfc",
      "a.smc",
      "a.md",
      "a.gen",
      "a.smd",
      "a.nds",
      "a.iso",
      "a.bin",
      "a.chd",
      "a.cue",
      "a.zip",
      "a.7z",
      "nes",
      "",
    ]) {
      expect(systemForFileName(name), name).toBeNull();
    }
  });
});
