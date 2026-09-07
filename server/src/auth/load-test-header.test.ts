import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The load-test branch as `verifyAuthHeader` actually sees it.
 *
 * `load-test.test.ts` pins the predicate; this pins the wiring, which is the
 * half that a refactor can quietly drop. The assertions that matter are the
 * negative ones: with the variable unset, and on the production app, the header
 * that works on staging must resolve to nobody.
 *
 * No database and no Clerk key: `verifyAuthHeader` returns an `AuthUser` from
 * this branch without touching either, and the tokens here are not JWTs, so the
 * Clerk fallthrough fails at decode without a network call.
 */

const TOKEN = "loadtest-".padEnd(48, "z");

process.env.LOAD_TEST_TOKEN = TOKEN;
process.env.FLY_APP_NAME = "pqp-api-staging";
process.env.NODE_ENV = "production";

const { verifyAuthHeader } = await import("./clerk.js");
const { resetLoadTestAuthWarning } = await import("./load-test.js");

beforeEach(() => {
  resetLoadTestAuthWarning();
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.LOAD_TEST_TOKEN = TOKEN;
  process.env.FLY_APP_NAME = "pqp-api-staging";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyAuthHeader with LOAD_TEST_TOKEN", () => {
  it("resolves a suffixed bearer to a distinct identity", async () => {
    const auth = await verifyAuthHeader(`Bearer ${TOKEN}:c41`);
    expect(auth).toEqual({
      clerkId: "load_test_user_c41",
      displayName: "Load Test c41",
      avatarUrl: null,
      emailDomains: [],
    });
  });

  it("grants no email domain, so no SSO domain join", async () => {
    const auth = await verifyAuthHeader(`Bearer ${TOKEN}:c42`);
    expect(auth?.emailDomains).toEqual([]);
  });

  it("refuses the header when the variable is unset", async () => {
    delete process.env.LOAD_TEST_TOKEN;
    expect(await verifyAuthHeader(`Bearer ${TOKEN}:c43`)).toBeNull();
  });

  it("refuses the header on the production app", async () => {
    process.env.FLY_APP_NAME = "pqp-api";
    expect(await verifyAuthHeader(`Bearer ${TOKEN}:c44`)).toBeNull();
  });

  it("refuses a near-miss token on staging", async () => {
    expect(await verifyAuthHeader(`Bearer ${TOKEN}x:c45`)).toBeNull();
  });
});
