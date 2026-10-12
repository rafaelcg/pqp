import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "retro-surfaces.css"),
  "utf8",
);

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1] ?? "";
}

describe("the window's toolbar on a phone", () => {
  it("scrolls sideways instead of squeezing its buttons together", () => {
    expect(rule(".retro-tools")).toMatch(/overflow-x:\s*auto/);
    // Without it the pt-BR labels overlapped at 390 px ("FixadasChamar a atençãoBloquear").
    expect(rule(".retro-tool")).toMatch(/flex-shrink:\s*0/);
    expect(rule(".retro-tool")).toMatch(/white-space:\s*nowrap/);
  });
});
