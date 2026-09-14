import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remuxControlSignaturePayload } from "@pqp/shared";

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../lib/log.js", () => ({ logEvent }));

const query = vi.hoisted(() => vi.fn(async (_sql: string, _params?: unknown[]) => ({
  rowCount: 0,
  rows: [] as unknown[],
})));
vi.mock("../db.js", () => ({ getPool: () => ({ query }) }));

const {
  isLiveHlsLLEnabled,
  liveHlsLLAllowlist,
  resolveHlsMode,
  setRequestedHlsMode,
  requestedHlsModeFor,
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
const SECRET = "test-remux-secret";

function enableLL() {
  process.env.LIVE_HLS_LL = "true";
  process.env.LIVE_HLS_REMUX_CONTROL_URL = CONTROL_URL;
  process.env.LIVE_HLS_REMUX_CONTROL_SECRET = SECRET;
  process.env.LIVE_HLS_REMUX_ORIGIN_URL = ORIGIN_URL;
}

function disableLL() {
  delete process.env.LIVE_HLS_LL;
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
    expect(
      resolveHlsMode({ serverId: SERVER, requestedMode: true }),
    ).toBe("conventional");
  });

  it("stays conventional when the flag is on but nothing asked for it", () => {
    process.env.LIVE_HLS_LL = "true";
    expect(
      resolveHlsMode({ serverId: SERVER, requestedMode: false }),
    ).toBe("conventional");
  });

  it("is ll when the flag is on, requested, and there is no allowlist", () => {
    process.env.LIVE_HLS_LL = "true";
    expect(isLiveHlsLLEnabled()).toBe(true);
    expect(liveHlsLLAllowlist()).toBeNull();
    expect(
      resolveHlsMode({ serverId: SERVER, requestedMode: true }),
    ).toBe("ll");
  });

  it("is ll for a server on the allowlist", () => {
    process.env.LIVE_HLS_LL = "true";
    process.env.LIVE_HLS_LL_ALLOWLIST = `${OTHER_SERVER},${SERVER}`;
    expect(liveHlsLLAllowlist()).toEqual(new Set([OTHER_SERVER, SERVER]));
    expect(
      resolveHlsMode({ serverId: SERVER, requestedMode: true }),
    ).toBe("ll");
  });

  it("stays conventional for a server NOT on the allowlist", () => {
    process.env.LIVE_HLS_LL = "true";
    process.env.LIVE_HLS_LL_ALLOWLIST = OTHER_SERVER;
    expect(
      resolveHlsMode({ serverId: SERVER, requestedMode: true }),
    ).toBe("conventional");
  });

  it("stays conventional with no server id and an allowlist set", () => {
    process.env.LIVE_HLS_LL = "true";
    process.env.LIVE_HLS_LL_ALLOWLIST = SERVER;
    expect(
      resolveHlsMode({ serverId: null, requestedMode: true }),
    ).toBe("conventional");
  });
});

describe("the per-channel request field", () => {
  it("defaults to false for a channel that never asked", () => {
    expect(requestedHlsModeFor(CHANNEL)).toBe(false);
  });

  it("remembers a request until overwritten", () => {
    setRequestedHlsMode(CHANNEL, true);
    expect(requestedHlsModeFor(CHANNEL)).toBe(true);
    expect(requestedHlsModeFor(OTHER_CHANNEL)).toBe(false);
    setRequestedHlsMode(CHANNEL, false);
    expect(requestedHlsModeFor(CHANNEL)).toBe(false);
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
      pliGateFactor: 1.5,
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

/** A minimal in-memory stand-in for the control API's three routes. */
function createFakeRemuxServer() {
  const sessions = new Map<string, ReturnType<typeof buildInfo>>();
  const calls: { method: string; path: string; headers: Headers; body: string }[] = [];
  /** Every sessionId ever accepted by POST /sessions, in order, even after it was later stopped. */
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
      return new Response(
        JSON.stringify({ sessions: [...sessions.values()] }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };

  return { fetchImpl, sessions, calls, created };
}

describe("the control client is signed with LIVE_HLS_REMUX_CONTROL_SECRET", () => {
  it("sends a timestamp and a matching HMAC-SHA256 signature", async () => {
    enableLL();
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl, now: () => 1_000_000 });

    await reconcileLlHlsNow(CHANNEL, "peer-1");

    // A GET /sessions precedes the POST (`findExistingRemuxSession`, the
    // retry-safety check) -- both must be signed, so this asserts the LAST
    // call, the POST that actually starts the session.
    const call = server.calls.at(-1)!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/sessions");
    const timestamp = call.headers.get("x-pqp-remux-timestamp");
    const signature = call.headers.get("x-pqp-remux-signature");
    expect(timestamp).toBe("1000000");
    const expected = createHmac("sha256", SECRET)
      .update(remuxControlSignaturePayload("POST", "/sessions", "1000000", call.body), "utf8")
      .digest("hex");
    expect(signature).toBe(expected);
  });

  it("signs a DELETE with the id in the path and an empty body", async () => {
    enableLL();
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl, now: () => 2_000_000 });
    await reconcileLlHlsNow(CHANNEL, "peer-1");
    server.calls.length = 0;

    await stopLlSession(CHANNEL, "test-stop");

    expect(server.calls).toHaveLength(1);
    const call = server.calls[0]!;
    expect(call.method).toBe("DELETE");
    expect(call.body).toBe("");
    const signature = call.headers.get("x-pqp-remux-signature");
    const expected = createHmac("sha256", SECRET)
      .update(remuxControlSignaturePayload("DELETE", call.path, "2000000", ""), "utf8")
      .digest("hex");
    expect(signature).toBe(expected);
  });
});

describe("starting and stopping a session", () => {
  it("fails closed, counted, when the control plane is not configured", async () => {
    // LIVE_HLS_LL unset entirely: reconcileLlHlsNow is only ever reached
    // from hls-egress.ts after resolveHlsMode already said "ll", but this
    // function itself must not assume that -- an operator can set the flag
    // without yet setting the box's URL and secret.
    const stream = await reconcileLlHlsNow(CHANNEL, "peer-1");
    expect(stream).toBeNull();
    expect(llHlsActivity().startFailures).toBe(1);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlStartFailed",
      expect.objectContaining({ channelId: CHANNEL, reason: "not-configured" }),
    );
  });

  it("starts a session, records the row, and returns a stream with mode ll", async () => {
    enableLL();
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl, now: () => 3_000_000 });

    const stream = await reconcileLlHlsNow(CHANNEL, "peer-1");

    expect(stream).not.toBeNull();
    expect(stream?.mode).toBe("ll");
    expect(stream?.presenterPeerId).toBe("peer-1");
    // The SAME access-controlled, signed-token path the conventional ladder
    // uses -- never the egress box's raw origin URL. See llPlaylistUrl's own
    // doc comment (a Farol HIGH finding on the first version of this file).
    expect(stream?.hlsUrl.startsWith(`/api/voice/hls-playlist/${CHANNEL}/`)).toBe(true);
    expect(stream?.hlsUrl.startsWith(ORIGIN_URL)).toBe(false);
    expect(llHasRoom(CHANNEL)).toBe(true);
    expect(llStreamFor(CHANNEL)).toEqual(stream);
    expect(llHlsActivity().sessions).toBe(1);

    const insertCall = query.mock.calls.find(([sql]) =>
      (sql as string).includes("INSERT INTO hls_sessions"),
    );
    expect(insertCall).toBeTruthy();
    expect(insertCall![1]).toEqual(
      expect.arrayContaining([CHANNEL]),
    );
  });

  it("reuses the running session for the same presenter, without a second call", async () => {
    enableLL();
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });

    const first = await reconcileLlHlsNow(CHANNEL, "peer-1");
    const second = await reconcileLlHlsNow(CHANNEL, "peer-1");

    expect(second).toEqual(first);
    expect(server.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("stops and restarts on a presenter change", async () => {
    enableLL();
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });

    await reconcileLlHlsNow(CHANNEL, "peer-1");
    const second = await reconcileLlHlsNow(CHANNEL, "peer-2");

    expect(second?.presenterPeerId).toBe("peer-2");
    // A genuinely new session (a second distinct sessionId was created on
    // the box), not the old presenter's row relabelled.
    expect(server.created).toHaveLength(2);
    expect(server.created[0]).not.toBe(server.created[1]);
    expect(server.sessions.size).toBe(1);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlStopped",
      expect.objectContaining({ channelId: CHANNEL, reason: "presenter-changed" }),
    );
  });

  it("stops on no presenter and logs the reason", async () => {
    enableLL();
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    await reconcileLlHlsNow(CHANNEL, "peer-1");

    const result = await reconcileLlHlsNow(CHANNEL, null);

    expect(result).toBeNull();
    expect(llHasRoom(CHANNEL)).toBe(false);
    expect(server.sessions.size).toBe(0);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlStopped",
      expect.objectContaining({ channelId: CHANNEL, reason: "no-share" }),
    );
  });

  it("treats a 404 on stop (already gone) as success, not a failure to log", async () => {
    enableLL();
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    await reconcileLlHlsNow(CHANNEL, "peer-1");
    // Gone on the box already -- a race with something else, or a restart.
    server.sessions.clear();

    await stopLlSession(CHANNEL, "test");

    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlStopped",
      expect.objectContaining({ reason: "test" }),
    );
    expect(logEvent).not.toHaveBeenCalledWith(
      "voice.hlsLlStopFailed",
      expect.anything(),
    );
  });

  it("keeps the room when the remote DELETE fails, instead of forgetting it", async () => {
    enableLL();
    const server = createFakeRemuxServer();
    let failDelete = false;
    setHlsRemuxTestHooks({
      fetch: async (url, init) => {
        if (failDelete && (init.method ?? "GET").toUpperCase() === "DELETE") {
          throw new Error("ETIMEDOUT");
        }
        return server.fetchImpl(url, init);
      },
    });
    await reconcileLlHlsNow(CHANNEL, "peer-1");
    failDelete = true;

    await stopLlSession(CHANNEL, "test");

    // Still owned: a failed stop must not be forgotten, or the next
    // reconcile would start a second session on top of one that, for all
    // this process knows, is still running on the box (a Farol finding on
    // PR #580).
    expect(llHasRoom(CHANNEL)).toBe(true);
    expect(server.sessions.size).toBe(1);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlStopFailed",
      expect.objectContaining({ channelId: CHANNEL, reason: "test" }),
    );
  });

  it("defers a presenter switch rather than starting a second session when the old one won't stop", async () => {
    enableLL();
    const server = createFakeRemuxServer();
    let failDelete = false;
    setHlsRemuxTestHooks({
      fetch: async (url, init) => {
        if (failDelete && (init.method ?? "GET").toUpperCase() === "DELETE") {
          throw new Error("ETIMEDOUT");
        }
        return server.fetchImpl(url, init);
      },
    });
    const first = await reconcileLlHlsNow(CHANNEL, "peer-1");
    failDelete = true;

    const second = await reconcileLlHlsNow(CHANNEL, "peer-2");

    // The old session's stop could not be confirmed, so no new one was
    // started on top of it: the channel is still reported as peer-1's
    // session, not a second, orphaned peer-2 session.
    expect(second).toEqual(first);
    expect(server.created).toHaveLength(1);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlSwitchDeferred",
      expect.objectContaining({ channelId: CHANNEL, presenterPeerId: "peer-2" }),
    );
  });

  it("does NOT reuse a stale session found only by channelId, with no pending attempt of its own", async () => {
    // A leftover session for this room that THIS process never itself
    // attempted (it survived an ended party's failed teardown, say) must
    // never be silently adopted as if it were a fresh start -- the Farol
    // finding (second round) that replaced "any session for this
    // channelId" with "the specific sessionId I am waiting to confirm".
    // Cleaning up a genuine leftover like this one is `adoptLlHlsSessions`'s
    // job on the next boot, not a live start's.
    enableLL();
    const server = createFakeRemuxServer();
    server.sessions.set("00000000-0000-4000-8000-0000000000e1", {
      sessionId: "00000000-0000-4000-8000-0000000000e1",
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
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });

    const stream = await reconcileLlHlsNow(CHANNEL, "peer-1");

    expect(stream).not.toBeNull();
    // A brand-new session was started; the stale one was left exactly as it
    // was, not touched or reused.
    expect(server.created).toHaveLength(1);
    expect(server.created[0]).not.toBe("00000000-0000-4000-8000-0000000000e1");
    expect(server.sessions.size).toBe(2);
    expect(logEvent).not.toHaveBeenCalledWith(
      "voice.hlsLlStartFoundExisting",
      expect.anything(),
    );
  });

  it("resumes an ambiguous start on the next attempt instead of minting a duplicate", async () => {
    // The POST reaches the box, but this process never sees the response
    // (a dropped connection, a timeout on the way back). The NEXT attempt
    // for the same channel must find and confirm that exact session rather
    // than starting a second one.
    enableLL();
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
    expect(llHasRoom(CHANNEL)).toBe(false);

    const second = await reconcileLlHlsNow(CHANNEL, "peer-1");

    expect(second).not.toBeNull();
    expect(server.created).toHaveLength(1); // no second POST
    expect(server.sessions.size).toBe(1);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlStartFoundExisting",
      expect.objectContaining({ channelId: CHANNEL, sessionId: server.created[0] }),
    );
  });

  it("expires a stale pending marker instead of letting a later, unrelated party adopt it", async () => {
    // A channel whose one ambiguous attempt is never retried (the presenter
    // leaves, nobody shares again for a while) must not keep that marker
    // forever: a much later, unrelated party starting in the SAME channel
    // must never "confirm" the old attempt's session just because its id
    // still happens to be the one remembered (a Farol finding on PR #580,
    // third round).
    enableLL();
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
    vi.useFakeTimers();
    try {
      const first = await reconcileLlHlsNow(CHANNEL, "peer-1");
      expect(first).toBeNull();
      const staleSessionId = server.created[0]!;
      expect(server.sessions.has(staleSessionId)).toBe(true);

      // Past the 2-minute window, and for a different presenter entirely --
      // a genuinely new, unrelated party in this same channel.
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);

      const second = await reconcileLlHlsNow(CHANNEL, "peer-9");

      expect(second).not.toBeNull();
      expect(second?.presenterPeerId).toBe("peer-9");
      // A fresh session was started -- the stale one was never treated as
      // belonging to this new party.
      expect(server.created).toHaveLength(2);
      expect(server.created[1]).not.toBe(staleSessionId);
      expect(logEvent).toHaveBeenCalledWith(
        "voice.hlsLlPendingStartExpired",
        expect.objectContaining({ channelId: CHANNEL, sessionId: staleSessionId }),
      );
      expect(logEvent).not.toHaveBeenCalledWith(
        "voice.hlsLlStartFoundExisting",
        expect.objectContaining({ sessionId: staleSessionId }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes an unresolved rollback before starting anything new for the room", async () => {
    enableLL();
    const server = createFakeRemuxServer();
    let failInsert = true;
    let failDelete = true;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO hls_sessions") && failInsert) {
        throw new Error("db down");
      }
      return { rowCount: 0, rows: [] };
    });
    setHlsRemuxTestHooks({
      fetch: async (url, init) => {
        if (failDelete && (init.method ?? "GET").toUpperCase() === "DELETE") {
          throw new Error("ETIMEDOUT");
        }
        return server.fetchImpl(url, init);
      },
    });

    const first = await reconcileLlHlsNow(CHANNEL, "peer-1");
    expect(first).toBeNull();
    // The session is still running: recording failed AND the rollback
    // DELETE also failed, so nothing tore it down yet.
    expect(server.sessions.size).toBe(1);
    expect(server.created).toHaveLength(1);

    failDelete = false;
    failInsert = false;
    const second = await reconcileLlHlsNow(CHANNEL, "peer-1");

    expect(second).not.toBeNull();
    // The stuck session was cleaned up first, then a genuinely fresh one
    // was started -- not the same id resurrected, and not a second one
    // running alongside the first.
    expect(server.created).toHaveLength(2);
    expect(server.sessions.size).toBe(1);
  });

  it("stops the session it just started/found and refuses to publish when the row cannot be recorded", async () => {
    enableLL();
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO hls_sessions")) {
        throw new Error("connection terminated");
      }
      return { rowCount: 0, rows: [] };
    });

    const stream = await reconcileLlHlsNow(CHANNEL, "peer-1");

    expect(stream).toBeNull();
    expect(llHasRoom(CHANNEL)).toBe(false);
    // The remux session that was started is stopped again: nothing keeps
    // running on the box with no `hls_sessions` row behind it (a Farol
    // finding on PR #580).
    expect(server.sessions.size).toBe(0);
    expect(llHlsActivity().startFailures).toBe(1);
  });
});

describe("boot adoption", () => {
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

  it("adopts a remote session with a matching, owned row", async () => {
    enableLL();
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    server.sessions.set("00000000-0000-4000-8000-0000000000c1", {
      sessionId: "00000000-0000-4000-8000-0000000000c1",
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
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "row-1",
              channel_id: CHANNEL,
              started_at: new Date(1_725_000_000_000).toISOString(),
              ended_at: null,
              remux_session_id: "00000000-0000-4000-8000-0000000000c1",
              presenter_peer_id: "peer-1",
              origin_base_url: ORIGIN_URL,
            },
          ],
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const result = await adoptLlHlsSessions();

    expect(result).toEqual({ adopted: 1, ended: 0, stopped: 0 });
    expect(llHasRoom(CHANNEL)).toBe(true);
    expect(llStreamFor(CHANNEL)?.presenterPeerId).toBe("peer-1");
    expect(llStreamFor(CHANNEL)?.mode).toBe("ll");
    // The go-live request is restored alongside the adopted row, or the
    // very next reconcile (a roster event after boot) would resolve
    // "conventional" and immediately stop the session this just adopted.
    expect(requestedHlsModeFor(CHANNEL)).toBe(true);
  });

  it("does NOT adopt a row already marked ended, even if the box still answers with it", async () => {
    // A failed DELETE outside `stopLlSession`'s own retry path, or a bare
    // race with the 1-hour lookback window: the row says this process
    // already told the party it was over. Adopting it anyway would
    // resurrect a session someone was told had stopped (a Farol finding on
    // PR #580).
    enableLL();
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    server.sessions.set("00000000-0000-4000-8000-0000000000c3", {
      sessionId: "00000000-0000-4000-8000-0000000000c3",
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
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "row-ended",
              channel_id: CHANNEL,
              started_at: new Date(1_725_000_000_000).toISOString(),
              ended_at: new Date().toISOString(),
              remux_session_id: "00000000-0000-4000-8000-0000000000c3",
              presenter_peer_id: "peer-1",
              origin_base_url: ORIGIN_URL,
            },
          ],
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const result = await adoptLlHlsSessions();

    expect(result).toEqual({ adopted: 0, ended: 0, stopped: 1 });
    expect(llHasRoom(CHANNEL)).toBe(false);
    expect(server.sessions.has("00000000-0000-4000-8000-0000000000c3")).toBe(false);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlOrphanStopped",
      expect.objectContaining({
        sessionId: "00000000-0000-4000-8000-0000000000c3",
        reason: "no-row",
      }),
    );
  });

  it("stops a remote session with no owning row", async () => {
    enableLL();
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    server.sessions.set("00000000-0000-4000-8000-0000000000c2", {
      sessionId: "00000000-0000-4000-8000-0000000000c2",
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

    const result = await adoptLlHlsSessions();

    expect(result).toEqual({ adopted: 0, ended: 0, stopped: 1 });
    expect(server.sessions.has("00000000-0000-4000-8000-0000000000c2")).toBe(false);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsLlOrphanStopped",
      expect.objectContaining({ sessionId: "00000000-0000-4000-8000-0000000000c2", reason: "no-row" }),
    );
  });

  it("ends a row whose remote session is gone", async () => {
    enableLL();
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    // No sessions on the box at all -- it restarted with nothing to adopt.
    let updateCalled = false;
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "row-dead",
              channel_id: CHANNEL,
              started_at: new Date().toISOString(),
              ended_at: null,
              remux_session_id: "remux-dead",
              presenter_peer_id: "peer-1",
              origin_base_url: ORIGIN_URL,
            },
          ],
        };
      }
      if (sql.includes("UPDATE hls_sessions")) {
        updateCalled = true;
        // One round trip for every stale row (a batched ANY($1) call), not
        // one UPDATE per row -- a Farol finding on PR #580.
        expect(params).toEqual([["row-dead"]]);
      }
      return { rowCount: 1, rows: [] };
    });

    const result = await adoptLlHlsSessions();

    expect(result).toEqual({ adopted: 0, ended: 1, stopped: 0 });
    expect(updateCalled).toBe(true);
  });

  it("stops orphan sessions in parallel, BOUNDED, not one at a time and not all at once", async () => {
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
    // More orphans than the concurrency bound, so an unbounded
    // `Promise.allSettled` over the whole set (the Farol finding this test
    // pins) would show every one of them in flight at once.
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
    expect(maxConcurrent).toBeLessThanOrEqual(5);
  });
});

describe("llHlsActivity", () => {
  it("reads zero on a fresh process", () => {
    expect(llHlsActivity()).toEqual({ sessions: 0, startFailures: 0, demoted: 0 });
  });

  it("resetHlsRemuxForTests clears sessions and counters", async () => {
    enableLL();
    const server = createFakeRemuxServer();
    setHlsRemuxTestHooks({ fetch: server.fetchImpl });
    await reconcileLlHlsNow(CHANNEL, "peer-1");
    expect(llHlsActivity().sessions).toBe(1);

    resetHlsRemuxForTests();

    expect(llHlsActivity()).toEqual({ sessions: 0, startFailures: 0, demoted: 0 });
    expect(llHasRoom(CHANNEL)).toBe(false);
  });
});
