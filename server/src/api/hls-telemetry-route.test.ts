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
 * `POST /api/live-hls/telemetry`: BROADCAST_PIPELINE B0.5. Authenticated,
 * schema-checked, rate-limited, and its acceptance folds straight into
 * `hls-latency-metrics.ts`'s histogram, which `GET /api/admin/metrics`
 * reports back as `liveHls.latency`. This file proves the HTTP surface;
 * `hls-latency-metrics.test.ts` proves the histogram math.
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

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../lib/log.js", () => ({ logEvent }));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { hlsTelemetryActivity, resetHlsLatencyMetricsForTests } = await import(
  "../voice/hls-latency-metrics.js"
);

let server: Server;
let baseUrl: string;

async function post(
  body: unknown,
  as: { id: string; clerk_id: string } | null,
): Promise<{ status: number; json: unknown }> {
  actor = as;
  const response = await fetch(`${baseUrl}/api/live-hls/telemetry`, {
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

describeDb("POST /api/live-hls/telemetry", () => {
  let viewer: { id: string; clerk_id: string };

  beforeAll(async () => {
    await initDb();
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    viewer = await upsertUser({
      clerkId: "clerk_hls_telemetry_viewer",
      displayName: "Viewer",
      avatarUrl: null,
    });
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(() => {
    resetApiRateLimits();
    resetHlsLatencyMetricsForTests();
    logEvent.mockClear();
  });

  afterEach(() => {
    actor = null;
  });

  it("refuses an unauthenticated batch", async () => {
    const result = await post(
      { sessionId: "s1", samples: [{ rung: "720p30", latencyMs: 5_000 }] },
      null,
    );
    expect(result.status).toBe(401);
    expect(hlsTelemetryActivity().batchesAccepted).toBe(0);
  });

  it("accepts a well-formed batch and folds it into the histogram", async () => {
    const result = await post(
      {
        sessionId: "session-abc",
        samples: [
          { rung: "720p30", latencyMs: 8_000 },
          { rung: "720p30", latencyMs: 9_000, bufferSeconds: 18, stalls: 0 },
        ],
      },
      viewer,
    );
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ ok: true });

    const activity = hlsTelemetryActivity();
    expect(activity.batchesAccepted).toBe(1);
    expect(activity.samplesRecorded).toBe(2);
    expect(activity.byRung).toHaveLength(1);
    expect(activity.byRung[0]!.rung).toBe("720p30");
    expect(activity.byRung[0]!.count).toBe(2);
  });

  it("logs exactly one structured line per accepted batch, naming the session", async () => {
    await post(
      {
        sessionId: "session-xyz",
        samples: [
          { rung: "720p30", latencyMs: 4_000 },
          { rung: "1080p30", latencyMs: 5_000 },
        ],
      },
      viewer,
    );
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsTelemetryBatch",
      expect.objectContaining({
        sessionId: "session-xyz",
        samples: 2,
        rungs: expect.arrayContaining(["720p30", "1080p30"]),
      }),
    );
  });

  it("refuses a batch failing schema validation and counts it separately from acceptance", async () => {
    const result = await post(
      { sessionId: "session-abc", samples: [{ rung: "720p30", latencyMs: -5 }] },
      viewer,
    );
    expect(result.status).toBe(400);
    const activity = hlsTelemetryActivity();
    expect(activity.batchesRejectedSchema).toBe(1);
    expect(activity.batchesAccepted).toBe(0);
    expect(activity.samplesRecorded).toBe(0);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("refuses a batch with no session id", async () => {
    const result = await post(
      { samples: [{ rung: "720p30", latencyMs: 1_000 }] },
      viewer,
    );
    expect(result.status).toBe(400);
    expect(hlsTelemetryActivity().batchesRejectedSchema).toBe(1);
  });

  it("refuses an empty samples array", async () => {
    const result = await post({ sessionId: "session-abc", samples: [] }, viewer);
    expect(result.status).toBe(400);
  });

  it("rate-limits a caller sending far more batches than a real sampled viewer would", async () => {
    let lastStatus = 200;
    for (let i = 0; i < 20; i++) {
      const result = await post(
        { sessionId: "session-abc", samples: [{ rung: "720p30", latencyMs: 1_000 }] },
        viewer,
      );
      lastStatus = result.status;
    }
    expect(lastStatus).toBe(429);
    expect(hlsTelemetryActivity().batchesRejectedRateLimit).toBeGreaterThan(0);
  });
});
