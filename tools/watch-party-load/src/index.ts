/* eslint-disable no-console -- this is a command-line load harness. */
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { Client as PgClient } from "pg";
import { WebSocket } from "ws";
import { Agent, setGlobalDispatcher } from "undici";
import {
  AudioEncoding,
  FfiRequest,
  FfiResponse,
  SetRemoteTrackPublicationQualityRequest,
  VideoEncoding,
  VideoQuality,
  livekitFfiRequest,
} from "@livekit/rtc-ffi-bindings";
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  LocalVideoTrack,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoFrame,
  VideoSource,
  VideoStream,
  dispose,
} from "@livekit/rtc-node";

// Bound the HTTP keep-alive pool per process. Fly's per-machine concurrency
// limit counts every TCP connection, and undici's default is unbounded, so an
// idle pool would eat the budget the WebSockets need.
setGlobalDispatcher(new Agent({ connections: 16, keepAliveTimeout: 1000 }));

const STAGING_API = "https://pqp-api-staging.fly.dev";
const STAGING_WS = "wss://pqp-api-staging.fly.dev/ws";
// SAFETY, NOT CONFIGURATION: this harness generates hundreds of real clients on
// the real application path, so it must never be pointed at production. The
// hosted target is pinned to the exact staging API and WebSocket below, and any
// SFU host in this set, or under *.pqp.gg at all, is refused outright (see
// parseTarget). Local mode is restricted to loopback. Do not relax any of these
// three checks, not even "just to check something quickly": generators are also
// firewalled against api.pqp.gg and sfu.pqp.gg, and this is the second lock.
const PROD_HOSTS = new Set(["pqp.gg", "api.pqp.gg", "sfu.pqp.gg"]);
const HTTP_TIMEOUT_MS = 15_000;
const MEDIA_CONNECT_TIMEOUT_MS = 20_000;
// The browser arms a 12 s join timer from socket open (JOIN_TIMEOUT_MS in
// client/src/hooks/use-voice.ts) and retries. Mirror that: 12 s per attempt,
// 1 s doubling backoff to 30 s, give up after --join-deadline-seconds.
const WELCOME_TIMEOUT_MS = 12_000;
// SFU_JOIN_TIMEOUT_MS in the client: no picture within this is a failed join.
const FIRST_FRAME_ABANDON_MS = 45_000;
const AUDIO_BITRATE_BPS = 64_000;
const MOTION_TILES = 1;
// Judging, not load shape. A local smoke measured the SFU's bandwidth estimate
// reaching the 1.5 Mbps ceiling about ten seconds after the presenter started;
// decoded frames only reach 30 fps once it has, so the decode-rate criterion
// counts from here. `--decode-warmup-seconds` overrides it.
const DECODE_WARMUP_SECONDS = 10;
// Two flow readings closer than this cannot be compared: at 1.5 Mbps a shorter
// window may legitimately carry no new bytes.
const MIN_FLOW_GAP_MS = 1_000;
// How long an interrupted or crashing shard may spend hanging its seats up.
const ABORT_TIMEOUT_MS = 10_000;

type Command = "prepare" | "shard" | "cleanup";
type Manifest = {
  version: 1;
  runId: string;
  apiUrl: string;
  wsUrl: string;
  participants: number;
  serverId: string;
  textChannelId: string;
  voiceChannelId: string;
  inviteCode: string;
  createdAt: string;
};
type Session = { url: string; token: string; room: string; identity: string };
type Role = "presenter" | "receiver" | "audio" | "camera";
type VideoProfile = { width: number; height: number; bitrate: number; fps: number; simulcast: boolean; source: TrackSource };
type Layer = { rid: string; width: number; height: number; fps: number; targetBitrate: number; bytesSent: number };
type Rtp = {
  bytesReceived: number; videoBytesReceived: number; audioBytesReceived: number; bytesSent: number;
  packetsReceived: number; packetsLost: number; framesDecoded: number; keyFramesDecoded: number; framesDropped: number;
  frameWidth: number; frameHeight: number; framesPerSecond: number; freezeCount: number; jitterMs: number;
  nackCount: number; pliCount: number; firCount: number;
  outboundVideoFps: number; outboundVideoWidth: number; outboundVideoHeight: number; layers: Layer[];
};
type Flow = { atMs: number; bytesReceived: number; videoBytesReceived: number; framesDecoded: number; frameWidth: number; frameHeight: number; framesPerSecond: number; framesDropped: number; freezeCount: number; packetsLost: number; pliCount: number; nackCount: number };
type ParticipantResult = {
  index: number;
  role: Role;
  presenter: boolean;
  legacy: boolean;
  arrivalAtMs?: number;
  bootstrapMs?: number;
  welcomeMs?: number;
  socketOpenToWelcomeMs?: number;
  welcomeAttempts: number;
  resumed?: boolean;
  tokenMs?: number;
  rtcConnectedMs?: number;
  rtcConnectedAtMs?: number;
  firstFrameFromConnectMs?: number;
  firstFrameFromArrivalMs?: number;
  firstFrameAbandoned?: boolean;
  videoFrames: number;
  audioFrames: number;
  subscribedTracks: number;
  decodeSample: boolean;
  rtp?: Rtp;
  decodedVideoFps?: number;
  sourceVideoFps?: number;
  sentBitrateBps?: number;
  requestedVideoBitrateBps?: number;
  disconnects: number;
  /** Milliseconds between media start and the final RTP reading. */
  heldMs?: number;
  flow: Flow[];
  ws?: { wireBytes: number; frames: Record<string, { count: number; bytes: number }> };
  /** Run D: every reconnect this participant performed during its hold. */
  churns?: Array<{ atMs: number; resumed: boolean; welcomeMs?: number; rtc: boolean; rtcConnectedMs?: number; firstFrameMs?: number; failure?: string }>;
  failure?: string;
  failureClass?: string;
  /** Every pass criterion this participant missed. Empty means it passed. */
  verdict?: string[];
};
type Criteria = { holdMs: number; startAtMs: number; minDecodedFps: number; warmupSeconds: number; stampede: boolean; expectedHeight: number; presenterFps: number };

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function arg(name: string, fallback = ""): string {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : (process.argv[at + 1] ?? "");
}
function has(name: string): boolean {
  return process.argv.includes(name);
}
function requiredArg(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function numberArg(name: string, fallback: number): number {
  const value = Number(arg(name, String(fallback)));
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
function integerArg(name: string, fallback: number): number {
  const value = Number(arg(name, String(fallback)));
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}
/**
 * PQP_LOAD_SIZE_OVERRIDE=1 lets a hosted run use any count from 2 to 2000 and
 * any hold from 5 s to 30 min. It exists for calibration (how much does one
 * generator cost per receiver) and for the stall check; the 500 contract stays
 * the default and the production refusals are untouched by it.
 */
const sizeOverride = process.env.PQP_LOAD_SIZE_OVERRIDE === "1";
function participantsAllowed(total: number, safe: { local: boolean; smoke: boolean; diagnostic: boolean }): boolean {
  if (sizeOverride && total >= 2 && total <= 2000) return true;
  return total === 500 || (safe.local && total >= 2 && total <= 5) || (safe.smoke && total === 2) || (safe.diagnostic && total >= 2 && total <= 24);
}
function assertSafeTarget(): { runId: string; apiUrl: string; wsUrl: string; sfuHost: string; local: boolean; smoke: boolean; diagnostic: boolean } {
  const runId = need("TEST_RUN_ID");
  if (!/^[a-z0-9][a-z0-9-]{2,48}$/.test(runId)) throw new Error("TEST_RUN_ID must be a lowercase, traceable run id");
  const target = need("PQP_LOAD_TARGET");
  if (target !== "staging" && target !== "local") throw new Error("PQP_LOAD_TARGET must be staging or local");
  const local = target === "local";
  const smoke = process.env.PQP_LOAD_SMOKE === "1";
  const diagnostic = process.env.PQP_LOAD_DIAGNOSTIC === "1";
  if (diagnostic && (local || !runId.startsWith("wpdiag-"))) throw new Error("staging diagnostic runs require a wpdiag-* run id");
  const apiUrl = process.env.PQP_LOAD_API_URL ?? (local ? "http://localhost:3001" : STAGING_API);
  const wsUrl = process.env.PQP_LOAD_WS_URL ?? (local ? "ws://localhost:3001/ws" : STAGING_WS);
  const api = new URL(apiUrl);
  const ws = new URL(wsUrl);
  if (!local && (api.origin !== STAGING_API || ws.href.replace(/\/$/, "") !== STAGING_WS)) throw new Error("only the exact pqp staging API and WebSocket are allowed");
  if (local && (!["localhost", "127.0.0.1", "::1"].includes(api.hostname) || !["localhost", "127.0.0.1", "::1"].includes(ws.hostname))) throw new Error("local runs may only use loopback API and WebSocket hosts");
  const sfuHost = need("PQP_LOAD_SFU_HOST").toLowerCase();
  if (PROD_HOSTS.has(sfuHost) || sfuHost.endsWith(".pqp.gg")) throw new Error("production SFU hosts are forbidden");
  if (local && !["localhost", "127.0.0.1", "::1"].includes(sfuHost)) throw new Error("local runs may only use a loopback SFU host");
  return { runId, apiUrl, wsUrl, sfuHost, local, smoke, diagnostic };
}
function diagnostic(event: string, index: number, extra: Record<string, unknown> = {}): void {
  if (process.env.PQP_LOAD_DIAGNOSTIC === "1" || process.env.PQP_LOAD_TRACE === "1") console.error(JSON.stringify({ event, index, at: new Date().toISOString(), ...extra }));
}
function tokenFor(runId: string, index: string | number, local: boolean): string {
  return local ? `dev-local-token:${runId}-${index}` : `${need("LOAD_TEST_TOKEN")}:${runId}-${index}`;
}
class HttpError extends Error {
  constructor(public status: number, public path: string, public bodyText: string) { super(`${path} -> ${status}`); }
}
async function api<T>(base: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new HttpError(res.status, `${method} ${path}`, (await res.text().catch(() => "")).slice(0, 200));
  return await res.json() as T;
}
/**
 * Bucket a failure so the summary can tell a rig fault from a server one:
 * EMFILE/ENOBUFS are the generator, `could not find a good candidate` is
 * fly-proxy's connection cap, 429 is a limiter, 5xx is the server.
 */
function classify(error: unknown): string {
  const text = error instanceof Error ? `${error.message} ${(error as { code?: string }).code ?? ""}` : String(error);
  if (/EMFILE|ENOBUFS|ENFILE/.test(text)) return "generator:fds";
  if (/could not find a good candidate|no healthy|load balancing/i.test(text)) return "proxy-limit";
  if (error instanceof HttpError) {
    if (error.status === 429) return `rate-limit:${error.path}`;
    if (error.status === 503) return /candidate/i.test(error.bodyText) ? "proxy-limit" : `server:503:${error.path}`;
    if (error.status >= 500) return `server:${error.status}:${error.path}`;
    return `http:${error.status}:${error.path}`;
  }
  if (/no voice welcome/.test(text)) return "welcome-timeout";
  if (/LiveKit connect timed out/.test(text)) return "rtc-connect-timeout";
  if (/voice-join-refused|voice-room-full|voice-transport-unsupported/.test(text)) return text.trim();
  if (/first frame/.test(text)) return "first-frame-abandoned";
  if (/no received presenter RTP/.test(text)) return "no-rtp";
  if (/no decoded presenter media/.test(text)) return "no-decoded-media";
  if (/invalid handle|handle not found/i.test(text)) return "rtc-node:handle";
  if (/timed out|timeout|TimeoutError/i.test(text)) return "timeout";
  if (/ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed/.test(text)) return "network";
  return "other";
}
async function within<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
async function passAgeGate(base: string, token: string): Promise<void> {
  const me = await api<{ ageGate?: string }>(base, token, "GET", "/api/me");
  if (me.ageGate !== "passed") await api(base, token, "POST", "/api/me/age-check", { dateOfBirth: "1990-01-01" });
}
async function prepare(safe: ReturnType<typeof assertSafeTarget>): Promise<void> {
  const total = numberArg("--participants", 500);
  if (!participantsAllowed(total, safe)) throw new Error("hosted runs require exactly 500 participants (or PQP_LOAD_SIZE_OVERRIDE=1 for 2 to 2000); local smoke permits 2 to 5; staging smoke is exactly 2; diagnostic staging permits 2 to 24");
  // Reserve the report path first. A failed write after server creation leaves
  // an invite and synthetic users with no manifest capable of cleaning them.
  const output = requiredArg("--manifest");
  const fd = openSync(output, "wx", 0o600);
  closeSync(fd);
  const owner = tokenFor(safe.runId, "owner", safe.local);
  await passAgeGate(safe.apiUrl, owner);
  const created = await api<{ server: { id: string }; channels: Array<{ id: string; type: string }> }>(safe.apiUrl, owner, "POST", "/api/servers", { name: `Load ${safe.runId}` });
  const text = created.channels.find((channel) => channel.type === "text");
  const voice = created.channels.find((channel) => channel.type === "voice");
  if (!text || !voice) throw new Error("created server is missing default text or voice channel");
  await api(safe.apiUrl, owner, "PATCH", `/api/channels/${voice.id}`, { voiceTransport: "livekit" });
  const invite = await api<{ invite: { code: string } }>(safe.apiUrl, owner, "POST", `/api/servers/${created.server.id}/invites`, {});
  const manifest: Manifest = { version: 1, runId: safe.runId, apiUrl: safe.apiUrl, wsUrl: safe.wsUrl, participants: total, serverId: created.server.id, textChannelId: text.id, voiceChannelId: voice.id, inviteCode: invite.invite.code, createdAt: new Date().toISOString() };
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ prepared: true, manifest: arg("--manifest"), runId: safe.runId, participants: total }, null, 2));
}
function manifest(safe: ReturnType<typeof assertSafeTarget>): Manifest {
  const parsed = JSON.parse(readFileSync(requiredArg("--manifest"), "utf8")) as Manifest;
  if (parsed.version !== 1 || parsed.runId !== safe.runId || parsed.apiUrl !== safe.apiUrl || parsed.wsUrl !== safe.wsUrl || !participantsAllowed(parsed.participants, safe)) throw new Error("manifest does not match this allowed run");
  return parsed;
}
type WsCounters = { wireBytes: number; frames: Record<string, { count: number; bytes: number }> };
type AppSession = { socket: WebSocket; peerId: string; resumeToken: string; welcomeMs: number; socketOpenToWelcomeMs: number; attempts: number; resumed: boolean; counters: WsCounters };
/**
 * The cold-browser HTTP, then the app socket: auth (with or without the delta
 * caps, and with or without permessage-deflate, to mirror a native app that
 * has not updated), the channel and voice joins, and the welcome. One attempt
 * is 12 s from socket open like the browser's; a miss closes the socket and
 * retries with backoff until the deadline, which is what a person's client
 * does. Every frame the socket receives is counted by type so the report can
 * say what a socket without the delta caps pays.
 */
/**
 * The browser's first load, as `coldBootstrap` in server/scripts/load-fanout.ts
 * replays it: 21 requests in App.tsx order, roughly a hundred pool checkouts.
 * The thin bootstrap (age gate, invite, four GETs) is what the harness shipped
 * with; --cold-bootstrap swaps this in for the runs that measure the API path.
 */
async function coldBootstrap(base: string, token: string, room: Manifest): Promise<void> {
  const get = (path: string, method = "GET") => api(base, token, method, path, method === "POST" ? {} : undefined).then(() => undefined, (error) => { throw error; });
  const all = (...paths: string[]) => Promise.all(paths.map((p) => get(p)));
  await get("/api/me");
  await all("/api/ice-servers", "/api/voice/backend");
  await all("/api/servers", "/api/community-home/config");
  await all("/api/dms", "/api/blocks", "/api/attachments/config", "/api/communities/config", "/api/friends", "/api/me/depoimentos/pending");
  await all(`/api/servers/${room.serverId}/channels`, `/api/servers/${room.serverId}/unread`);
  await all(`/api/servers/${room.serverId}/members`, `/api/servers/${room.serverId}/roles`, `/api/servers/${room.serverId}/permissions`);
  await all(`/api/channels/${room.voiceChannelId}/messages`, "/api/gifs/config");
  await get(`/api/channels/${room.voiceChannelId}/read`, "POST");
  await get("/api/ice-servers");
}
type Resume = { peerId: string; resumeToken: string };
/**
 * One app-socket handshake: auth (with or without the delta caps, and with or
 * without permessage-deflate, to mirror a native app that has not updated),
 * the channel and voice joins, and the welcome. One attempt is 12 s from
 * socket open like the browser's; a miss closes the socket and retries with
 * backoff until the deadline, which is what a person's client does. With a
 * resume pair it is the reconnect path and the welcome should say
 * `resumed: true`. Every frame the socket receives is counted by type so the
 * report can say what a socket without the delta caps pays.
 */
async function openAppSocket(wsUrl: string, token: string, room: Manifest, legacy: boolean, deadlineAtMs: number, index: number, counters: WsCounters, started: number, resume?: Resume): Promise<AppSession> {
  let attempts = 0;
  let backoff = 1_000;
  for (;;) {
    attempts += 1;
    const attemptStarted = Date.now();
    try {
      return await new Promise<AppSession>((resolve, reject) => {
        const socket = new WebSocket(wsUrl, { perMessageDeflate: !legacy });
        let opened = 0;
        const connectTimer = setTimeout(() => { socket.close(); reject(new Error("no voice welcome within 12s of socket open")); }, WELCOME_TIMEOUT_MS + HTTP_TIMEOUT_MS);
        socket.on("open", () => {
          opened = Date.now();
          // Re-arm from open, the way the browser does.
          clearTimeout(connectTimer);
          const welcomeTimer = setTimeout(() => { socket.close(); reject(new Error("no voice welcome within 12s of socket open")); }, WELCOME_TIMEOUT_MS);
          socket.once("close", () => clearTimeout(welcomeTimer));
          const auth: Record<string, unknown> = { type: "auth", token };
          if (!legacy) auth.caps = ["voice-roster-delta", "presence-delta"];
          socket.send(JSON.stringify(auth));
        });
        socket.on("message", (raw) => {
          const bytes = Buffer.isBuffer(raw) ? raw.length : Array.isArray(raw) ? raw.reduce((n, b) => n + b.length, 0) : (raw as ArrayBuffer).byteLength;
          let frame: { type?: string; peerId?: string; resumeToken?: string; resumed?: boolean };
          try { frame = JSON.parse(String(raw)); } catch { return; }
          const type = frame.type ?? "?";
          const slot = counters.frames[type] ?? (counters.frames[type] = { count: 0, bytes: 0 });
          slot.count += 1; slot.bytes += bytes;
          if (type === "ready") {
            socket.send(JSON.stringify({ type: "join-channel", channelId: room.textChannelId }));
            socket.send(JSON.stringify({ type: "join-voice-room", voiceChannelId: room.voiceChannelId, transports: ["livekit"], resume: true, ...(resume ? { resumePeerId: resume.peerId, resumeToken: resume.resumeToken } : {}) }));
          }
          if (type === "welcome") {
            if (!frame.peerId) { reject(new Error("welcome missing peer id")); return; }
            resolve({ socket, peerId: frame.peerId, resumeToken: frame.resumeToken ?? "", welcomeMs: Date.now() - started, socketOpenToWelcomeMs: Date.now() - (opened || attemptStarted), attempts, resumed: frame.resumed === true, counters });
          }
          if (["voice-join-refused", "voice-room-full", "voice-transport-unsupported"].includes(type)) { reject(new Error(type)); }
        });
        socket.on("error", (error) => { reject(error); });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostic("welcome-attempt-failed", index, { attempt: attempts, message });
      // Refusals are answers, not slowness: do not retry them.
      if (/voice-join-refused|voice-room-full|voice-transport-unsupported|missing peer id/.test(message)) throw error;
      if (Date.now() + backoff > deadlineAtMs) throw error;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
/** The cold-browser HTTP, then the app socket. */
async function appSession(base: string, wsUrl: string, token: string, room: Manifest, legacy: boolean, deadlineAtMs: number, index: number, cold: boolean): Promise<AppSession> {
  const started = Date.now();
  await passAgeGate(base, token);
  await api(base, token, "POST", `/api/invites/${room.inviteCode}/join`);
  if (cold) await coldBootstrap(base, token, room);
  else await Promise.all([api(base, token, "GET", "/api/me"), api(base, token, "GET", "/api/servers"), api(base, token, "GET", "/api/friends"), api(base, token, "GET", "/api/dms")]);
  const counters: WsCounters = { wireBytes: 0, frames: {} };
  return openAppSocket(wsUrl, token, room, legacy, deadlineAtMs, index, counters, started);
}
async function mint(base: string, token: string, room: Manifest, peerId: string, resumeToken: string, expectedSfuHost: string): Promise<Session> {
  const result = await api<Session>(base, token, "POST", "/api/voice/token", { voiceChannelId: room.voiceChannelId, peerId, ...(resumeToken ? { resumeToken } : {}) });
  const host = new URL(result.url).hostname.toLowerCase();
  if (host !== expectedSfuHost || PROD_HOSTS.has(host) || host.endsWith(".pqp.gg")) throw new Error("token returned a non-isolated or unexpected SFU host");
  if (result.room !== room.voiceChannelId || !result.token) throw new Error("invalid media token response");
  return result;
}
function consume(track: RemoteTrack, stats: ParticipantResult): void {
  const stream = track.kind === TrackKind.KIND_VIDEO ? new VideoStream(track) : new AudioStream(track);
  void (async () => {
    const reader = stream.getReader();
    try { for (;;) { const { done } = await reader.read(); if (done) break; if (track.kind === TrackKind.KIND_VIDEO) stats.videoFrames += 1; else stats.audioFrames += 1; } } catch { /* disconnect owns the final state */ }
  })();
}
/**
 * Ask the SFU for a specific simulcast layer. rtc-node has no adaptiveStream
 * and no public setVideoQuality, so this goes straight to the FFI request the
 * SDK itself would issue. HIGH for the presenter's share (the stage tile is
 * large in the real client); LOW for camera tiles, which are small.
 */
function pinQuality(publication: RemoteTrackPublication, quality: VideoQuality): void {
  const request = new FfiRequest({ message: { case: "setRemoteTrackPublicationQuality", value: new SetRemoteTrackPublicationQualityRequest({ trackPublicationHandle: publication.ffiHandle.handle, quality }) } });
  FfiResponse.fromBinary(livekitFfiRequest(request.toBinary()));
}
const emptyRtp = (): Rtp => ({ bytesReceived: 0, videoBytesReceived: 0, audioBytesReceived: 0, bytesSent: 0, packetsReceived: 0, packetsLost: 0, framesDecoded: 0, keyFramesDecoded: 0, framesDropped: 0, frameWidth: 0, frameHeight: 0, framesPerSecond: 0, freezeCount: 0, jitterMs: 0, nackCount: 0, pliCount: 0, firCount: 0, outboundVideoFps: 0, outboundVideoWidth: 0, outboundVideoHeight: 0, layers: [] });
async function rtpStats(room: Room): Promise<Rtp> {
  const report = await room.getRtcStats();
  const totals = emptyRtp();
  for (const stat of [...report.publisherStats, ...report.subscriberStats]) {
    if (stat.stats.case === "inboundRtp") {
      const v = stat.stats.value;
      const isVideo = v.stream?.kind === "video";
      const bytes = Number(v.inbound?.bytesReceived ?? 0n);
      totals.bytesReceived += bytes;
      if (isVideo) totals.videoBytesReceived += bytes; else totals.audioBytesReceived += bytes;
      totals.packetsReceived += Number(v.received?.packetsReceived ?? 0n);
      totals.packetsLost += Number(v.received?.packetsLost ?? 0n);
      if (isVideo) {
        totals.framesDecoded += v.inbound?.framesDecoded ?? 0;
        totals.keyFramesDecoded += v.inbound?.keyFramesDecoded ?? 0;
        totals.framesDropped += v.inbound?.framesDropped ?? 0;
        totals.frameWidth = Math.max(totals.frameWidth, v.inbound?.frameWidth ?? 0);
        totals.frameHeight = Math.max(totals.frameHeight, v.inbound?.frameHeight ?? 0);
        totals.framesPerSecond = Math.max(totals.framesPerSecond, v.inbound?.framesPerSecond ?? 0);
        totals.freezeCount += v.inbound?.freezeCount ?? 0;
        totals.jitterMs = Math.max(totals.jitterMs, (v.received?.jitter ?? 0) * 1000);
        totals.nackCount += v.inbound?.nackCount ?? 0;
        totals.pliCount += v.inbound?.pliCount ?? 0;
        totals.firCount += v.inbound?.firCount ?? 0;
      }
    }
    if (stat.stats.case === "outboundRtp") {
      const v = stat.stats.value;
      totals.bytesSent += Number(v.sent?.bytesSent ?? 0n);
      if (v.stream?.kind === "video") {
        totals.outboundVideoFps = Math.max(totals.outboundVideoFps, v.outbound?.framesPerSecond ?? 0);
        totals.outboundVideoWidth = Math.max(totals.outboundVideoWidth, v.outbound?.frameWidth ?? 0);
        totals.outboundVideoHeight = Math.max(totals.outboundVideoHeight, v.outbound?.frameHeight ?? 0);
        totals.layers.push({ rid: v.outbound?.rid ?? "", width: v.outbound?.frameWidth ?? 0, height: v.outbound?.frameHeight ?? 0, fps: v.outbound?.framesPerSecond ?? 0, targetBitrate: v.outbound?.targetBitrate ?? 0, bytesSent: Number(v.sent?.bytesSent ?? 0n) });
      }
    }
  }
  return totals;
}
type Publisher = { stop: () => Promise<void>; frames: () => number };
/** A screen-like picture with a moving noisy tile, or nothing when `video` is null; audio is a tone or a speech-shaped signal. */
async function publish(room: Room, video: VideoProfile | null, audio: "tone" | "speech" | null): Promise<Publisher> {
  const participant = room.localParticipant;
  if (!participant) throw new Error("LiveKit room connected without a local participant");
  const closers: Array<() => Promise<void>> = [];
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let frames = 0;
  if (audio) {
    const audioSource = new AudioSource(48_000, 1);
    const track = LocalAudioTrack.createAudioTrack("load-audio", audioSource);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    options.audioEncoding = new AudioEncoding({ maxBitrate: BigInt(AUDIO_BITRATE_BPS) });
    await participant.publishTrack(track, options);
    let tick = 0;
    let phase = 0;
    let seed = 0x2545f491;
    timers.push(setInterval(() => {
      const samples = new Int16Array(960);
      if (audio === "tone") {
        for (let i = 0; i < samples.length; i += 1) samples[i] = Math.round(8000 * Math.sin((tick * 960 + i) * Math.PI * 2 * 440 / 48_000));
      } else {
        // Speech-shaped: a gliding fundamental with harmonics under a 4 Hz
        // syllabic envelope plus a little noise, so Opus neither DTXes it away
        // nor treats it as a pure tone, and the SFU's speaker detection fires.
        const f0 = 120 + 60 * Math.sin(tick * 0.02);
        for (let i = 0; i < samples.length; i += 1) {
          const t = (tick * 960 + i) / 48_000;
          const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t + (tick >> 6));
          phase += (2 * Math.PI * f0) / 48_000;
          seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
          const noise = ((seed & 0xffff) / 0xffff - 0.5) * 0.15;
          const voiced = Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.3 * Math.sin(3 * phase) + 0.15 * Math.sin(4 * phase);
          samples[i] = Math.max(-32767, Math.min(32767, Math.round(6000 * env * (voiced * 0.5 + noise))));
        }
      }
      void audioSource.captureFrame(new AudioFrame(samples, 48_000, 1, 960));
      tick += 1;
    }, 20));
    closers.push(async () => { await track.close(); await audioSource.close(); });
  }
  if (video) {
    const videoSource = new VideoSource(video.width, video.height);
    const track = LocalVideoTrack.createVideoTrack("load-video", videoSource);
    const options = new TrackPublishOptions();
    options.source = video.source;
    options.simulcast = video.simulcast;
    options.videoEncoding = new VideoEncoding({ maxBitrate: BigInt(video.bitrate), maxFramerate: video.fps });
    await participant.publishTrack(track, options);
    const W = video.width; const H = video.height;
    const staticFrame = new Uint8Array(W * H * 3 / 2);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) staticFrame[y * W + x] = ((x >> 4) ^ (y >> 4)) & 1 ? 74 : 148;
    const chroma = W * H;
    staticFrame.fill(112, chroma, chroma + chroma / 4);
    staticFrame.fill(144, chroma + chroma / 4);
    let tick = 0;
    timers.push(setInterval(() => {
      // Screen-like background plus independently moving noisy tiles. Full
      // frame noise needs ~1 MB/frame and a 1.5 Mbps encoder correctly drops to
      // ~1fps; a static slide does the opposite. This is moving content that can
      // sustain both the 30fps cadence and the intended bitrate ceiling.
      const pixels = new Uint8Array(staticFrame);
      let state = (tick + 1) * 0x9e3779b1;
      const tileW = Math.round(W / 8); const tileH = Math.round(H / 6);
      for (let tile = 0; tile < MOTION_TILES; tile += 1) {
        const left = (tile * 211 + tick * (17 + tile)) % (W - tileW);
        const top = (tile * 97 + tick * (11 + tile)) % (H - tileH);
        for (let y = top; y < top + tileH; y += 1) {
          for (let x = left; x < left + tileW; x += 1) {
            state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
            pixels[y * W + x] = state & 255;
          }
        }
      }
      videoSource.captureFrame(new VideoFrame(pixels, W, H, VideoBufferType.I420), BigInt(Date.now()) * 1000n);
      tick += 1; frames += 1;
    }, 1000 / video.fps));
    closers.push(async () => { await track.close(); await videoSource.close(); });
  }
  return { frames: () => frames, stop: async () => { for (const t of timers) clearInterval(t); for (const c of closers) await c().catch(() => {}); } };
}
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
/**
 * Every participant that may hold a seat in the API's voice room, with the
 * one function that gives it back. `one` registers itself before it joins and
 * hangs up in its own `finally`; a signal or a crash hangs up whatever is
 * still here (see `armAbort`), so an interrupted shard does not leave orphan
 * seats in the API's voice maps and `voice_peers`.
 */
const seats = new Map<number, () => Promise<void>>();
/**
 * Hang up over the app socket before closing it. A socket that merely closes
 * leaves a seat that declared `resume: true` in the room as a resumable
 * orphan for `VOICE_RESUME_TTL_MS` (90 s on the server); `leave-voice-room`
 * removes it now. The resume pair rides along so the server can still retire
 * the seat if this socket somehow no longer maps to it.
 */
async function hangUp(socket: WebSocket, peerId: string, resumeToken: string): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) return;
  const leave = { type: "leave-voice-room", ...(peerId && resumeToken ? { resumePeerId: peerId, resumeToken } : {}) };
  await new Promise<void>((resolve) => socket.send(JSON.stringify(leave), () => resolve()));
}
let aborting = false;
let uncaughtErrors = 0;
async function abortRun(code: number): Promise<never> {
  aborting = true;
  const pending = [...seats.values()];
  console.error(JSON.stringify({ event: "hang-up", seats: pending.length, exitCode: code }));
  await within("hang up", ABORT_TIMEOUT_MS, Promise.all(pending.map((leave) => leave().catch(() => {})))).catch((error) => console.error(String(error)));
  await dispose().catch(() => {});
  process.exit(code);
}
/**
 * SIGINT, SIGTERM and a crash all hang every seat up before the process ends.
 * One exception: rtc-node's FFI can throw `trying to drop an invalid handle`
 * or `handle not found` out of a finalizer for a room that one participant
 * already released after a failed connect. That belongs to that participant
 * (its result already carries the failure); ending the process would turn it
 * into the loss of every other seat in the shard. Those are counted and
 * survived; anything else aborts.
 */
function armAbort(): void {
  const onSignal = (signal: NodeJS.Signals) => { if (!aborting) void abortRun(signal === "SIGINT" ? 130 : 143); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const onCrash = (error: unknown) => {
    const text = error instanceof Error ? `${error.message} ${(error as { code?: string }).code ?? ""}` : String(error);
    uncaughtErrors += 1;
    console.error(JSON.stringify({ event: "uncaught", message: text.slice(0, 400) }));
    if (/invalid handle|handle not found/i.test(text)) return;
    if (!aborting) void abortRun(1);
  };
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
}
/**
 * Every criterion a participant missed, empty when it passed. Scaled to the
 * hold: continuity is judged on the flow readings the hold produced plus the
 * final reading, and the decode rate on the seconds left after the warm-up,
 * so a healthy 15 s smoke passes and a stalled 900 s run fails. A hold at or
 * below the warm-up proves delivery and continuity, not the decode rate.
 * In stampede mode the barrier rule does not apply, the first decoded frame
 * must land within 45 s of the participant's own arrival, and the received
 * height must reach the layer the presenter profile promises.
 */
function judge(result: ParticipantResult, criteria: Criteria): string[] {
  const reasons: string[] = [];
  const rtp = result.rtp;
  if (result.failure) reasons.push(`failed: ${result.failure}`);
  if (result.disconnects > 0) reasons.push(`${result.disconnects} unexpected disconnect(s)`);
  if (!criteria.stampede && (result.rtcConnectedAtMs ?? Infinity) > criteria.startAtMs) reasons.push("RTC connected after start-at-ms");
  if (result.presenter) {
    // rtc-node reports no outbound framesPerSecond for the publisher, so the
    // capture rate and the bytes that left stand in for it.
    if ((result.sourceVideoFps ?? 0) < criteria.presenterFps * 0.9) reasons.push(`presenter source ${(result.sourceVideoFps ?? 0).toFixed(1)} fps, need ${criteria.presenterFps * 0.9}`);
    if ((rtp?.bytesSent ?? 0) === 0) reasons.push("presenter sent no RTP");
    return reasons;
  }
  if (result.subscribedTracks < 2) reasons.push(`subscribed ${result.subscribedTracks} track(s), need 2`);
  if ((rtp?.bytesReceived ?? 0) === 0) reasons.push("no RTP received");
  if (criteria.stampede) {
    if (result.firstFrameAbandoned || result.firstFrameFromArrivalMs === undefined) reasons.push("no decoded frame within 45 s of arrival");
    else if (result.firstFrameFromArrivalMs > FIRST_FRAME_ABANDON_MS) reasons.push(`first frame ${result.firstFrameFromArrivalMs} ms after arrival, budget ${FIRST_FRAME_ABANDON_MS}`);
    const height = Math.max(0, ...result.flow.map((f) => f.frameHeight), rtp?.frameHeight ?? 0);
    if (height < criteria.expectedHeight) reasons.push(`received height ${height}, expected ${criteria.expectedHeight}`);
  }
  // Continuity. Every subscriber decodes natively (rtc-node decodes whether or
  // not a VideoStream drains the frames), so a frozen decoder shows here for
  // every receiver, not only the sampled ones, and bytes still arriving cannot
  // hide it.
  const points = [...result.flow.map((f) => ({ atMs: f.atMs, bytesReceived: f.bytesReceived, framesDecoded: f.framesDecoded })), ...(rtp ? [{ atMs: result.heldMs ?? criteria.holdMs, bytesReceived: rtp.bytesReceived, framesDecoded: rtp.framesDecoded }] : [])]
    .sort((a, b) => a.atMs - b.atMs)
    .reduce<Array<{ atMs: number; bytesReceived: number; framesDecoded: number }>>((kept, point) => { if (kept.length === 0 || point.atMs - kept[kept.length - 1]!.atMs >= MIN_FLOW_GAP_MS) kept.push(point); return kept; }, []);
  if (points.length < 2) reasons.push(`only ${points.length} usable flow reading(s); hold at least 10 s to judge continuity`);
  for (let at = 1; at < points.length; at += 1) {
    const [before, after] = [points[at - 1]!, points[at]!];
    if (after.bytesReceived <= before.bytesReceived) reasons.push(`RTP stalled between ${before.atMs} ms and ${after.atMs} ms`);
    if (after.framesDecoded <= before.framesDecoded) reasons.push(`decoder stalled between ${before.atMs} ms and ${after.atMs} ms`);
  }
  const steadySeconds = Math.max(0, criteria.holdMs / 1000 - criteria.warmupSeconds);
  const minDecodedFrames = Math.ceil(criteria.minDecodedFps * steadySeconds);
  if (result.decodeSample && (rtp?.framesDecoded ?? 0) < minDecodedFrames) reasons.push(`decoded ${rtp?.framesDecoded ?? 0} frames, need ${minDecodedFrames} (${criteria.minDecodedFps} fps over the ${steadySeconds} s after a ${criteria.warmupSeconds} s warm-up)`);
  return reasons;
}
type ShardPlan = {
  holdMs: number;
  startAtMs: number;
  /** 0 keeps the original barrier (everyone connected before T0, presenter starts at T0). >0 is the stampede: presenter live first, receivers arrive across the window. */
  arrivalWindowMs: number;
  arrivalLeadMs: number;
  presenterVideo: VideoProfile;
  cameraVideo: VideoProfile;
  screenPin: VideoQuality | null;
  cameraPin: VideoQuality | null;
  joinDeadlineMs: number;
  coldBootstrap: boolean;
  /** Run D: this process reconnects one receiver every this many ms during the hold (0 = off). */
  churnEveryMs: number;
  /** Run D: every Nth churn also drops the LiveKit room and re-mints (0 = never). */
  churnRtcEvery: number;
};
async function one(index: number, role: Role, legacy: boolean, decodeSample: boolean, safe: ReturnType<typeof assertSafeTarget>, roomInfo: Manifest, plan: ShardPlan, arriveAtMs: number, acquireJoin: () => Promise<() => void>, churnSlot = -1, churnSlots = 1): Promise<ParticipantResult> {
  const presenter = role === "presenter";
  const result: ParticipantResult = { index, role, presenter, legacy, decodeSample, welcomeAttempts: 0, videoFrames: 0, audioFrames: 0, subscribedTracks: 0, disconnects: 0, flow: [] };
  let socket: WebSocket | undefined; let room: Room | undefined; let publisher: Publisher | undefined; let intentionalDisconnect = false; let releaseJoin: (() => void) | undefined; let wsCounters: WsCounters | undefined;
  let peerId = ""; let resumeToken = "";
  const timers: Array<ReturnType<typeof setInterval>> = [];
  // Idempotent: the normal path, a signal and a crash may all reach it.
  let leaving: Promise<void> | undefined;
  const leave = (): Promise<void> => (leaving ??= (async () => {
    for (const t of timers) clearInterval(t);
    releaseJoin?.(); releaseJoin = undefined;
    // rtc-node may already have released a handle after a failed connect. A
    // teardown error belongs to that one synthetic participant; it must not
    // abort every other in-flight participant or turn a failed run into no
    // report at all.
    if (publisher) await publisher.stop().catch(() => {});
    intentionalDisconnect = true;
    if (socket) await hangUp(socket, peerId, resumeToken).catch(() => {});
    if (room) await room.disconnect().catch(() => {});
    if (socket) {
      const wire = (socket as unknown as { _socket?: { bytesRead?: number } })._socket?.bytesRead ?? 0;
      result.ws = { wireBytes: wire, frames: wsCounters?.frames ?? {} };
      socket.close();
    }
    seats.delete(index);
  })());
  seats.set(index, leave);
  try {
    await sleep(arriveAtMs - Date.now());
    result.arrivalAtMs = Date.now();
    releaseJoin = await acquireJoin();
    diagnostic("join-slot-acquired", index, { waitedMs: Date.now() - result.arrivalAtMs });
    const started = Date.now(); const token = tokenFor(safe.runId, index, safe.local);
    const joined = await appSession(safe.apiUrl, safe.wsUrl, token, roomInfo, legacy, result.arrivalAtMs + plan.joinDeadlineMs, index, plan.coldBootstrap);
    socket = joined.socket; peerId = joined.peerId; resumeToken = joined.resumeToken; wsCounters = joined.counters;
    result.bootstrapMs = Date.now() - started; result.welcomeMs = joined.welcomeMs; result.socketOpenToWelcomeMs = joined.socketOpenToWelcomeMs; result.welcomeAttempts = joined.attempts; result.resumed = joined.resumed;
    diagnostic("app-session-ready", index, { bootstrapMs: result.bootstrapMs, welcomeMs: result.welcomeMs, socketOpenToWelcomeMs: result.socketOpenToWelcomeMs });
    const wireRoom = (r: Room) => {
      r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication) => {
        result.subscribedTracks += 1;
        if (track.kind === TrackKind.KIND_VIDEO) {
          const pin = publication.source === TrackSource.SOURCE_SCREENSHARE ? plan.screenPin : plan.cameraPin;
          if (pin !== null) { try { pinQuality(publication, pin); } catch (error) { diagnostic("pin-failed", index, { message: error instanceof Error ? error.message : String(error) }); } }
        }
        if (decodeSample) consume(track, result);
      });
      r.on(RoomEvent.Disconnected, () => { if (!intentionalDisconnect) result.disconnects += 1; });
    };
    room = new Room();
    wireRoom(room);
    // Mint immediately before connect: the token has a TTL and a slow ramp
    // must not turn into expiry failures.
    const tokenStarted = Date.now(); const session = await mint(safe.apiUrl, token, roomInfo, joined.peerId, joined.resumeToken, safe.sfuHost); result.tokenMs = Date.now() - tokenStarted;
    diagnostic("media-token-ready", index, { tokenMs: result.tokenMs });
    const connected = Date.now(); await within("LiveKit connect", MEDIA_CONNECT_TIMEOUT_MS, room.connect(session.url, session.token, { autoSubscribe: true, dynacast: true })); result.rtcConnectedMs = Date.now() - connected; result.rtcConnectedAtMs = Date.now();
    diagnostic("rtc-connected", index, { rtcConnectedMs: result.rtcConnectedMs });
    releaseJoin(); releaseJoin = undefined;
    diagnostic("join-slot-released", index);
    const stampede = plan.arrivalWindowMs > 0;
    if (!stampede) await sleep(plan.startAtMs - Date.now());
    const mediaStartedAt = Date.now();
    if (role === "presenter") { publisher = await publish(room, plan.presenterVideo, "tone"); result.requestedVideoBitrateBps = plan.presenterVideo.bitrate; }
    else if (role === "audio") publisher = await publish(room, null, "speech");
    else if (role === "camera") { publisher = await publish(room, plan.cameraVideo, "speech"); result.requestedVideoBitrateBps = plan.cameraVideo.bitrate; }
    // Time to first decoded frame, from RTC connect and from arrival.
    if (role !== "presenter") {
      const pollStarted = Date.now();
      for (;;) {
        const s = await rtpStats(room);
        if (s.framesDecoded > 0) { result.firstFrameFromConnectMs = Date.now() - result.rtcConnectedAtMs; result.firstFrameFromArrivalMs = Date.now() - result.arrivalAtMs; break; }
        if (Date.now() - pollStarted > FIRST_FRAME_ABANDON_MS) { result.firstFrameAbandoned = true; break; }
        await sleep(500);
      }
      diagnostic("first-frame", index, { fromConnectMs: result.firstFrameFromConnectMs, abandoned: result.firstFrameAbandoned });
    }
    const collectFlow = () => void rtpStats(room!).then((s) => result.flow.push({ atMs: Date.now() - mediaStartedAt, bytesReceived: s.bytesReceived, videoBytesReceived: s.videoBytesReceived, framesDecoded: s.framesDecoded, frameWidth: s.frameWidth, frameHeight: s.frameHeight, framesPerSecond: s.framesPerSecond, framesDropped: s.framesDropped, freezeCount: s.freezeCount, packetsLost: s.packetsLost, pliCount: s.pliCount, nackCount: s.nackCount })).catch((error) => { result.failure ??= `RTP stats: ${error instanceof Error ? error.message : String(error)}`; });
    timers.push(setInterval(collectFlow, 5_000));
    // Hold: own-arrival based in the stampede, common in the barrier. The
    // presenter outlives the last receiver's hold by a margin either way.
    const holdUntil = stampede
      ? (presenter ? plan.startAtMs + plan.arrivalLeadMs + plan.arrivalWindowMs + plan.holdMs + 20_000 : mediaStartedAt + plan.holdMs)
      : plan.startAtMs + plan.holdMs + (presenter ? 5_000 : 0);
    if (plan.churnEveryMs > 0 && role !== "presenter" && churnSlot >= 0) {
      // Staggered across this process: slot k churns at (k+1) x every, then
      // every (slots x every) after that, never in the last 60 s of the hold.
      result.churns = [];
      let churnAt = mediaStartedAt + (churnSlot + 1) * plan.churnEveryMs;
      let n = 0;
      while (churnAt < holdUntil - 60_000) {
        await sleep(churnAt - Date.now());
        const rtc = plan.churnRtcEvery > 0 && ((churnSlot + n * churnSlots) % plan.churnRtcEvery === 0);
        const record: NonNullable<ParticipantResult["churns"]>[number] = { atMs: Date.now() - mediaStartedAt, resumed: false, rtc };
        result.churns.push(record);
        try {
          // The app socket drops without a leave, the way a flaky link does.
          const old = socket; socket = undefined;
          old?.close();
          const t0 = Date.now();
          const again = await openAppSocket(safe.wsUrl, token, roomInfo, legacy, Date.now() + 60_000, index, wsCounters!, t0, { peerId, resumeToken });
          socket = again.socket; record.welcomeMs = again.socketOpenToWelcomeMs; record.resumed = again.resumed;
          if (again.peerId !== peerId) record.failure = `resumed with a different peer id (${again.resumed ? "resumed" : "fresh"})`;
          peerId = again.peerId; resumeToken = again.resumeToken || resumeToken;
          if (rtc) {
            intentionalDisconnect = true;
            await room!.disconnect().catch(() => {});
            const session = await mint(safe.apiUrl, token, roomInfo, peerId, resumeToken, safe.sfuHost);
            const fresh = new Room(); wireRoom(fresh);
            intentionalDisconnect = false;
            const c0 = Date.now();
            await within("LiveKit reconnect", MEDIA_CONNECT_TIMEOUT_MS, fresh.connect(session.url, session.token, { autoSubscribe: true, dynacast: true }));
            record.rtcConnectedMs = Date.now() - c0;
            room = fresh;
            const p0 = Date.now(); const baseline = 0;
            for (;;) { const st = await rtpStats(room); if (st.framesDecoded > baseline) { record.firstFrameMs = Date.now() - p0; break; } if (Date.now() - p0 > FIRST_FRAME_ABANDON_MS) { record.failure = "no frame within 45 s after RTC reconnect"; break; } await sleep(500); }
          }
        } catch (error) { record.failure = error instanceof Error ? error.message : String(error); }
        diagnostic("churn", index, record as unknown as Record<string, unknown>);
        n += 1;
        churnAt = mediaStartedAt + (churnSlot + 1 + n * churnSlots) * plan.churnEveryMs;
      }
    }
    await sleep(holdUntil - Date.now());
    for (const t of timers) clearInterval(t);
    result.rtp = await rtpStats(room);
    const heldMs = Math.max(1, Date.now() - mediaStartedAt);
    result.heldMs = heldMs;
    result.decodedVideoFps = result.rtp.framesDecoded / (heldMs / 1000);
    if (publisher && (role === "presenter" || role === "camera")) { result.sourceVideoFps = publisher.frames() / (heldMs / 1000); result.sentBitrateBps = (result.rtp.bytesSent * 8) / (heldMs / 1000); }
    if (!presenter && (result.subscribedTracks < 2 || result.rtp.bytesReceived === 0)) throw new Error(`no received presenter RTP (tracks=${result.subscribedTracks}, bytes=${result.rtp.bytesReceived})`);
    if (decodeSample && !presenter && (result.videoFrames === 0 || result.audioFrames === 0)) throw new Error(`no decoded presenter media (video=${result.videoFrames}, audio=${result.audioFrames})`);
    if (result.firstFrameAbandoned) throw new Error("no first frame within 45s");
  } catch (error) { result.failure = error instanceof Error ? error.message : String(error); result.failureClass = classify(error); diagnostic("participant-failed", index, { failure: result.failure, class: result.failureClass }); }
  finally {
    await leave();
  }
  return result;
}
function profileFor(name: string, source: TrackSource): VideoProfile {
  // The client's ladder (client/src/lib/video-quality.ts): a room above 20
  // people holds the share at 720p / 1.5 Mbps unless the presenter chose 1080p
  // by name, which is 4 Mbps with 720p and 360p rungs under it. Cameras are
  // 1080p30 at 2.5 Mbps.
  switch (name) {
    case "720p": return { width: 1280, height: 720, bitrate: 1_500_000, fps: 30, simulcast: false, source };
    case "720p-simulcast": return { width: 1280, height: 720, bitrate: 1_500_000, fps: 30, simulcast: true, source };
    case "1080p": return { width: 1920, height: 1080, bitrate: source === TrackSource.SOURCE_CAMERA ? 2_500_000 : 4_000_000, fps: 30, simulcast: true, source };
    default: throw new Error(`unknown video profile ${name}`);
  }
}
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}
async function shard(safe: ReturnType<typeof assertSafeTarget>): Promise<void> {
  const info = manifest(safe); const shardIndex = integerArg("--shard-index", -1); const shardCount = numberArg("--shard-count", 0); const holdSeconds = numberArg("--hold-seconds", 900); const decodeSamples = numberArg("--decode-sample", safe.local ? 2 : 25); const startAtMs = Number(arg("--start-at-ms", safe.local ? String(Date.now() + 1_000) : "0"));
  const minDecodedFps = numberArg("--min-decoded-fps", 24);
  const warmupSeconds = numberArg("--decode-warmup-seconds", DECODE_WARMUP_SECONDS);
  const arrivalWindowSeconds = numberArg("--arrival-window-seconds", 0);
  const arrivalLeadSeconds = numberArg("--arrival-lead-seconds", 10);
  const legacyShare = numberArg("--legacy-share", 0);
  const audioPublishers = numberArg("--audio-publishers", 0);
  const cameraPublishers = numberArg("--camera-publishers", 0);
  const joinConcurrency = numberArg("--join-concurrency", 12);
  const joinDeadlineSeconds = numberArg("--join-deadline-seconds", 120);
  const coldBoot = has("--cold-bootstrap");
  const churnEveryMs = numberArg("--churn-every-ms", 0);
  const churnRtcEvery = numberArg("--churn-rtc-every", 10);
  const presenterOnly = has("--presenter-only");
  const noPresenter = has("--no-presenter");
  const pinArg = (name: string, fallback: string): VideoQuality | null => { const v = arg(name, fallback); if (v === "none") return null; if (v === "high") return VideoQuality.HIGH; if (v === "medium") return VideoQuality.MEDIUM; if (v === "low") return VideoQuality.LOW; throw new Error(`${name} must be high|medium|low|none`); };
  const plan: ShardPlan = {
    holdMs: holdSeconds * 1000, startAtMs, arrivalWindowMs: arrivalWindowSeconds * 1000, arrivalLeadMs: arrivalLeadSeconds * 1000,
    presenterVideo: profileFor(arg("--presenter-profile", "720p"), TrackSource.SOURCE_SCREENSHARE),
    cameraVideo: profileFor(arg("--camera-profile", "1080p"), TrackSource.SOURCE_CAMERA),
    screenPin: pinArg("--screen-pin", "none"), cameraPin: pinArg("--camera-pin", "low"),
    joinDeadlineMs: joinDeadlineSeconds * 1000,
    coldBootstrap: coldBoot, churnEveryMs, churnRtcEvery,
  };
  const holdIsAllowed = sizeOverride
    ? holdSeconds >= 5 && holdSeconds <= 1800
    : safe.local
      ? holdSeconds >= 5 && holdSeconds <= 60
      : safe.diagnostic
        ? holdSeconds >= 5 && holdSeconds <= 60
        : safe.smoke
          ? holdSeconds >= 60 && holdSeconds <= 120
          : holdSeconds >= 600 && holdSeconds <= 900;
  if (shardIndex < 0 || shardCount < 1 || shardIndex >= shardCount || !holdIsAllowed || !Number.isFinite(startAtMs) || startAtMs < Date.now() + (safe.local ? 0 : 30_000)) throw new Error("valid shard indexes, a 5 to 60s local / 60 to 120s explicit staging smoke / 600 to 900s 500-person hold (any 5 s to 30 min under PQP_LOAD_SIZE_OVERRIDE=1), and a shared start-at-ms at least 30s ahead are required");
  let indexes = Array.from({ length: info.participants }, (_, i) => i).filter((i) => i % shardCount === shardIndex);
  if (presenterOnly) indexes = [0];
  else if (noPresenter) indexes = indexes.filter((i) => i !== 0);
  const roleOf = (i: number): Role => i === 0 ? "presenter" : i <= audioPublishers ? "audio" : i <= audioPublishers + cameraPublishers ? "camera" : "receiver";
  // 20% legacy means indexes 80..99 of every hundred: deterministic, spread
  // across shards, never the presenter.
  const isLegacy = (i: number): boolean => i > 0 && legacyShare > 0 && (i % 100) >= 100 - legacyShare;
  const decodedIndexes = new Set(indexes.filter((index) => index !== 0).slice(0, decodeSamples));
  // Arrivals: barrier mode is "now"; the stampede spreads receivers evenly
  // across the window after the presenter has been live for the lead.
  const perSlot = info.participants > 1 ? plan.arrivalWindowMs / (info.participants - 1) : 0;
  const arriveAt = (i: number): number => plan.arrivalWindowMs === 0 || i === 0 ? Date.now() : startAtMs + plan.arrivalLeadMs + Math.round((i - 1) * perSlot);
  const startedAt = Date.now(); const cpuStart = process.cpuUsage(); let maxRssBytes = process.memoryUsage().rss; let maxEventLoopLagMs = 0; let expectedTick = Date.now() + 1000;
  const sampler = setInterval(() => { maxRssBytes = Math.max(maxRssBytes, process.memoryUsage().rss); maxEventLoopLagMs = Math.max(maxEventLoopLagMs, Date.now() - expectedTick); expectedTick += 1000; }, 1000);
  const acquireJoin = joinGate(joinConcurrency);
  armAbort();
  console.error(JSON.stringify({ shard: shardIndex, of: shardCount, participants: indexes.length, roles: { presenter: indexes.filter((i) => roleOf(i) === "presenter").length, audio: indexes.filter((i) => roleOf(i) === "audio").length, camera: indexes.filter((i) => roleOf(i) === "camera").length, receiver: indexes.filter((i) => roleOf(i) === "receiver").length }, legacy: indexes.filter(isLegacy).length, mode: plan.arrivalWindowMs > 0 ? "stampede" : "barrier", startAt: new Date(startAtMs).toISOString(), lastArrival: new Date(Math.max(...indexes.map(arriveAt))).toISOString() }));
  const churners = indexes.filter((i) => roleOf(i) !== "presenter");
  const results = await Promise.all(indexes.map((index) => one(index, roleOf(index), isLegacy(index), decodedIndexes.has(index), safe, info, plan, arriveAt(index), acquireJoin, churners.indexOf(index), Math.max(1, churners.length))));
  clearInterval(sampler);
  const wallMs = Date.now() - startedAt; const cpu = process.cpuUsage(cpuStart);
  const decoded = results.filter((result) => result.decodeSample);
  const totalReceivedBytes = results.reduce((sum, result) => sum + (result.rtp?.bytesReceived ?? 0), 0);
  const totalSentBytes = results.reduce((sum, result) => sum + (result.rtp?.bytesSent ?? 0), 0);
  const criteria: Criteria = { holdMs: holdSeconds * 1000, startAtMs, minDecodedFps, warmupSeconds, stampede: plan.arrivalWindowMs > 0, expectedHeight: plan.presenterVideo.height, presenterFps: plan.presenterVideo.fps };
  for (const result of results) result.verdict = judge(result, criteria);
  const failed = results.filter((result) => result.verdict!.length > 0);
  const receivers = results.filter((r) => r.role !== "presenter");
  const withinFirstFrame = receivers.filter((r) => (r.firstFrameFromArrivalMs ?? Infinity) <= FIRST_FRAME_ABANDON_MS).length;
  const failureClasses: Record<string, number> = {};
  for (const r of results) if (r.failureClass) failureClasses[r.failureClass] = (failureClasses[r.failureClass] ?? 0) + 1;
  const report = {
    runId: safe.runId, host: hostname(), shardIndex, shardCount, expectedParticipants: info.participants, startAtMs,
    plan: { holdSeconds, arrivalWindowSeconds, arrivalLeadSeconds, legacyShare, audioPublishers, cameraPublishers, joinConcurrency, presenterProfile: arg("--presenter-profile", "720p"), cameraProfile: arg("--camera-profile", "1080p"), screenPin: arg("--screen-pin", "none"), cameraPin: arg("--camera-pin", "low"), presenterOnly, noPresenter, coldBootstrap: coldBoot, churnEveryMs, churnRtcEvery },
    mediaContract: { source: `${plan.presenterVideo.width}x${plan.presenterVideo.height}@${plan.presenterVideo.fps}`, requestedVideoBitrateBps: plan.presenterVideo.bitrate, requestedAudioBitrateBps: AUDIO_BITRATE_BPS, decodedSampleCount: decoded.length, minDecodedFps, decodeWarmupSeconds: warmupSeconds, minDecodedFrames: Math.ceil(minDecodedFps * Math.max(0, holdSeconds - warmupSeconds)) },
    generator: { wallMs, cpuMs: (cpu.user + cpu.system) / 1000, cpuPercentOfOneCore: ((cpu.user + cpu.system) / 1000 / wallMs) * 100, maxRssBytes, maxEventLoopLagMs, uncaughtErrors },
    aggregateRtp: { receivedBytes: totalReceivedBytes, receivedBitrateBps: totalReceivedBytes * 8_000 / (holdSeconds * 1000), sentBytes: totalSentBytes, sentBitrateBps: totalSentBytes * 8_000 / (holdSeconds * 1000) },
    summary: { participants: results.length, receivers: receivers.length, failed: results.filter((r) => r.failure).length, missedCriteria: failed.length, failureClasses, firstFrameWithin45s: withinFirstFrame, welcomeP95SocketOpenMs: percentile(receivers.map((r) => r.socketOpenToWelcomeMs).filter((n): n is number => n !== undefined), 95), firstFrameP95FromArrivalMs: percentile(receivers.map((r) => r.firstFrameFromArrivalMs).filter((n): n is number => n !== undefined), 95) },
    results,
    passed: failed.length === 0,
  };
  const out = requiredArg("--report"); writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  // The first few verdicts on the console so a red run says why without
  // opening the report.
  console.log(JSON.stringify({ report: out, passed: report.passed, summary: report.summary, verdicts: failed.slice(0, 10).map((result) => ({ index: result.index, verdict: result.verdict })) }, null, 2));
  if (!report.passed) process.exitCode = 1;
}
async function cleanup(safe: ReturnType<typeof assertSafeTarget>): Promise<void> {
  const info = manifest(safe);
  const databaseUrl = need("PQP_LOAD_DATABASE_URL");
  const owner = tokenFor(safe.runId, "owner", safe.local);
  const prefix = safe.local ? "dev_local_user" : "load_test_user";
  const clerkIds = [
    `${prefix}_${safe.runId}-owner`,
    ...Array.from({ length: info.participants }, (_, index) => `${prefix}_${safe.runId}-${index}`),
  ];
  // Require the database URL before mutating anything. Cleanup is all-or-nothing
  // from the operator's perspective: do not delete the room and strand accounts.
  const db = new PgClient({ connectionString: databaseUrl });
  await db.connect();
  try {
    await api(safe.apiUrl, owner, "DELETE", `/api/servers/${info.serverId}`);
    const deleted = await db.query<{ clerk_id: string }>("DELETE FROM users WHERE clerk_id = ANY($1::text[]) RETURNING clerk_id", [clerkIds]);
    if (deleted.rowCount !== clerkIds.length) throw new Error(`cleanup deleted ${deleted.rowCount ?? 0}/${clerkIds.length} scoped synthetic accounts`);
    console.log(JSON.stringify({ cleaned: true, serverId: info.serverId, deletedSyntheticAccounts: deleted.rowCount }));
  } finally {
    await db.end();
  }
}
const USAGE = [
  "usage: pnpm exec tsx src/index.ts <command> [flags]   (or: pnpm wp <command> [flags])",
  "  prepare --manifest <file> [--participants N]",
  "  shard   --manifest <file> --shard-index I --shard-count N --report <file>",
  "          [--hold-seconds S] [--decode-sample N] [--start-at-ms T]",
  "          [--min-decoded-fps F] [--decode-warmup-seconds S]",
  "          [--arrival-window-seconds W] [--arrival-lead-seconds L]   stampede: presenter live first, receivers arrive across W",
  "          [--legacy-share P]           P% of sockets send no caps and no permessage-deflate (native apps that have not updated)",
  "          [--presenter-profile 720p|720p-simulcast|1080p] [--screen-pin high|medium|low|none]",
  "          [--audio-publishers N] [--camera-publishers M] [--camera-profile 1080p|720p] [--camera-pin low|none]",
  "          [--join-concurrency N] [--join-deadline-seconds S] [--presenter-only] [--no-presenter]",
  "          [--cold-bootstrap]            the browser's 21-request first load instead of the thin one",
  "          [--churn-every-ms MS] [--churn-rtc-every N]   run D: this process reconnects one receiver every MS (resume pair, expect resumed:true); every Nth also drops the LiveKit room and re-mints",
  "  cleanup --manifest <file>            (also needs PQP_LOAD_DATABASE_URL)",
  "  help",
  "env: TEST_RUN_ID, PQP_LOAD_TARGET=staging|local, PQP_LOAD_SFU_HOST,",
  "     LOAD_TEST_TOKEN (staging only), PQP_LOAD_API_URL / PQP_LOAD_WS_URL",
  "     (loopback overrides), PQP_LOAD_SMOKE=1, PQP_LOAD_DIAGNOSTIC=1,",
  "     PQP_LOAD_SIZE_OVERRIDE=1 (hosted 2..2000 participants, 5 s..30 min hold), PQP_LOAD_TRACE=1",
].join("\n");
const command = process.argv[2] as Command | "help" | "--help" | "-h" | undefined;
if (command === "help" || command === "--help" || command === "-h") {
  console.log(USAGE);
  await dispose();
} else {
  if (!(["prepare", "shard", "cleanup"] as string[]).includes(command ?? "")) throw new Error(USAGE);
  const safe = assertSafeTarget();
  try { if (command === "prepare") await prepare(safe); else if (command === "shard") await shard(safe); else await cleanup(safe); }
  finally { await dispose(); }
}
