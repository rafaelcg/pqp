import { afterEach, describe, expect, it } from "vitest";
import { clampLimit, isUuid, resolveCorsOrigin } from "./http.js";

const originalAllowed = process.env.ALLOWED_ORIGINS;

afterEach(() => {
  if (originalAllowed === undefined) {
    delete process.env.ALLOWED_ORIGINS;
  } else {
    process.env.ALLOWED_ORIGINS = originalAllowed;
  }
});

describe("clampLimit", () => {
  it("falls back for missing, non-numeric, and non-positive values", () => {
    expect(clampLimit(null, 50, 100)).toBe(50);
    expect(clampLimit("abc", 50, 100)).toBe(50);
    expect(clampLimit("0", 50, 100)).toBe(50);
    expect(clampLimit("-5", 50, 100)).toBe(50);
    expect(clampLimit("Infinity", 50, 100)).toBe(50);
  });

  it("caps oversized requests", () => {
    expect(clampLimit("100000000", 50, 100)).toBe(100);
  });

  it("passes through and truncates valid values", () => {
    expect(clampLimit("25", 50, 100)).toBe(25);
    expect(clampLimit("25.9", 50, 100)).toBe(25);
  });
});

describe("isUuid", () => {
  it("accepts a canonical uuid in either case", () => {
    expect(isUuid("11111111-2222-4333-8444-555555555555")).toBe(true);
    expect(isUuid("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid("1; DROP TABLE users")).toBe(false);
    expect(isUuid("11111111222243338444555555555555")).toBe(false);
    expect(isUuid("11111111-2222-4333-8444-55555555555")).toBe(false);
  });
});

describe("resolveCorsOrigin", () => {
  it("stays permissive when no allowlist is configured", () => {
    delete process.env.ALLOWED_ORIGINS;
    expect(resolveCorsOrigin("https://anything.example")).toBe("*");
    expect(resolveCorsOrigin(undefined)).toBe("*");
  });

  it("echoes only allowlisted origins", () => {
    process.env.ALLOWED_ORIGINS =
      "https://pqp.gg, https://pqp-3yr.pages.dev/";
    expect(resolveCorsOrigin("https://pqp.gg")).toBe("https://pqp.gg");
    expect(resolveCorsOrigin("https://pqp-3yr.pages.dev")).toBe(
      "https://pqp-3yr.pages.dev",
    );
    expect(resolveCorsOrigin("https://evil.example")).toBeNull();
    expect(resolveCorsOrigin(undefined)).toBeNull();
  });
});
