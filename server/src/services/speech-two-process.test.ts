import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

/**
 * THE PRODUCTION SHAPE, AS PROCESSES: an API (`WORKER_MODE=api`) and a worker
 * (`WORKER_MODE=worker`, `node worker.js`'s own entry point), both with
 * `CLUSTER_BUS=postgres`, one database, one bucket. Alice sends a voice note
 * in a conversation through the API; the API only queues the job (it has no
 * provider and runs no jobs); the worker is woken by the NOTIFY, downloads the
 * bytes, runs the replay provider and publishes the transcript; and the frame
 * reaches Bob's socket ON THE API, which only the bus relay could have
 * delivered, because the worker holds no sockets at all.
 *
 * Pitfall 12 is why this is processes and not a mock: the frame starts in a
 * process with no `/ws`, and a single-process test passes whether or not the
 * frame type is on the relay's allowlist (`CHAT_SERVER_MESSAGE_TYPES`).
 *
 * The flags are rows (`PUT /api/admin/flags` with the machine token), never
 * the environment. Storage is a tiny S3 stand-in in this process that keeps
 * what is PUT and answers HEAD and ranged GET, ignoring signatures.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(SERVER_DIR, "node_modules", ".bin", "tsx");
const TOKEN = "facefeedfacefeedfacefeedfacefeed";
const WEBM = readFileSync(join(SERVER_DIR, "src", "speech", "fixtures", "note.webm"));
const WAVEFORM = Buffer.alloc(64, 100).toString("base64");
const SPOKEN = "chego em dez minutos";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** PUT, HEAD, ranged GET and DELETE on path-style keys. Nothing else. */
function startFakeBucket(port: number): Promise<{ server: Server; objects: Map<string, { type: string; body: Buffer }> }> {
  const objects = new Map<string, { type: string; body: Buffer }>();
  const server = createHttpServer((req, res) => {
    const key = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        objects.set(key, { type: String(req.headers["content-type"] ?? ""), body: Buffer.concat(chunks) });
        res.writeHead(200).end();
      });
      return;
    }
    const object = objects.get(key);
    if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204).end();
      return;
    }
    if (!object) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Length": object.body.length, "Content-Type": object.type }).end();
      return;
    }
    const range = /bytes=(\d+)-(\d+)/.exec(String(req.headers.range ?? ""));
    const body = range ? object.body.subarray(Number(range[1]), Number(range[2]) + 1) : object.body;
    res.writeHead(range ? 206 : 200, { "Content-Length": body.length, "Content-Type": object.type }).end(body);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, objects })));
}

interface Proc {
  name: string;
  port: number;
  child: ChildProcess;
  log: string[];
}

async function startProcess(
  name: string,
  entry: string,
  env: NodeJS.ProcessEnv,
  readyWhen: string,
): Promise<Proc> {
  const port = await freePort();
  const full: NodeJS.ProcessEnv = { ...process.env, ...env, PORT: String(port) };
  delete full.VITEST;
  delete full.VITEST_WORKER_ID;
  delete full.VITEST_POOL_ID;
  const child = spawn(TSX, [entry], { cwd: SERVER_DIR, env: full, stdio: ["ignore", "pipe", "pipe"] });
  const log: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  const proc = { name, port, child, log };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${name} exited during boot:\n${log.join("")}`);
    }
    const ok = await fetch(`http://127.0.0.1:${port}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ok && log.join("").includes(readyWhen)) {
      return proc;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${name} never became ready:\n${log.join("")}`);
}

async function stopProcess(proc: Proc | undefined): Promise<void> {
  if (!proc || proc.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.child.once("exit", () => resolve()));
  proc.child.kill("SIGTERM");
  const timer = setTimeout(() => proc.child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

/** A signed-in socket that has joined one channel, keeping every frame. */
async function openSocket(port: number, token: string, channelId: string) {
  const frames: Array<Record<string, any>> = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  socket.on("message", (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()));
    } catch {
      // not JSON: not ours
    }
  });
  socket.send(JSON.stringify({ type: "auth", token }));
  await waitFor(() => frames.some((frame) => frame.type === "ready"), 10_000, "ready");
  socket.send(JSON.stringify({ type: "join-channel", channelId }));
  return { socket, frames };
}

async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeDb("voice note transcription across an API and a worker process", () => {
  let api: Proc | undefined;
  let worker: Proc | undefined;
  let bucket: Awaited<ReturnType<typeof startFakeBucket>> | undefined;
  let dmChannelId: string;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    const db = await import("../db.js");
    await db.initDb();
    await db
      .getPool()
      .query(
        `TRUNCATE users, servers, channels, feature_flags, feature_flag_overrides,
                  feature_flag_audit, speech_jobs, speech_usage_daily
         RESTART IDENTITY CASCADE`,
      );
    // The two dev-bypass accounts, made here so they can share a server
    // (a conversation needs something in common) before either process runs.
    const { upsertUser } = await import("./users.js");
    const { createServer } = await import("./servers.js");
    const { openConversation } = await import("./dms.js");
    const alice = await upsertUser({ clerkId: "dev_local_user_alice", displayName: "Alice", avatarUrl: null });
    const bob = await upsertUser({ clerkId: "dev_local_user_bob", displayName: "Bob", avatarUrl: null });
    await db.getPool().query(`UPDATE users SET age_checked_at = NOW(), age_check_passed = TRUE`);
    const { server } = await createServer("Voz", alice.id);
    await db
      .getPool()
      .query(`INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`, [server.id, bob.id]);
    dmChannelId = (await openConversation(alice.id, [bob.id])).channelId;
    await db.closePool();

    const bucketPort = await freePort();
    bucket = await startFakeBucket(bucketPort);
    const shared: NodeJS.ProcessEnv = {
      DATABASE_URL,
      CLUSTER_BUS: "postgres",
      VOICE_REGISTRY: "postgres",
      DEV_AUTH_BYPASS: "true",
      DEV_SEED: "false",
      NODE_ENV: "development",
      ADMIN_METRICS_TOKEN: TOKEN,
      S3_ENDPOINT: `http://127.0.0.1:${bucketPort}`,
      S3_BUCKET: "voice",
      S3_REGION: "auto",
      S3_ACCESS_KEY_ID: "test",
      S3_SECRET_ACCESS_KEY: "test",
      S3_FORCE_PATH_STYLE: "true",
      S3_PUBLIC_BASE_URL: "",
      CONTENT_SCAN_PROVIDER: "",
      LIVEKIT_URL: "",
      LIVE_HLS_ENABLED: "",
      VOICE_NOTES: "",
      VOICE_NOTE_TRANSCRIPTION: "",
      VOICE_STT_DAILY_SECONDS: "",
      // Transcoding is not what this test is about, and whether a machine has
      // ffmpeg must not decide whether it passes.
      FFMPEG_PATH: "/nonexistent/ffmpeg",
    };
    api = await startProcess(
      "api",
      "src/index.ts",
      { ...shared, WORKER_MODE: "api", VOICE_STT_PROVIDER: "" },
      "flags.started",
    );

    // On through the dashboard's door: rows, not environment.
    for (const key of ["voice_notes", "voice_note_transcription"]) {
      const response = await fetch(`http://127.0.0.1:${api.port}/api/admin/flags`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ key, enabled: true }),
      });
      expect(response.status).toBe(200);
    }

    worker = await startProcess(
      "worker",
      "src/worker.ts",
      {
        ...shared,
        WORKER_MODE: "worker",
        VOICE_STT_PROVIDER: "replay",
        VOICE_STT_REPLAY_TEXT: SPOKEN,
      },
      "job(s) scheduled",
    );
  }, 150_000);

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await Promise.all([stopProcess(api), stopProcess(worker)]);
    await new Promise<void>((resolve) => (bucket ? bucket.server.close(() => resolve()) : resolve()));
  }, 30_000);

  it("the API queues, the worker transcribes, and Bob's socket on the API gets the text", async () => {
    const bob = await openSocket(api!.port, "dev-local-token:bob", dmChannelId);
    const alice = await openSocket(api!.port, "dev-local-token:alice", dmChannelId);
    sockets.push(bob.socket, alice.socket);

    // Mint, upload, send: exactly what a recorder does.
    const minted = await fetch(`http://127.0.0.1:${api!.port}/api/channels/${dmChannelId}/attachments`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-local-token:alice", "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "voice.webm",
        contentType: "audio/webm",
        byteSize: WEBM.length,
        voice: { durationMs: 1_500, waveform: WAVEFORM },
      }),
    });
    expect(minted.status, await minted.clone().text()).toBe(201);
    const { attachmentId, uploadUrl } = (await minted.json()) as { attachmentId: string; uploadUrl: string };
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "audio/webm", "Content-Length": String(WEBM.length) },
      body: WEBM,
    });
    expect(put.status).toBe(200);
    alice.socket.send(
      JSON.stringify({ type: "message-create", channelId: dmChannelId, body: "", attachmentIds: [attachmentId] }),
    );

    await waitFor(() => bob.frames.some((frame) => frame.type === "message-broadcast"), 10_000, "the message");
    const message = bob.frames.find((frame) => frame.type === "message-broadcast")!.message;
    expect(message.attachments[0].voice.transcript).toEqual({ status: "pending", text: null, language: null });

    await waitFor(
      () => bob.frames.some((frame) => frame.type === "voice-note-transcript"),
      20_000,
      `the transcript frame (worker log:\n${worker!.log.join("")})`,
    );
    const frame = bob.frames.find((candidate) => candidate.type === "voice-note-transcript")!;
    expect(frame).toEqual({
      type: "voice-note-transcript",
      channelId: dmChannelId,
      messageId: message.id,
      attachmentId,
      transcript: { status: "done", text: SPOKEN, language: "pt" },
    });

    // And the API serves the stored text to a fresh read, to either side.
    const history = await fetch(`http://127.0.0.1:${api!.port}/api/channels/${dmChannelId}/messages`, {
      headers: { Authorization: "Bearer dev-local-token:alice" },
    });
    const body = (await history.json()) as { messages?: Array<Record<string, any>> } | Array<Record<string, any>>;
    const messages = Array.isArray(body) ? body : (body.messages ?? []);
    const stored = messages.find((candidate) => candidate.id === message.id)!;
    expect(stored.attachments[0].voice.transcript).toEqual({ status: "done", text: SPOKEN, language: "pt" });

    // Only the worker ran it: the API runs no jobs and has no provider.
    expect(api!.log.join("")).not.toContain("voiceNote.transcription");
    expect(worker!.log.join("")).toContain("bus.enabled");
  }, 60_000);
});
