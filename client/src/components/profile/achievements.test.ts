import { describe, expect, it } from "vitest";
import { TURMA_1000_BADGE } from "@pqp/shared";
import type { Translator } from "@/lib/i18n";
import { achievementChipLabel } from "./achievements";

describe("achievementChipLabel", () => {
  const t: Translator["t"] = (key, vars) =>
    key === "publicProfile.achievements.turma1000.chip"
      ? `Turma dos 1000 · #${vars?.n}`
      : key;

  it("prints the founding number without leading zeros", () => {
    expect(
      achievementChipLabel(
        { badge: TURMA_1000_BADGE, name: "Turma dos 1000", ordinal: 3 },
        t,
      ),
    ).toBe("Turma dos 1000 · #3");
  });

  it("leaves caça-bugs as the server-supplied name", () => {
    expect(
      achievementChipLabel(
        { badge: "caca-bugs", name: "Caça-bugs", ordinal: null },
        t,
      ),
    ).toBe("Caça-bugs");
  });
});
