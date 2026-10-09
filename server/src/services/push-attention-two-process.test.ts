import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

/**
 * THE PUSH ATTENTION GATE ACROSS TWO REAL API PROCESSES, configured the way
 * production's two replicas are: `CLUSTER_BUS=postgres`, `VOICE_REGISTRY=postgres`,
 * one database.
 *
 * Bob's only socket is on A. Alice writes to him from a socket on B, so the
 * push decision runs on B (pushes fire on the origin instance only) and the
 * only way B can know what Bob's socket said is the status snapshot crossing
 * the Postgres bus. The flag is flipped on A through the dashboard's machine
 * token, so B can only learn it from the bus too (both run a ten minute flag
 * TTL).
 *
 * The decision is read off B's log: every refusal is a `push.skipped` line
 * with its reason (`push-skips.ts`), and Bob has no device on file, so being
 * let past the socket rule ends as `reason=no_subscription` with nothing sent
 * to any vendor. Three distinct reasons, so the per-reason log rate limit
 * never hides one.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(SERVER_DIR, "node_modules", ".bin", "tsx");
const TOKEN = "beadbeadbeadbeadbeadbeadbeadbead";

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

interface Api {
  name: string;
  port: number;
  child: ChildProcess;
  log: string[];
}

async function startApi(name: string): Promise<Api> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DATABASE_URL,
    CLUSTER_BUS: "postgres",
    VOICE_REGISTRY: "postgres",
    DEV_AUTH_BYPASS: "true",
    DEV_SEED: "false",
    NODE_ENV: "development",
    ADMIN_METRICS_TOKEN: TOKEN,
    FEATURE_FLAGS_TTL_MS: String(10 * 60_000),
    // A push leg has to exist or the pipeline returns before deciding
    // anything. Nobody has a subscription, so nothing is ever sent with these.
    VAPID_PUBLIC_KEY: "test-public-key",
    VAPID_PRIVATE_KEY: "test-private-key",
    VAPID_SUBJECT: "mailto:push@example.test",
    APNS_KEY_ID: "",
    FCM_PROJECT_ID: "",
    // The environment must not be what turns the gate on.
    PUSH_ATTENTION_GATE: "",
    LIVEKIT_URL: "",
    LIVE_HLS_ENABLED: "",
    S3_BUCKET: "",
    WORKER_MODE: "",
  };
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;
  const child = spawn(TSX, ["src/index.ts"], {
    cwd: SERVER_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  const api = { name, port, child, log };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${name} exited during boot:\n${log.join("")}`);
    }
    const ok = await fetch(`http://127.0.0.1:${port}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ok && log.join("").includes("flags.started")) {
      return api;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${name} never became healthy:\n${log.join("")}`);
}

async function stopApi(api: Api | undefined): Promise<void> {
  if (!api || api.child.exitCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => api.child.once("exit", () => resolve()));
  api.child.kill("SIGTERM");
  const timer = setTimeout(() => api.child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

async function openSocket(port: number, token: string) {
  const frames: Array<Record<string, unknown>> = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  socket.on("message", (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    } catch {
      // not JSON: not ours
    }
  });
  socket.send(JSON.stringify({ type: "auth", token }));
  await waitFor(() => frames.some((frame) => frame.type === "ready"), 10_000, "ready");
  return { socket, frames };
}

async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeDb("push attention gate across two API processes", () => {
  let a: Api | undefined;
  let b: Api | undefined;
  let dmChannelId: string;
  let bobId: string;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    const db = await import("../db.js");
    await db.initDb();
    await db
      .getPool()
      .query(
        `TRUNCATE users, servers, channels, feature_flags, feature_flag_overrides,
                  feature_flag_audit, push_subscriptions
         RESTART IDENTITY CASCADE`,
      );
    const { upsertUser } = await import("./users.js");
    const { createServer } = await import("./servers.js");
    const { openConversation } = await import("./dms.js");
    const alice = await upsertUser({ clerkId: "dev_local_user_alice", displayName: "Alice", avatarUrl: null });
    const bob = await upsertUser({ clerkId: "dev_local_user_bob", displayName: "Bob", avatarUrl: null });
    bobId = bob.id;
    await db.getPool().query(`UPDATE users SET age_checked_at = NOW(), age_check_passed = TRUE`);
    const { server } = await createServer("Casa", alice.id);
    await db
      .getPool()
      .query(`INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`, [server.id, bob.id]);
    dmChannelId = (await openConversation(alice.id, [bob.id])).channelId;
    await db.closePool();

    [a, b] = await Promise.all([startApi("api-a"), startApi("api-b")]);
  }, 150_000);

  afterAll(async () => {
    for (const socket of sockets) {
      socket.close();
    }
    await Promise.all([stopApi(a), stopApi(b)]);
  }, 30_000);

  /**
   * Alice keeps writing from B until B's log shows `reason` for Bob: the status
   * snapshot and the flag both cross the bus asynchronously, so the first
   * message after a change may still be decided on the old state.
   */
  async function decidedOnB(
    alice: Awaited<ReturnType<typeof openSocket>>,
    reason: string,
  ): Promise<void> {
    const line = `push.skipped kind=message reason=${reason} userId=${bobId}`;
    const deadline = Date.now() + 15_000;
    let sent = 0;
    while (!b!.log.join("").includes(line)) {
      if (Date.now() > deadline) {
        throw new Error(`B never decided ${reason} after ${sent} messages:\n${b!.log.join("").slice(-4000)}`);
      }
      alice.socket.send(
        JSON.stringify({ type: "message-create", channelId: dmChannelId, body: `oi ${sent}` }),
      );
      sent += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  async function setGate(enabled: boolean): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${a!.port}/api/admin/flags`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ key: "push_attention_gate", enabled }),
    });
    expect(response.status).toBe(200);
  }

  it("a foreground socket on A suppresses B's push only while it is foreground", async () => {
    const bob = await openSocket(a!.port, "dev-local-token:bob");
    const alice = await openSocket(b!.port, "dev-local-token:alice");
    sockets.push(bob.socket, alice.socket);
    alice.socket.send(JSON.stringify({ type: "join-channel", channelId: dmChannelId }));

    // Gate off (no row): Bob's backgrounded socket still silences him, which
    // is the bug this gate exists for.
    bob.socket.send(JSON.stringify({ type: "set-attention", foreground: false }));
    await decidedOnB(alice, "live_socket");

    // Gate on, flipped on A. Bob comes to the front on A: B suppresses.
    await setGate(true);
    bob.socket.send(JSON.stringify({ type: "set-attention", foreground: true }));
    await decidedOnB(alice, "attentive_socket");

    // Bob puts the app in the background on A: B lets the push through. He
    // has no device, so the pipeline ends at the subscription lookup, which is
    // only reached past the socket rule.
    bob.socket.send(JSON.stringify({ type: "set-attention", foreground: false }));
    await decidedOnB(alice, "no_subscription");
  }, 60_000);
});
