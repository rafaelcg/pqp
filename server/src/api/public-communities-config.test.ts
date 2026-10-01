import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * `GET /api/public/communities/config`: the signed-out landing page's read of
 * `COMMUNITIES_ENABLED`. Pinned: answers with no credential (and a garbage
 * Authorization header does not veto it), body is exactly `{ enabled }`, off is
 * a 200 and not a 404, it follows the same switch as the authenticated route,
 * non-GET is 405, it is publicly cacheable, its own bucket runs out, and the
 * authenticated `/api/communities/config` is unchanged.
 */

let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async () =>
    actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");

let server: Server;
let baseUrl: string;
const original = process.env.COMMUNITIES_ENABLED;

beforeAll(async () => {
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleApi(req, res, pathname);
  });
  await new Promise<void>((done) => server.listen(0, done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  actor = null;
  resetApiRateLimits();
});

afterEach(() => {
  if (original === undefined) delete process.env.COMMUNITIES_ENABLED;
  else process.env.COMMUNITIES_ENABLED = original;
});

const url = () => `${baseUrl}/api/public/communities/config`;

describe("public communities config", () => {
  it("answers 200 {enabled:true} unauthenticated when the switch is on", async () => {
    process.env.COMMUNITIES_ENABLED = "true";
    const res = await fetch(url(), { headers: { Origin: "https://pqp.gg" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("answers 200 {enabled:false} when off, never 404", async () => {
    delete process.env.COMMUNITIES_ENABLED;
    const res = await fetch(url());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });

  it("only the exact string 'true' turns it on, like the authenticated route", async () => {
    process.env.COMMUNITIES_ENABLED = "1";
    expect(await (await fetch(url())).json()).toEqual({ enabled: false });
  });

  it("a garbage Authorization header does not veto it", async () => {
    process.env.COMMUNITIES_ENABLED = "true";
    const res = await fetch(url(), {
      headers: { Authorization: "Bearer expired.jwt.token" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
  });

  it("refuses non-GET methods with 405", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(url(), { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toContain("GET");
    }
  });

  it("runs out of its own address-keyed bucket", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await fetch(url())).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it("leaves the authenticated route as it was: 401 without a session, same value with one", async () => {
    process.env.COMMUNITIES_ENABLED = "true";
    const anon = await fetch(`${baseUrl}/api/communities/config`);
    expect(anon.status).toBe(401);

    actor = { id: "u1", clerk_id: "c1" };
    const authed = await fetch(`${baseUrl}/api/communities/config`, {
      headers: { Authorization: "Bearer t" },
    });
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual({ enabled: true });
    expect(authed.headers.get("cache-control")).not.toBe("public, max-age=60");
  });
});
