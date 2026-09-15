import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_HLS_MODE_LL,
  LIVE_HLS_MODE_PARAM,
  remuxControlSignaturePayload,
} from "@pqp/shared";

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../lib/log.js", () => ({ logEvent }));

const query = vi.hoisted(() =>
  vi.fn(async (_sql: string, _params?: unknown[]) => ({
    rowCount: 0,
    rows: [] as unknown[],
  })),
);
vi.mock("../db.js", () => ({ getPool: () => ({ query }) }));

const {
  isLiveHlsLLEnabled,
  liveHlsLLAllowlist,
  liveHlsLLAvailable,
  resolveHlsMode,
  requestedHlsModeForChannel,
  setRequestedHlsMode,
  deriveLlSessionId,
  remuxControlUrl,
  remuxControlSecret,
  remuxOriginBaseUrl,
  remuxSessionConfig,
  llHasRoom,
  llStreamFor,
  llHlsActivity,
  reconcileLlHlsNow,
  stopLlSession,
  adoptLlHlsSessions,
  setHlsRemuxTestHooks,
  resetHlsRemuxForTests,
} = await import("./hls-remux.js");

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const OTHER_CHANNEL = "00000000-0000-4000-8000-0000000000bb";
const SERVER = "00000000-0000-4000-8000-0000000000ee";
const OTHER_SERVER = "00000000-0000-4000-8000-0000000000ff";
const CONTROL_URL = "https://egress.example.test:8443";
const ORIGIN_URL = "https://hls-origin.example.test";
/**
 * `LIVE_HLS_PLAYLIST_BASE_URL`. Not decoration: the edge Worker is the ONLY
 * thing that can render an LL playlist (this API's own proxy answers "not
 * found" for a `mode = 'll'` row, by design), so `resolveHlsMode` refuses
 * `ll` without one -- see `llPlaylistFrontConfigured`.
 */
const EDGE_BASE_URL = "https://hls.example.test";
const SECRET = "test-remux-secret";

function enableLL() {
  process.env.LIVE_HLS_LL = "true";
  process.env.LIVE_HLS_PLAYLIST_BASE_URL = EDGE_BASE_URL;
  process.env.LIVE_HLS_REMUX_CONTROL_URL = CONTROL_URL;
  process.env.LIVE_HLS_REMUX_CONTROL_SECRET = SECRET;
  process.env.LIVE_HLS_REMUX_ORIGIN_URL = ORIGIN_URL;
}

/**
 * The flag AND an edge playlist front. Both are required before `ll` is ever
 * on the table (`llPlaylistFrontConfigured`): the edge Worker is the only
 * thing that can render an LL playlist, so an API with no edge host picking
 * `ll` would mean a party live, correct in every log, and black for
 * everybody watching.
 */
function enableMode() {
  process.env.LIVE_HLS_LL = "true";
  process.env.LIVE_HLS_PLAYLIST_BASE_URL = EDGE_BASE_URL;
}

function disableLL() {
  delete process.env.LIVE_HLS_LL;
  delete process.env.LIVE_HLS_PLAYLIST_BASE_URL;
  delete process.env.LIVE_HLS_LL_ALLOWLIST;
  delete process.env.LIVE_HLS_REMUX_CONTROL_URL;
  delete process.env.LIVE_HLS_REMUX_CONTROL_SECRET;
  delete process.env.LIVE_HLS_REMUX_ORIGIN_URL;
  delete process.env.LIVE_HLS_REMUX_PART_MS;
  delete process.env.LIVE_HLS_REMUX_SEGMENT_MS;
  delete process.env.LIVE_HLS_REMUX_RING_SEGMENTS;
  delete process.env.LIVE_HLS_REMUX_KEYFRAME_POLICY;
  delete process.env.LIVE_HLS_REMUX_PLI_PACE_MS;
  delete process.env.LIVE_HLS_REMUX_PLI_GATE_FACTOR;
  delete process.env.LIVE_HLS_REMUX_DELAY_SECONDS;
}

// ---------------------------------------------------------------------------
// A minimal fake Postgres for `hls_sessions` / `channel_sessions`, dispatched
// by matching the SQL text `hls-remux.ts` actually sends. Real rows, real
// timestamps (ms since epoch internally, ISO strings on the wire out) --
// this is what lets the "resume the exact same deterministic id" and
// "retry a stop with backoff" behavior be tested end to end rather than
// mocked away.
// ---------------------------------------------------------------------------

interface FakeHlsRow {
  id: string;
  channel_id: string;
  object_prefix: string;
  started_at: number;
  ended_at: number | null;
  remux_session_id: string | null;
  presenter_peer_id: string | null;
  stopping_at: number | null;
  stop_attempts: number;
  /** Which API process owns it. The fake plays one machine unless a test says otherwise. */
  instance_id?: string | null;
}

function createFakeDb() {
  const hlsRows: FakeHlsRow[] = [];
  const channelSessions = new Map<
    string,
    { channel_id: string; status: string; low_latency_requested: boolean }
  >();
  let nextId = 1;

  async function queryImpl(
    sql: string,
    params?: unknown[],
  ): Promise<{ rowCount: number; rows: unknown[] }> {
    const p = params ?? [];

    if (sql.includes("INSERT INTO hls_sessions")) {
      const [channelId, objectPrefix, startedAtMs, remuxSessionId, presenterPeerId] = p as [
        string,
        string,
        number,
        string,
        string,
      ];
      const exists = hlsRows.find((r) => r.object_prefix === objectPrefix);
      if (!exists) {
        hlsRows.push({
          id: `row-${nextId++}`,
          channel_id: channelId,
          object_prefix: objectPrefix,
          started_at: startedAtMs,
          ended_at: null,
          remux_session_id: remuxSessionId,
          presenter_peer_id: presenterPeerId,
          stopping_at: null,
          stop_attempts: 0,
          instance_id: (p[7] as string | null) ?? null,
        });
      }
      return { rowCount: 1, rows: [] };
    }

    // `claimHlsSessionRow`: the compare-and-set an LL start or adoption runs
    // before it touches the box. These suites run with the registry off (one
    // machine), so the owner predicate is omitted and any OPEN row is
    // claimable -- the two-machine version of this is pinned on a real
    // Postgres in `hls-ll-demotion.test.ts`.
    if (sql.includes("SET instance_id = $2") && sql.includes("s.id = $1::uuid")) {
      const [id, instanceId] = p as [string, string];
      const row = hlsRows.find((r) => r.id === id && r.ended_at === null);
      if (row) {
        row.instance_id = instanceId;
      }
      return { rowCount: row ? 1 : 0, rows: [] };
    }

    // `clearRequestedHlsMode`: the durable half of a demotion.
    if (
      sql.includes("UPDATE channel_sessions SET low_latency_requested = FALSE") &&
      sql.includes("channel_id = $1")
    ) {
      const [channelId] = p as [string];
      let count = 0;
      for (const row of channelSessions.values()) {
        if (row.channel_id === channelId && row.status === "live" && row.low_latency_requested) {
          row.low_latency_requested = false;
          count += 1;
        }
      }
      return { rowCount: count, rows: [] };
    }

    if (sql.includes("SELECT low_latency_requested")) {
      const [channelId] = p as [string];
      const found = [...channelSessions.values()].find(
        (c) => c.channel_id === channelId && c.status === "live",
      );
      return {
        rowCount: found ? 1 : 0,
        rows: found ? [{ low_latency_requested: found.low_latency_requested }] : [],
      };
    }

    if (sql.includes("UPDATE channel_sessions SET low_latency_requested")) {
      const [requested, watchPartySessionId] = p as [boolean, string];
      const row = channelSessions.get(watchPartySessionId);
      if (row) {
        row.low_latency_requested = requested;
      }
      return { rowCount: row ? 1 : 0, rows: [] };
    }

    if (sql.includes("stop_attempts = stop_attempts + 1") && sql.includes("object_prefix")) {
      const [objectPrefix] = p as [string];
      const row = hlsRows.find((r) => r.object_prefix === objectPrefix && r.ended_at === null);
      if (row) {
        row.stopping_at = Date.now();
        row.stop_attempts += 1;
      }
      return { rowCount: row ? 1 : 0, rows: [] };
    }

    if (sql.includes("stop_attempts = stop_attempts + 1") && sql.includes("WHERE id = $1")) {
      const [id] = p as [string];
      const row = hlsRows.find((r) => r.id === id);
      if (row) {
        row.stopping_at = Date.now();
        row.stop_attempts += 1;
      }
      return { rowCount: row ? 1 : 0, rows: [] };
    }

    if (sql.includes("SET ended_at = NOW()") && sql.includes("object_prefix")) {
      const [objectPrefix] = p as [string];
      const row = hlsRows.find((r) => r.object_prefix === objectPrefix && r.ended_at === null);
      if (row) {
        row.ended_at = Date.now();
      }
      return { rowCount: row ? 1 : 0, rows: [] };
    }

    if (sql.includes("SET ended_at = NOW()") && sql.includes("id = ANY")) {
      const [ids] = p as [string[]];
      let count = 0;
      for (const id of ids) {
        const row = hlsRows.find((r) => r.id === id && r.ended_at === null);
        if (row) {
          row.ended_at = Date.now();
          count += 1;
        }
      }
      return { rowCount: count, rows: [] };
    }

    if (sql.includes("ORDER BY started_at DESC")) {
      const [channelId] = p as [string];
      const matches = hlsRows
        .filter((r) => r.channel_id === channelId && r.ended_at === null)
        .sort((a, b) => b.started_at - a.started_at);
      const row = matches[0];
      return {
        rowCount: row ? 1 : 0,
        rows: row
          ? [
              {
                id: row.id,
                started_at: new Date(row.started_at).toISOString(),
                remux_session_id: row.remux_session_id,
                presenter_peer_id: row.presenter_peer_id,
                stopping_at: row.stopping_at ? new Date(row.stopping_at).toISOString() : null,
                stop_attempts: row.stop_attempts,
                instance_id: row.instance_id ?? null,
              },
            ]
          : [],
      };
    }

    if (sql.includes("mode = 'll' AND cleaned_at IS NULL")) {
      const cutoffMs = Date.now() - 60 * 60 * 1000;
      const matches = hlsRows.filter((r) => r.ended_at === null || r.ended_at > cutoffMs);
      return {
        rowCount: matches.length,
        rows: matches.map((row) => ({
          id: row.id,
          channel_id: row.channel_id,
          started_at: new Date(row.started_at).toISOString(),
          ended_at: row.ended_at ? new Date(row.ended_at).toISOString() : null,
          remux_session_id: row.remux_session_id,
          presenter_peer_id: row.presenter_peer_id,
          stopping_at: row.stopping_at ? new Date(row.stopping_at).toISOString() : null,
          stop_attempts: row.stop_attempts,
          instance_id: row.instance_id ?? null,
        })),
      };
    }

    return { rowCount: 0, rows: [] };
  }

  return { hlsRows, channelSessions, queryImpl };
}

/** A minimal in-memory stand-in for the control API's three routes. */
function createFakeRemuxServer() {
  const sessions = new Map<string, ReturnType<typeof buildInfo>>();
  const calls: { method: string; path: string; headers: Headers; body: string }[] = [];
  const created: string[] = [];

  function buildInfo(sessionId: string, room: string, channelId: string) {
    return {
      sessionId,
      room,
      channelId,
      subscribed: true,
      startedAtMs: Date.now(),
      lastPartAtMs: null,
      lastIdrAtMs: null,
      openSegmentMs: null,
      partsWritten: 0,
      bytesServed: 0,
    };
  }

  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const { pathname } = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : "";
    calls.push({ method, path: pathname, headers: new Headers(init.headers), body });

    if (method === "POST" && pathname === "/sessions") {
      const req = JSON.parse(body) as { sessionId: string; room: string; channelId: string };
      const info = buildInfo(req.sessionId, req.room, req.channelId);
      sessions.set(req.sessionId, info);
      created.push(req.sessionId);
      return new Response(JSON.stringify(info), { status: 201 });
    }
    if (method === "DELETE" && pathname.startsWith("/sessions/")) {
      const id = pathname.slice("/sessions/".length);
      const existed = sessions.delete(id);
      return new Response(null, { status: existed ? 204 : 404 });
    }
    if (method === "GET" && pathname === "/sessions") {
      return new Response(JSON.stringify({ sessions: [...sessions.values()] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };

  return { fetchImpl, sessions, calls, created };
}

beforeEach(() => {
  disableLL();
  resetHlsRemuxForTests();
  logEvent.mockClear();
  query.mockClear();
  query.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
});

afterEach(() => {
  disableLL();
  resetHlsRemuxForTests();
});

describe("resolveHlsMode: flag off means conventional, whatever was asked", () => {
  it("stays conventional when the flag is unset, even with the request field set", () => {
    expect(resolveHlsMode({ serverId: SERVER, requestedMode: true })).toBe("conventional");
  });

  it("stays conventional when the flag is on but nothing asked for it", () => {
    enableMode();
    expect(resolveHlsMode({ serverId: SERVER, requestedMode: false })).toBe("conventional");
  });

  it("is ll when the flag is on, requested, and there is no allowlist", () => {
    enableMode();
    expect(isLiveHlsLLEnabled()).toBe(true);
    expect(liveHlsLLAllowlist()).toBeNull();
    expect(resolveHlsMode({ serverId: SERVER, requestedMode: true })).toBe("ll");
  });

  it("is ll for a server on the allowlist", () => {
    enableMode();
    process.env.LIVE_HLS_LL_ALLOWLIST = `${OTHER_SERVER},${SERVER}`;
    expect(liveHlsLLAllowlist()).toEqual(new Set([OTHER_SERVER, SERVER]));
    expect(resolveHlsMode({ serverId: SERVER, requestedMode: true })).toBe("ll");
  });

  it("stays conventional for a server NOT on the allowlist", () => {
    enableMode();
    process.env.LIVE_HLS_LL_ALLOWLIST = OTHER_SERVER;
    expect(resolveHlsMode({ serverId: SERVER, requestedMode: true })).toBe("conventional");
  });

  it("stays conventional with no server id and an allowlist set", () => {
    enableMode();
    process.env.LIVE_HLS_LL_ALLOWLIST = SERVER;
    expect(resolveHlsMode({ serverId: null, requestedMode: true })).toBe("conventional");
  });
});

describe("liveHlsLLAvailable: the client's gate for showing the switch at all", () => {
  it("is false when the flag is unset, whatever the server", () => {
    expect(liveHlsLLAvailable(SERVER)).toBe(false);
    expect(liveHlsLLAvailable(null)).toBe(false);
  });

  it("is true for any server when the flag is on and there is no allowlist", () => {
    enableMode();
    expect(liveHlsLLAvailable(SERVER)).toBe(true);
    expect(liveHlsLLAvailable(OTHER_SERVER)).toBe(true);
    // The deployment-wide answer, asked before a client knows its server:
    // no allowlist means yes, same as `resolveHlsMode` would decide once it
    // does know.
    expect(liveHlsLLAvailable(null)).toBe(true);
  });

  it("is true only for a server on the allowlist", () => {
    enableMode();
    process.env.LIVE_HLS_LL_ALLOWLIST = SERVER;
    expect(liveHlsLLAvailable(SERVER)).toBe(true);
    expect(liveHlsLLAvailable(OTHER_SERVER)).toBe(false);
    expect(liveHlsLLAvailable(null)).toBe(false);
  });
});

describe("the per-channel request field is durable, not process memory", () => {
  it("defaults to false for a channel with no live party row", async () => {
    expect(await requestedHlsModeForChannel(CHANNEL)).toBe(false);
  });

  it("persists a request written on the party's own row and reads it back by channel", async () => {
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    db.channelSessions.set("party-1", {
      channel_id: CHANNEL,
      status: "live",
      low_latency_requested: false,
    });

    await setRequestedHlsMode("party-1", true);

    expect(await requestedHlsModeForChannel(CHANNEL)).toBe(true);
  });

  it("survives being read by a totally different call -- no in-memory state involved", async () => {
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    db.channelSessions.set("party-2", {
      channel_id: OTHER_CHANNEL,
      status: "live",
      low_latency_requested: true,
    });

    // resetHlsRemuxForTests clears every in-memory map this module has; the
    // request must still read back true because it was never IN one.
    resetHlsRemuxForTests();
    query.mockImplementation(db.queryImpl);

    expect(await requestedHlsModeForChannel(OTHER_CHANNEL)).toBe(true);
    expect(await requestedHlsModeForChannel(CHANNEL)).toBe(false);
  });

  it("fails CLOSED: answers null (never false) on a database read failure, logged once", async () => {
    // null must never be confused with a genuine "no request" (false):
    // hls-egress.ts's reconcileLiveHlsNow treats null as "cannot decide,
    // try again later" and makes no mode change at all, where false would
    // resolve `conventional` and could tear down a running LL session on a
    // transient blip (a Farol finding on PR #580, fifth round).
    query.mockImplementation(async () => {
      throw new Error("connection terminated");
    });

    expect(await requestedHlsModeForChannel(CHANNEL)).toBeNull();
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlLookupFailed",
      expect.objectContaining({ channelId: CHANNEL, source: "requested-mode" }),
    );

    // Rate limited: a second failure for the same channel inside the window
    // does not log again.
    logEvent.mockClear();
    expect(await requestedHlsModeForChannel(CHANNEL)).toBeNull();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("logs voice.hlsLlLookupFailed again for a DIFFERENT channel even inside the same window", async () => {
    query.mockImplementation(async () => {
      throw new Error("connection terminated");
    });

    await requestedHlsModeForChannel(CHANNEL);
    logEvent.mockClear();
    await requestedHlsModeForChannel(OTHER_CHANNEL);

    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlLookupFailed",
      expect.objectContaining({ channelId: OTHER_CHANNEL }),
    );
  });
});

describe("deriveLlSessionId: deterministic per (channel, startedAt)", () => {
  it("is the same value for the same inputs, every time", () => {
    const a = deriveLlSessionId(CHANNEL, 1_725_000_000_000);
    const b = deriveLlSessionId(CHANNEL, 1_725_000_000_000);
    expect(a).toBe(b);
  });

  it("differs for a different channel or a different startedAt", () => {
    const base = deriveLlSessionId(CHANNEL, 1_725_000_000_000);
    expect(deriveLlSessionId(OTHER_CHANNEL, 1_725_000_000_000)).not.toBe(base);
    expect(deriveLlSessionId(CHANNEL, 1_725_000_000_001)).not.toBe(base);
  });

  it("is shaped like the uuid the wire contract requires", () => {
    const id = deriveLlSessionId(CHANNEL, 1_725_000_000_000);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("config helpers", () => {
  it("read the control URL, secret and origin, trimmed and un-slashed", () => {
    process.env.LIVE_HLS_REMUX_CONTROL_URL = "https://egress.example.test/ ";
    process.env.LIVE_HLS_REMUX_CONTROL_SECRET = " s3cret ";
    process.env.LIVE_HLS_REMUX_ORIGIN_URL = "https://hls-origin.example.test//";
    expect(remuxControlUrl()).toBe("https://egress.example.test");
    expect(remuxControlSecret()).toBe("s3cret");
    expect(remuxOriginBaseUrl()).toBe("https://hls-origin.example.test");
  });

  it("answer null when unset", () => {
    expect(remuxControlUrl()).toBeNull();
    expect(remuxControlSecret()).toBeNull();
    expect(remuxOriginBaseUrl()).toBeNull();
  });

  it("defaults the session config to pqp-remux's own defaults", () => {
    expect(remuxSessionConfig()).toEqual({
      partMs: 500,
      segmentMs: 4000,
      ringSegments: 6,
      keyframePolicy: "natural",
      pliPaceMs: 500,
      // 1x the segment target, matching the Go binary's
      // keyframe.defaultGateFactor. A gate above 1 cannot produce a
      // segment shorter than that multiple of segmentMs, which is how
      // production ended up with 11 second segments against a 4 second
      // target on 2026-09-15.
      pliGateFactor: 1,
    });
  });

  it("reads overrides", () => {
    process.env.LIVE_HLS_REMUX_PART_MS = "200";
    process.env.LIVE_HLS_REMUX_KEYFRAME_POLICY = "pli";
    process.env.LIVE_HLS_REMUX_PLI_GATE_FACTOR = "2.5";
    expect(remuxSessionConfig()).toMatchObject({
      partMs: 200,
      keyframePolicy: "pli",
      pliGateFactor: 2.5,
    });
  });
});

describe("the control client is signed with LIVE_HLS_REMUX_CONTROL_SECRET", () => {
  it("sends a timestamp, a nonce, and a matching HMAC-SHA256 signature on the POST that starts a session", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl, now: () => 1_000_000 });

    await reconcileLlHlsNow(CHANNEL, "peer-1");

    const call = server.calls.find((c) => c.method === "POST")!;
    expect(call.path).toBe("/sessions");
    const timestamp = call.headers.get("x-pqp-remux-timestamp");
    const nonce = call.headers.get("x-pqp-remux-nonce");
    const signature = call.headers.get("x-pqp-remux-signature");
    expect(timestamp).toBe("1000000");
    expect(nonce).toBeTruthy();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    const expected = createHmac("sha256", SECRET)
      .update(
        remuxControlSignaturePayload("POST", "/sessions", "1000000", nonce!, call.body),
        "utf8",
      )
      .digest("hex");
    expect(signature).toBe(expected);
  });

  it("signs a DELETE with the id in the path and an empty body", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl, now: () => 2_000_000 });
    await reconcileLlHlsNow(CHANNEL, "peer-1");
    server.calls.length = 0;

    await stopLlSession(CHANNEL, "test-stop");

    const call = server.calls.find((c) => c.method === "DELETE")!;
    expect(call.body).toBe("");
    const nonce = call.headers.get("x-pqp-remux-nonce");
    expect(nonce).toBeTruthy();
    const signature = call.headers.get("x-pqp-remux-signature");
    const expected = createHmac("sha256", SECRET)
      .update(
        remuxControlSignaturePayload("DELETE", call.path, "2000000", nonce!, ""),
        "utf8",
      )
      .digest("hex");
    expect(signature).toBe(expected);
  });

  it("uses a different nonce on every request, even with the clock stopped", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl, now: () => 3_000_000 });

    await reconcileLlHlsNow(CHANNEL, "peer-1");
    await stopLlSession(CHANNEL, "test-stop");

    const nonces = server.calls.map((c) => c.headers.get("x-pqp-remux-nonce"));
    expect(nonces.length).toBeGreaterThanOrEqual(2);
    expect(new Set(nonces).size).toBe(nonces.length);
  });
});

describe("the LL playlist URL never names the origin host (item 1)", () => {
  it("is an API-relative path, never the raw egress origin", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });

    const stream = await reconcileLlHlsNow(CHANNEL, "peer-1");

    expect(stream).not.toBeNull();
    expect(stream?.hlsUrl.startsWith(`/api/voice/hls-playlist/${CHANNEL}/`)).toBe(true);
    expect(stream?.hlsUrl).not.toContain(ORIGIN_URL);
    expect(stream?.hlsUrl).not.toMatch(/^https?:\/\//);
  });

  it("is API-relative for an adopted session too", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    const sessionId = "00000000-0000-4000-8000-0000000000c1";
    server.sessions.set(sessionId, {
      sessionId,
      room: CHANNEL,
      channelId: CHANNEL,
      subscribed: true,
      startedAtMs: Date.now(),
      lastPartAtMs: null,
      lastIdrAtMs: null,
      openSegmentMs: null,
      partsWritten: 0,
      bytesServed: 0,
    });
    db.hlsRows.push({
      id: "row-adopt",
      channel_id: CHANNEL,
      object_prefix: `live/${CHANNEL}/1725000000000-ll`,
      started_at: 1_725_000_000_000,
      ended_at: null,
      remux_session_id: sessionId,
      presenter_peer_id: "peer-1",
      stopping_at: null,
      stop_attempts: 0,
    });
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });

    await adoptLlHlsSessions();

    expect(llStreamFor(CHANNEL)?.hlsUrl).not.toMatch(/^https?:\/\//);
    expect(llStreamFor(CHANNEL)?.hlsUrl).toBe(
      `/api/voice/hls-playlist/${CHANNEL}/1725000000000?${LIVE_HLS_MODE_PARAM}=${LIVE_HLS_MODE_LL}`,
    );
  });
});

describe("the delivery mode is stated on the wire, not inferred at the edge", () => {
  /**
   * THE 2026-09-15 FAILURE, PINNED AT ITS SOURCE. Low latency was enabled in
   * production four times and no viewer was ever handed the low-latency
   * stream: the edge Worker decided the mode by probing the remux for
   * `state.json`, a session 300 ms old had none, and it quietly answered
   * with the conventional ladder's master -- for a party whose conventional
   * ladder the API had deliberately not started. The fix is that the API,
   * which CHOSE the mode, says so in the URL it hands out.
   */
  it("an LL session's hlsUrl carries the mode marker, and says `ll` beside it", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });

    const stream = await reconcileLlHlsNow(CHANNEL, "peer-1");

    expect(stream?.mode).toBe("ll");
    expect(stream?.hlsUrl).toContain(`${LIVE_HLS_MODE_PARAM}=${LIVE_HLS_MODE_LL}`);
    // The marker rides on a URL `stampViewerStream` then appends `?t=` to
    // with an `&`, so the whole thing has to parse as one query string.
    const url = new URL(`https://api.example.test${stream!.hlsUrl}`);
    expect(url.searchParams.get(LIVE_HLS_MODE_PARAM)).toBe(LIVE_HLS_MODE_LL);
  });

  it("states the part target the session actually writes at", async () => {
    enableLL();
    process.env.LIVE_HLS_REMUX_PART_MS = "320";
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });

    const stream = await reconcileLlHlsNow(CHANNEL, "peer-1");

    expect(stream?.partTargetMs).toBe(320);
  });

  it("refuses `ll` outright when there is no edge front to render it", () => {
    // `LIVE_HLS_LL` on, the party asked, no allowlist -- and no
    // `LIVE_HLS_PLAYLIST_BASE_URL`. The only renderer of an LL playlist is
    // the edge Worker; this API's own proxy answers "not found" for a
    // `mode = 'll'` row. Picking the mode anyway is a party that is live,
    // correct in every log, and black for everybody watching.
    process.env.LIVE_HLS_LL = "true";
    delete process.env.LIVE_HLS_PLAYLIST_BASE_URL;
    expect(resolveHlsMode({ serverId: SERVER, requestedMode: true })).toBe("conventional");
    expect(liveHlsLLAvailable(SERVER)).toBe(false);
  });
});

describe("starting a session (item 2: deterministic ids)", () => {
  it("fails closed, counted, when the control plane is not configured", async () => {
    const stream = await reconcileLlHlsNow(CHANNEL, "peer-1");
    expect(stream).toBeNull();
    expect(llHlsActivity().startFailures).toBe(1);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlStartFailed",
      expect.objectContaining({ channelId: CHANNEL, reason: "not-configured" }),
    );
  });

  it("fails closed on a findOpenLlRow read error: no insert, no remux call, nothing torn down", async () => {
    // The core fix of item 2's follow-up (a Farol finding, fourth round):
    // a lookup failure must never be read as "no open row", because that
    // would let this proceed to mint and start a SECOND session on top of
    // one that might still be running fine.
    enableLL();
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    query.mockImplementation(async () => {
      throw new Error("connection terminated");
    });

    const stream = await reconcileLlHlsNow(CHANNEL, "peer-1");

    expect(stream).toBeNull();
    expect(server.calls).toHaveLength(0); // the control API was never even asked
    expect(llHasRoom(CHANNEL)).toBe(false);
    expect(llHlsActivity().startFailures).toBe(1);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlLookupFailed",
      expect.objectContaining({ channelId: CHANNEL, source: "open-row" }),
    );
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlStartFailed",
      expect.objectContaining({ channelId: CHANNEL, reason: "lookup-failed" }),
    );
  });

  it("recovers and starts normally once the database read succeeds again", async () => {
    enableLL();
    const db = createFakeDb();
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    let failOnce = true;
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("connection terminated");
      }
      return db.queryImpl(sql, params);
    });

    const first = await reconcileLlHlsNow(CHANNEL, "peer-1");
    expect(first).toBeNull();

    const second = await reconcileLlHlsNow(CHANNEL, "peer-1");

    expect(second).not.toBeNull();
    expect(llHasRoom(CHANNEL)).toBe(true);
  });

  it("starts a session, records a row keyed by the derived id, and returns a stream", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });

    const stream = await reconcileLlHlsNow(CHANNEL, "peer-1");

    expect(stream).not.toBeNull();
    expect(stream?.mode).toBe("ll");
    expect(stream?.presenterPeerId).toBe("peer-1");
    expect(llHasRoom(CHANNEL)).toBe(true);
    expect(llStreamFor(CHANNEL)).toEqual(stream);
    expect(llHlsActivity().sessions).toBe(1);

    expect(db.hlsRows).toHaveLength(1);
    const row = db.hlsRows[0]!;
    expect(row.remux_session_id).toBe(deriveLlSessionId(CHANNEL, row.started_at));
    expect(server.created).toEqual([row.remux_session_id]);
  });

  it("reuses the running session for the same presenter, without a second call", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });

    const first = await reconcileLlHlsNow(CHANNEL, "peer-1");
    const second = await reconcileLlHlsNow(CHANNEL, "peer-1");

    expect(second).toEqual(first);
    expect(server.created).toHaveLength(1);
  });

  it("resumes an ambiguous start on the next attempt with the SAME derived id -- no marker needed", async () => {
    // The POST reaches the box, but this process never sees the response.
    // The row was inserted BEFORE the POST, so the next attempt finds it via
    // `findOpenLlRow`, recomputes the identical id from (channelId,
    // startedAt), and confirms it rather than minting a second one.
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    let dropNextPostResponse = true;
    setHlsRemuxTestHooks({
      fetch: async (url, init) => {
        const method = (init.method ?? "GET").toUpperCase();
        if (method === "POST" && dropNextPostResponse) {
          dropNextPostResponse = false;
          await server.fetchImpl(url, init); // lands on the box
          throw new Error("ETIMEDOUT"); // but never reaches this caller
        }
        return server.fetchImpl(url, init);
      },
    });

    const first = await reconcileLlHlsNow(CHANNEL, "peer-1");
    expect(first).toBeNull();
    expect(server.created).toHaveLength(1);
    expect(db.hlsRows).toHaveLength(1);
    const expectedId = db.hlsRows[0]!.remux_session_id;

    const second = await reconcileLlHlsNow(CHANNEL, "peer-1");

    expect(second).not.toBeNull();
    expect(server.created).toHaveLength(1); // no second POST
    expect(db.hlsRows).toHaveLength(1); // no second row either
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlStartFoundExisting",
      expect.objectContaining({ channelId: CHANNEL, sessionId: expectedId }),
    );
  });

  it("never lets a much later, unrelated party in the same channel adopt a stale attempt's id", async () => {
    // There is no expiring marker to forget any more (item 2 removed it):
    // the row itself is the only reference, and it is only ever resolved by
    // confirming it, stopping it, or a boot sweep finding it truly gone.
    // Time passing alone changes nothing -- the durable row is still there
    // when a different presenter reconciles much later.
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    let dropNextPostResponse = true;
    setHlsRemuxTestHooks({
      fetch: async (url, init) => {
        const method = (init.method ?? "GET").toUpperCase();
        if (method === "POST" && dropNextPostResponse) {
          dropNextPostResponse = false;
          await server.fetchImpl(url, init);
          throw new Error("ETIMEDOUT");
        }
        return server.fetchImpl(url, init);
      },
    });

    const first = await reconcileLlHlsNow(CHANNEL, "peer-1");
    expect(first).toBeNull();
    const staleId = db.hlsRows[0]!.remux_session_id;

    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      // A different presenter: the row still belongs to peer-1's attempt,
      // so this must close it, not confirm it as this presenter's own.
      const second = await reconcileLlHlsNow(CHANNEL, "peer-9");
      expect(second?.presenterPeerId).toBe("peer-9");
      // The stale row is stopped and superseded by a genuinely new one (a
      // new derived id for the new startedAt), never confirmed as-is.
      expect(llStreamFor(CHANNEL)?.presenterPeerId).toBe("peer-9");
      const finalRow = db.hlsRows.find((r) => r.ended_at === null);
      expect(finalRow?.remux_session_id).not.toBe(staleId);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stopping a session (item 3: retry with backoff, never silently forgotten)", () => {
  it("stops on no presenter and marks the row ended", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    await reconcileLlHlsNow(CHANNEL, "peer-1");

    const result = await reconcileLlHlsNow(CHANNEL, null);

    expect(result).toBeNull();
    expect(llHasRoom(CHANNEL)).toBe(false);
    expect(server.sessions.size).toBe(0);
    expect(db.hlsRows[0]!.ended_at).not.toBeNull();
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlStopped",
      expect.objectContaining({ channelId: CHANNEL, reason: "no-share" }),
    );
  });

  it("treats a 404 on stop (already gone) as success", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    await reconcileLlHlsNow(CHANNEL, "peer-1");
    server.sessions.clear();

    await stopLlSession(CHANNEL, "test");

    expect(db.hlsRows[0]!.ended_at).not.toBeNull();
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlStopped",
      expect.objectContaining({ reason: "test" }),
    );
    expect(logEvent).not.toHaveBeenCalledWith("voice.hlsLlStopFailed", expect.anything());
  });

  it("counts a failed DELETE in llStopFailures and marks the row stopping, not ended", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({
      fetch: async (url, init) => {
        if ((init.method ?? "GET").toUpperCase() === "DELETE") {
          throw new Error("ETIMEDOUT");
        }
        return server.fetchImpl(url, init);
      },
    });
    await reconcileLlHlsNow(CHANNEL, "peer-1");

    await stopLlSession(CHANNEL, "test");

    expect(llHlsActivity().stopFailures).toBe(1);
    expect(llHasRoom(CHANNEL)).toBe(false); // the in-memory room is forgotten either way
    const row = db.hlsRows[0]!;
    expect(row.ended_at).toBeNull(); // but the DB row is not: it is "stopping"
    expect(row.stopping_at).not.toBeNull();
    expect(server.sessions.size).toBe(1); // still running on the box
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlStopFailed",
      expect.objectContaining({ channelId: CHANNEL, reason: "test" }),
    );
  });

  it("retries a stopping row on the next start attempt for a different presenter, respecting backoff", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    let failDelete = true;
    setHlsRemuxTestHooks({
      fetch: async (url, init) => {
        if (failDelete && (init.method ?? "GET").toUpperCase() === "DELETE") {
          throw new Error("ETIMEDOUT");
        }
        return server.fetchImpl(url, init);
      },
    });
    await reconcileLlHlsNow(CHANNEL, "peer-1");
    await stopLlSession(CHANNEL, "no-share"); // fails, row -> stopping
    expect(llHlsActivity().stopFailures).toBe(1);

    // Immediately retrying (still inside the backoff window) must not hit
    // the control API again.
    const server2Calls = server.calls.length;
    const immediateRetry = await reconcileLlHlsNow(CHANNEL, "peer-2");
    expect(immediateRetry).toBeNull(); // still blocked: the stopping row is unresolved
    expect(server.calls.length).toBe(server2Calls); // no new DELETE attempted, backoff held

    // Past the backoff window and with the DELETE now able to succeed:
    failDelete = false;
    vi.useFakeTimers();
    try {
      // One failed attempt so far -> backoff step index 1 -> 5000ms.
      await vi.advanceTimersByTimeAsync(6_000);
      const resumed = await reconcileLlHlsNow(CHANNEL, "peer-2");
      expect(resumed).not.toBeNull();
      expect(resumed?.presenterPeerId).toBe("peer-2");
      const oldRow = db.hlsRows.find((r) => r.presenter_peer_id === "peer-1");
      expect(oldRow?.ended_at).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("per-room single-flight (item 4)", () => {
  it("serializes two concurrent reconciles for the same channel into one session", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });

    const [a, b] = await Promise.all([
      reconcileLlHlsNow(CHANNEL, "peer-1"),
      reconcileLlHlsNow(CHANNEL, "peer-1"),
    ]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.hlsUrl).toBe(b?.hlsUrl);
    expect(server.created).toHaveLength(1);
    expect(db.hlsRows).toHaveLength(1);
  });

  it("does not interleave a concurrent start and stop for the same channel", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    await reconcileLlHlsNow(CHANNEL, "peer-1");

    const results = await Promise.all([
      reconcileLlHlsNow(CHANNEL, "peer-1"), // no-op, same presenter
      reconcileLlHlsNow(CHANNEL, null), // stop
    ]);

    // Whichever order they queued in, the two calls ran one after another,
    // never concurrently mutating `llRooms` for this channel.
    expect(results.some((r) => r === null)).toBe(true);
  });
});

describe("boot adoption (item 5: excludes ended/stopping rows, bounded concurrency, batched updates)", () => {
  it("does nothing, and touches no database, when the flag is off", async () => {
    const result = await adoptLlHlsSessions();
    expect(result).toEqual({ adopted: 0, ended: 0, stopped: 0 });
    expect(query).not.toHaveBeenCalled();
  });

  it("answers null when the control API cannot be asked at all", async () => {
    enableLL();
    setHlsRemuxTestHooks({
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const result = await adoptLlHlsSessions();
    expect(result).toBeNull();
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlBootReconcileSkipped",
      expect.objectContaining({ reason: "list-failed" }),
    );
  });

  it("adopts a remote session with a matching, open, non-stopping row", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    const sessionId = "00000000-0000-4000-8000-0000000000c1";
    server.sessions.set(sessionId, {
      sessionId,
      room: CHANNEL,
      channelId: CHANNEL,
      subscribed: true,
      startedAtMs: Date.now(),
      lastPartAtMs: null,
      lastIdrAtMs: null,
      openSegmentMs: null,
      partsWritten: 3,
      bytesServed: 1024,
    });
    db.hlsRows.push({
      id: "row-1",
      channel_id: CHANNEL,
      object_prefix: `live/${CHANNEL}/1725000000000-ll`,
      started_at: 1_725_000_000_000,
      ended_at: null,
      remux_session_id: sessionId,
      presenter_peer_id: "peer-1",
      stopping_at: null,
      stop_attempts: 0,
    });
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });

    const result = await adoptLlHlsSessions();

    expect(result).toEqual({ adopted: 1, ended: 0, stopped: 0 });
    expect(llHasRoom(CHANNEL)).toBe(true);
    expect(llStreamFor(CHANNEL)?.presenterPeerId).toBe("peer-1");
    expect(llStreamFor(CHANNEL)?.mode).toBe("ll");
  });

  it("does NOT adopt a row already marked ended, even if the box still answers with it", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    const sessionId = "00000000-0000-4000-8000-0000000000c3";
    server.sessions.set(sessionId, {
      sessionId,
      room: CHANNEL,
      channelId: CHANNEL,
      subscribed: true,
      startedAtMs: Date.now(),
      lastPartAtMs: null,
      lastIdrAtMs: null,
      openSegmentMs: null,
      partsWritten: 0,
      bytesServed: 0,
    });
    db.hlsRows.push({
      id: "row-ended",
      channel_id: CHANNEL,
      object_prefix: `live/${CHANNEL}/1725000000000-ll`,
      started_at: 1_725_000_000_000,
      ended_at: Date.now(),
      remux_session_id: sessionId,
      presenter_peer_id: "peer-1",
      stopping_at: null,
      stop_attempts: 0,
    });
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });

    const result = await adoptLlHlsSessions();

    expect(result).toEqual({ adopted: 0, ended: 0, stopped: 1 });
    expect(llHasRoom(CHANNEL)).toBe(false);
    expect(server.sessions.has(sessionId)).toBe(false);
  });

  it("does NOT adopt a row marked stopping -- retries the stop instead", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    const sessionId = "00000000-0000-4000-8000-0000000000c4";
    server.sessions.set(sessionId, {
      sessionId,
      room: CHANNEL,
      channelId: CHANNEL,
      subscribed: true,
      startedAtMs: Date.now(),
      lastPartAtMs: null,
      lastIdrAtMs: null,
      openSegmentMs: null,
      partsWritten: 0,
      bytesServed: 0,
    });
    db.hlsRows.push({
      id: "row-stopping",
      channel_id: CHANNEL,
      object_prefix: `live/${CHANNEL}/1725000000000-ll`,
      started_at: 1_725_000_000_000,
      ended_at: null,
      remux_session_id: sessionId,
      presenter_peer_id: "peer-1",
      stopping_at: Date.now() - 60_000, // well past every backoff step
      stop_attempts: 1,
    });
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });

    const result = await adoptLlHlsSessions();

    expect(llHasRoom(CHANNEL)).toBe(false);
    expect(server.sessions.has(sessionId)).toBe(false);
    expect(db.hlsRows[0]!.ended_at).not.toBeNull();
    expect(result?.adopted).toBe(0);
  });

  it("stops orphan sessions in parallel, BOUNDED at 4, not one at a time and not all at once", async () => {
    enableLL();
    const server = createFakeRemuxServer();
    let concurrentInFlight = 0;
    let maxConcurrent = 0;
    setHlsRemuxTestHooks({
      fetch: async (url, init) => {
        const method = (init.method ?? "GET").toUpperCase();
        if (method === "DELETE") {
          concurrentInFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrentInFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          concurrentInFlight -= 1;
        }
        return server.fetchImpl(url, init);
      },
    });
    const ids = Array.from(
      { length: 12 },
      (_, i) => `00000000-0000-4000-8000-00000000d${String(i).padStart(3, "0")}`,
    );
    for (const id of ids) {
      server.sessions.set(id, {
        sessionId: id,
        room: OTHER_CHANNEL,
        channelId: OTHER_CHANNEL,
        subscribed: true,
        startedAtMs: Date.now(),
        lastPartAtMs: null,
        lastIdrAtMs: null,
        openSegmentMs: null,
        partsWritten: 0,
        bytesServed: 0,
      });
    }

    const result = await adoptLlHlsSessions();

    expect(result).toEqual({ adopted: 0, ended: 0, stopped: 12 });
    expect(maxConcurrent).toBeGreaterThan(1);
    expect(maxConcurrent).toBeLessThanOrEqual(4);
  });

  it("ends stale rows (no matching remote session) with one batched UPDATE, not one per row", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    // No sessions on the box at all -- two rows that were open here now
    // have nothing on the box behind them.
    db.hlsRows.push(
      {
        id: "row-a",
        channel_id: CHANNEL,
        object_prefix: `live/${CHANNEL}/1000-ll`,
        started_at: 1000,
        ended_at: null,
        remux_session_id: "00000000-0000-4000-8000-0000000000d1",
        presenter_peer_id: "peer-1",
        stopping_at: null,
        stop_attempts: 0,
      },
      {
        id: "row-b",
        channel_id: OTHER_CHANNEL,
        object_prefix: `live/${OTHER_CHANNEL}/2000-ll`,
        started_at: 2000,
        ended_at: null,
        remux_session_id: "00000000-0000-4000-8000-0000000000d2",
        presenter_peer_id: "peer-2",
        stopping_at: null,
        stop_attempts: 0,
      },
    );
    let updateCalls = 0;
    const originalImpl = db.queryImpl;
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("id = ANY")) {
        updateCalls += 1;
        expect((params![0] as string[]).sort()).toEqual(["row-a", "row-b"]);
      }
      return originalImpl(sql, params);
    });

    const result = await adoptLlHlsSessions();

    expect(result).toEqual({ adopted: 0, ended: 2, stopped: 0 });
    expect(updateCalls).toBe(1);
    expect(db.hlsRows.every((r) => r.ended_at !== null)).toBe(true);
  });
});

describe("llHlsActivity", () => {
  it("reads zero on a fresh process", () => {
    expect(llHlsActivity()).toEqual({
      sessions: 0,
      startFailures: 0,
      stopFailures: 0,
      demoted: 0,
    });
  });

  it("resetHlsRemuxForTests clears sessions and counters", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    await reconcileLlHlsNow(CHANNEL, "peer-1");
    expect(llHlsActivity().sessions).toBe(1);

    resetHlsRemuxForTests();

    expect(llHlsActivity()).toEqual({
      sessions: 0,
      startFailures: 0,
      stopFailures: 0,
      demoted: 0,
    });
    expect(llHasRoom(CHANNEL)).toBe(false);
  });
});
