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
 * `POST /api/stream-quality/telemetry`: authenticated, schema-checked,
 * rate-limited, and its acceptance folds straight into
 * `stream-quality-metrics.ts`'s bounded histograms, which
 * `GET /api/admin/metrics` reports back as `streamQuality`. This file proves
 * the HTTP surface; `stream-quality-metrics.test.ts` proves the bucket math.
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
const {
  streamQualityMetricsSnapshot,
  resetStreamQualityMetricsForTests,
} = await import("../voice/stream-quality-metrics.js");

let server: Server;
let baseUrl: string;

async function post(
  body: unknown,
  as: { id: string; clerk_id: string } | null,
): Promise<{ status: number; json: unknown }> {
  actor = as;
  const response = await fetch(`${baseUrl}/api/stream-quality/telemetry`, {
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

describeDb("POST /api/stream-quality/telemetry", () => {
  let caller: { id: string; clerk_id: string };

  beforeAll(async () => {
    await initDb();
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    caller = await upsertUser({
      clerkId: "clerk_stream_quality_telemetry",
      displayName: "Caller",
      avatarUrl: null,
    });
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(() => {
    resetApiRateLimits();
    resetStreamQualityMetricsForTests();
  });

  afterEach(() => {
    actor = null;
  });

  it("refuses an unauthenticated batch", async () => {
    const result = await post(
      { samples: [{ role: "presenter", transport: "mesh" }] },
      null,
    );
    expect(result.status).toBe(401);
    expect(streamQualityMetricsSnapshot().batchesAccepted).toBe(0);
  });

  it("accepts a well-formed batch and folds it into the histogram", async () => {
    const result = await post(
      {
        samples: [
          {
            role: "presenter",
            transport: "mesh",
            fps: 6,
            kbps: 350,
            width: 640,
            height: 360,
            qualityLimitationReason: "bandwidth",
          },
        ],
      },
      caller,
    );
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ ok: true });

    const snapshot = streamQualityMetricsSnapshot();
    expect(snapshot.batchesAccepted).toBe(1);
    expect(snapshot.samplesAccepted).toBe(1);
    expect(snapshot.fpsBuckets.presenter.mesh["5-9"]).toBe(1);
    expect(snapshot.limitationReasons.mesh.bandwidth).toBe(1);
  });

  it("carries no PII to a bounded bucket, no matter what a caller sends: no free-text field exists on the schema", async () => {
    const result = await post(
      {
        samples: [{ role: "viewer", transport: "livekit", fps: 30 }],
      },
      caller,
    );
    expect(result.status).toBe(200);
    // Response body carries nothing back but the ack -- no echo of caller
    // identity, no channel/session id, because the route never received one.
    expect(result.json).toEqual({ ok: true });
  });

  it("refuses a batch failing schema validation and counts it separately from acceptance", async () => {
    const result = await post(
      { samples: [{ role: "presenter", transport: "carrier-pigeon" }] },
      caller,
    );
    expect(result.status).toBe(400);
    const snapshot = streamQualityMetricsSnapshot();
    expect(snapshot.batchesRejectedSchema).toBe(1);
    expect(snapshot.batchesAccepted).toBe(0);
    expect(snapshot.samplesAccepted).toBe(0);
  });

  it("refuses an empty samples array", async () => {
    const result = await post({ samples: [] }, caller);
    expect(result.status).toBe(400);
  });

  it("rate limits a caller sending many batches back to back", async () => {
    let lastStatus = 200;
    for (let i = 0; i < 10; i++) {
      const result = await post(
        { samples: [{ role: "viewer", transport: "mesh" }] },
        caller,
      );
      lastStatus = result.status;
    }
    expect(lastStatus).toBe(429);
    expect(streamQualityMetricsSnapshot().batchesRejectedRateLimit).toBeGreaterThan(0);
  });
});
