import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_HLS_MODE_LL,
  LIVE_HLS_MODE_PARAM,
  remuxControlSignaturePayload,
  remuxStartSessionRequestSchema,
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
  liveHlsRequestForChannel,
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
  rebindLlForReplacedTrack,
  setLlPresenterIdentity,
  stopLlSession,
  adoptLlHlsSessions,
  setHlsRemuxTestHooks,
  setLlCameraSlot,
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

/** Every fake party starts at the same instant; no test here turns on when. */
const FAKE_PARTY_CREATED_AT_MS = 1_725_000_000_000;

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

    // `rebindLlSession`: the row follows the peer the box was rebound to.
    if (sql.includes("SET presenter_peer_id = $2")) {
      const [objectPrefix, presenterPeerId] = p as [string, string];
      const row = hlsRows.find((r) => r.object_prefix === objectPrefix && r.ended_at === null);
      if (row) {
        row.presenter_peer_id = presenterPeerId;
      }
      return { rowCount: row ? 1 : 0, rows: [] };
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

    if (sql.includes("SELECT id, low_latency_requested")) {
      const [channelId] = p as [string];
      const found = [...channelSessions].find(
        ([, c]) => c.channel_id === channelId && c.status === "live",
      );
      return {
        rowCount: found ? 1 : 0,
        rows: found
          ? [
              {
                id: found[0],
                low_latency_requested: found[1].low_latency_requested,
                created_at_ms: String(FAKE_PARTY_CREATED_AT_MS),
              },
            ]
          : [],
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

/**
 * How the fake box answers `POST /sessions/:id/rebind`: a box with the route
 * (`ok`), one without it (`missing-route`, Go's plain-text 404), one that has
 * lost the session regardless of what it holds (`gone`), a demoted session
 * (`demoted`), or no answer at all (`unreachable`).
 */
type FakeRebindMode = "ok" | "missing-route" | "gone" | "demoted" | "unreachable";

/** A minimal in-memory stand-in for the control API's routes. */
function createFakeRemuxServer() {
  let rebindMode: FakeRebindMode = "ok";
  const rebinds: { sessionId: string; presenterIdentity: string }[] = [];
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
      const req = JSON.parse(body) as {
        sessionId: string;
        room: string;
        channelId: string;
        presenterIdentity?: string;
      };
      const info: ReturnType<typeof buildInfo> & { presenterIdentity?: string } = {
        ...buildInfo(req.sessionId, req.room, req.channelId),
        presenterIdentity: req.presenterIdentity,
      };
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
    const rebind = /^\/sessions\/([^/]+)\/rebind$/.exec(pathname);
    if (method === "POST" && rebind) {
      const id = rebind[1]!;
      const { presenterIdentity } = JSON.parse(body) as { presenterIdentity: string };
      switch (rebindMode) {
        case "missing-route":
          return new Response("404 page not found\n", { status: 404 });
        case "unreachable":
          throw new Error("ECONNREFUSED");
        case "demoted":
          return new Response(JSON.stringify({ error: "session is demoted" }), { status: 409 });
        case "gone":
          return new Response(JSON.stringify({ error: "session not found" }), { status: 404 });
        default:
          if (!sessions.has(id)) {
            return new Response(JSON.stringify({ error: "session not found" }), { status: 404 });
          }
          rebinds.push({ sessionId: id, presenterIdentity });
          (sessions.get(id) as { presenterIdentity?: string }).presenterIdentity = presenterIdentity;
          return new Response(
            JSON.stringify({ sessionId: id, presenterIdentity, result: "bound" }),
            { status: 200 },
          );
      }
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };

  return {
    fetchImpl,
    sessions,
    calls,
    created,
    rebinds,
    setRebindMode: (mode: FakeRebindMode) => {
      rebindMode = mode;
    },
  };
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

describe("the per-server row beats the allowlist, and NULL is the allowlist", () => {
  it("TRUE is ll and available for a server the variable does not name", () => {
    enableMode();
    process.env.LIVE_HLS_LL_ALLOWLIST = OTHER_SERVER;
    expect(resolveHlsMode({ serverId: SERVER, requestedMode: true, override: true })).toBe("ll");
    expect(liveHlsLLAvailable(SERVER, true)).toBe(true);
  });

  it("FALSE is conventional and unavailable even when the variable names it", () => {
    enableMode();
    process.env.LIVE_HLS_LL_ALLOWLIST = SERVER;
    expect(resolveHlsMode({ serverId: SERVER, requestedMode: true, override: false })).toBe(
      "conventional",
    );
    expect(liveHlsLLAvailable(SERVER, false)).toBe(false);
  });

  it("NULL answers exactly what no override answers", () => {
    enableMode();
    for (const allowlist of [undefined, SERVER, OTHER_SERVER]) {
      if (allowlist === undefined) {
        delete process.env.LIVE_HLS_LL_ALLOWLIST;
      } else {
        process.env.LIVE_HLS_LL_ALLOWLIST = allowlist;
      }
      expect(resolveHlsMode({ serverId: SERVER, requestedMode: true, override: null })).toBe(
        resolveHlsMode({ serverId: SERVER, requestedMode: true }),
      );
      expect(liveHlsLLAvailable(SERVER, null)).toBe(liveHlsLLAvailable(SERVER));
    }
  });

  it("cannot turn on a deployment without the flag, nor a party that did not ask", () => {
    expect(resolveHlsMode({ serverId: SERVER, requestedMode: true, override: true })).toBe(
      "conventional",
    );
    expect(liveHlsLLAvailable(SERVER, true)).toBe(false);
    enableMode();
    expect(resolveHlsMode({ serverId: SERVER, requestedMode: false, override: true })).toBe(
      "conventional",
    );
  });

  it("does not apply to the deployment-wide answer, which has no server", () => {
    enableMode();
    process.env.LIVE_HLS_LL_ALLOWLIST = SERVER;
    expect(liveHlsLLAvailable(null, true)).toBe(false);
  });
});

describe("the per-channel request field is durable, not process memory", () => {
  it("defaults to false for a channel with no live party row", async () => {
    expect(await liveHlsRequestForChannel(CHANNEL)).toEqual({
      requested: false,
      partySessionId: null,
      partyCreatedAtMs: null,
    });
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

    expect(await liveHlsRequestForChannel(CHANNEL)).toEqual({
      requested: true,
      partySessionId: "party-1",
      partyCreatedAtMs: FAKE_PARTY_CREATED_AT_MS,
    });
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

    expect(await liveHlsRequestForChannel(OTHER_CHANNEL)).toEqual({
      requested: true,
      partySessionId: "party-2",
      partyCreatedAtMs: FAKE_PARTY_CREATED_AT_MS,
    });
    expect(await liveHlsRequestForChannel(CHANNEL)).toEqual({
      requested: false,
      partySessionId: null,
      partyCreatedAtMs: null,
    });
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

    expect(await liveHlsRequestForChannel(CHANNEL)).toBeNull();
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlLookupFailed",
      expect.objectContaining({ channelId: CHANNEL, source: "requested-mode" }),
    );

    // Rate limited: a second failure for the same channel inside the window
    // does not log again.
    logEvent.mockClear();
    expect(await liveHlsRequestForChannel(CHANNEL)).toBeNull();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("logs voice.hlsLlLookupFailed again for a DIFFERENT channel even inside the same window", async () => {
    query.mockImplementation(async () => {
      throw new Error("connection terminated");
    });

    await liveHlsRequestForChannel(CHANNEL);
    logEvent.mockClear();
    await liveHlsRequestForChannel(OTHER_CHANNEL);

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

  // The one field both sides must agree on: the box names every R2 object
  // after `startedAtMs`, and the row's `object_prefix` embeds the same number.
  // Before the field existed the box used its own clock and the two differed by
  // a few milliseconds, so retention, keep_replay and replay all looked at an
  // empty prefix (the 2026-09-21 broadcast).
  it("sends the row's own started_at as startedAtMs, so the box writes under the row's prefix", async () => {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl, now: () => 1_790_029_937_773 });

    await reconcileLlHlsNow(CHANNEL, "peer-1");

    const call = server.calls.find((c) => c.method === "POST")!;
    const body = JSON.parse(call.body) as { startedAtMs?: number };
    const row = db.hlsRows[0]!;
    expect(body.startedAtMs).toBe(row.started_at);
    expect(row.object_prefix).toBe(`live/${CHANNEL}/${body.startedAtMs}-ll`);
    // And the request still validates against the shared contract.
    expect(remuxStartSessionRequestSchema.parse(body)).toMatchObject({
      startedAtMs: row.started_at,
    });
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
    // one that might still be running fine. Resume-adopt asks first and
    // stands down on the same answer, so startLlSession is never reached
    // and startFailures stays at zero — the failure is the stand-down, not
    // a counted start attempt.
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
    expect(llHlsActivity().startFailures).toBe(0);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlLookupFailed",
      expect.objectContaining({ channelId: CHANNEL, source: "open-row" }),
    );
  });

  it("recovers and starts normally once the database read succeeds again", async () => {
    enableLL();
    const db = createFakeDb();
    const server = createFakeRemuxServer();
    let now = 1_700_000_000_000;
    setHlsRemuxTestHooks({ fetch: server.fetchImpl, now: () => now });
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

    // The stand-down is cached for a few seconds so a roster storm does not
    // re-probe on every join; past that window the next reconcile asks again.
    now += 6_000;
    const second = await reconcileLlHlsNow(CHANNEL, "peer-1");

    expect(second).not.toBeNull();
    expect(llHasRoom(CHANNEL)).toBe(true);
  });

  it("carries the companion's camera slot on the stream an audience is handed", async () => {
    // `llStreamFor` is what every audience reader reads. Until 2026-09-25 the
    // camera lived only on the companion's private copy, so an LL viewer
    // never learned it existed.
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    const stream = await reconcileLlHlsNow(CHANNEL, "peer-1");
    const slot = {
      cameraHlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${stream!.startedAt}/cam360p30`,
      cameraHasVideo: true,
      cameraHasVoiceAudio: false,
    };

    // A slot for another session is refused rather than pinned on this one.
    expect(setLlCameraSlot(CHANNEL, stream!.startedAt - 1, slot)).toBe(false);
    expect(llStreamFor(CHANNEL)?.cameraHlsUrl).toBeUndefined();

    expect(setLlCameraSlot(CHANNEL, stream!.startedAt, slot)).toBe(true);
    expect(llStreamFor(CHANNEL)).toEqual({ ...stream, ...slot });
    // Idempotent: the same slot again changes nothing.
    expect(setLlCameraSlot(CHANNEL, stream!.startedAt, slot)).toBe(false);

    expect(setLlCameraSlot(CHANNEL, stream!.startedAt, null)).toBe(true);
    expect(llStreamFor(CHANNEL)).toEqual(stream);
    expect(setLlCameraSlot(CHANNEL, stream!.startedAt, null)).toBe(false);
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
      rebindsTotal: 0,
      rebindsByReason: {},
      rebindFailuresByWhy: {},
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
      rebindsTotal: 0,
      rebindsByReason: {},
      rebindFailuresByWhy: {},
    });
    expect(llHasRoom(CHANNEL)).toBe(false);
  });
});

describe("a presenter track change keeps the LL session (rebind in place)", () => {
  /** peer id -> person, the answer `ws/voice.ts` registers. */
  function people(map: Record<string, string>) {
    setLlPresenterIdentity((_channel, peerId) => map[peerId] ?? null);
  }

  async function started() {
    enableLL();
    const db = createFakeDb();
    query.mockImplementation(db.queryImpl);
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    const first = await reconcileLlHlsNow(CHANNEL, "peer-1");
    expect(first).not.toBeNull();
    // A new session is keyed by its start instant: make sure one started
    // after this cannot share this one's millisecond.
    await new Promise((resolve) => setTimeout(resolve, 3));
    return { db, server, first: first! };
  }

  it("names the presenter on the start request, so the box follows only their screen", async () => {
    const { server } = await started();
    const post = server.calls.find((c) => c.method === "POST" && c.path === "/sessions");
    const body = remuxStartSessionRequestSchema.parse(JSON.parse(post!.body));
    expect(body.presenterIdentity).toBe("peer-1");
  });

  it("the same person under a new peer id is rebound on the box: same session, same URL, no stop", async () => {
    people({ "peer-1": "user-rafa", "peer-2": "user-rafa" });
    const { db, server, first } = await started();

    const again = await reconcileLlHlsNow(CHANNEL, "peer-2");

    expect(again?.startedAt).toBe(first.startedAt);
    expect(again?.hlsUrl).toBe(first.hlsUrl);
    expect(again?.presenterPeerId).toBe("peer-2");
    expect(server.created).toHaveLength(1);
    expect(server.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(server.rebinds).toEqual([
      { sessionId: server.created[0], presenterIdentity: "peer-2" },
    ]);
    // The row follows, so the other machine's resume adoption matches the
    // peer that is presenting now.
    expect(db.hlsRows).toHaveLength(1);
    expect(db.hlsRows[0]!.presenter_peer_id).toBe("peer-2");
    expect(db.hlsRows[0]!.ended_at).toBeNull();
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlRebound",
      expect.objectContaining({
        channelId: CHANNEL,
        reason: "presenter-reconnected",
        from: "peer-1",
        to: "peer-2",
        result: "bound",
      }),
    );
    expect(logEvent).not.toHaveBeenCalledWith("voice.hlsLlStopped", expect.anything());
    expect(llHlsActivity().rebindsByReason).toEqual({ "presenter-reconnected": 1 });
    // And the peer it now follows keeps it on the next roster event.
    expect(await reconcileLlHlsNow(CHANNEL, "peer-2")).toEqual(again);
    expect(server.rebinds).toHaveLength(1);
  });

  it("a DIFFERENT person is a new session, as before: no rebind is attempted", async () => {
    people({ "peer-1": "user-rafa", "peer-9": "user-andre" });
    const { server, first } = await started();
    const next = await reconcileLlHlsNow(CHANNEL, "peer-9");
    expect(server.rebinds).toHaveLength(0);
    expect(server.created).toHaveLength(2);
    expect(next?.startedAt).not.toBe(first.startedAt);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlStopped",
      expect.objectContaining({ reason: "presenter-changed" }),
    );
  });

  it("an older box without the route falls back to a new session, and says why", async () => {
    people({ "peer-1": "user-rafa", "peer-2": "user-rafa" });
    const { server, first } = await started();
    server.setRebindMode("missing-route");
    const next = await reconcileLlHlsNow(CHANNEL, "peer-2");
    expect(next?.startedAt).not.toBe(first.startedAt);
    expect(server.created).toHaveLength(2);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlRebindFailed",
      expect.objectContaining({ why: "unsupported", fallback: "new-session", status: 404 }),
    );
    expect(llHlsActivity().rebindFailuresByWhy).toEqual({ unsupported: 1 });
  });

  it("a box that lost the session falls back to a new session rather than a demotion", async () => {
    people({ "peer-1": "user-rafa", "peer-2": "user-rafa" });
    const { server } = await started();
    server.setRebindMode("gone");
    await reconcileLlHlsNow(CHANNEL, "peer-2");
    expect(server.created).toHaveLength(2);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlRebindFailed",
      expect.objectContaining({ why: "session-gone", fallback: "new-session" }),
    );
    expect(llHlsActivity().demoted).toBe(0);
  });

  it("a demoted session is held for the demotion sweep, never replaced here", async () => {
    people({ "peer-1": "user-rafa", "peer-2": "user-rafa" });
    const { server, first } = await started();
    server.setRebindMode("demoted");
    const held = await reconcileLlHlsNow(CHANNEL, "peer-2");
    expect(held).toEqual(first);
    expect(server.created).toHaveLength(1);
    expect(server.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlRebindFailed",
      expect.objectContaining({ why: "demoted", fallback: "demotion-sweep" }),
    );
  });

  it("a control API it cannot reach holds the session and rebinds on the next reconcile", async () => {
    people({ "peer-1": "user-rafa", "peer-2": "user-rafa" });
    const { server, first } = await started();
    server.setRebindMode("unreachable");
    const held = await reconcileLlHlsNow(CHANNEL, "peer-2");
    expect(held).toEqual(first);
    expect(server.created).toHaveLength(1);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlRebindFailed",
      expect.objectContaining({ why: "control-api-error", fallback: "retry" }),
    );

    server.setRebindMode("ok");
    const rebound = await reconcileLlHlsNow(CHANNEL, "peer-2");
    expect(rebound?.startedAt).toBe(first.startedAt);
    expect(rebound?.presenterPeerId).toBe("peer-2");
    expect(server.created).toHaveLength(1);
  });

  it("a replaced screen track under the same peer is a nudge to the box, never a new session", async () => {
    const { server, first } = await started();
    await rebindLlForReplacedTrack(CHANNEL, "peer-1", { videoFrom: "TR_a", videoTo: "TR_b" });
    expect(server.rebinds).toEqual([
      { sessionId: server.created[0], presenterIdentity: "peer-1" },
    ]);
    expect(server.created).toHaveLength(1);
    expect(llStreamFor(CHANNEL)).toEqual(first);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlRebound",
      expect.objectContaining({ reason: "screen-track-replaced", videoTo: "TR_b" }),
    );
    // An older box: logged, and nothing else happens at all.
    server.setRebindMode("missing-route");
    await rebindLlForReplacedTrack(CHANNEL, "peer-1");
    expect(server.created).toHaveLength(1);
    expect(llStreamFor(CHANNEL)).toEqual(first);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlRebindFailed",
      expect.objectContaining({ reason: "screen-track-replaced", why: "unsupported", fallback: "none" }),
    );
  });

  it("a replaced-track nudge says whether to ask again: only when the box could not be asked", async () => {
    const { server } = await started();
    expect(await rebindLlForReplacedTrack(CHANNEL, "peer-1")).toBe(true);
    server.setRebindMode("unreachable");
    expect(await rebindLlForReplacedTrack(CHANNEL, "peer-1")).toBe(false);
    server.setRebindMode("missing-route");
    expect(await rebindLlForReplacedTrack(CHANNEL, "peer-1")).toBe(true);
    server.setRebindMode("demoted");
    expect(await rebindLlForReplacedTrack(CHANNEL, "peer-1")).toBe(true);
  });

  it("a presenter row write that failed after a rebind is retried until it lands", async () => {
    people({ "peer-1": "user-rafa", "peer-2": "user-rafa" });
    const { db } = await started();
    let failPresenterWrite = true;
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SET presenter_peer_id = $2") && failPresenterWrite) {
        failPresenterWrite = false;
        throw new Error("connection reset");
      }
      return db.queryImpl(sql, params);
    });
    const rebound = await reconcileLlHlsNow(CHANNEL, "peer-2");
    expect(rebound?.presenterPeerId).toBe("peer-2");
    expect(db.hlsRows[0]!.presenter_peer_id).toBe("peer-1");
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlSessionRecordFailed",
      expect.objectContaining({ step: "presenter-peer" }),
    );
    await reconcileLlHlsNow(CHANNEL, "peer-2");
    expect(db.hlsRows[0]!.presenter_peer_id).toBe("peer-2");
  });

  it("a rebind whose row write died with the process is recovered from the box, not replaced", async () => {
    // The box accepted the rebind, the row write failed, and the process
    // restarted before retrying it. The new process knows nothing about the
    // person (no identity hook answers for the old peer) and the row still
    // names peer-1; the box says it follows peer-2.
    people({ "peer-1": "user-rafa", "peer-2": "user-rafa" });
    const { db, server, first } = await started();
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SET presenter_peer_id = $2")) {
        throw new Error("connection reset");
      }
      return db.queryImpl(sql, params);
    });
    await reconcileLlHlsNow(CHANNEL, "peer-2");
    expect(db.hlsRows[0]!.presenter_peer_id).toBe("peer-1");

    // The process restarts.
    resetHlsRemuxForTests();
    enableLL();
    query.mockImplementation(db.queryImpl);
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    const again = await reconcileLlHlsNow(CHANNEL, "peer-2");

    expect(again?.startedAt).toBe(first.startedAt);
    expect(again?.presenterPeerId).toBe("peer-2");
    expect(server.created).toHaveLength(1);
    expect(server.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(db.hlsRows[0]!.presenter_peer_id).toBe("peer-2");
  });

  it("knows the person from the old peer when the session was adopted before anybody was back", async () => {
    // A boot adoption records no person (no socket is back yet); the old
    // peer, held for its resume window, is still in this process's map when
    // the new one arrives.
    const { server, first } = await started();
    people({ "peer-1": "user-rafa", "peer-2": "user-rafa" });
    const next = await reconcileLlHlsNow(CHANNEL, "peer-2");
    expect(next?.startedAt).toBe(first.startedAt);
    expect(server.rebinds).toHaveLength(1);
  });
});
