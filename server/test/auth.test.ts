import { afterEach, describe, expect, it } from "vitest";

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
});

describe("isDevAuthBypassEnabled", () => {
  it("is false when the flag is unset", async () => {
    delete process.env.DEV_AUTH_BYPASS;
    const { isDevAuthBypassEnabled } = await import("../dist/auth/clerk.js");
    expect(isDevAuthBypassEnabled()).toBe(false);
  });

  it("is true when set outside production", async () => {
    process.env.DEV_AUTH_BYPASS = "true";
    process.env.NODE_ENV = "test";
    const { isDevAuthBypassEnabled } = await import("../dist/auth/clerk.js");
    expect(isDevAuthBypassEnabled()).toBe(true);
  });

  it("is ignored in production even when set", async () => {
    process.env.DEV_AUTH_BYPASS = "true";
    process.env.NODE_ENV = "production";
    const { isDevAuthBypassEnabled } = await import("../dist/auth/clerk.js");
    expect(isDevAuthBypassEnabled()).toBe(false);
  });
});
