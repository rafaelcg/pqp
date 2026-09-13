/* eslint-disable no-console -- this is a command-line load harness. */
import { readFileSync, writeFileSync } from "node:fs";
import { WebSocket } from "ws";
import { Agent, setGlobalDispatcher } from "undici";
import { AudioEncoding } from "@livekit/rtc-ffi-bindings";
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  TrackPublishOptions,
  TrackSource,
  dispose,
} from "@livekit/rtc-node";

/**
 * A separate, standalone script (own `main`, no shared state with `index.ts`
 * or `hls-audience.ts`) that drives the THIRD half of a watch party: not the
 * presenter's publish, not the HLS audience polling the playlist, but the
 * people **seated in the call** joining and leaving throughout the event.
 *
 * WHY THIS EXISTS. docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md item A3:
 * "every earlier test hit the playlist route or WS joins on staging's DB; the
 * write path was never measured." The 2026-09-12 collapse was ~330 tx/s
 * against Postgres with 276 clients and 60 seated -- a number produced by
 * ordinary join/leave/mute churn over 90 minutes, not by a synthetic burst.
 * `index.ts` proves 500 people can receive one presenter's media; this proves
 * the API and the database can absorb a room of people continuously walking
 * in and out of it while that media plays, which is the load shape that
 * actually took production down.
 *
 * WHAT IT DOES. Reads the manifest `index.ts prepare` already wrote (same
 * server, same voice channel -- point it at the room a presenter from
 * `index.ts shard --presenter-only` is sharing to, and run
 * `hls-audience.ts` against that same channel's playlist at the same time;
 * see docs/EVENT_RUNBOOK.md for the full three-process recipe). It then:
 *
 *   1. Ramps `--seats` accounts up to a steady seated population over
 *      `--ramp-seconds`: each opens an app WebSocket, authenticates, joins
 *      the invite, and sends `join-voice-room` -- the exact sequence that
 *      writes a `voice_peers` row and fans a roster update out to the room.
 *   2. Every seat, independently, sends `set-voice-state` (mute/unmute) on
 *      `--presence-every-ms`, exercising the roster-broadcast path A2 asks
 *      to have its write budget measured.
 *   3. A churn scheduler picks a random currently-seated slot every
 *      `60_000 / --churn-per-minute` ms, has it leave (a real
 *      `leave-voice-room`, not a resume -- churn is meant to hit the
 *      DELETE+INSERT pair pitfall 13 is about, not the resume path
 *      `index.ts`'s `--churn-every-ms` already covers), waits a short random
 *      "stepped away" gap, then rejoins as a fresh seat. The seated
 *      population stays near `--seats` for the whole run while the join/leave
 *      write rate stays at the configured churn rate.
 *   4. Optionally (`--speaking-publishers N`, needs `PQP_LOAD_SFU_HOST`), the
 *      first N seats additionally mint a LiveKit token and publish a
 *      continuous speech-shaped audio track, so the SFU's real active-speaker
 *      detection fires under load. These N never churn (excluded from the
 *      scheduler in step 3), matching a room's usual shape: a handful of
 *      people actually talking, everyone else listening or drifting through.
 *      "Speaking" is deliberately not a WS message the client can send --
 *      `packages/shared/src/signaling.ts` says why -- so audio is the only
 *      way to generate it honestly.
 *   5. Every `--ready-sample-seconds` (default 10s), polls the deployment's
 *      own `GET /ready` (no auth needed; it is one of the pre-router
 *      exceptions, CLAUDE.md pitfall 8) and records `checks.postgres.ms` and
 *      `checks.pool.queued`/`inUse`/`max` -- the two numbers A3 asks this
 *      harness to report, sampled independently of anything the seats
 *      themselves see.
 *
 * At the end it writes one JSON report: every seat's join/leave/failure
 * history, the full `/ready` time series, and a summary against the pass
 * criteria in this package's README ("seat-churn mode").
 *
 * SAFETY, NOT CONFIGURATION: staging only, and that is not a default, it is
 * the only mode this file has. `PQP_LOAD_TARGET` must be exactly `staging`;
 * there is no local/smoke path here the way `index.ts` has one, because this
 * harness's whole purpose is measuring a real Postgres under real network
 * conditions, which a loopback database cannot stand in for. `assertSafe`
 * below is the only place that decides this; do not relax it "just to check
 * something quickly" -- see `index.ts`'s identical warning, which applies
 * here word for word.
 */

// Bound the HTTP keep-alive pool per process, same reasoning as index.ts.
setGlobalDispatcher(new Agent({ connections: 16, keepAliveTimeout: 1000 }));

const STAGING_API = "https://pqp-api-staging.fly.dev";
const STAGING_WS = "wss://pqp-api-staging.fly.dev/ws";
const PROD_HOSTS = new Set(["pqp.gg", "api.pqp.gg", "sfu.pqp.gg"]);
const HTTP_TIMEOUT_MS = 15_000;
const WELCOME_TIMEOUT_MS = 12_000;
const READY_TIMEOUT_MS = 10_000;
const AUDIO_BITRATE_BPS = 32_000;

function arg(name: string, fallback = ""): string {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : (process.argv[at + 1] ?? "");
}
function requiredArg(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function numberArg(name: string, fallback: number): number {
  const value = Number(arg(name, String(fallback)));
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}
function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// ------------------------------------------------------------------ safety

type Safe = { runId: string; apiUrl: string; wsUrl: string; sfuHost: string | null };

function assertSafe(): Safe {
  const runId = need("TEST_RUN_ID");
  if (!/^[a-z0-9][a-z0-9-]{2,48}$/.test(runId)) throw new Error("TEST_RUN_ID must be a lowercase, traceable run id");
  const target = need("PQP_LOAD_TARGET");
  if (target !== "staging") {
    throw new Error(
      "seat-churn is staging only (docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md A3): PQP_LOAD_TARGET must be 'staging'. There is no production or local mode for this script.",
    );
  }
  const apiUrl = process.env.PQP_LOAD_API_URL ?? STAGING_API;
  const wsUrl = process.env.PQP_LOAD_WS_URL ?? STAGING_WS;
  const api = new URL(apiUrl);
  if (api.origin !== STAGING_API || wsUrl.replace(/\/$/, "") !== STAGING_WS) {
    throw new Error("only the exact pqp staging API and WebSocket are allowed");
  }
  if (PROD_HOSTS.has(api.hostname.toLowerCase()) || api.hostname.toLowerCase().endsWith(".pqp.gg")) {
    throw new Error("refusing a production-shaped API host even under PQP_LOAD_API_URL");
  }
  const sfuHostRaw = process.env.PQP_LOAD_SFU_HOST;
  let sfuHost: string | null = null;
  if (sfuHostRaw) {
    sfuHost = sfuHostRaw.toLowerCase();
    if (PROD_HOSTS.has(sfuHost) || sfuHost.endsWith(".pqp.gg")) throw new Error("production SFU hosts are forbidden");
  }
  return { runId, apiUrl, wsUrl, sfuHost };
}

function tokenFor(runId: string, index: string | number): string {
  return `${need("LOAD_TEST_TOKEN")}:${runId}-seat-churn-${index}`;
}

// --------------------------------------------------------------------- api

class HttpError extends Error {
  constructor(public status: number, public path: string, public bodyText: string) {
    super(`${path} -> ${status}`);
  }
}
async function api<T>(base: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new HttpError(res.status, `${method} ${path}`, (await res.text().catch(() => "")).slice(0, 200));
  return (await res.json()) as T;
}
async function passAgeGate(base: string, token: string): Promise<void> {
  const me = await api<{ ageGate?: string }>(base, token, "GET", "/api/me");
  if (me.ageGate !== "passed") await api(base, token, "POST", "/api/me/age-check", { dateOfBirth: "1990-01-01" });
}

type Manifest = {
  version: 1;
  runId: string;
  apiUrl: string;
  wsUrl: string;
  serverId: string;
  textChannelId: string;
  voiceChannelId: string;
  inviteCode: string;
};
function readManifest(safe: Safe): Manifest {
  const parsed = JSON.parse(readFileSync(requiredArg("--manifest"), "utf8")) as Manifest;
  if (parsed.version !== 1 || parsed.runId !== safe.runId || parsed.apiUrl !== safe.apiUrl || parsed.wsUrl !== safe.wsUrl) {
    throw new Error("manifest does not match this run (TEST_RUN_ID/API/WS must be the ones it was prepared with -- see index.ts prepare)");
  }
  // seat-churn deliberately does not reuse index.ts's `participantsAllowed`
  // gate: that function encodes the 500-person RTC delivery contract, which
  // has nothing to do with a seated-population size chosen for DB load. Any
  // manifest `index.ts prepare` produced for this TEST_RUN_ID/api/ws is
  // valid here regardless of the --participants it was prepared with.
  return parsed;
}

// ------------------------------------------------------------------- ready

type ReadySample = {
  atMs: number;
  ok: boolean | null;
  postgresOk: boolean | null;
  postgresMs: number | null;
  poolQueued: number | null;
  poolInUse: number | null;
  poolMax: number | null;
  error?: string;
};
async function sampleReady(apiUrl: string, startedAt: number): Promise<ReadySample> {
  try {
    const res = await fetch(`${apiUrl}/ready`, { signal: AbortSignal.timeout(READY_TIMEOUT_MS) });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      checks?: { postgres?: { ok?: boolean; ms?: number }; pool?: { queued?: number; inUse?: number; max?: number } };
    };
    return {
      atMs: Date.now() - startedAt,
      ok: body.ok ?? (res.status === 200),
      postgresOk: body.checks?.postgres?.ok ?? null,
      postgresMs: body.checks?.postgres?.ms ?? null,
      poolQueued: body.checks?.pool?.queued ?? null,
      poolInUse: body.checks?.pool?.inUse ?? null,
      poolMax: body.checks?.pool?.max ?? null,
    };
  } catch (error) {
    return {
      atMs: Date.now() - startedAt,
      ok: false,
      postgresOk: null,
      postgresMs: null,
      poolQueued: null,
      poolInUse: null,
      poolMax: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------- app socket

type AppSession = { socket: WebSocket; peerId: string };
/**
 * Cold HTTP (age gate + invite join), then the app socket handshake through
 * `join-voice-room`. Trimmed from `index.ts`'s `appSession`/`openAppSocket`:
 * no delta caps, no legacy-share simulation, no resume pair -- seat-churn's
 * whole point is fresh joins and real leaves, not the resume path those
 * flags exist to test.
 */
async function joinSeat(safe: Safe, manifest: Manifest, token: string): Promise<AppSession> {
  await passAgeGate(safe.apiUrl, token);
  await api(safe.apiUrl, token, "POST", `/api/invites/${manifest.inviteCode}/join`);
  return await new Promise<AppSession>((resolve, reject) => {
    const socket = new WebSocket(safe.wsUrl, { perMessageDeflate: true });
    // Every path out of this promise other than a successful `welcome` must
    // close this socket itself: a refusal frame or a welcome timeout used to
    // reject the promise and leave the (still open, still authenticated)
    // socket behind, so a run heavy on refusals -- exactly the overloaded-
    // staging case this harness exists to rehearse -- accumulated open
    // sockets and server-side sessions nothing here ever cleaned up.
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error("no voice welcome within 12s of socket open"));
    }, WELCOME_TIMEOUT_MS + HTTP_TIMEOUT_MS);
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "auth", token, caps: ["voice-roster-delta", "presence-delta"] }));
    });
    socket.on("message", (raw) => {
      let frame: { type?: string; peerId?: string };
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type === "ready") {
        socket.send(JSON.stringify({ type: "join-channel", channelId: manifest.textChannelId }));
        socket.send(
          JSON.stringify({
            type: "join-voice-room",
            voiceChannelId: manifest.voiceChannelId,
            transports: ["livekit"],
            resume: false,
          }),
        );
      }
      if (frame.type === "welcome") {
        if (settled) return;
        if (!frame.peerId) {
          fail(new Error("welcome missing peer id"));
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ socket, peerId: frame.peerId });
      }
      if (["voice-join-refused", "voice-room-full", "voice-transport-unsupported"].includes(frame.type ?? "")) {
        fail(new Error(frame.type));
      }
    });
    socket.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
async function leaveSeat(session: AppSession): Promise<void> {
  if (session.socket.readyState === WebSocket.OPEN) {
    await new Promise<void>((resolve) => session.socket.send(JSON.stringify({ type: "leave-voice-room" }), () => resolve()));
  }
  session.socket.close();
}
function setVoiceState(session: AppSession, muted: boolean, deafened: boolean): void {
  if (session.socket.readyState === WebSocket.OPEN) {
    session.socket.send(JSON.stringify({ type: "set-voice-state", muted, deafened }));
  }
}

// ------------------------------------------------------------------ speaking

type Session = { url: string; token: string; room: string };
async function mint(apiUrl: string, token: string, manifest: Manifest, peerId: string, expectedSfuHost: string): Promise<Session> {
  const result = await api<Session>(apiUrl, token, "POST", "/api/voice/token", { voiceChannelId: manifest.voiceChannelId, peerId });
  const host = new URL(result.url).hostname.toLowerCase();
  if (host !== expectedSfuHost || PROD_HOSTS.has(host) || host.endsWith(".pqp.gg")) throw new Error("token returned a non-isolated or unexpected SFU host");
  return result;
}
/** A speech-shaped audio-only publish -- the same synthesis index.ts uses for
 * `--audio-publishers`, trimmed to audio only (no video, no simulcast): this
 * is what makes the SFU's active-speaker detection fire for real, which is
 * the only honest way to produce "speaking" (packages/shared/src/signaling.ts
 * explains why it is not a WS message the client can just declare). */
async function publishSpeech(room: Room): Promise<() => Promise<void>> {
  const participant = room.localParticipant;
  if (!participant) throw new Error("LiveKit room connected without a local participant");
  const audioSource = new AudioSource(48_000, 1);
  const track = LocalAudioTrack.createAudioTrack("seat-churn-audio", audioSource);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  options.audioEncoding = new AudioEncoding({ maxBitrate: BigInt(AUDIO_BITRATE_BPS) });
  await participant.publishTrack(track, options);
  let tick = 0;
  let phase = 0;
  let seed = 0x2545f491;
  const timer = setInterval(() => {
    const samples = new Int16Array(960);
    const f0 = 120 + 60 * Math.sin(tick * 0.02);
    for (let i = 0; i < samples.length; i += 1) {
      const t = (tick * 960 + i) / 48_000;
      const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t + (tick >> 6));
      phase += (2 * Math.PI * f0) / 48_000;
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const noise = ((seed & 0xffff) / 0xffff - 0.5) * 0.15;
      const voiced = Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.3 * Math.sin(3 * phase);
      samples[i] = Math.max(-32767, Math.min(32767, Math.round(6000 * env * (voiced * 0.5 + noise))));
    }
    void audioSource.captureFrame(new AudioFrame(samples, 48_000, 1, 960));
    tick += 1;
  }, 20);
  return async () => {
    clearInterval(timer);
    await track.close().catch(() => {});
    await audioSource.close().catch(() => {});
  };
}

// --------------------------------------------------------------------- plan

type Plan = {
  seats: number;
  churnPerMinute: number;
  durationMs: number;
  rampMs: number;
  presenceEveryMs: number;
  speakingPublishers: number;
  readySampleMs: number;
  joinConcurrency: number;
};
type SeatEvent = { atMs: number; kind: "joined" | "left" | "join-failed" | "leave-failed"; error?: string };
type SeatRecord = { slot: number; speaking: boolean; events: SeatEvent[]; joins: number; leaves: number; failures: number };

function joinGate(limit: number): () => Promise<() => void> {
  let available = limit;
  const waiting: Array<() => void> = [];
  return async () => {
    if (available === 0) await new Promise<void>((resolve) => waiting.push(resolve));
    else available -= 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) next();
      else available += 1;
    };
  };
}

async function run(): Promise<void> {
  const safe = assertSafe();
  const manifest = readManifest(safe);
  const plan: Plan = {
    seats: numberArg("--seats", 80),
    churnPerMinute: numberArg("--churn-per-minute", 5),
    durationMs: numberArg("--duration-seconds", 1800) * 1000,
    rampMs: numberArg("--ramp-seconds", 60) * 1000,
    presenceEveryMs: numberArg("--presence-every-ms", 45_000),
    speakingPublishers: numberArg("--speaking-publishers", 0),
    readySampleMs: numberArg("--ready-sample-seconds", 10) * 1000,
    joinConcurrency: numberArg("--join-concurrency", 12),
  };
  if (plan.seats < 1) throw new Error("--seats must be at least 1");
  if (plan.speakingPublishers > plan.seats) throw new Error("--speaking-publishers cannot exceed --seats");
  if (plan.speakingPublishers > 0 && !safe.sfuHost) throw new Error("--speaking-publishers > 0 needs PQP_LOAD_SFU_HOST");
  const out = requiredArg("--out");
  const acquireJoin = joinGate(plan.joinConcurrency);

  console.error(
    JSON.stringify({
      event: "start",
      runId: safe.runId,
      voiceChannelId: manifest.voiceChannelId,
      seats: plan.seats,
      churnPerMinute: plan.churnPerMinute,
      durationSeconds: plan.durationMs / 1000,
      speakingPublishers: plan.speakingPublishers,
    }),
  );

  const startedAt = Date.now();
  const endAt = startedAt + plan.durationMs;
  const records: SeatRecord[] = Array.from({ length: plan.seats }, (_, slot) => ({
    slot,
    speaking: slot < plan.speakingPublishers,
    events: [],
    joins: 0,
    leaves: 0,
    failures: 0,
  }));
  // Live sessions, keyed by slot. Absent while a slot is between leave and
  // rejoin, or hung up entirely at the end.
  const sessions = new Map<number, AppSession>();
  const speakingStops = new Map<number, () => Promise<void>>();
  let stopping = false;

  async function joinOne(slot: number, cycle: number): Promise<void> {
    const release = await acquireJoin();
    try {
      const token = tokenFor(safe.runId, `${slot}-${cycle}`);
      const session = await joinSeat(safe, manifest, token);
      // joinSeat awaits real HTTP + WS round trips, so shutdown can begin
      // while one is still in flight. The wind-down sweep below only leaves
      // whatever is in `sessions` when IT runs; a session inserted after
      // that sweep has already run would sit uncounted and unclosed for the
      // rest of the process's life. Close it immediately instead of handing
      // it to a wind-down that already happened.
      if (stopping) {
        await leaveSeat(session).catch(() => {});
        records[slot]!.events.push({
          atMs: Date.now() - startedAt,
          kind: "join-failed",
          error: "joined after shutdown began; closed immediately",
        });
        return;
      }
      sessions.set(slot, session);
      records[slot]!.joins += 1;
      records[slot]!.events.push({ atMs: Date.now() - startedAt, kind: "joined" });
      if (records[slot]!.speaking && safe.sfuHost) {
        try {
          const minted = await mint(safe.apiUrl, token, manifest, session.peerId, safe.sfuHost);
          const room = new Room();
          await room.connect(minted.url, minted.token, { autoSubscribe: false, dynacast: false });
          speakingStops.set(slot, await publishSpeech(room));
        } catch (error) {
          // A publish failure does not cost this seat its place in the room;
          // it just stays silent, which is recorded rather than escalated.
          records[slot]!.events.push({ atMs: Date.now() - startedAt, kind: "join-failed", error: `speech publish: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
    } catch (error) {
      records[slot]!.failures += 1;
      records[slot]!.events.push({ atMs: Date.now() - startedAt, kind: "join-failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      release();
    }
  }
  async function leaveOne(slot: number): Promise<void> {
    const session = sessions.get(slot);
    if (!session) return;
    sessions.delete(slot);
    const stopSpeaking = speakingStops.get(slot);
    speakingStops.delete(slot);
    try {
      if (stopSpeaking) await stopSpeaking();
      await leaveSeat(session);
      records[slot]!.leaves += 1;
      records[slot]!.events.push({ atMs: Date.now() - startedAt, kind: "left" });
    } catch (error) {
      records[slot]!.failures += 1;
      records[slot]!.events.push({ atMs: Date.now() - startedAt, kind: "leave-failed", error: error instanceof Error ? error.message : String(error) });
    }
  }

  // 1. Ramp every seat up.
  const rampGap = plan.rampMs / Math.max(1, plan.seats);
  await Promise.all(
    records.map(async (record, slot) => {
      await sleep(slot * rampGap);
      if (!stopping) await joinOne(slot, 0);
    }),
  );
  console.error(JSON.stringify({ event: "ramp-complete", seated: sessions.size, of: plan.seats, atMs: Date.now() - startedAt }));

  // 2. Presence updates: every held seat toggles mute on its own clock.
  const presenceTimers = records.map((record) =>
    setInterval(() => {
      const session = sessions.get(record.slot);
      if (!session) return;
      const nextMuted = (record.events.filter((e) => e.kind === "joined").length + record.events.length) % 2 === 0;
      setVoiceState(session, nextMuted, false);
    }, plan.presenceEveryMs + Math.floor(Math.random() * 1000)),
  );

  // 3. Churn scheduler: never touches a speaking seat. Ticks fire on a FIXED
  // cadence (setInterval), not chained after each cycle's leave/gap/rejoin
  // finishes: the old scheme rescheduled the next tick only once a cycle
  // completed, so the actual churn rate was the configured one MINUS
  // whatever the "stepped away" gap and the rejoin's own network time cost --
  // materially fewer than --churn-per-minute cycles per minute at the
  // documented default. A fixed interval keeps the configured rate honest.
  // `busyChurnSlots` keeps two overlapping ticks from grabbing the same slot
  // mid-cycle now that ticks no longer wait on each other.
  const churnableSlots = records.filter((r) => !r.speaking).map((r) => r.slot);
  const cycleCounters = new Map<number, number>();
  const busyChurnSlots = new Set<number>();
  const pendingChurns = new Set<Promise<void>>();
  let churnTimer: ReturnType<typeof setInterval> | undefined;
  if (churnableSlots.length > 0) {
    const gapMs = 60_000 / Math.max(0.001, plan.churnPerMinute);
    churnTimer = setInterval(() => {
      if (stopping || Date.now() >= endAt) return;
      const candidates = churnableSlots.filter((slot) => sessions.has(slot) && !busyChurnSlots.has(slot));
      if (candidates.length === 0) return;
      const slot = candidates[Math.floor(Math.random() * candidates.length)]!;
      busyChurnSlots.add(slot);
      const cycle = (cycleCounters.get(slot) ?? 0) + 1;
      cycleCounters.set(slot, cycle);
      const churn = (async () => {
        try {
          await leaveOne(slot);
          await sleep(2_000 + Math.random() * 6_000); // "stepped away" gap
          // Re-check `stopping` AFTER the gap, not just before starting: the
          // wind-down's own final sweep (below) can run entirely inside this
          // wait, and joinOne's own `stopping` recheck is the second layer
          // in case shutdown lands between here and that call returning.
          if (!stopping && Date.now() < endAt) await joinOne(slot, cycle);
        } finally {
          busyChurnSlots.delete(slot);
        }
      })();
      pendingChurns.add(churn);
      void churn.finally(() => pendingChurns.delete(churn));
    }, gapMs);
  }

  // 4. /ready sampling, independent of the seats. Pushed as each request
  // resolves, so slow or overlapping /ready calls can complete out of the
  // order they were sent in -- readySamples is sorted by `atMs` before the
  // streak math below runs rather than trusted as already chronological.
  // Pending requests are tracked and awaited at shutdown too, or a request
  // still in flight when the interval is cleared would simply vanish from
  // the report instead of contributing its sample.
  const readySamples: ReadySample[] = [];
  const pendingReadySamples = new Set<Promise<void>>();
  const scheduleReadySample = (): void => {
    const pending: Promise<void> = sampleReady(safe.apiUrl, startedAt)
      .then((sample) => {
        readySamples.push(sample);
      })
      .finally(() => pendingReadySamples.delete(pending));
    pendingReadySamples.add(pending);
  };
  const readyTimer = setInterval(scheduleReadySample, plan.readySampleMs);
  readySamples.push(await sampleReady(safe.apiUrl, startedAt));

  await sleep(Math.max(0, endAt - Date.now()));

  // Wind down: no more churn, no more presence flips, hang every seat up.
  stopping = true;
  if (churnTimer) clearInterval(churnTimer);
  for (const timer of presenceTimers) clearInterval(timer);
  clearInterval(readyTimer);
  // Every in-flight churn cycle (leave -> gap -> rejoin) must finish before
  // the final sweep below: joinOne's own `stopping` recheck stops it from
  // handing that sweep a live session after the fact, but the sweep still
  // needs to run AFTER any leaveOne a churn cycle already has in flight,
  // not race it on the same slot.
  await Promise.all([...pendingChurns]);
  await Promise.all(records.map((record) => leaveOne(record.slot)));
  await Promise.all([...pendingReadySamples]);
  readySamples.sort((a, b) => a.atMs - b.atMs);
  await dispose().catch(() => {});

  const endedAt = Date.now();
  const postgresMsValues = readySamples.map((s) => s.postgresMs).filter((n): n is number => n !== null);
  const poolQueuedValues = readySamples.map((s) => s.poolQueued).filter((n): n is number => n !== null);
  const percentile = (values: number[], p: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
  };
  const notOk = readySamples.filter((s) => s.ok === false).length;
  // Longest run of consecutive samples over each alert's threshold, in
  // seconds -- an approximation of the "for" duration the matching Grafana
  // rule in tools/monitoring/grafana-alert-rules-event.json evaluates
  // continuously; this is a discrete-sample stand-in for the same question.
  const longestStreakSeconds = (predicate: (s: ReadySample) => boolean): number => {
    let longest = 0;
    let current = 0;
    for (const sample of readySamples) {
      if (predicate(sample)) {
        current += plan.readySampleMs / 1000;
        longest = Math.max(longest, current);
      } else {
        current = 0;
      }
    }
    return longest;
  };
  const longestNotReadySeconds = longestStreakSeconds((s) => s.ok === false);
  const longestPostgresOver200Seconds = longestStreakSeconds((s) => (s.postgresMs ?? 0) > 200);
  const longestPoolOver20Seconds = longestStreakSeconds((s) => (s.poolQueued ?? 0) > 20);
  // `.failures` is incremented by BOTH joinOne's and leaveOne's catch blocks
  // (kinds "join-failed" and "leave-failed"), so this is already every
  // failure the run recorded, not joins alone -- named `totalFailures` here
  // (it used to read `totalJoinFailures`, which underclaimed what it counts).
  const totalFailures = records.reduce((sum, r) => sum + r.failures, 0);
  const totalJoins = records.reduce((sum, r) => sum + r.joins, 0);
  const totalLeaves = records.reduce((sum, r) => sum + r.leaves, 0);
  // Pass criteria from this package's README ("seat-churn mode"): readiness
  // never sustained false for 60s+, postgres ms never sustained > 200 for
  // 2 minutes+, pool queued never sustained > 20 for 60s+, and the harness's
  // own join/leave failure rate stays under 1% -- a failure here is either
  // the API refusing load or the harness itself losing a race, and either
  // one should be looked at, not averaged away.
  const failureRate = totalJoins + totalFailures > 0 ? totalFailures / (totalJoins + totalFailures) : 0;
  const verdict: string[] = [];
  if (longestNotReadySeconds >= 60) verdict.push(`GET /ready reported false for ${longestNotReadySeconds}s straight, budget 60s`);
  if (longestPostgresOver200Seconds >= 120) verdict.push(`postgres ms stayed above 200 for ${longestPostgresOver200Seconds}s straight, budget 120s`);
  if (longestPoolOver20Seconds >= 60) verdict.push(`pool queued stayed above 20 for ${longestPoolOver20Seconds}s straight, budget 60s`);
  if (failureRate > 0.01) verdict.push(`seat join/leave failure rate ${(failureRate * 100).toFixed(2)}%, budget 1%`);

  const summary = {
    config: { runId: safe.runId, voiceChannelId: manifest.voiceChannelId, ...plan },
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
    seats: {
      configured: plan.seats,
      speaking: plan.speakingPublishers,
      churnable: churnableSlots.length,
      finalSeated: sessions.size,
      totalJoins,
      totalLeaves,
      totalFailures,
      failureRate,
    },
    ready: {
      samples: readySamples.length,
      notOkSamples: notOk,
      longestNotReadySeconds,
      longestPostgresOver200Seconds,
      longestPoolOver20Seconds,
      postgresMs: { p50: percentile(postgresMsValues, 50), p95: percentile(postgresMsValues, 95), p99: percentile(postgresMsValues, 99), max: postgresMsValues.length ? Math.max(...postgresMsValues) : null },
      poolQueued: { p50: percentile(poolQueuedValues, 50), p95: percentile(poolQueuedValues, 95), max: poolQueuedValues.length ? Math.max(...poolQueuedValues) : null },
      series: readySamples,
    },
    seatRecords: records,
    verdict,
    passed: verdict.length === 0,
  };
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(
    JSON.stringify(
      {
        report: out,
        passed: summary.passed,
        verdict,
        seats: summary.seats,
        readySummary: { samples: summary.ready.samples, notOkSamples: summary.ready.notOkSamples, postgresMsP95: summary.ready.postgresMs.p95, poolQueuedP95: summary.ready.poolQueued.p95 },
      },
      null,
      2,
    ),
  );
  if (!summary.passed) process.exitCode = 1;
}

const USAGE = [
  "usage: pnpm exec tsx src/seat-churn.ts --manifest <file> --out <file>",
  "         [--seats N=80] [--churn-per-minute R=5] [--duration-seconds S=1800]",
  "         [--ramp-seconds R=60] [--presence-every-ms MS=45000]",
  "         [--speaking-publishers N=0] [--ready-sample-seconds S=10]",
  "         [--join-concurrency N=12]",
  "env: TEST_RUN_ID, PQP_LOAD_TARGET=staging (only), LOAD_TEST_TOKEN,",
  "     PQP_LOAD_API_URL / PQP_LOAD_WS_URL (must resolve to the exact staging",
  "     API/WS), PQP_LOAD_SFU_HOST (required only if --speaking-publishers > 0)",
  "",
  "Run alongside `index.ts shard --presenter-only` (the share) and",
  "`hls-audience.ts` (the watchers) against the same manifest's voice channel.",
  "See docs/EVENT_RUNBOOK.md for the full recipe and pass criteria.",
].join("\n");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
} else {
  try {
    await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exitCode = 1;
  }
}
