import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHEET_SCRIM, SHEET_SURFACE, SHEET_SURFACE_PHONE } from "@/components/ui/sheet";

const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

function block(selector: string): string {
  const start = css.indexOf(selector);
  return css.slice(start, css.indexOf("\n}\n", start));
}

describe("Sheet surface", () => {
  it("changes nothing with the toggle off: every class is behind the redesign variant", () => {
    for (const recipe of [SHEET_SURFACE, SHEET_SURFACE_PHONE, SHEET_SCRIM]) {
      for (const cls of recipe.split(" ")) {
        expect(cls.startsWith("redesign:")).toBe(true);
      }
    }
  });

  it("is a sheet on a phone only, for a dialog centred on a larger screen", () => {
    for (const cls of SHEET_SURFACE_PHONE.split(" ")) {
      expect(cls.startsWith("redesign:max-sm:")).toBe(true);
    }
  });

  it("defines its tokens in the dark block and overrides fill, lift and scrim in light", () => {
    const dark = block(":root[data-redesign] {");
    for (const token of ["--sheet-radius", "--sheet-surface", "--sheet-edge", "--sheet-shadow", "--sheet-scrim", "--sheet-scrim-blur"]) {
      expect(dark).toContain(`${token}:`);
    }
    const light = block(':root[data-redesign][data-theme="light"] {');
    for (const token of ["--sheet-surface", "--sheet-shadow", "--sheet-scrim"]) {
      expect(light).toContain(`${token}:`);
    }
  });

  it("is drawn by Dialog's phone sheet, the app launcher and the cinema picker", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    expect(read("./dialog.tsx")).toContain("SHEET_SURFACE_PHONE");
    // The full sheet, not the phone-only recipe whose name contains it.
    expect(read("../apps/app-launcher.tsx")).toMatch(/\bSHEET_SURFACE\b(?!_)/);
    expect(read("../voice/cinema-stage.tsx")).toContain("SHEET_SCRIM");
  });
});
