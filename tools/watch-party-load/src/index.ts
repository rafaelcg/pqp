/* eslint-disable no-console -- this is a command-line load harness. */
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { Client as PgClient } from "pg";
import { WebSocket } from "ws";
import { AudioEncoding, VideoEncoding } from "@livekit/rtc-ffi-bindings";
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  LocalVideoTrack,
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

const STAGING_API = "https://pqp-api-staging.fly.dev";
const STAGING_WS = "wss://pqp-api-staging.fly.dev/ws";
const PROD_HOSTS = new Set(["pqp.gg", "api.pqp.gg", "sfu.pqp.gg"]);
const HTTP_TIMEOUT_MS = 15_000;
const MEDIA_CONNECT_TIMEOUT_MS = 20_000;
// A staging API machine has a finite connection pool. Joining 250 identities at
// once turns one media test into a bootstrap-pool exhaustion test.
const JOIN_CONCURRENCY = 12;
const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const VIDEO_FPS = 30;
const VIDEO_BITRATE_BPS = 1_500_000;
const AUDIO_BITRATE_BPS = 64_000;
const MOTION_TILES = 1;

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
type ParticipantResult = {
  index: number;
  presenter: boolean;
  bootstrapMs?: number;
  welcomeMs?: number;
  tokenMs?: number;
  rtcConnectedMs?: number;
  rtcConnectedAtMs?: number;
  videoFrames: number;
  audioFrames: number;
  subscribedTracks: number;
  decodeSample: boolean;
  rtp?: { bytesReceived: number; bytesSent: number; packetsLost: number; framesDecoded: number; outboundVideoFps: number; outboundVideoWidth: number; outboundVideoHeight: number };
  decodedVideoFps?: number;
  sourceVideoFps?: number;
  requestedVideoBitrateBps?: number;
  disconnects: number;
  flow: Array<{ atMs: number; bytesReceived: number; framesDecoded: number }>;
  failure?: string;
};

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
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
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
function integerArg(name: string, fallback: number): number {
  const value = Number(arg(name, String(fallback)));
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}
function assertSafeTarget(): { runId: string; apiUrl: string; wsUrl: string; sfuHost: string; local: boolean; smoke: boolean } {
  const runId = need("TEST_RUN_ID");
  if (!/^[a-z0-9][a-z0-9-]{2,48}$/.test(runId)) throw new Error("TEST_RUN_ID must be a lowercase, traceable run id");
  const target = need("PQP_LOAD_TARGET");
  if (target !== "staging" && target !== "local") throw new Error("PQP_LOAD_TARGET must be staging or local");
  const local = target === "local";
  const smoke = process.env.PQP_LOAD_SMOKE === "1";
  const apiUrl = process.env.PQP_LOAD_API_URL ?? (local ? "http://localhost:3001" : STAGING_API);
  const wsUrl = process.env.PQP_LOAD_WS_URL ?? (local ? "ws://localhost:3001/ws" : STAGING_WS);
  const api = new URL(apiUrl);
  const ws = new URL(wsUrl);
  if (!local && (api.origin !== STAGING_API || ws.href.replace(/\/$/, "") !== STAGING_WS)) throw new Error("only the exact pqp staging API and WebSocket are allowed");
  if (local && (!["localhost", "127.0.0.1", "::1"].includes(api.hostname) || !["localhost", "127.0.0.1", "::1"].includes(ws.hostname))) throw new Error("local runs may only use loopback API and WebSocket hosts");
  const sfuHost = need("PQP_LOAD_SFU_HOST").toLowerCase();
  if (PROD_HOSTS.has(sfuHost) || sfuHost.endsWith(".pqp.gg")) throw new Error("production SFU hosts are forbidden");
  if (local && !["localhost", "127.0.0.1", "::1"].includes(sfuHost)) throw new Error("local runs may only use a loopback SFU host");
  return { runId, apiUrl, wsUrl, sfuHost, local, smoke };
}
function tokenFor(runId: string, index: string | number, local: boolean): string {
  return local ? `dev-local-token:${runId}-${index}` : `${need("LOAD_TEST_TOKEN")}:${runId}-${index}`;
}
async function api<T>(base: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return await res.json() as T;
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
async function passAgeGate(base: string, token: string): Promise<void> {
  const me = await api<{ ageGate?: string }>(base, token, "GET", "/api/me");
  if (me.ageGate !== "passed") await api(base, token, "POST", "/api/me/age-check", { dateOfBirth: "1990-01-01" });
}
async function prepare(safe: ReturnType<typeof assertSafeTarget>): Promise<void> {
  const total = numberArg("--participants", 500);
  if (total !== 500 && !(safe.local && total >= 2 && total <= 5) && !(safe.smoke && total === 2)) throw new Error("hosted runs require exactly 500 participants; local smoke permits 2–5; staging smoke is exactly 2 with PQP_LOAD_SMOKE=1");
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
  if (parsed.version !== 1 || parsed.runId !== safe.runId || parsed.apiUrl !== safe.apiUrl || parsed.wsUrl !== safe.wsUrl || (parsed.participants !== 500 && !(safe.local && parsed.participants >= 2 && parsed.participants <= 5) && !(safe.smoke && parsed.participants === 2))) throw new Error("manifest does not match this allowed run");
  return parsed;
}
async function appSession(base: string, wsUrl: string, token: string, room: Manifest): Promise<{ socket: WebSocket; peerId: string; resumeToken: string; welcomeMs: number }> {
  const started = Date.now();
  await passAgeGate(base, token);
  await api(base, token, "POST", `/api/invites/${room.inviteCode}/join`);
  await Promise.all([api(base, token, "GET", "/api/me"), api(base, token, "GET", "/api/servers"), api(base, token, "GET", "/api/friends"), api(base, token, "GET", "/api/dms")]);
  const socket = new WebSocket(wsUrl, { perMessageDeflate: true });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("no voice welcome within 45s")); }, 45_000);
    socket.on("open", () => socket.send(JSON.stringify({ type: "auth", token, caps: ["voice-roster-delta", "presence-delta"] })));
    socket.on("message", (raw) => {
      let frame: { type?: string; peerId?: string; resumeToken?: string };
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame.type === "ready") {
        socket.send(JSON.stringify({ type: "join-channel", channelId: room.textChannelId }));
        socket.send(JSON.stringify({ type: "join-voice-room", voiceChannelId: room.voiceChannelId, transports: ["livekit"], resume: true }));
      }
      if (frame.type === "welcome") {
        clearTimeout(timer);
        if (!frame.peerId) { reject(new Error("welcome missing peer id")); return; }
        resolve({ socket, peerId: frame.peerId, resumeToken: frame.resumeToken ?? "", welcomeMs: Date.now() - started });
      }
      if (["voice-join-refused", "voice-room-full", "voice-transport-unsupported"].includes(frame.type ?? "")) { clearTimeout(timer); reject(new Error(frame.type)); }
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}
async function mint(base: string, token: string, room: Manifest, peerId: string, resumeToken: string, expectedSfuHost: string): Promise<Session> {
  const result = await api<Session>(base, token, "POST", "/api/voice/token", { voiceChannelId: room.voiceChannelId, peerId, ...(resumeToken ? { resumeToken } : {}) });
  const host = new URL(result.url).hostname.toLowerCase();
  if (host !== expectedSfuHost || PROD_HOSTS.has(host) || host.endsWith(".pqp.gg")) throw new Error("token returned a non-isolated or unexpected SFU host");
  if (result.room !== room.voiceChannelId || !result.token) throw new Error("invalid media token response");
  return result;
}
function consume(track: any, stats: ParticipantResult): void {
  const stream = track.kind === TrackKind.KIND_VIDEO ? new VideoStream(track) : new AudioStream(track);
  void (async () => {
    const reader = stream.getReader();
    try { for (;;) { const { done } = await reader.read(); if (done) break; if (track.kind === TrackKind.KIND_VIDEO) stats.videoFrames += 1; else stats.audioFrames += 1; } } catch { /* disconnect owns the final state */ }
  })();
}
async function rtpStats(room: Room): Promise<NonNullable<ParticipantResult["rtp"]>> {
  const report = await room.getRtcStats();
  const totals = { bytesReceived: 0, bytesSent: 0, packetsLost: 0, framesDecoded: 0, outboundVideoFps: 0, outboundVideoWidth: 0, outboundVideoHeight: 0 };
  for (const stat of [...report.publisherStats, ...report.subscriberStats]) {
    if (stat.stats.case === "inboundRtp") {
      const inbound = stat.stats.value.inbound;
      totals.bytesReceived += Number(inbound?.bytesReceived ?? 0n);
      totals.packetsLost += Number(stat.stats.value.received?.packetsLost ?? 0n);
      totals.framesDecoded += inbound?.framesDecoded ?? 0;
    }
    if (stat.stats.case === "outboundRtp") {
      totals.bytesSent += Number(stat.stats.value.sent?.bytesSent ?? 0n);
      if (stat.stats.value.stream?.kind === "video") {
        totals.outboundVideoFps = Math.max(totals.outboundVideoFps, stat.stats.value.outbound?.framesPerSecond ?? 0);
        totals.outboundVideoWidth = Math.max(totals.outboundVideoWidth, stat.stats.value.outbound?.frameWidth ?? 0);
        totals.outboundVideoHeight = Math.max(totals.outboundVideoHeight, stat.stats.value.outbound?.frameHeight ?? 0);
      }
    }
  }
  return totals;
}
async function publish(room: Room): Promise<{ stop: () => Promise<void>; frames: () => number }> {
  const audioSource = new AudioSource(48_000, 1);
  const videoSource = new VideoSource(VIDEO_WIDTH, VIDEO_HEIGHT);
  const audio = LocalAudioTrack.createAudioTrack("load-audio", audioSource);
  const video = LocalVideoTrack.createVideoTrack("load-video", videoSource);
  const audioOptions = new TrackPublishOptions(); audioOptions.source = TrackSource.SOURCE_MICROPHONE;
  const videoOptions = new TrackPublishOptions();
  videoOptions.source = TrackSource.SOURCE_SCREENSHARE;
  videoOptions.videoEncoding = new VideoEncoding({ maxBitrate: BigInt(VIDEO_BITRATE_BPS), maxFramerate: VIDEO_FPS });
  audioOptions.audioEncoding = new AudioEncoding({ maxBitrate: BigInt(AUDIO_BITRATE_BPS) });
  const participant = room.localParticipant;
  if (!participant) throw new Error("LiveKit room connected without a local participant");
  await participant.publishTrack(audio, audioOptions);
  await participant.publishTrack(video, videoOptions);
  let tick = 0;
  let frames = 0;
  const staticFrame = new Uint8Array(VIDEO_WIDTH * VIDEO_HEIGHT * 3 / 2);
  for (let y = 0; y < VIDEO_HEIGHT; y += 1) {
    for (let x = 0; x < VIDEO_WIDTH; x += 1) {
      staticFrame[y * VIDEO_WIDTH + x] = ((x >> 4) ^ (y >> 4)) & 1 ? 74 : 148;
    }
  }
  const staticChromaStart = VIDEO_WIDTH * VIDEO_HEIGHT;
  staticFrame.fill(112, staticChromaStart, staticChromaStart + staticChromaStart / 4);
  staticFrame.fill(144, staticChromaStart + staticChromaStart / 4);
  const videoTimer = setInterval(() => {
    // Screen-like background plus independently moving noisy tiles. Full
    // frame noise needs ~1 MB/frame and a 1.5 Mbps encoder correctly drops to
    // ~1fps; a static slide does the opposite. This is moving content that can
    // sustain both the 30fps cadence and the intended bitrate ceiling.
    const pixels = new Uint8Array(staticFrame);
    let state = (tick + 1) * 0x9e3779b1;
    for (let tile = 0; tile < MOTION_TILES; tile += 1) {
      const left = (tile * 211 + tick * (17 + tile)) % (VIDEO_WIDTH - 160);
      const top = (tile * 97 + tick * (11 + tile)) % (VIDEO_HEIGHT - 120);
      for (let y = top; y < top + 120; y += 1) {
        for (let x = left; x < left + 160; x += 1) {
          state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
          pixels[y * VIDEO_WIDTH + x] = state & 255;
        }
      }
    }
    videoSource.captureFrame(new VideoFrame(pixels, VIDEO_WIDTH, VIDEO_HEIGHT, VideoBufferType.I420), BigInt(Date.now()) * 1000n);
    tick += 1; frames += 1;
  }, 1000 / VIDEO_FPS);
  let audioTick = 0;
  const audioTimer = setInterval(() => {
    const samples = new Int16Array(960);
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.round(8000 * Math.sin((audioTick * 960 + i) * Math.PI * 2 * 440 / 48_000));
    void audioSource.captureFrame(new AudioFrame(samples, 48_000, 1, 960)); audioTick += 1;
  }, 20);
  return { frames: () => frames, stop: async () => { clearInterval(videoTimer); clearInterval(audioTimer); await audio.close(); await video.close(); await audioSource.close(); await videoSource.close(); } };
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
async function one(index: number, presenter: boolean, decodeSample: boolean, safe: ReturnType<typeof assertSafeTarget>, roomInfo: Manifest, holdMs: number, startAtMs: number, acquireJoin: () => Promise<() => void>): Promise<ParticipantResult> {
  const result: ParticipantResult = { index, presenter, decodeSample, videoFrames: 0, audioFrames: 0, subscribedTracks: 0, disconnects: 0, flow: [] };
  let socket: WebSocket | undefined; let room: Room | undefined; let publisher: Awaited<ReturnType<typeof publish>> | undefined; let intentionalDisconnect = false; let releaseJoin: (() => void) | undefined;
  try {
    releaseJoin = await acquireJoin();
    const started = Date.now(); const token = tokenFor(safe.runId, index, safe.local);
    const joined = await appSession(safe.apiUrl, safe.wsUrl, token, roomInfo); socket = joined.socket; result.bootstrapMs = Date.now() - started; result.welcomeMs = joined.welcomeMs;
    const tokenStarted = Date.now(); const session = await mint(safe.apiUrl, token, roomInfo, joined.peerId, joined.resumeToken, safe.sfuHost); result.tokenMs = Date.now() - tokenStarted;
    room = new Room(); room.on(RoomEvent.TrackSubscribed, (track: any) => { result.subscribedTracks += 1; if (decodeSample) consume(track, result); }); room.on(RoomEvent.Disconnected, () => { if (!intentionalDisconnect) result.disconnects += 1; });
    const connected = Date.now(); await within("LiveKit connect", MEDIA_CONNECT_TIMEOUT_MS, room.connect(session.url, session.token, { autoSubscribe: true, dynacast: true })); result.rtcConnectedMs = Date.now() - connected; result.rtcConnectedAtMs = Date.now();
    releaseJoin(); releaseJoin = undefined;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAtMs - Date.now())));
    if (presenter) publisher = await publish(room);
    const collectFlow = () => void rtpStats(room!).then((stats) => result.flow.push({ atMs: Date.now() - startAtMs, bytesReceived: stats.bytesReceived, framesDecoded: stats.framesDecoded })).catch((error) => { result.failure ??= `RTP stats: ${error instanceof Error ? error.message : String(error)}`; });
    const flowTimer = setInterval(collectFlow, 5_000);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    clearInterval(flowTimer);
    result.rtp = await rtpStats(room);
    result.decodedVideoFps = result.rtp.framesDecoded / (holdMs / 1000);
    if (publisher) { result.sourceVideoFps = publisher.frames() / (holdMs / 1000); result.requestedVideoBitrateBps = VIDEO_BITRATE_BPS; }
    if (!presenter && (result.subscribedTracks < 2 || result.rtp.bytesReceived === 0)) throw new Error(`no received presenter RTP (tracks=${result.subscribedTracks}, bytes=${result.rtp.bytesReceived})`);
    if (decodeSample && !presenter && (result.videoFrames === 0 || result.audioFrames === 0)) throw new Error(`no decoded presenter media (video=${result.videoFrames}, audio=${result.audioFrames})`);
  } catch (error) { result.failure = error instanceof Error ? error.message : String(error); }
  finally { releaseJoin?.(); if (publisher) await publisher.stop(); intentionalDisconnect = true; if (room) await room.disconnect(); socket?.close(); }
  return result;
}
async function shard(safe: ReturnType<typeof assertSafeTarget>): Promise<void> {
  const info = manifest(safe); const shardIndex = integerArg("--shard-index", -1); const shardCount = numberArg("--shard-count", 0); const holdSeconds = numberArg("--hold-seconds", 900); const decodeSamples = numberArg("--decode-sample", safe.local ? 2 : 25); const startAtMs = Number(arg("--start-at-ms", safe.local ? String(Date.now() + 1_000) : "0"));
  const minDecodedFps = numberArg("--min-decoded-fps", 24);
  const holdIsAllowed = safe.local
    ? holdSeconds >= 5 && holdSeconds <= 60
    : safe.smoke
      ? holdSeconds >= 60 && holdSeconds <= 120
      : holdSeconds >= 600 && holdSeconds <= 900;
  if (shardIndex < 0 || shardCount < 1 || shardIndex >= shardCount || !holdIsAllowed || !Number.isFinite(startAtMs) || startAtMs < Date.now() + (safe.local ? 0 : 30_000)) throw new Error("valid shard indexes, a 5–60s local / 60–120s explicit staging smoke / 600–900s 500-person hold, and a shared start-at-ms at least 30s ahead are required");
  const indexes = Array.from({ length: info.participants }, (_, i) => i).filter((i) => i % shardCount === shardIndex);
  const decodedIndexes = new Set(indexes.filter((index) => index !== 0).slice(0, decodeSamples));
  const startedAt = Date.now(); const cpuStart = process.cpuUsage(); let maxRssBytes = process.memoryUsage().rss; let maxEventLoopLagMs = 0; let expectedTick = Date.now() + 1000;
  const sampler = setInterval(() => { maxRssBytes = Math.max(maxRssBytes, process.memoryUsage().rss); maxEventLoopLagMs = Math.max(maxEventLoopLagMs, Date.now() - expectedTick); expectedTick += 1000; }, 1000);
  const acquireJoin = joinGate(JOIN_CONCURRENCY);
  const results = await Promise.all(indexes.map((index) => one(index, index === 0, decodedIndexes.has(index), safe, info, holdSeconds * 1000, startAtMs, acquireJoin)));
  clearInterval(sampler);
  const wallMs = Date.now() - startedAt; const cpu = process.cpuUsage(cpuStart);
  const decoded = results.filter((result) => result.decodeSample);
  const totalReceivedBytes = results.reduce((sum, result) => sum + (result.rtp?.bytesReceived ?? 0), 0);
  const totalSentBytes = results.reduce((sum, result) => sum + (result.rtp?.bytesSent ?? 0), 0);
  const hasContinuousRtp = (result: ParticipantResult) => result.flow.length >= 2 && result.flow.slice(1).every((sample, at) => sample.bytesReceived > result.flow[at]!.bytesReceived);
  const report = {
    runId: safe.runId, host: hostname(), shardIndex, shardCount, expectedParticipants: info.participants, startAtMs,
    mediaContract: { source: `${VIDEO_WIDTH}x${VIDEO_HEIGHT}@${VIDEO_FPS}`, requestedVideoBitrateBps: VIDEO_BITRATE_BPS, requestedAudioBitrateBps: AUDIO_BITRATE_BPS, decodedSampleCount: decoded.length, minDecodedFps },
    generator: { wallMs, cpuMs: (cpu.user + cpu.system) / 1000, cpuPercentOfOneCore: ((cpu.user + cpu.system) / 1000 / wallMs) * 100, maxRssBytes, maxEventLoopLagMs },
    aggregateRtp: { receivedBytes: totalReceivedBytes, receivedBitrateBps: totalReceivedBytes * 8_000 / (holdSeconds * 1000), sentBytes: totalSentBytes, sentBitrateBps: totalSentBytes * 8_000 / (holdSeconds * 1000) },
    results,
    passed: results.every((result) => !result.failure && result.disconnects === 0 && (result.rtcConnectedAtMs ?? Infinity) <= startAtMs && (!result.presenter ? result.subscribedTracks >= 2 && (result.rtp?.bytesReceived ?? 0) > 0 && hasContinuousRtp(result) : (result.rtp?.outboundVideoFps ?? 0) >= VIDEO_FPS * 0.9) && (!result.decodeSample || result.presenter || (result.decodedVideoFps ?? 0) >= minDecodedFps)),
  };
  const out = requiredArg("--report"); writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); console.log(JSON.stringify({ report: out, passed: report.passed, failures: results.filter((r) => r.failure).length }, null, 2));
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
const command = process.argv[2] as Command;
if (!(["prepare", "shard", "cleanup"] as string[]).includes(command)) throw new Error("usage: run prepare|shard|cleanup");
const safe = assertSafeTarget();
try { if (command === "prepare") await prepare(safe); else if (command === "shard") await shard(safe); else await cleanup(safe); }
finally { await dispose(); }
