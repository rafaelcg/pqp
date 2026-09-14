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

/**
 * A pass-through spy on `resolveHlsSessionId`, real Postgres query and all,
 * for every test except the one that overrides it with
 * `mockImplementationOnce` to prove the session-lookup guard's timeout and
 * negative cache actually reach through this route (`hls-telemetry-session-
 * guard.test.ts` proves the guard's own logic in isolation; this proves the
 * route wires it up).
 */
const resolveHlsSessionIdSpy = vi.hoisted(() => vi.fn());
vi.mock("../voice/hls-playlist-proxy.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../voice/hls-playlist-proxy.js")>();
  resolveHlsSessionIdSpy.mockImplementation(actual.resolveHlsSessionId);
  return { ...actual, resolveHlsSessionId: resolveHlsSessionIdSpy };
});

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { hlsTelemetryActivity, resetHlsLatencyMetricsForTests } = await import(
  "../voice/hls-latency-metrics.js"
);
const { mintHlsViewerToken } = await import("../voice/hls-viewer-token.js");
const { hlsObjectPrefix } = await import("../voice/hls-egress.js");
const { resetHlsPlaylistCacheForTests } = await import(
  "../voice/hls-playlist-proxy.js"
);

const TOKEN_CHANNEL = "00000000-0000-4000-8000-0000000000cc";
const TOKEN_STARTED_AT = 1_700_000_000_000;

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
    // Needed for mintHlsViewerToken/decodeHlsViewerToken below -- the
    // session-token tests mint a real, verifiable capability rather than a
    // fixture string.
    process.env.CLERK_SECRET_KEY = "sk_test_hls_telemetry";
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
    delete process.env.CLERK_SECRET_KEY;
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(() => {
    resetApiRateLimits();
    resetHlsLatencyMetricsForTests();
    resetHlsPlaylistCacheForTests();
    logEvent.mockClear();
    resolveHlsSessionIdSpy.mockClear();
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

  it("logs exactly one structured line per accepted batch, naming the (unsigned) session", async () => {
    // No sessionToken here (the config under test throughout most of this
    // file), so the client's own `sessionId` is not trusted as a label --
    // see the "sessionToken binding" describe block below for the literal
    // "unsigned" bucket this batch is recorded under instead.
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
        sessionId: "unsigned",
        sessionVerified: false,
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

  it("counts an unknown rung in samplesRejectedUnknownRung and drops it from the log line's rungs, but still accepts the batch", async () => {
    // Farol finding, 2026-09-13: the route used to pre-filter unknown rungs
    // before calling recordHlsLatencySample, which is the ONLY place that
    // increments this counter -- so a batch full of garbage rungs recorded
    // nothing AND the counter meant to say so stayed at zero.
    const result = await post(
      {
        sessionId: "session-abc",
        samples: [
          { rung: "720p30", latencyMs: 1_000 },
          { rung: "not-a-real-rung", latencyMs: 2_000 },
        ],
      },
      viewer,
    );
    expect(result.status).toBe(200);
    const activity = hlsTelemetryActivity();
    expect(activity.batchesAccepted).toBe(1);
    expect(activity.samplesRecorded).toBe(1);
    expect(activity.samplesRejectedUnknownRung).toBe(1);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsTelemetryBatch",
      expect.objectContaining({
        samples: 2,
        droppedUnknownRungSamples: 1,
        rungs: ["720p30"],
      }),
    );
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

  /**
   * Farol finding, 2026-09-13: "authenticated users can submit telemetry for
   * arbitrary sessions". A `sessionToken` is the SAME `?t=` capability the
   * caller's playlist request carried, verified here rather than trusted, so
   * the batch's real session identity cannot be a string the caller invented.
   */
  describe("sessionToken binding", () => {
    it("uses the verified token's channel/session instead of the client's sessionId, and marks it verified", async () => {
      const token = mintHlsViewerToken({
        userId: viewer.id,
        channelId: TOKEN_CHANNEL,
        startedAt: TOKEN_STARTED_AT,
      })!;
      const result = await post(
        {
          sessionId: "whatever-the-client-typed",
          sessionToken: token,
          samples: [{ rung: "720p30", latencyMs: 1_000 }],
        },
        viewer,
      );
      expect(result.status).toBe(200);
      expect(logEvent).toHaveBeenCalledWith(
        "voice.hlsTelemetryBatch",
        expect.objectContaining({
          sessionId: `${TOKEN_CHANNEL}:${TOKEN_STARTED_AT}`,
          sessionVerified: true,
        }),
      );
    });

    it("records the literal 'unsigned' bucket when no token is sent, ignoring the client's own sessionId (Farol finding, 2026-09-14)", async () => {
      const result = await post(
        {
          sessionId: "an-attacker-could-put-anything-here",
          samples: [{ rung: "720p30", latencyMs: 1_000 }],
        },
        viewer,
      );
      expect(result.status).toBe(200);
      expect(logEvent).toHaveBeenCalledWith(
        "voice.hlsTelemetryBatch",
        expect.objectContaining({
          sessionId: "unsigned",
          sessionVerified: false,
        }),
      );
    });

    it("refuses a session token naming a different user than the authenticated caller", async () => {
      const otherUsersToken = mintHlsViewerToken({
        userId: "11111111-1111-4111-8111-111111111111",
        channelId: TOKEN_CHANNEL,
        startedAt: TOKEN_STARTED_AT,
      })!;
      const result = await post(
        {
          sessionId: "session-abc",
          sessionToken: otherUsersToken,
          samples: [{ rung: "720p30", latencyMs: 1_000 }],
        },
        viewer,
      );
      expect(result.status).toBe(400);
      expect(hlsTelemetryActivity().batchesRejectedSession).toBe(1);
      expect(hlsTelemetryActivity().batchesAccepted).toBe(0);
      expect(logEvent).not.toHaveBeenCalled();
    });

    it("refuses a tampered session token", async () => {
      const token = mintHlsViewerToken({
        userId: viewer.id,
        channelId: TOKEN_CHANNEL,
        startedAt: TOKEN_STARTED_AT,
      })!;
      const result = await post(
        {
          sessionId: "session-abc",
          sessionToken: `${token.slice(0, -2)}xx`,
          samples: [{ rung: "720p30", latencyMs: 1_000 }],
        },
        viewer,
      );
      expect(result.status).toBe(400);
      expect(hlsTelemetryActivity().batchesRejectedSession).toBe(1);
    });

    it("refuses an expired session token", async () => {
      const now = 1_700_000_000_000;
      const token = mintHlsViewerToken({
        userId: viewer.id,
        channelId: TOKEN_CHANNEL,
        startedAt: TOKEN_STARTED_AT,
        now: now - 2 * 60 * 60 * 1000,
      })!;
      const result = await post(
        {
          sessionId: "session-abc",
          sessionToken: token,
          samples: [{ rung: "720p30", latencyMs: 1_000 }],
        },
        viewer,
      );
      expect(result.status).toBe(400);
      expect(hlsTelemetryActivity().batchesRejectedSession).toBe(1);
    });

    /**
     * Farol finding, 2026-09-14: the recorded session id used to be the
     * verified `channelId:startedAt` PAIR, which reads the same to a human
     * as the `hls_sessions.id` the playlist tag and the egress log carry,
     * but is never the same STRING -- so nothing could actually join a p95
     * against `voice.hlsStarted` by equality. This proves the two match.
     */
    it("resolves the verified token to the real hls_sessions row id -- the same string the playlist tag and the egress log use", async () => {
      const server = await getPool().query<{ id: string }>(
        `INSERT INTO servers (name, owner_id) VALUES ('canon-test', $1) RETURNING id`,
        [viewer.id],
      );
      const channel = await getPool().query<{ id: string }>(
        `INSERT INTO channels (server_id, name, type, position)
         VALUES ($1, 'cinema', 'watch_party', 0) RETURNING id`,
        [server.rows[0]!.id],
      );
      const channelId = channel.rows[0]!.id;
      const startedAt = 1_701_000_000_000;
      const session = await getPool().query<{ id: string }>(
        `INSERT INTO hls_sessions (channel_id, object_prefix, started_at, rung)
         VALUES ($1, $2, NOW(), '720p30') RETURNING id`,
        [channelId, hlsObjectPrefix(channelId, startedAt, "720p30")],
      );
      const canonicalSessionId = session.rows[0]!.id;
      const token = mintHlsViewerToken({
        userId: viewer.id,
        channelId,
        startedAt,
      })!;
      const result = await post(
        {
          sessionId: "client-typed-label-must-not-win",
          sessionToken: token,
          samples: [{ rung: "720p30", latencyMs: 1_000 }],
        },
        viewer,
      );
      expect(result.status).toBe(200);
      expect(logEvent).toHaveBeenCalledWith(
        "voice.hlsTelemetryBatch",
        expect.objectContaining({
          sessionId: canonicalSessionId,
          sessionVerified: true,
        }),
      );
    });
  });

  /**
   * Farol finding, 2026-09-14: "the session-ID fallback conflates a
   * successful database write with a failed metadata lookup and can tear
   * down a camera egress." REJECTED -- one sentence, then the proof. The
   * telemetry route's only database access for a signed batch is
   * `resolveHlsSessionId` (`hls-playlist-proxy.ts`'s `sessionRungs`), a
   * single `SELECT` with no `INSERT`/`UPDATE`/`DELETE` anywhere in it, and
   * neither that function nor this route imports anything from
   * `hls-egress.ts` that starts, reopens, or stops an egress (`grep` for
   * `stopRoom`/`reapForeignEgresses`/`endSupersededSessions` across both
   * files returns nothing); the "camera reopen hits an ended row" finding
   * Farol raised earlier this same review is a real but UNRELATED path,
   * reachable only from an actual camera start/stop, never from a telemetry
   * POST. This test is the property itself, not just the reasoning: it
   * proves no telemetry batch -- for a real, a stale, or a wholly invented
   * session -- changes a single row anywhere in `hls_sessions`.
   */
  it("changes nothing in hls_sessions, for a real session, a stale one, or one that was never real", async () => {
    const server = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('readonly-test', $1) RETURNING id`,
      [viewer.id],
    );
    const channel = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'cinema', 'watch_party', 0) RETURNING id`,
      [server.rows[0]!.id],
    );
    const channelId = channel.rows[0]!.id;
    const liveStartedAt = 1_702_000_000_000;
    const staleStartedAt = 1_702_100_000_000;
    await getPool().query(
      `INSERT INTO hls_sessions (channel_id, object_prefix, started_at, rung)
       VALUES ($1, $2, NOW(), '720p30')`,
      [channelId, hlsObjectPrefix(channelId, liveStartedAt, "720p30")],
    );
    // A row the SQL predicate excludes on purpose (`ended_at IS NOT NULL`):
    // exactly the "stale" case `resolveHlsSessionId` falls back away from.
    await getPool().query(
      `INSERT INTO hls_sessions (channel_id, object_prefix, started_at, ended_at, rung)
       VALUES ($1, $2, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '30 minutes', '720p30')`,
      [channelId, hlsObjectPrefix(channelId, staleStartedAt, "720p30")],
    );

    const snapshotAll = async () =>
      (
        await getPool().query(
          `SELECT id, channel_id, object_prefix, started_at, ended_at,
                  keep_replay, cleaned_at, egress_id, rung,
                  presenter_peer_id, video_track_id
             FROM hls_sessions
            WHERE channel_id = $1
            ORDER BY id`,
          [channelId],
        )
      ).rows;

    const before = await snapshotAll();
    expect(before).toHaveLength(2);

    const liveToken = mintHlsViewerToken({
      userId: viewer.id,
      channelId,
      startedAt: liveStartedAt,
    })!;
    const staleToken = mintHlsViewerToken({
      userId: viewer.id,
      channelId,
      startedAt: staleStartedAt,
    })!;
    const neverRealToken = mintHlsViewerToken({
      userId: viewer.id,
      channelId,
      startedAt: 9_999_999_999_999,
    })!;

    for (const token of [liveToken, staleToken, neverRealToken]) {
      const result = await post(
        {
          sessionId: "irrelevant",
          sessionToken: token,
          samples: [{ rung: "720p30", latencyMs: 1_000 }],
        },
        viewer,
      );
      expect(result.status).toBe(200);
    }

    const after = await snapshotAll();
    expect(after).toEqual(before);
  });

  /**
   * Farol finding, 2026-09-14: a batch with no token to verify used to still
   * accept the client's OWN `sessionId` as a label and a rate-limit key --
   * exactly the unbounded, attacker-controlled key space the `rung`
   * whitelist (3dde4d4a) closed on the histogram side of this route.
   * `LIVE_HLS_SIGNED_URLS=false` mints no token at all and is fully
   * supported, so this is the shape every one of ITS batches takes.
   */
  describe("no session label at all without a token", () => {
    it("never lets the client's sessionId reach the per-session rate limiter -- many accounts, one 'unsigned' bucket, none of them 429", async () => {
      let lastStatus = 200;
      for (let i = 0; i < 130; i++) {
        const fakeViewer = {
          id: `unsigned-user-${i}`,
          clerk_id: `unsigned-user-${i}`,
        };
        const result = await post(
          {
            sessionId: `attacker-chosen-label-${i}`,
            samples: [{ rung: "720p30", latencyMs: 1_000 }],
          },
          fakeViewer,
        );
        lastStatus = result.status;
      }
      // Each of these 130 accounts made exactly one request -- well inside
      // its OWN per-user budget -- and none of them share a session-level
      // bucket to exhaust, because there is no session-level bucket in this
      // mode at all.
      expect(lastStatus).toBe(200);
      expect(hlsTelemetryActivity().batchesAccepted).toBeGreaterThanOrEqual(130);
    });
  });

  /**
   * Farol findings, 2026-09-14: "telemetry requests can remain stuck on a
   * hung session lookup" and "telemetry batches can repeatedly retry a
   * failed session lookup". `hls-telemetry-session-guard.test.ts` proves the
   * guard's own timeout/negative-cache logic with fake timers and no
   * database; this proves the ROUTE actually reaches it, with a real
   * (never-settling) `resolveHlsSessionId` call and the real 500ms bound.
   */
  describe("a session lookup that never settles", () => {
    /**
     * Farol finding, 2026-09-14: concurrent batches for the same session
     * each started their own lookup. Different users, same verified
     * session, all in flight at once -- the shape a party's sampled
     * audience actually produces when it flushes on the same tick.
     */
    it("shares one resolveHlsSessionId call across concurrent batches for the same session", async () => {
      // `post`'s test harness authenticates through a single shared `actor`
      // variable set just before each `fetch`, which only works for
      // sequential calls -- so this uses ONE caller sending several
      // requests at once, which is enough to prove single-flight: the
      // guard dedupes on the SESSION key, not on who is asking. A short
      // real delay on the (mocked) lookup gives three real HTTP requests,
      // each over its own loopback socket, room to all reach the route
      // handler before the first one resolves -- without it, whichever
      // request happens to win the race to the handler first can finish
      // before the next one arrives, understating the dedup this proves.
      resolveHlsSessionIdSpy.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve("shared-id"), 50)),
      );
      const token = mintHlsViewerToken({
        userId: viewer.id,
        channelId: TOKEN_CHANNEL,
        startedAt: TOKEN_STARTED_AT,
      })!;
      const results = await Promise.all(
        [0, 1, 2].map(() =>
          post(
            {
              sessionId: "irrelevant",
              sessionToken: token,
              samples: [{ rung: "720p30", latencyMs: 1_000 }],
            },
            viewer,
          ),
        ),
      );
      for (const result of results) {
        expect(result.status).toBe(200);
      }
      expect(resolveHlsSessionIdSpy).toHaveBeenCalledTimes(1);
    });

    it("fails the batch closed with 503, then skips the lookup entirely for the next batch on the same session", async () => {
      resolveHlsSessionIdSpy.mockImplementationOnce(
        () => new Promise<string | null>(() => {}),
      );
      const token = mintHlsViewerToken({
        userId: viewer.id,
        channelId: TOKEN_CHANNEL,
        startedAt: TOKEN_STARTED_AT,
      })!;
      const stuck = await post(
        {
          sessionId: "irrelevant",
          sessionToken: token,
          samples: [{ rung: "720p30", latencyMs: 1_000 }],
        },
        viewer,
      );
      expect(stuck.status).toBe(503);
      expect(hlsTelemetryActivity().batchesRejectedSessionLookupTimeout).toBe(1);
      expect(hlsTelemetryActivity().batchesAccepted).toBe(0);

      // Same verified session, still inside the 30s negative-cache window:
      // the lookup must not be attempted a second time, and the batch is
      // accepted on the composite fallback instead of failing again.
      const next = await post(
        {
          sessionId: "irrelevant",
          sessionToken: token,
          samples: [{ rung: "720p30", latencyMs: 1_000 }],
        },
        viewer,
      );
      expect(next.status).toBe(200);
      expect(resolveHlsSessionIdSpy).toHaveBeenCalledTimes(1);
      expect(logEvent).toHaveBeenCalledWith(
        "voice.hlsTelemetryBatch",
        expect.objectContaining({
          sessionId: `${TOKEN_CHANNEL}:${TOKEN_STARTED_AT}`,
          sessionVerified: true,
        }),
      );
    }, 10_000);

    it("the per-session rate limiter gates the lookup -- a caller it 429s never reaches resolveHlsSessionId at all", async () => {
      // Many different accounts (each under its OWN per-user budget, one
      // request apiece) sharing the SAME verified session, past the
      // per-session limiter's capacity (120). If the limiter ran AFTER the
      // lookup, every one of these 130 would still call it before being
      // refused; if it gates the lookup as intended, the calls that got a
      // 429 make no call to it at all.
      let rejected = 0;
      for (let i = 0; i < 130; i++) {
        const fakeViewer = {
          id: `guard-order-user-${i}`,
          clerk_id: `guard-order-${i}`,
        };
        const token = mintHlsViewerToken({
          userId: fakeViewer.id,
          channelId: TOKEN_CHANNEL,
          startedAt: TOKEN_STARTED_AT,
        })!;
        const result = await post(
          {
            sessionId: "irrelevant",
            sessionToken: token,
            samples: [{ rung: "720p30", latencyMs: 1_000 }],
          },
          fakeViewer,
        );
        if (result.status === 429) {
          rejected += 1;
        }
      }
      expect(rejected).toBeGreaterThan(0);
      expect(resolveHlsSessionIdSpy.mock.calls.length).toBeLessThan(130);
      expect(resolveHlsSessionIdSpy.mock.calls.length).toBe(130 - rejected);
    });
  });

  /**
   * Farol finding, 2026-09-13 (performance): the route only capped one
   * caller's own rate, not how much traffic one session's worth of viewers
   * could add up to across many accounts. Each of these callers is under
   * its OWN per-user budget (one request each), so only the per-session
   * limiter can be what trips.
   */
  it("rate-limits a session receiving far more batches than one real party would, across many accounts", async () => {
    let lastStatus = 200;
    let accepted = 0;
    for (let i = 0; i < 130; i++) {
      const fakeViewer = { id: `session-limit-user-${i}`, clerk_id: `session-limit-${i}` };
      const token = mintHlsViewerToken({
        userId: fakeViewer.id,
        channelId: TOKEN_CHANNEL,
        startedAt: TOKEN_STARTED_AT,
      })!;
      const result = await post(
        {
          sessionId: "irrelevant-because-verified",
          sessionToken: token,
          samples: [{ rung: "720p30", latencyMs: 1_000 }],
        },
        fakeViewer,
      );
      lastStatus = result.status;
      if (result.status === 200) {
        accepted += 1;
      }
    }
    expect(lastStatus).toBe(429);
    expect(accepted).toBeLessThan(130);
    expect(hlsTelemetryActivity().batchesRejectedRateLimit).toBeGreaterThan(0);
  });
});
