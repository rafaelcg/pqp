import { describe, expect, it } from "vitest";
import {
  BRING_CREW_REMIND_AFTER_MS,
  BRING_CREW_REMIND_BELOW,
  BRING_CREW_WINDOW_MS,
  bringCrewPhase,
} from "./discord-bring-crew.js";

const T0 = Date.parse("2026-10-10T12:00:00Z");
const HOUR = 60 * 60 * 1000;

describe("bringCrewPhase", () => {
  it("is fresh on the first day, whoever came", () => {
    expect(bringCrewPhase(T0, T0, 0)).toBe("fresh");
    expect(bringCrewPhase(T0, T0 + 23 * HOUR, 0)).toBe("fresh");
  });

  it("reminds a day later when fewer than the threshold arrived", () => {
    const later = T0 + BRING_CREW_REMIND_AFTER_MS;
    expect(bringCrewPhase(T0, later, 0)).toBe("reminder");
    expect(bringCrewPhase(T0, later, BRING_CREW_REMIND_BELOW - 1)).toBe("reminder");
  });

  it("does not nag a room that filled up", () => {
    const later = T0 + 2 * BRING_CREW_REMIND_AFTER_MS;
    expect(bringCrewPhase(T0, later, BRING_CREW_REMIND_BELOW)).toBe("fresh");
  });

  it("is over once the window closes, even for an empty room", () => {
    expect(bringCrewPhase(T0, T0 + BRING_CREW_WINDOW_MS, 0)).toBe("over");
    expect(bringCrewPhase(T0, T0 + BRING_CREW_WINDOW_MS - 1, 0)).toBe("reminder");
  });

  it("treats a clock behind the import as fresh rather than over", () => {
    expect(bringCrewPhase(T0, T0 - HOUR, 0)).toBe("fresh");
  });
});
