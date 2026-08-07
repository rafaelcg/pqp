import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { WebSocket } from "ws";
import type { AgeGateStatus } from "@pqp/shared";

/**
 * The 18+ gate, end to end, with NOTHING about authentication stubbed.
 *
 * Every other suite that drives `handleApi` replaces `auth/clerk.js` wholesale,
 * which would also replace the thing being tested here — the gate lives inside
 * that module for the WebSocket path and immediately after it for the HTTP one.
 * So this file authenticates through the real code by switching on the dev
 * bypass, which mints an identity from a fixed token without a network call and
 * refuses to run under NODE_ENV=production.
 *
 * What has to hold, and why each one is here rather than left to the client:
 *
 *  - a pending account is refused on HTTP *and* on the WebSocket;
 *  - it can still read `/api/me`, answer the question, and reach its LGPD
 *    art. 18 routes;
 *  - answering under 18 blocks the account, and a second answer is refused;
 *  - accounts that predate the column are prompted, not grandfathered.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}
process.env.DEV_AUTH_BYPASS = "true";

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { clearAuthCaches, DEV_AUTH_TOKEN } = await import("../auth/clerk.js");
const { handleWsConnection } = await import("../ws/index.js");

let server: Server;
let baseUrl: string;

interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

/**
 * A distinct local identity per test. The dev bypass turns `token:suffix` into
 * `dev_local_user_<suffix>`, which is what lets one suite hold a pending
 * account, a blocked one and an adult one at the same time.
 */
function tokenFor(suffix: string): string {
  return `${DEV_AUTH_TOKEN}:${suffix}`;
}

async function call<T = Record<string, unknown>>(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
  };
}

/** Today minus `years`, as `YYYY-MM-DD` — a date that is unambiguously past. */
function birthdayYearsAgo(years: number): string {
  const now = new Date();
  const year = now.getUTCFullYear() - years;
  return `${year}-01-02`;
}

const ADULT_DOB = birthdayYearsAgo(30);
const CHILD_DOB = birthdayYearsAgo(12);

/** Sign in once and clear the gate, the way a real adult account starts. */
async function adultAccount(suffix: string): Promise<string> {
  const token = tokenFor(suffix);
  const declared = await call<{ ageGate: AgeGateStatus }>(
    token,
    "POST",
    "/api/me/age-check",
    { dateOfBirth: ADULT_DOB },
  );
  expect(declared.status).toBe(200);
  expect(declared.body.ageGate).toBe("passed");
  return token;
}

interface FakeSocket {
  socket: WebSocket;
  sent: string[];
  closedWith: () => { code: number; reason: string } | null;
  deliver: (frame: unknown) => void;
}

/**
 * The three members `handleWsConnection` touches, plus a record of what it did.
 * `close` is the observable that matters: a refused socket takes the same
 * 4401 path a bad token takes, which is exactly the point of putting the gate
 * inside `resolveAuthUser` rather than adding a branch to the socket handler.
 */
function fakeSocket(): FakeSocket {
  const handlers = new Map<string, (...args: never[]) => void>();
  const sent: string[] = [];
  let closed: { code: number; reason: string } | null = null;

  const socket = {
    readyState: 1,
    send: (payload: string) => {
      sent.push(payload);
    },
    ping: () => {},
    terminate: () => {},
    close: (code: number, reason: string) => {
      closed = { code, reason };
      socket.readyState = 3;
    },
    on: (event: string, fn: (...args: never[]) => void) => {
      handlers.set(event, fn);
      return socket;
    },
  };

  return {
    socket: socket as unknown as WebSocket,
    sent,
    closedWith: () => closed,
    deliver: (frame: unknown) => {
      handlers.get("message")?.(JSON.stringify(frame) as never);
    },
  };
}

/**
 * Drive one WebSocket handshake to its conclusion: either a `ready` frame or a
 * close. The handler is fire-and-forget by design (a throwing handler must not
 * become an unhandled rejection), so the outcome has to be waited for.
 */
async function handshake(
  token: string,
): Promise<{ ready: boolean; close: { code: number; reason: string } | null }> {
  const fake = fakeSocket();
  handleWsConnection(fake.socket, `test-${token}`);
  fake.deliver({ type: "auth", token });

  await vi.waitFor(() => {
    const settled =
      fake.closedWith() !== null ||
      fake.sent.some((raw) => raw.includes('"ready"'));
    expect(settled).toBe(true);
  });

  return {
    ready: fake.sent.some((raw) => raw.includes('"ready"')),
    close: fake.closedWith(),
  };
}

describeDb("18+ age gate", () => {
  beforeAll(async () => {
    await initDb();
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    // The DB row for an identity is cached for 30s; a truncate without this
    // leaves the next test authenticating as a user id that no longer exists.
    clearAuthCaches();
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, server_bans,
                channel_reads, message_mentions, message_reactions,
                message_attachments, user_blocks, dm_pairs, link_embeds
       RESTART IDENTITY CASCADE`,
    );
  });

  // ------------------------------------------------------------ new accounts

  it("starts a brand-new account pending", async () => {
    const me = await call<{ ageGate: AgeGateStatus }>(
      tokenFor("fresh"),
      "GET",
      "/api/me",
    );
    expect(me.status).toBe(200);
    expect(me.body.ageGate).toBe("pending");
  });

  it("refuses every non-exempt route while pending", async () => {
    const token = tokenFor("pending");
    // Create the row first, so the refusals below are the gate and not a
    // half-made account.
    await call(token, "GET", "/api/me");

    for (const [method, path] of [
      ["GET", "/api/servers"],
      ["GET", "/api/dms"],
      ["GET", "/api/blocks"],
      ["GET", "/api/ice-servers"],
      ["POST", "/api/servers"],
      ["PATCH", "/api/me/preferences"],
      ["GET", "/api/users/search?q=someone"],
      // Even a route that does not exist: a refused account has no business
      // learning which paths are real.
      ["GET", "/api/definitely-not-a-route"],
    ] as const) {
      const res = await call(token, method, path);
      expect(`${method} ${path} -> ${res.status}`).toBe(
        `${method} ${path} -> 403`,
      );
    }
  });

  it("still lets a pending account read /api/me and answer", async () => {
    const token = tokenFor("answerer");
    expect((await call(token, "GET", "/api/me")).status).toBe(200);

    const declared = await call<{ ageGate: AgeGateStatus }>(
      token,
      "POST",
      "/api/me/age-check",
      { dateOfBirth: ADULT_DOB },
    );
    expect(declared.status).toBe(200);
    expect(declared.body.ageGate).toBe("passed");

    // And the very next request goes through — no cache to wait out.
    expect((await call(token, "GET", "/api/servers")).status).toBe(200);
  });

  it("leaves the LGPD art. 18 routes reachable while refused", async () => {
    const token = tokenFor("lgpd");
    await call(token, "GET", "/api/me");

    // These belong to the account-deletion work stream and may not exist yet,
    // so what is asserted is that the *gate* is not what stopped them: a 404 or
    // 405 from the router means the request got past enforcement.
    for (const [method, path] of [
      ["DELETE", "/api/me"],
      ["GET", "/api/me/export"],
    ] as const) {
      const res = await call(token, method, path);
      expect(`${method} ${path} -> ${res.status}`).not.toBe(
        `${method} ${path} -> 403`,
      );
    }
  });

  it("refuses the WebSocket handshake while pending", async () => {
    const token = tokenFor("wspending");
    await call(token, "GET", "/api/me");

    const result = await handshake(token);
    expect(result.ready).toBe(false);
    expect(result.close?.code).toBe(4401);
  });

  it("admits the WebSocket once the gate is passed", async () => {
    const token = await adultAccount("wsadult");
    const result = await handshake(token);
    expect(result.ready).toBe(true);
    expect(result.close).toBeNull();
  });

  // -------------------------------------------------------------- under 18

  it("blocks the account when the declared date is under 18", async () => {
    const token = tokenFor("child");
    const declared = await call<{ ageGate: AgeGateStatus }>(
      token,
      "POST",
      "/api/me/age-check",
      { dateOfBirth: CHILD_DOB },
    );
    // Recording the answer succeeded; the answer is what refuses.
    expect(declared.status).toBe(200);
    expect(declared.body.ageGate).toBe("blocked");

    const me = await call<{ ageGate: AgeGateStatus }>(token, "GET", "/api/me");
    expect(me.body.ageGate).toBe("blocked");
  });

  it("refuses a blocked account on HTTP and on the WebSocket", async () => {
    const token = tokenFor("blocked");
    await call(token, "POST", "/api/me/age-check", { dateOfBirth: CHILD_DOB });

    const http = await call<{ error: string }>(token, "GET", "/api/servers");
    expect(http.status).toBe(403);
    expect(http.body.error).toMatch(/cannot be used/i);

    const ws = await handshake(token);
    expect(ws.ready).toBe(false);
    expect(ws.close?.code).toBe(4401);
  });

  it("keeps a blocked account's own data reachable", async () => {
    const token = tokenFor("blockedlgpd");
    await call(token, "POST", "/api/me/age-check", { dateOfBirth: CHILD_DOB });

    expect((await call(token, "GET", "/api/me")).status).toBe(200);
    expect((await call(token, "DELETE", "/api/me")).status).not.toBe(403);
    expect((await call(token, "GET", "/api/me/export")).status).not.toBe(403);
  });

  // ------------------------------------------------------------- no retries

  it("refuses a second answer after failing the first", async () => {
    const token = tokenFor("retrier");
    const first = await call<{ ageGate: AgeGateStatus }>(
      token,
      "POST",
      "/api/me/age-check",
      { dateOfBirth: CHILD_DOB },
    );
    expect(first.body.ageGate).toBe("blocked");

    const second = await call<{ error: string }>(
      token,
      "POST",
      "/api/me/age-check",
      { dateOfBirth: ADULT_DOB },
    );
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already answered/i);

    // And the stored answer did not move.
    const me = await call<{ ageGate: AgeGateStatus }>(token, "GET", "/api/me");
    expect(me.body.ageGate).toBe("blocked");
    const stored = await getPool().query<{ age_check_passed: boolean }>(
      `SELECT age_check_passed FROM users WHERE clerk_id = 'dev_local_user_retrier'`,
    );
    expect(stored.rows[0]?.age_check_passed).toBe(false);
  });

  it("refuses a second answer after passing the first", async () => {
    const token = await adultAccount("repeater");
    const second = await call(token, "POST", "/api/me/age-check", {
      dateOfBirth: CHILD_DOB,
    });
    expect(second.status).toBe(409);
    expect((await call(token, "GET", "/api/servers")).status).toBe(200);
  });

  it("refuses concurrent answers except one", async () => {
    const token = tokenFor("racer");
    await call(token, "GET", "/api/me");

    const [a, b] = await Promise.all([
      call(token, "POST", "/api/me/age-check", { dateOfBirth: ADULT_DOB }),
      call(token, "POST", "/api/me/age-check", { dateOfBirth: CHILD_DOB }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  // --------------------------------------------------------- malformed input

  it("does not spend the attempt on an unusable date", async () => {
    const token = tokenFor("typist");
    for (const dateOfBirth of [
      "2007-02-30",
      "not-a-date",
      "1990-7-4",
      "0208-01-01",
      `${new Date().getUTCFullYear() + 5}-01-01`,
    ]) {
      const res = await call(token, "POST", "/api/me/age-check", {
        dateOfBirth,
      });
      expect(`${dateOfBirth} -> ${res.status}`).toBe(`${dateOfBirth} -> 400`);
    }

    // Still unanswered, so the real date of birth is still accepted.
    const declared = await call<{ ageGate: AgeGateStatus }>(
      token,
      "POST",
      "/api/me/age-check",
      { dateOfBirth: ADULT_DOB },
    );
    expect(declared.body.ageGate).toBe("passed");
  });

  it("refuses a body that is not a declaration at all", async () => {
    const token = tokenFor("emptybody");
    expect((await call(token, "POST", "/api/me/age-check", {})).status).toBe(
      400,
    );
    expect(
      (await call(token, "POST", "/api/me/age-check", { dateOfBirth: 19900704 }))
        .status,
    ).toBe(400);
  });

  // ------------------------------------------------------- existing accounts

  it("prompts an account that predates the column instead of grandfathering it", async () => {
    const token = tokenFor("legacy");
    // Sign in once so the row exists, then put it back exactly as a
    // pre-migration row reads: the columns are NULL because they did not exist.
    await call(token, "GET", "/api/me");
    await getPool().query(
      `UPDATE users
          SET age_checked_at = NULL, age_check_passed = NULL, age_check_dob = NULL
        WHERE clerk_id = 'dev_local_user_legacy'`,
    );

    const me = await call<{ ageGate: AgeGateStatus }>(token, "GET", "/api/me");
    expect(me.body.ageGate).toBe("pending");
    expect((await call(token, "GET", "/api/servers")).status).toBe(403);
    expect((await handshake(token)).close?.code).toBe(4401);

    // And they are one dialog away from being back to normal.
    const declared = await call<{ ageGate: AgeGateStatus }>(
      token,
      "POST",
      "/api/me/age-check",
      { dateOfBirth: ADULT_DOB },
    );
    expect(declared.body.ageGate).toBe("passed");
    expect((await call(token, "GET", "/api/servers")).status).toBe(200);
  });

  // ------------------------------------------------------- data minimisation

  it("keeps the date of birth only for the account it refused", async () => {
    await adultAccount("keeper");
    await call(tokenFor("refused"), "POST", "/api/me/age-check", {
      dateOfBirth: CHILD_DOB,
    });

    const rows = await getPool().query<{
      clerk_id: string;
      age_check_dob: Date | null;
      age_checked_at: Date | null;
    }>(
      `SELECT clerk_id, age_check_dob, age_checked_at FROM users
        ORDER BY clerk_id`,
    );
    const byId = new Map(rows.rows.map((row) => [row.clerk_id, row]));

    // An adult's answer is reduced to the boolean plus the moment of the check.
    expect(byId.get("dev_local_user_keeper")?.age_check_dob).toBeNull();
    expect(byId.get("dev_local_user_keeper")?.age_checked_at).not.toBeNull();
    // A refusal keeps the declared date, because it is the evidence an appeal
    // would have to be decided on.
    expect(byId.get("dev_local_user_refused")?.age_check_dob).not.toBeNull();
  });

  it("refuses to leave the two answer columns disagreeing", async () => {
    const token = tokenFor("invariant");
    await call(token, "GET", "/api/me");
    await expect(
      getPool().query(
        `UPDATE users SET age_checked_at = NOW()
          WHERE clerk_id = 'dev_local_user_invariant'`,
      ),
    ).rejects.toThrow(/users_age_check_complete/);
  });
});
