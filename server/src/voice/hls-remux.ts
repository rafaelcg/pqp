import { createHmac, randomUUID } from "node:crypto";
import {
  remuxControlSignaturePayload,
  remuxErrorResponseSchema,
  remuxListSessionsResponseSchema,
  remuxSessionInfoSchema,
  REMUX_CONTROL_SIGNATURE_HEADER,
  REMUX_CONTROL_TIMESTAMP_HEADER,
  type LiveHlsStream,
  type RemuxKeyframePolicy,
  type RemuxSessionInfo,
} from "@pqp/shared";
import { logEvent } from "../lib/log.js";
import { getPool } from "../db.js";

/**
 * The `pqp-remux` driver, beside the LiveKit egress driver in `hls-egress.ts`.
 *
 * `docs/plans/LL_HLS.md`, task L1.5. Dark behind `LIVE_HLS_LL` (default off):
 * with the flag unset, `resolveHlsMode` always answers `conventional`,
 * nothing here ever calls the control API, `llRooms` stays empty, and every
 * counter in `llHlsActivity()` reads zero. See
 * `packages/shared/src/hls-remux-control.ts` for the wire contract this
 * module speaks (start/stop/list, HMAC signing) — that file is the one both
 * `pqp-api` and `pqp-remux` (L1.6) build from, so the shape lives there, not
 * here.
 *
 * What this module deliberately does NOT do, all left to later tasks:
 *
 *  - No camera, no mic archive. `pqp-remux` subscribes to one screen-share
 *    track and its own audio (per its own README, "Not yet" §
 *    "Presenter authorization") — there is nothing here for a webcam or a
 *    separate voice file to attach to.
 *  - No health polling, no stall detection, no restart-then-demote ladder.
 *    That is `L1.6`'s watchdog; `llDemoted` is exposed on the metrics
 *    surface now precisely so that task has a counter to increment into,
 *    not because anything here can produce it.
 *  - No R2 writer. `origin_base_url` is stored because the LL playlist front
 *    (`L2.x`) needs it, not because anything here writes objects there.
 */

// ---------------------------------------------------------------------------
// Flag, allowlist, mode selection
// ---------------------------------------------------------------------------

function truthyEnv(name: string): boolean {
  const raw = process.env[name];
  return raw === "true" || raw === "1";
}

/** `LIVE_HLS_LL`, read per call like every other flag in this feature. */
export function isLiveHlsLLEnabled(): boolean {
  return truthyEnv("LIVE_HLS_LL");
}

/**
 * `LIVE_HLS_LL_ALLOWLIST`: comma-separated server ids. Mirrors
 * `liveHlsServerAllowlist` in `hls-egress.ts` exactly — unset or empty means
 * every server, once the flag and the request agree LL is wanted.
 */
export function liveHlsLLAllowlist(): Set<string> | null {
  const raw = process.env.LIVE_HLS_LL_ALLOWLIST;
  if (!raw) {
    return null;
  }
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return ids.length > 0 ? new Set(ids) : null;
}

/**
 * Pure, so the whole matrix is testable with no environment and no database:
 * flag off -> `conventional`, whatever was requested. Flag on but the party
 * did not ask -> `conventional` (the default `docs/plans/LL_HLS.md` §4
 * requires). Flag on, asked, and either no allowlist or this server is on
 * it -> `ll`. Asked, flag on, allowlist set, server not on it ->
 * `conventional`, silently: `watchPartyStateRequestSchema.lowLatency` is not
 * a promise the client's request can enforce on its own.
 */
export function resolveHlsMode(input: {
  serverId: string | null | undefined;
  requestedMode: boolean;
}): "conventional" | "ll" {
  if (!input.requestedMode) {
    return "conventional";
  }
  if (!isLiveHlsLLEnabled()) {
    return "conventional";
  }
  const allowlist = liveHlsLLAllowlist();
  if (allowlist === null) {
    return "ll";
  }
  return input.serverId && allowlist.has(input.serverId) ? "ll" : "conventional";
}

/**
 * What a channel's most recent "go live" asked for. Set by the
 * `POST /api/watch-parties/:id/state` route when `state: "live"` carries
 * `lowLatency`, read by `reconcileLiveHlsNow` at the moment a sharer actually
 * appears (which can be well after the party went live). A channel that has
 * never asked, or last asked with `lowLatency` false/absent, answers false —
 * there is no "sticky yes" from a previous party.
 */
const requestedHlsMode = new Map<string, boolean>();

export function setRequestedHlsMode(channelId: string, requested: boolean): void {
  if (requested) {
    requestedHlsMode.set(channelId, true);
  } else {
    requestedHlsMode.delete(channelId);
  }
}

export function requestedHlsModeFor(channelId: string): boolean {
  return requestedHlsMode.get(channelId) === true;
}

// ---------------------------------------------------------------------------
// Control-plane client: signing and the three routes
// ---------------------------------------------------------------------------

function envTrimmed(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/** Base URL of the control API, e.g. `https://egress-1.pqp.gg:8443`. No trailing slash. */
export function remuxControlUrl(): string | null {
  const raw = envTrimmed("LIVE_HLS_REMUX_CONTROL_URL");
  return raw ? raw.replace(/\/+$/, "") : null;
}

export function remuxControlSecret(): string | null {
  return envTrimmed("LIVE_HLS_REMUX_CONTROL_SECRET");
}

/**
 * Where parts and playlists for a session are actually served from (Caddy on
 * the egress box, `docs/plans/LL_HLS.md` §1), distinct from the control URL
 * above, which never serves media. Required to start a session: a session
 * nothing can ever play is not worth starting.
 */
export function remuxOriginBaseUrl(): string | null {
  const raw = envTrimmed("LIVE_HLS_REMUX_ORIGIN_URL");
  return raw ? raw.replace(/\/+$/, "") : null;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveFloatFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * What a fresh session is started with. Every field here is a `pqp-remux`
 * config knob (`tools/pqp-remux/README.md` "Config") re-exposed as a
 * `pqp-api` env var of the same shape, prefixed `LIVE_HLS_REMUX_` to keep
 * "this box's own env" and "what the API asked the box for" visibly
 * separate. Defaults match the Go binary's own defaults, so an operator who
 * sets nothing gets the same session `pqp-remux` would run standalone.
 */
export function remuxSessionConfig(): {
  partMs: number;
  segmentMs: number;
  ringSegments: number;
  keyframePolicy: RemuxKeyframePolicy;
  pliPaceMs: number;
  pliGateFactor: number;
} {
  const policy = process.env.LIVE_HLS_REMUX_KEYFRAME_POLICY?.trim();
  return {
    partMs: positiveIntFromEnv("LIVE_HLS_REMUX_PART_MS", 500),
    segmentMs: positiveIntFromEnv("LIVE_HLS_REMUX_SEGMENT_MS", 4000),
    ringSegments: positiveIntFromEnv("LIVE_HLS_REMUX_RING_SEGMENTS", 6),
    keyframePolicy: policy === "pli" ? "pli" : "natural",
    pliPaceMs: positiveIntFromEnv("LIVE_HLS_REMUX_PLI_PACE_MS", 500),
    pliGateFactor: positiveFloatFromEnv("LIVE_HLS_REMUX_PLI_GATE_FACTOR", 1.5),
  };
}

/** What the go-live badge claims for an LL session. Not yet measured (`L3.x`). */
export function llDelaySeconds(): number {
  return positiveIntFromEnv("LIVE_HLS_REMUX_DELAY_SECONDS", 3);
}

const REMUX_CONTROL_TIMEOUT_MS = 5_000;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init);
let nowImpl: () => number = () => Date.now();

/** Test hook: inject a fake control server and a fake clock for signing. */
export function setHlsRemuxTestHooks(hooks: {
  fetch?: FetchLike;
  now?: () => number;
}): void {
  if (hooks.fetch) {
    fetchImpl = hooks.fetch;
  }
  if (hooks.now) {
    nowImpl = hooks.now;
  }
}

export class RemuxControlError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RemuxControlError";
  }
}

function signRequest(
  method: string,
  path: string,
  rawBody: string,
): { timestamp: string; signature: string } {
  const secret = remuxControlSecret();
  if (!secret) {
    throw new RemuxControlError("LIVE_HLS_REMUX_CONTROL_SECRET is not set");
  }
  const timestamp = String(nowImpl());
  const payload = remuxControlSignaturePayload(method, path, timestamp, rawBody);
  const signature = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return { timestamp, signature };
}

/** `POST`/`GET`/`DELETE` against the control API, signed, with a hard timeout. */
async function remuxFetch(method: string, path: string, body?: unknown): Promise<Response> {
  const base = remuxControlUrl();
  if (!base) {
    throw new RemuxControlError("LIVE_HLS_REMUX_CONTROL_URL is not set");
  }
  const rawBody = body === undefined ? "" : JSON.stringify(body);
  const { timestamp, signature } = signRequest(method, path, rawBody);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMUX_CONTROL_TIMEOUT_MS);
  try {
    return await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        [REMUX_CONTROL_TIMESTAMP_HEADER]: timestamp,
        [REMUX_CONTROL_SIGNATURE_HEADER]: signature,
      },
      body: rawBody.length > 0 ? rawBody : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const parsed = remuxErrorResponseSchema.safeParse(await response.json());
    if (parsed.success) {
      return parsed.data.error;
    }
  } catch {
    // Not JSON, or not the expected shape. Fall through to the status line.
  }
  return `${response.status} ${response.statusText}`;
}

async function remuxStartSession(
  input: ReturnType<typeof buildStartRequest>,
): Promise<RemuxSessionInfo> {
  const response = await remuxFetch("POST", "/sessions", input);
  if (response.status !== 200 && response.status !== 201 && response.status !== 409) {
    throw new RemuxControlError(await errorMessage(response), response.status);
  }
  return remuxSessionInfoSchema.parse(await response.json());
}

async function remuxStopSession(sessionId: string): Promise<void> {
  const response = await remuxFetch("DELETE", `/sessions/${sessionId}`);
  // Idempotent: a session already gone is not a failure to stop it.
  if (response.status !== 204 && response.status !== 404) {
    throw new RemuxControlError(await errorMessage(response), response.status);
  }
}

async function remuxListSessions(): Promise<RemuxSessionInfo[]> {
  const response = await remuxFetch("GET", "/sessions");
  if (response.status !== 200) {
    throw new RemuxControlError(await errorMessage(response), response.status);
  }
  return remuxListSessionsResponseSchema.parse(await response.json()).sessions;
}

function buildStartRequest(input: {
  sessionId: string;
  channelId: string;
}): {
  sessionId: string;
  room: string;
  channelId: string;
  partMs: number;
  segmentMs: number;
  ringSegments: number;
  keyframePolicy: RemuxKeyframePolicy;
  pliPaceMs: number;
  pliGateFactor: number;
} {
  const cfg = remuxSessionConfig();
  return {
    sessionId: input.sessionId,
    // The LiveKit room name IS the voice channel id everywhere else in this
    // codebase (`startRung` passes `channelId` straight to
    // `startTrackCompositeEgress`), so LL keeps the same identity rather than
    // inventing a second name for the same room.
    room: input.channelId,
    channelId: input.channelId,
    partMs: cfg.partMs,
    segmentMs: cfg.segmentMs,
    ringSegments: cfg.ringSegments,
    keyframePolicy: cfg.keyframePolicy,
    pliPaceMs: cfg.pliPaceMs,
    pliGateFactor: cfg.pliGateFactor,
  };
}

// ---------------------------------------------------------------------------
// Session bookkeeping and the DB rows
// ---------------------------------------------------------------------------

interface LlRoom {
  sessionId: string;
  startedAt: number;
  presenterPeerId: string;
  stream: LiveHlsStream;
}

const llRooms = new Map<string, LlRoom>();
let llStartFailures = 0;
/**
 * Incremented by `L1.6`'s watchdog when a stalled LL session is demoted back
 * to the conventional ladder. Nothing in this file can produce that
 * transition yet — this counter exists now so the metrics surface and the
 * dashboard panel are ready for it, and belongs at zero until that task
 * ships.
 */
let llDemoted = 0;

function llObjectPrefix(channelId: string, startedAt: number): string {
  // Same scheme as `hlsObjectPrefix` in `hls-egress.ts` (`live/<channel>/<startedAt>-<suffix>`),
  // kept as a local literal rather than an import to avoid a two-way module
  // dependency between the two drivers: `hls-egress.ts` calls into this file,
  // this file must never need to reach back into it for a format string.
  return `live/${channelId}/${startedAt}-ll`;
}

/**
 * What a viewer is actually handed as `LiveHlsStream.hlsUrl`, and
 * deliberately the SAME shape `viewerPlaylistUrl` in `hls-egress.ts` uses for
 * the conventional ladder -- never the egress box's raw origin URL.
 *
 * A Farol review of the first version of this file (PR #580) is why: that
 * version pointed `hlsUrl` straight at `${originBaseUrl}/${sessionId}/playlist.m3u8`,
 * an object nothing checks a token against, and every recipient of a
 * `voice-stream` / `channel-live` frame or a `GET /api/channels/:id/live`
 * response would have received a bearer link -- copy it, and anybody in the
 * world who ever saw it could play a private party's stream forever, with no
 * way to revoke it short of ending the session. Routing through this API's
 * own path means every existing consumer (`pushLiveHls`'s per-peer send,
 * `stampViewerStream`) mints and appends the SAME signed, per-user,
 * per-session `?t=` capability the conventional path already requires --
 * `extractChannelId`'s regex in `hls-viewer-token.ts` matches this exact
 * prefix, so it works with no changes there.
 *
 * This does NOT mean an LL session is playable today: `renderSignedPlaylist`
 * has no idea what a `mode: 'll'` row is (`rung IS NULL` for one, so
 * `sessionRungs` treats it as a pre-ladder single-rendition session and goes
 * looking for a LiveKit-shaped object that was never written) and answers
 * "not found" rather than serving anything -- which is the honest, SAFE
 * failure this task's scope should produce: no client treats `mode: "ll"`
 * specially yet (`L2.4`), and the playlist front that would make this URL
 * actually resolve is `L2.1`/`L2.2`. What matters for L1.5 is that nothing
 * this server hands out can be played by someone the access check would
 * have refused.
 */
function llPlaylistUrl(channelId: string, startedAt: number): string {
  return `/api/voice/hls-playlist/${channelId}/${startedAt}`;
}

async function recordLlSessionStarted(
  channelId: string,
  startedAt: number,
  remuxSessionId: string,
  presenterPeerId: string,
  partTargetMs: number,
  originBaseUrl: string,
): Promise<boolean> {
  try {
    await getPool().query(
      `INSERT INTO hls_sessions
         (channel_id, object_prefix, started_at, mode, remux_session_id,
          presenter_peer_id, part_target_ms, origin_base_url)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), 'll', $4, $5, $6, $7)
       ON CONFLICT (object_prefix) DO NOTHING`,
      [
        channelId,
        llObjectPrefix(channelId, startedAt),
        startedAt,
        remuxSessionId,
        presenterPeerId,
        partTargetMs,
        originBaseUrl,
      ],
    );
    return true;
  } catch (error) {
    logEvent("voice.hlsLlSessionRecordFailed", {
      channelId,
      startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function recordLlSessionEnded(channelId: string, startedAt: number): Promise<void> {
  try {
    await getPool().query(
      `UPDATE hls_sessions SET ended_at = NOW()
       WHERE object_prefix = $1 AND ended_at IS NULL`,
      [llObjectPrefix(channelId, startedAt)],
    );
  } catch (error) {
    logEvent("voice.hlsLlSessionEndFailed", {
      channelId,
      startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** One round trip for every stale row, not one per row (a Farol finding on PR #580). */
async function recordLlSessionsEndedByIds(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  try {
    await getPool().query(
      `UPDATE hls_sessions SET ended_at = NOW() WHERE id = ANY($1::uuid[]) AND ended_at IS NULL`,
      [ids],
    );
  } catch (error) {
    logEvent("voice.hlsLlSessionEndFailed", {
      ids,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Start / stop / reconcile — the seam `hls-egress.ts` calls
// ---------------------------------------------------------------------------

/** Whether this process currently holds an LL session for this channel. */
export function llHasRoom(channelId: string): boolean {
  return llRooms.has(channelId);
}

export function llStreamFor(channelId: string): LiveHlsStream | null {
  return llRooms.get(channelId)?.stream ?? null;
}

/**
 * Reuse a session the box already holds for this room rather than start a
 * second one. This is the guard against a retried start after an ambiguous
 * POST (the request reached the box, but the response was lost or timed
 * out): with no durable "I already asked" state on this side, the next
 * attempt asks the box FIRST whether `channelId` already has a session, and
 * only issues `POST /sessions` when it genuinely does not. Best-effort: a
 * `GET /sessions` failure here is not fatal, it just means this attempt
 * skips the check and starts fresh (the pre-existing risk, not a new one).
 */
async function findExistingRemuxSession(channelId: string): Promise<RemuxSessionInfo | null> {
  try {
    const sessions = await remuxListSessions();
    return sessions.find((session) => session.channelId === channelId) ?? null;
  } catch {
    return null;
  }
}

async function startLlSession(
  channelId: string,
  presenterPeerId: string,
): Promise<LiveHlsStream | null> {
  const originBaseUrl = remuxOriginBaseUrl();
  if (!remuxControlUrl() || !remuxControlSecret() || !originBaseUrl) {
    llStartFailures += 1;
    logEvent("voice.hlsLlStartFailed", { channelId, reason: "not-configured" });
    return null;
  }
  const startedAt = Date.now();
  const cfg = remuxSessionConfig();
  let info: RemuxSessionInfo;
  try {
    const existing = await findExistingRemuxSession(channelId);
    if (existing) {
      logEvent("voice.hlsLlStartFoundExisting", { channelId, sessionId: existing.sessionId });
      info = existing;
    } else {
      info = await remuxStartSession(
        buildStartRequest({ sessionId: randomUUID(), channelId }),
      );
    }
  } catch (error) {
    llStartFailures += 1;
    logEvent("voice.hlsLlStartFailed", {
      channelId,
      reason: "control-api-error",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const recorded = await recordLlSessionStarted(
    channelId,
    startedAt,
    info.sessionId,
    presenterPeerId,
    cfg.partMs,
    originBaseUrl,
  );
  if (!recorded) {
    // A session is now running on the box with no `hls_sessions` row behind
    // it. Publishing a stream nobody's retention or boot-adoption logic
    // knows about is worse than refusing: stop what was just started (or
    // found) and let the caller's next reconcile try again from scratch.
    llStartFailures += 1;
    try {
      await remuxStopSession(info.sessionId);
    } catch (error) {
      logEvent("voice.hlsLlStartRollbackFailed", {
        channelId,
        sessionId: info.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
  const stream: LiveHlsStream = {
    hlsUrl: llPlaylistUrl(channelId, startedAt),
    startedAt,
    presenterPeerId,
    delaySeconds: llDelaySeconds(),
    mode: "ll",
  };
  llRooms.set(channelId, {
    sessionId: info.sessionId,
    startedAt,
    presenterPeerId,
    stream,
  });
  logEvent("voice.hlsLlStarted", {
    channelId,
    sessionId: info.sessionId,
    subscribed: info.subscribed,
  });
  return stream;
}

/**
 * Every teardown carries a `reason` (pitfall 15's rule, and this driver has
 * no excuse to relearn it on day one).
 *
 * THE ROOM IS KEPT, NOT FORGOTTEN, WHEN THE REMOTE STOP FAILS. An earlier
 * version deleted from `llRooms` and marked the row ended unconditionally,
 * so a control-API hiccup left the remux process running with nothing on
 * this side still tracking it -- a future reconcile would then start a
 * SECOND session for the same room, and `adoptLlHlsSessions`'s boot sweep
 * could adopt a row marked `ended_at` while the session it names was still
 * live on the box (a Farol finding on PR #580). Now the row is only ended,
 * and the room only forgotten, once the box has actually confirmed the
 * session is gone (204 or 404, both idempotent successes in
 * `remuxStopSession`). A failure leaves the room in place so the NEXT call
 * here (the following reconcile, or nothing at all if the party is truly
 * over) gets another chance, at the cost of a session this process believes
 * is still live when the box may have already dropped it -- the same
 * ambiguity `adoptLlHlsSessions` exists to resolve on the next boot.
 */
export async function stopLlSession(channelId: string, reason: string): Promise<void> {
  const room = llRooms.get(channelId);
  if (!room) {
    return;
  }
  try {
    await remuxStopSession(room.sessionId);
  } catch (error) {
    logEvent("voice.hlsLlStopFailed", {
      channelId,
      sessionId: room.sessionId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  llRooms.delete(channelId);
  await recordLlSessionEnded(channelId, room.startedAt);
  logEvent("voice.hlsLlStopped", { channelId, sessionId: room.sessionId, reason });
}

/**
 * The LL half of `reconcileLiveHlsNow`. No track probing: unlike the
 * conventional ladder, `pqp-remux` finds the presenter's screen share itself
 * (its README, "Presenter authorization" — the first `SCREEN_SHARE` source
 * it sees), so there is nothing here to compare a track sid against. A
 * presenter reconnecting under a fresh peer id is therefore NOT specially
 * reattached the way the conventional path does it: the simpler rule below
 * (same peer id keeps the session, any other change restarts it) is correct
 * for L1.5's scope and can be sharpened once `L1.6`'s watchdog exists to
 * make a restart cheap to recover from.
 *
 * CONCURRENT CALLS FOR THE SAME CHANNEL CANNOT INTERLEAVE HERE. This
 * function is only ever reached through `reconcileLiveHlsNow` in
 * `hls-egress.ts`, which itself is only ever reached through the exported
 * `reconcileLiveHls`'s `reconcileQueue` -- a promise chain keyed per
 * channel, so a second roster event for a channel already mid-reconcile
 * waits for the first to finish rather than racing it. Two starts for one
 * room (a Farol concern on PR #580) would need two DIFFERENT channels'
 * reconciles to both resolve to the same LiveKit room name, which cannot
 * happen: the room name IS the channel id.
 */
export async function reconcileLlHlsNow(
  channelId: string,
  presenterPeerId: string | null,
): Promise<LiveHlsStream | null> {
  if (!presenterPeerId) {
    if (llRooms.has(channelId)) {
      await stopLlSession(channelId, "no-share");
    }
    return null;
  }
  const current = llRooms.get(channelId);
  if (current && current.presenterPeerId === presenterPeerId) {
    return current.stream;
  }
  if (current) {
    await stopLlSession(channelId, "presenter-changed");
    if (llRooms.has(channelId)) {
      // The stop above did not land (still in the map): do not start a
      // second session on top of one this process cannot confirm is gone.
      // The next reconcile -- another roster event, or the health path once
      // `L1.6` exists -- tries the stop again first.
      logEvent("voice.hlsLlSwitchDeferred", { channelId, presenterPeerId });
      return llRooms.get(channelId)!.stream;
    }
  }
  return startLlSession(channelId, presenterPeerId);
}

// ---------------------------------------------------------------------------
// Boot adoption
// ---------------------------------------------------------------------------

interface StaleLlRow {
  id: string;
  channel_id: string;
  started_at: string;
  ended_at: string | null;
  remux_session_id: string | null;
  presenter_peer_id: string | null;
  origin_base_url: string | null;
}

/**
 * The LL half of `reconcileStaleHlsSessions`: called once at boot, after the
 * conventional adoption, so a restart of `pqp-api` does not tear down a
 * live low-latency party either. Same two-sweep shape as
 * `reapForeignEgresses`/`sweepOwnStaleVoicePeers` (pitfall 13's rule — both
 * directions get a case for their own rows): every row this process might
 * own is reconciled against what the box actually reports, and neither side
 * is trusted alone.
 *
 *  - a live remote session with an owning row -> adopted into `llRooms`.
 *  - a live remote session with no row, or a row with no presenter -> the
 *    box is asked to stop it: nobody here can rebuild a room for it.
 *  - a row with no matching remote session -> ended: the box does not hold
 *    it any more, so its retention row should not sit open forever.
 *
 * `null` (rather than the zero-in-every-field result) when the control API
 * could not be asked at all — same fail-safe as `reconcileStaleHlsSessions`'s
 * `listActiveEgresses() === null` branch: ending rows on a network hiccup
 * would let the retention sweep collect a session the box is still happily
 * running.
 */
export async function adoptLlHlsSessions(): Promise<{
  adopted: number;
  ended: number;
  stopped: number;
} | null> {
  if (!isLiveHlsLLEnabled() || !remuxControlUrl() || !remuxControlSecret()) {
    return { adopted: 0, ended: 0, stopped: 0 };
  }
  let remoteSessions: RemuxSessionInfo[];
  try {
    remoteSessions = await remuxListSessions();
  } catch (error) {
    logEvent("voice.hlsLlBootReconcileSkipped", {
      reason: "list-failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const rows = await getPool().query<StaleLlRow>(
    `SELECT id, channel_id, started_at, ended_at, remux_session_id, presenter_peer_id, origin_base_url
     FROM hls_sessions
     WHERE mode = 'll' AND cleaned_at IS NULL
       AND (ended_at IS NULL OR ended_at > NOW() - INTERVAL '1 hour')`,
  );

  // ONLY AN OPEN ROW (`ended_at IS NULL`) OWNS A SESSION. The query above
  // also reads rows ended within the last hour -- purely so the loop below
  // can still name them when logging an orphan stop -- but `stopLlSession`
  // now only marks a row ended once the box has confirmed the session gone
  // (see its own doc comment), so a row with `ended_at` set here means THIS
  // process already believes that session is stopped. Adopting it anyway
  // because the box still happens to answer with it (a Farol finding on PR
  // #580: a failed DELETE outside this process's own stop path, or a
  // straight race with the 1-hour window) would resurrect a party that was
  // told it ended. Such a row is treated exactly like "no row at all" below:
  // the box is asked to stop it, not owned again.
  const rowByRemuxId = new Map(
    rows.rows
      .filter((row) => row.remux_session_id && row.ended_at === null)
      .map((row) => [row.remux_session_id!, row]),
  );
  const remoteById = new Map(remoteSessions.map((session) => [session.sessionId, session]));

  let adopted = 0;
  const toStop: { sessionId: string; reason: "no-presenter" | "no-row" }[] = [];
  for (const remote of remoteSessions) {
    const row = rowByRemuxId.get(remote.sessionId);
    if (!row || !row.presenter_peer_id) {
      toStop.push({
        sessionId: remote.sessionId,
        reason: row ? "no-presenter" : "no-row",
      });
      continue;
    }
    const startedAt = new Date(row.started_at).getTime();
    llRooms.set(row.channel_id, {
      sessionId: remote.sessionId,
      startedAt,
      presenterPeerId: row.presenter_peer_id,
      stream: {
        hlsUrl: llPlaylistUrl(row.channel_id, startedAt),
        startedAt,
        presenterPeerId: row.presenter_peer_id,
        delaySeconds: llDelaySeconds(),
        mode: "ll",
      },
    });
    // The go-live request that started this session lived only in memory
    // (`setRequestedHlsMode`), which a restart just wiped. Without restoring
    // it here, the NEXT reconcile for this channel resolves `conventional`
    // (the safe default) and immediately stops the very session this loop
    // just adopted -- a Farol finding on PR #580. The adopted row is proof
    // the party asked for LL, so the request is restored alongside it.
    setRequestedHlsMode(row.channel_id, true);
    adopted += 1;
    logEvent("voice.hlsLlSessionAdopted", {
      channelId: row.channel_id,
      sessionId: remote.sessionId,
    });
  }

  // Bounded parallel cleanup, not one round trip per orphan in a row: this
  // runs before `listen()` (a Farol finding on PR #580 — a few dozen slow
  // stops would otherwise delay readiness by however long that many
  // sequential 5 s timeouts take).
  const stopResults = await Promise.allSettled(
    toStop.map(({ sessionId }) => remuxStopSession(sessionId)),
  );
  let stopped = 0;
  stopResults.forEach((result, index) => {
    const { sessionId, reason } = toStop[index]!;
    if (result.status === "fulfilled") {
      stopped += 1;
      logEvent("voice.hlsLlOrphanStopped", { sessionId, reason });
    } else {
      logEvent("voice.hlsLlOrphanStopFailed", {
        sessionId,
        error:
          result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  const staleIds = rows.rows
    .filter((row) => !(row.remux_session_id && remoteById.has(row.remux_session_id)))
    .map((row) => row.id);
  await recordLlSessionsEndedByIds(staleIds);
  if (staleIds.length > 0) {
    logEvent("voice.hlsLlRowsEndedNoSession", { count: staleIds.length });
  }

  return { adopted, ended: staleIds.length, stopped };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export function llHlsActivity(): {
  sessions: number;
  startFailures: number;
  demoted: number;
} {
  return {
    sessions: llRooms.size,
    startFailures: llStartFailures,
    demoted: llDemoted,
  };
}

export function resetHlsRemuxForTests(): void {
  fetchImpl = (url, init) => fetch(url, init);
  nowImpl = () => Date.now();
  llRooms.clear();
  requestedHlsMode.clear();
  llStartFailures = 0;
  llDemoted = 0;
}
