import { describe, expect, it } from "vitest";
import type { DiscordImportArrivals } from "@pqp/shared";
import { bringCrewStrip } from "./bring-crew";

const base: DiscordImportArrivals = {
  enabled: true,
  importedAt: "2026-10-10T12:00:00.000Z",
  phase: "fresh",
  arrived: 0,
  viaLink: 0,
  inviteCode: "AbC123",
};

describe("bringCrewStrip", () => {
  it("draws nothing with the flag off, for a server that was not imported, or after the week", () => {
    expect(bringCrewStrip(null, null)).toBeNull();
    expect(bringCrewStrip({ ...base, enabled: false }, null)).toBeNull();
    expect(bringCrewStrip({ ...base, phase: null, importedAt: null }, null)).toBeNull();
    expect(bringCrewStrip({ ...base, phase: "over" }, null)).toBeNull();
  });

  it("asks for the announcement while nobody has come", () => {
    expect(bringCrewStrip(base, null)).toEqual({ kind: "empty", count: 0 });
  });

  it("counts who came", () => {
    expect(bringCrewStrip({ ...base, arrived: 12 }, null)).toEqual({
      kind: "arrived",
      count: 12,
    });
  });

  it("reminds a day later, even after the first-day strip was closed", () => {
    const reminder = { ...base, phase: "reminder" as const, arrived: 1 };
    expect(bringCrewStrip(reminder, "fresh")).toEqual({ kind: "reminder", count: 1 });
  });

  it("stays closed once the reminder was closed", () => {
    expect(bringCrewStrip({ ...base, phase: "reminder" }, "reminder")).toBeNull();
    expect(bringCrewStrip({ ...base, arrived: 5 }, "reminder")).toBeNull();
  });

  it("closing the first-day strip hides it for the first day", () => {
    expect(bringCrewStrip(base, "fresh")).toBeNull();
  });
});
