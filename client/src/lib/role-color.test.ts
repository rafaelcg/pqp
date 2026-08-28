import { describe, expect, it } from "vitest";
import { STAFF_ROLE_COLORS } from "@pqp/shared";
import {
  hexToHsv,
  hsvFromPointer,
  hsvToHex,
  parseHexColor,
  sameHex,
} from "./role-color";

describe("parseHexColor", () => {
  it("accepts six-digit hex with or without a hash", () => {
    expect(parseHexColor("#4EC4B0")).toBe("#4EC4B0");
    expect(parseHexColor("4ec4b0")).toBe("#4ec4b0");
  });

  it("rejects empty and short values", () => {
    expect(parseHexColor("")).toBeNull();
    expect(parseHexColor("#fff")).toBeNull();
    expect(parseHexColor("nope")).toBeNull();
  });
});

describe("hsv hex round-trip", () => {
  it("survives the staff palette", () => {
    for (const hex of Object.values(STAFF_ROLE_COLORS)) {
      const hsv = hexToHsv(hex);
      expect(hsv).not.toBeNull();
      expect(sameHex(hsvToHex(hsv!), hex)).toBe(true);
    }
  });

  it("keeps primaries", () => {
    expect(sameHex(hsvToHex(hexToHsv("#FF0000")!), "#FF0000")).toBe(true);
    expect(sameHex(hsvToHex(hexToHsv("#00FF00")!), "#00FF00")).toBe(true);
    expect(sameHex(hsvToHex(hexToHsv("#0000FF")!), "#0000FF")).toBe(true);
  });
});

describe("hsvFromPointer", () => {
  const box = { left: 0, top: 0, width: 100, height: 100 };

  it("reads saturation from x and value from y", () => {
    const next = hsvFromPointer({ h: 40, s: 0, v: 0 }, box, 80, 25);
    expect(next.h).toBe(40);
    expect(next.s).toBe(0.8);
    expect(next.v).toBe(0.75);
  });

  it("clamps to the square", () => {
    const next = hsvFromPointer({ h: 10, s: 0, v: 0 }, box, -20, 200);
    expect(next.s).toBe(0);
    expect(next.v).toBe(0);
  });
});
