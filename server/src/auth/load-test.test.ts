import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertLoadTestAuthConfig,
  isLoadTestAuthEnabled,
  loadTestIdentity,
  LOAD_TEST_TOKEN_MIN_LENGTH,
  resetLoadTestAuthWarning,
} from "./load-test.js";

/**
 * The load-test auth path, which exists to point hundreds of fake clients at a
 * PUBLIC staging hostname. Two properties matter more than anything it does:
 * it is absent when the secret is unset, and it is absent on production.
 *
 * The second one is why `FLY_APP_NAME` is tested as hard as the token is. The
 * container hardcodes `NODE_ENV=production`, so staging and production are
 * indistinguishable by the check the dev bypass uses, and the app name is what
 * separates them.
 */

const TOKEN = "x".repeat(LOAD_TEST_TOKEN_MIN_LENGTH);

const SAVED = {
  token: process.env.LOAD_TEST_TOKEN,
  app: process.env.FLY_APP_NAME,
  nodeEnv: process.env.NODE_ENV,
};

function setEnv(env: {
  token?: string;
  app?: string;
  nodeEnv?: string;
}): void {
  for (const [name, value] of [
    ["LOAD_TEST_TOKEN", env.token],
    ["FLY_APP_NAME", env.app],
    ["NODE_ENV", env.nodeEnv],
  ] as const) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

beforeEach(() => {
  resetLoadTestAuthWarning();
  vi.spyOn(console, "error").mockImplementation(() => {});
  setEnv({});
});

afterEach(() => {
  vi.restoreAllMocks();
  setEnv({
    token: SAVED.token,
    app: SAVED.app,
    nodeEnv: SAVED.nodeEnv,
  });
});

describe("isLoadTestAuthEnabled", () => {
  it("is off when the variable is unset", () => {
    setEnv({ app: "pqp-api-staging" });
    expect(isLoadTestAuthEnabled()).toBe(false);
  });

  it("is off when the variable is empty", () => {
    setEnv({ token: "", app: "pqp-api-staging" });
    expect(isLoadTestAuthEnabled()).toBe(false);
  });

  it("is off for a token shorter than the minimum", () => {
    setEnv({ token: "short", app: "pqp-api-staging" });
    expect(isLoadTestAuthEnabled()).toBe(false);
  });

  it("is on for a long token on a staging Fly app", () => {
    setEnv({ token: TOKEN, app: "pqp-api-staging", nodeEnv: "production" });
    expect(isLoadTestAuthEnabled()).toBe(true);
  });

  /** The whole point of the app-name guard. */
  it("is off on the production Fly app even with the secret set", () => {
    setEnv({ token: TOKEN, app: "pqp-api", nodeEnv: "production" });
    expect(isLoadTestAuthEnabled()).toBe(false);
  });

  it("is off on any Fly app that is not named -staging", () => {
    for (const app of ["pqp-api", "pqp-worker", "pqp-api-2", "staging-pqp"]) {
      setEnv({ token: TOKEN, app, nodeEnv: "production" });
      expect(isLoadTestAuthEnabled()).toBe(false);
    }
  });

  it("says so once when it refuses because of the host", () => {
    setEnv({ token: TOKEN, app: "pqp-api", nodeEnv: "production" });
    isLoadTestAuthEnabled();
    isLoadTestAuthEnabled();
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  describe("off Fly, where the app name says nothing", () => {
    it("is on in development", () => {
      setEnv({ token: TOKEN, nodeEnv: "development" });
      expect(isLoadTestAuthEnabled()).toBe(true);
    });

    it("is on with NODE_ENV unset", () => {
      setEnv({ token: TOKEN });
      expect(isLoadTestAuthEnabled()).toBe(true);
    });

    /** The dev bypass's rule, kept for every host Fly does not name. */
    it("is off under NODE_ENV=production", () => {
      setEnv({ token: TOKEN, nodeEnv: "production" });
      expect(isLoadTestAuthEnabled()).toBe(false);
    });
  });
});

describe("assertLoadTestAuthConfig", () => {
  it("passes when the variable is unset", () => {
    setEnv({});
    expect(() => assertLoadTestAuthConfig()).not.toThrow();
  });

  it("passes for a long token", () => {
    setEnv({ token: TOKEN });
    expect(() => assertLoadTestAuthConfig()).not.toThrow();
  });

  /**
   * Fatal rather than ignored: a short token is guessable, and somebody who
   * set one meant to enable the path. Failing quietly would leave a working
   * backdoor behind a five-character string.
   */
  it("throws for a token below the minimum", () => {
    setEnv({ token: "tooshort" });
    expect(() => assertLoadTestAuthConfig()).toThrow(/LOAD_TEST_TOKEN/);
  });

  /**
   * Blank is "not set". A shell that exports every name in an env file hands
   * the process empty strings for the names nobody filled in, and refusing to
   * boot over one would be a trap: blank authenticates nothing either way.
   */
  it("passes for an empty token", () => {
    setEnv({ token: "" });
    expect(() => assertLoadTestAuthConfig()).not.toThrow();
  });
});

describe("loadTestIdentity", () => {
  beforeEach(() => {
    setEnv({ token: TOKEN, app: "pqp-api-staging", nodeEnv: "production" });
  });

  it("resolves the bare token to one identity", () => {
    expect(loadTestIdentity(TOKEN)).toEqual({
      clerkId: "load_test_user",
      displayName: "Load Test",
    });
  });

  it("resolves a suffix to a distinct identity per suffix", () => {
    expect(loadTestIdentity(`${TOKEN}:a7`)?.clerkId).toBe("load_test_user_a7");
    expect(loadTestIdentity(`${TOKEN}:b9`)?.clerkId).toBe("load_test_user_b9");
  });

  it("refuses a wrong token of the same length", () => {
    expect(loadTestIdentity("y".repeat(TOKEN.length))).toBeNull();
  });

  it("refuses a token that is a prefix of the real one", () => {
    expect(loadTestIdentity(TOKEN.slice(0, -1))).toBeNull();
  });

  it("refuses a token with trailing junk that is not a suffix", () => {
    expect(loadTestIdentity(`${TOKEN}x`)).toBeNull();
  });

  it("refuses the dev bypass token", () => {
    expect(loadTestIdentity("dev-local-token")).toBeNull();
    expect(loadTestIdentity("dev-local-token:bob")).toBeNull();
  });

  it("refuses a suffix outside the alphabet", () => {
    for (const suffix of ["UPPER", "has space", "dot.dot", "a/b", "x".repeat(33), ""]) {
      expect(loadTestIdentity(`${TOKEN}:${suffix}`)).toBeNull();
    }
  });

  it("returns null when the variable is unset", () => {
    setEnv({ app: "pqp-api-staging" });
    expect(loadTestIdentity(TOKEN)).toBeNull();
  });
});
