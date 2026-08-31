import { describe, expect, it } from "vitest";
import {
  DEV_HALL_NAME,
  DEV_HALL_ROSTER,
  shouldSeedDevHall,
} from "./dev-seed.js";

describe("shouldSeedDevHall", () => {
  const on = { DEV_AUTH_BYPASS: "true" };

  it("runs only when the local bypass is on", () => {
    expect(shouldSeedDevHall(on)).toBe(true);
    expect(shouldSeedDevHall({})).toBe(false);
    expect(shouldSeedDevHall({ DEV_AUTH_BYPASS: "false" })).toBe(false);
  });

  it("never runs in production, Vitest, or when opted out", () => {
    expect(shouldSeedDevHall({ ...on, NODE_ENV: "production" })).toBe(false);
    expect(shouldSeedDevHall({ ...on, NODE_ENV: "test" })).toBe(false);
    expect(shouldSeedDevHall({ ...on, VITEST: "true" })).toBe(false);
    expect(shouldSeedDevHall({ ...on, DEV_SEED: "false" })).toBe(false);
  });

  it("still seeds under a development bypass unless opted out", () => {
    expect(shouldSeedDevHall({ ...on, NODE_ENV: "development" })).toBe(true);
    expect(
      shouldSeedDevHall({
        ...on,
        NODE_ENV: "development",
        DEV_SEED: "false",
      }),
    ).toBe(false);
  });
});

describe("DEV_HALL_ROSTER", () => {
  it("is a named Sandbox hall with unique suffixes and mixed cargos", () => {
    expect(DEV_HALL_NAME).toBe("Sandbox");
    const suffixes = DEV_HALL_ROSTER.map((person) => person.suffix);
    expect(new Set(suffixes).size).toBe(suffixes.length);
    expect(DEV_HALL_ROSTER.some((person) => person.staff === "admin")).toBe(
      true,
    );
    expect(DEV_HALL_ROSTER.some((person) => person.staff === "vip")).toBe(true);
    expect(DEV_HALL_ROSTER.some((person) => person.staff === "bot")).toBe(true);
    expect(DEV_HALL_ROSTER.some((person) => person.presence === "offline")).toBe(
      true,
    );
    expect(DEV_HALL_ROSTER.some((person) => person.presence === "online")).toBe(
      true,
    );
  });
});
