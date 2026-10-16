import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbUser } from "../db.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { completeConnection, startConnection, CONNECTION_SERVICE_ERROR } = await import(
  "./connections.js"
);
const { connectionFailureCounts, resetConnectionFailureState } = await import(
  "./connections-failures.js"
);
const { HttpError } = await import("../lib/http.js");

/**
 * The Twitch / Battle.net half of "connecting failed silently for 17 days":
 * a rotated client secret made the token endpoint answer 403, and the server
 * logged nothing and told the person to try again. These drive
 * `completeConnection` against a fake provider and read what it logged.
 */

const CODE = "authcode-SECRET-1234";
const CLIENT_SECRET = "client-secret-SECRET-5678";
const NONCE = "nonce-abcdef";
const VERIFIER = "verifier-SECRET-9012";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describeDb("completeConnection failures", () => {
  let alice: DbUser;
  const env = { ...process.env };
  let logs: string[];
  let errors: string[];
  let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    process.env.TWITCH_CLIENT_ID = "twitch-client-id";
    process.env.TWITCH_CLIENT_SECRET = CLIENT_SECRET;
    process.env.BATTLENET_CLIENT_ID = "bnet-client-id";
    process.env.BATTLENET_CLIENT_SECRET = CLIENT_SECRET;
    process.env.PUBLIC_APP_URL = "https://pqp.test";
    resetConnectionFailureState();
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    alice = await upsertUser({
      clerkId: "clerk_conn_fail_alice",
      displayName: "Alice",
      avatarUrl: null,
    });
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });
    fetchImpl = async () => {
      throw new Error("unexpected fetch");
    };
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => fetchImpl(String(url), init));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of [
      "TWITCH_CLIENT_ID",
      "TWITCH_CLIENT_SECRET",
      "BATTLENET_CLIENT_ID",
      "BATTLENET_CLIENT_SECRET",
      "PUBLIC_APP_URL",
    ]) {
      if (env[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = env[key];
      }
    }
  });

  async function seedState(
    provider: "twitch" | "battlenet",
    nonce = NONCE,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO connection_oauth_states
         (nonce, user_id, provider, redirect_origin, pkce_verifier)
       VALUES ($1, $2, $3, 'https://pqp.test', $4)`,
      [nonce, alice.id, provider, provider === "twitch" ? VERIFIER : null],
    );
  }

  async function complete(provider: "twitch" | "battlenet", nonce = NONCE) {
    try {
      await completeConnection(alice, provider, { code: CODE, state: nonce });
      return null;
    } catch (error) {
      return error as InstanceType<typeof HttpError>;
    }
  }

  function everything(): string {
    return [...logs, ...errors].join("\n");
  }

  function expectNoSecretsLogged(): void {
    const text = everything();
    for (const secret of [CODE, CLIENT_SECRET, VERIFIER, NONCE, "Bearer"]) {
      expect(text).not.toContain(secret);
    }
  }

  it("answers 502 and raises the credentials alert when the provider rejects the client secret", async () => {
    await seedState("twitch");
    fetchImpl = async () =>
      jsonResponse(403, { status: 403, message: "invalid client secret" });

    const failure = await complete("twitch");

    expect(failure).toBeInstanceOf(HttpError);
    expect(failure?.status).toBe(502);
    expect(failure?.message).toBe(CONNECTION_SERVICE_ERROR);

    const line = logs.find((entry) => entry.includes("connections.completeFailed"));
    expect(line).toBeDefined();
    expect(line).toContain("[pqp]");
    expect(line).toContain("provider=twitch");
    expect(line).toContain(`userId=${alice.id}`);
    expect(line).toContain("step=token_exchange");
    expect(line).toContain("status=502");
    expect(line).toContain("upstreamStatus=403");
    expect(line).toContain("upstreamError=invalid client secret");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "PROVIDER CREDENTIALS REJECTED: check TWITCH_CLIENT_SECRET",
    );
    expect(connectionFailureCounts()).toEqual({ "twitch.token_exchange": 1 });
    expectNoSecretsLogged();
  });

  it("raises the credentials alert once per provider per hour, not once per failure", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    fetchImpl = async () =>
      jsonResponse(403, { status: 403, message: "invalid client secret" });

    await seedState("twitch", "n1");
    await complete("twitch", "n1");
    await seedState("twitch", "n2");
    await complete("twitch", "n2");
    expect(errors).toHaveLength(1);
    // Every failure still leaves the ordinary line and counts.
    expect(
      logs.filter((entry) => entry.includes("connections.completeFailed")),
    ).toHaveLength(2);
    expect(connectionFailureCounts()["twitch.token_exchange"]).toBe(2);

    // Another provider has its own latch.
    await seedState("battlenet", "n3");
    fetchImpl = async () =>
      jsonResponse(401, { error: "invalid_client", error_description: "bad secret" });
    await complete("battlenet", "n3");
    expect(errors).toHaveLength(2);
    expect(errors[1]).toContain("check BATTLENET_CLIENT_SECRET");

    vi.setSystemTime(new Date("2026-10-16T13:00:01Z"));
    fetchImpl = async () =>
      jsonResponse(403, { status: 403, message: "invalid client secret" });
    await seedState("twitch", "n4");
    await complete("twitch", "n4");
    expect(errors).toHaveLength(3);
  });

  it("recognises 'invalid client' on a 400 too (a wrong client id)", async () => {
    await seedState("twitch");
    fetchImpl = async () => jsonResponse(400, { status: 400, message: "invalid client" });

    const failure = await complete("twitch");

    expect(failure?.status).toBe(502);
    expect(errors[0]).toContain("PROVIDER CREDENTIALS REJECTED");
  });

  it("keeps 400 and raises no alert when the provider rejects the person's code", async () => {
    await seedState("twitch");
    fetchImpl = async () =>
      jsonResponse(400, { status: 400, message: "Invalid authorization code" });

    const failure = await complete("twitch");

    expect(failure?.status).toBe(400);
    expect(failure?.message).toBe("Token endpoint returned 400");
    expect(errors).toHaveLength(0);
    const line = logs.find((entry) => entry.includes("connections.completeFailed"));
    expect(line).toContain("step=token_exchange");
    expect(line).toContain("status=400");
    expect(line).toContain("upstreamError=Invalid authorization code");
    expectNoSecretsLogged();
  });

  it("answers 502 without a credentials alert when the provider cannot be reached", async () => {
    await seedState("twitch");
    fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };

    const failure = await complete("twitch");

    expect(failure?.status).toBe(502);
    expect(failure?.message).toBe(CONNECTION_SERVICE_ERROR);
    expect(errors).toHaveLength(0);
    const line = logs.find((entry) => entry.includes("connections.completeFailed"));
    expect(line).toContain("step=token_exchange");
    expect(line).toContain("status=502");
    expect(line).toContain("reason=fetch failed");
    expect(line).not.toContain("upstreamStatus");
  });

  it("does not let a provider that echoes the secret or code leak it into the log", async () => {
    await seedState("twitch");
    fetchImpl = async () =>
      jsonResponse(403, {
        status: 403,
        message: `invalid client secret ${CLIENT_SECRET} for code ${CODE} ${VERIFIER}`,
      });

    await complete("twitch");

    expectNoSecretsLogged();
    expect(everything()).toContain("[redacted]");
  });

  it("names the userinfo step when the token worked and the profile fetch broke", async () => {
    await seedState("twitch");
    fetchImpl = async (url) =>
      url.includes("/oauth2/token")
        ? jsonResponse(200, { access_token: "tok-SECRET-3456" })
        : jsonResponse(500, { status: 500, message: "Internal Server Error" });

    const failure = await complete("twitch");

    expect(failure?.status).toBe(502);
    const line = logs.find((entry) => entry.includes("connections.completeFailed"));
    expect(line).toContain("step=userinfo");
    expect(line).toContain("upstreamStatus=500");
    expect(errors).toHaveLength(0);
    expect(text(logs)).not.toContain("tok-SECRET-3456");
  });

  it("logs a spent or unknown state instead of failing silently, and keeps it 400", async () => {
    const failure = await complete("twitch", "never-issued");

    expect(failure?.status).toBe(400);
    expect(failure?.message).toBe("Connection request expired or was already used");
    const line = logs.find((entry) => entry.includes("connections.completeFailed"));
    expect(line).toContain("step=state_consume");
    expect(line).toContain("provider=twitch");
    expect(everything()).not.toContain("never-issued");
  });

  it("logs a callback that has no state", async () => {
    let failure: unknown;
    try {
      await completeConnection(alice, "twitch", { code: CODE });
    } catch (error) {
      failure = error;
    }
    expect((failure as { status: number }).status).toBe(400);
    expect(logs.join("\n")).toContain("step=state_missing");
  });

  it("logs the provider's own error parameter", async () => {
    let failure: unknown;
    try {
      await completeConnection(alice, "twitch", { error: "access_denied" });
    } catch (error) {
      failure = error;
    }
    expect((failure as { message: string }).message).toBe("Connection was cancelled");
    expect(logs.join("\n")).toContain("step=provider_error");
  });

  it("logs a successful start with provider and user, never the URL", async () => {
    const started = await startConnection(alice, "twitch", "https://pqp.test");

    expect(started.url).toContain("id.twitch.tv");
    const line = logs.find((entry) => entry.includes("connections.start"));
    expect(line).toContain("provider=twitch");
    expect(line).toContain(`userId=${alice.id}`);
    expect(line).not.toContain("http");
    expect(line).not.toContain("state=");
  });
});

function text(lines: string[]): string {
  return lines.join("\n");
}
