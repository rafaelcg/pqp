/* eslint-disable no-console -- this is a command-line load harness. */
import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { Client as PgClient } from "pg";
import { WebSocket } from "ws";
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
  videoFrames: number;
  audioFrames: number;
  subscribedTracks: number;
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
function assertSafeTarget(): { runId: string; apiUrl: string; wsUrl: string; sfuHost: string; local: boolean } {
  const runId = need("TEST_RUN_ID");
  if (!/^[a-z0-9][a-z0-9-]{2,48}$/.test(runId)) throw new Error("TEST_RUN_ID must be a lowercase, traceable run id");
  const target = need("PQP_LOAD_TARGET");
  if (target !== "staging" && target !== "local") throw new Error("PQP_LOAD_TARGET must be staging or local");
  const local = target === "local";
  const apiUrl = process.env.PQP_LOAD_API_URL ?? (local ? "http://localhost:3001" : STAGING_API);
  const wsUrl = process.env.PQP_LOAD_WS_URL ?? (local ? "ws://localhost:3001/ws" : STAGING_WS);
  const api = new URL(apiUrl);
  const ws = new URL(wsUrl);
  if (!local && (api.origin !== STAGING_API || ws.href.replace(/\/$/, "") !== STAGING_WS)) throw new Error("only the exact pqp staging API and WebSocket are allowed");
  if (local && (!["localhost", "127.0.0.1", "::1"].includes(api.hostname) || !["localhost", "127.0.0.1", "::1"].includes(ws.hostname))) throw new Error("local runs may only use loopback API and WebSocket hosts");
  const sfuHost = need("PQP_LOAD_SFU_HOST").toLowerCase();
  if (PROD_HOSTS.has(sfuHost) || sfuHost.endsWith(".pqp.gg")) throw new Error("production SFU hosts are forbidden");
  if (local && !["localhost", "127.0.0.1", "::1"].includes(sfuHost)) throw new Error("local runs may only use a loopback SFU host");
  return { runId, apiUrl, wsUrl, sfuHost, local };
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
  if (total !== 500 && !(safe.local && total >= 2 && total <= 5)) throw new Error("hosted runs require exactly 500 participants; local smoke permits 2–5");
  const owner = tokenFor(safe.runId, "owner", safe.local);
  await passAgeGate(safe.apiUrl, owner);
  const created = await api<{ server: { id: string }; channels: Array<{ id: string; type: string }> }>(safe.apiUrl, owner, "POST", "/api/servers", { name: `Load ${safe.runId}` });
  const text = created.channels.find((channel) => channel.type === "text");
  const voice = created.channels.find((channel) => channel.type === "voice");
  if (!text || !voice) throw new Error("created server is missing default text or voice channel");
  await api(safe.apiUrl, owner, "PATCH", `/api/channels/${voice.id}`, { voiceTransport: "livekit" });
  const invite = await api<{ invite: { code: string } }>(safe.apiUrl, owner, "POST", `/api/servers/${created.server.id}/invites`, {});
  const manifest: Manifest = { version: 1, runId: safe.runId, apiUrl: safe.apiUrl, wsUrl: safe.wsUrl, participants: total, serverId: created.server.id, textChannelId: text.id, voiceChannelId: voice.id, inviteCode: invite.invite.code, createdAt: new Date().toISOString() };
  writeFileSync(requiredArg("--manifest"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ prepared: true, manifest: arg("--manifest"), runId: safe.runId, participants: total }, null, 2));
}
function manifest(safe: ReturnType<typeof assertSafeTarget>): Manifest {
  const parsed = JSON.parse(readFileSync(requiredArg("--manifest"), "utf8")) as Manifest;
  if (parsed.version !== 1 || parsed.runId !== safe.runId || parsed.apiUrl !== safe.apiUrl || parsed.wsUrl !== safe.wsUrl || (parsed.participants !== 500 && !(safe.local && parsed.participants >= 2 && parsed.participants <= 5))) throw new Error("manifest does not match this allowed run");
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
async function publish(room: Room): Promise<() => Promise<void>> {
  const audioSource = new AudioSource(48_000, 1);
  const videoSource = new VideoSource(320, 180);
  const audio = LocalAudioTrack.createAudioTrack("load-audio", audioSource);
  const video = LocalVideoTrack.createVideoTrack("load-video", videoSource);
  const audioOptions = new TrackPublishOptions(); audioOptions.source = TrackSource.SOURCE_MICROPHONE;
  const videoOptions = new TrackPublishOptions(); videoOptions.source = TrackSource.SOURCE_SCREENSHARE;
  const participant = room.localParticipant;
  if (!participant) throw new Error("LiveKit room connected without a local participant");
  await participant.publishTrack(audio, audioOptions);
  await participant.publishTrack(video, videoOptions);
  let tick = 0;
  const timer = setInterval(() => {
    const pixels = new Uint8Array(320 * 180 * 4);
    for (let y = 0; y < 180; y += 1) for (let x = 0; x < 320; x += 1) { const p = (y * 320 + x) * 4; pixels[p] = (x + tick) & 255; pixels[p + 1] = (y * 2 + tick) & 255; pixels[p + 2] = (x ^ y ^ tick) & 255; pixels[p + 3] = 255; }
    videoSource.captureFrame(new VideoFrame(pixels, 320, 180, VideoBufferType.RGBA));
    const samples = new Int16Array(960); for (let i = 0; i < samples.length; i += 1) samples[i] = Math.round(8000 * Math.sin((tick * 960 + i) * Math.PI * 2 * 440 / 48_000));
    void audioSource.captureFrame(new AudioFrame(samples, 48_000, 1, 960)); tick += 1;
  }, 20);
  return async () => { clearInterval(timer); await audio.close(); await video.close(); await audioSource.close(); await videoSource.close(); };
}
async function one(index: number, presenter: boolean, safe: ReturnType<typeof assertSafeTarget>, roomInfo: Manifest, holdMs: number): Promise<ParticipantResult> {
  const result: ParticipantResult = { index, presenter, videoFrames: 0, audioFrames: 0, subscribedTracks: 0 };
  let socket: WebSocket | undefined; let room: Room | undefined; let stopPublisher: (() => Promise<void>) | undefined;
  try {
    const started = Date.now(); const token = tokenFor(safe.runId, index, safe.local);
    const joined = await appSession(safe.apiUrl, safe.wsUrl, token, roomInfo); socket = joined.socket; result.bootstrapMs = Date.now() - started; result.welcomeMs = joined.welcomeMs;
    const tokenStarted = Date.now(); const session = await mint(safe.apiUrl, token, roomInfo, joined.peerId, joined.resumeToken, safe.sfuHost); result.tokenMs = Date.now() - tokenStarted;
    room = new Room(); room.on(RoomEvent.TrackSubscribed, (track: any) => { result.subscribedTracks += 1; consume(track, result); });
    const connected = Date.now(); await within("LiveKit connect", MEDIA_CONNECT_TIMEOUT_MS, room.connect(session.url, session.token, { autoSubscribe: true, dynacast: true })); result.rtcConnectedMs = Date.now() - connected;
    if (presenter) stopPublisher = await publish(room);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    if (!presenter && (result.videoFrames === 0 || result.audioFrames === 0)) throw new Error(`no decoded presenter media (video=${result.videoFrames}, audio=${result.audioFrames})`);
  } catch (error) { result.failure = error instanceof Error ? error.message : String(error); }
  finally { if (stopPublisher) await stopPublisher(); if (room) await room.disconnect(); socket?.close(); }
  return result;
}
async function shard(safe: ReturnType<typeof assertSafeTarget>): Promise<void> {
  const info = manifest(safe); const shardIndex = integerArg("--shard-index", -1); const shardCount = numberArg("--shard-count", 0); const holdSeconds = numberArg("--hold-seconds", 900);
  const holdIsAllowed = safe.local
    ? holdSeconds >= 5 && holdSeconds <= 60
    : holdSeconds >= 600 && holdSeconds <= 900;
  if (shardIndex < 0 || shardCount < 1 || shardIndex >= shardCount || !holdIsAllowed) throw new Error("valid shard indexes and a 5–60 second local or 600–900 second hosted hold are required");
  const indexes = Array.from({ length: info.participants }, (_, i) => i).filter((i) => i % shardCount === shardIndex);
  const results = await Promise.all(indexes.map((index) => one(index, index === 0, safe, info, holdSeconds * 1000)));
  const report = { runId: safe.runId, host: hostname(), shardIndex, shardCount, expectedParticipants: info.participants, results, passed: results.every((r) => !r.failure && (r.presenter || (r.videoFrames > 0 && r.audioFrames > 0))) };
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
