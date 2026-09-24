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
 * `POST /api/live-hls/presence`: the heartbeat a party's viewer counts are
 * built from (`voice/hls-viewer-counts.ts`). An account can only ever count
 * itself: the session comes from the signed viewer token and the viewer from
 * the authenticated caller, and the two must agree. A verified telemetry
 * batch counts the same way.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async (header: string | undefined) =>
    header && actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { mintHlsViewerToken } = await import("../voice/hls-viewer-token.js");
const { hlsViewerCounter } = await import("../voice/hls-viewer-counts.js");

const CHANNEL = "00000000-0000-4000-8000-0000000000dd";
const STARTED_AT = 1_700_000_060_000;

let server: Server;
let baseUrl: string;

async function post(
  path: string,
  body: unknown,
  as: { id: string; clerk_id: string } | null,
): Promise<{ status: number; json: unknown }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(as ? { Authorization: "Bearer test" } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

describeDb("POST /api/live-hls/presence", () => {
  let viewer: { id: string; clerk_id: string };
  let other: { id: string; clerk_id: string };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = "sk_test_hls_presence";
    await initDb();
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    viewer = await upsertUser({
      clerkId: "clerk_hls_presence_viewer",
      displayName: "Viewer",
      avatarUrl: null,
    });
    other = await upsertUser({
      clerkId: "clerk_hls_presence_other",
      displayName: "Other",
      avatarUrl: null,
    });
  });

  afterAll(async () => {
    delete process.env.CLERK_SECRET_KEY;
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(() => {
    resetApiRateLimits();
    hlsViewerCounter.resetForTests();
  });

  afterEach(() => {
    actor = null;
  });

  function tokenFor(userId: string): string {
    const token = mintHlsViewerToken({
      userId,
      channelId: CHANNEL,
      startedAt: STARTED_AT,
    });
    expect(token).toBeTruthy();
    return token!;
  }

  it("counts the caller once, however many beats it sends", async () => {
    const sessionToken = tokenFor(viewer.id);
    for (let i = 0; i < 3; i += 1) {
      const result = await post("/api/live-hls/presence", { sessionToken }, viewer);
      expect(result.status).toBe(200);
      expect(result.json).toEqual({ ok: true });
    }
    expect(hlsViewerCounter.stats()).toMatchObject({
      trackedSessions: 1,
      viewersHere: 1,
      noted: { presence: 3, playlist: 0, telemetry: 0 },
    });
  });

  it("refuses somebody else's token, so nobody can count anybody but themselves", async () => {
    const result = await post(
      "/api/live-hls/presence",
      { sessionToken: tokenFor(other.id) },
      viewer,
    );
    expect(result.status).toBe(400);
    expect(hlsViewerCounter.stats().trackedSessions).toBe(0);
  });

  it("refuses a forged token and an unauthenticated beat", async () => {
    const forged = await post(
      "/api/live-hls/presence",
      { sessionToken: "not-a-token" },
      viewer,
    );
    expect(forged.status).toBe(400);
    const anonymous = await post(
      "/api/live-hls/presence",
      { sessionToken: tokenFor(viewer.id) },
      null,
    );
    expect(anonymous.status).toBe(401);
    expect(hlsViewerCounter.stats().trackedSessions).toBe(0);
  });

  it("counts a verified telemetry batch as a sighting too", async () => {
    const result = await post(
      "/api/live-hls/telemetry",
      {
        sessionId: "whatever",
        sessionToken: tokenFor(viewer.id),
        samples: [{ rung: "720p30", latencyMs: 5_000 }],
      },
      viewer,
    );
    expect(result.status).toBe(200);
    expect(hlsViewerCounter.stats().noted.telemetry).toBe(1);
    expect(hlsViewerCounter.stats().viewersHere).toBe(1);
  });
});
