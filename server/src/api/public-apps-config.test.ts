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
 * `GET /api/public/apps/config`: the public pqp Apps pages' read of the global
 * `apps_landing` flag. Pinned: answers with no credential (and a garbage
 * Authorization header does not veto it, because the resolver here would throw
 * if it were ever asked), the body is exactly `{ enabled }`, off is a 200 and
 * not a 404, only the exact string `true` turns it on, non-GET is 405, it is
 * publicly cacheable, sets no cookie, and its own bucket runs out.
 */

const resolveAuthUser = vi.fn(async () => {
  throw new Error("the public apps config must never resolve a user");
});

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser,
  resolveAuthSession: resolveAuthUser,
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");

let server: Server;
let baseUrl: string;
const original = process.env.APPS_LANDING;

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
  resolveAuthUser.mockClear();
  resetApiRateLimits();
});

afterEach(() => {
  if (original === undefined) delete process.env.APPS_LANDING;
  else process.env.APPS_LANDING = original;
});

const url = () => `${baseUrl}/api/public/apps/config`;

describe("public apps config", () => {
  it("answers 200 {enabled:true} unauthenticated when the flag is on", async () => {
    process.env.APPS_LANDING = "true";
    const res = await fetch(url(), { headers: { Origin: "https://pqp.gg" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("is off by default, as a 200 and never a 404", async () => {
    delete process.env.APPS_LANDING;
    const res = await fetch(url());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });

  it("only the exact string 'true' turns it on", async () => {
    for (const raw of ["1", "on", "TRUE", "yes", ""]) {
      process.env.APPS_LANDING = raw;
      expect(await (await fetch(url())).json(), raw).toEqual({ enabled: false });
    }
  });

  it("a garbage Authorization header does not veto it, and no user is ever resolved", async () => {
    process.env.APPS_LANDING = "true";
    const res = await fetch(url(), {
      headers: { Authorization: "Bearer expired.jwt.token" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
    expect(resolveAuthUser).not.toHaveBeenCalled();
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
});
