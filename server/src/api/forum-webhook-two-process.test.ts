import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

/**
 * Forum PR 4 on TWO REAL API PROCESSES, the shape of `forum-two-process.test.ts`
 * (`CLUSTER_BUS=postgres`, one database, the flag flipped through the
 * dashboard's door). Two things only a real pair can prove:
 *
 *  - a webhook post made on api-a reaches a forum viewer on api-b over NOTIFY;
 *  - the webhook post bucket is ONE budget across machines (`sharedRateLimit`
 *    in Postgres): ten posts in all, alternating machines, and the eleventh
 *    is refused on either one, while each machine's own execute limiter (20
 *    burst) never trips.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(SERVER_DIR, "node_modules", ".bin", "tsx");
const TOKEN = "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";
const ALICE = "dev-local-token:alice";
const BOB = "dev-local-token:bob";

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
    FORUM_CHANNELS: "",
    READ_CACHE: "",
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
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${name} exited during boot:\n${log.join("")}`);
    }
    const ok = await fetch(`http://127.0.0.1:${port}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ok && log.join("").includes("flags.started")) {
      return { name, port, child, log };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // Not returned, so nothing else will ever stop it.
  child.kill("SIGKILL");
  throw new Error(`${name} never became healthy:\n${log.join("")}`);
}

async function stopApi(api: Api | undefined): Promise<void> {
  if (!api || api.child.exitCode !== null || api.child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => api.child.once("exit", () => resolve()));
  api.child.kill("SIGTERM");
  const timer = setTimeout(() => api.child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

async function call<T = Record<string, unknown>>(
  api: Api,
  method: string,
  path: string,
  auth: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`http://127.0.0.1:${api.port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
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

type Frame = Record<string, any>;

/** A signed-in socket that has joined one channel, keeping every frame. */
async function openSocket(api: Api, token: string, channelId: string) {
  const frames: Frame[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${api.port}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  socket.on("message", (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()) as Frame);
    } catch {
      // not JSON: not ours
    }
  });
  try {
    socket.send(JSON.stringify({ type: "auth", token }));
    await waitFor(() => frames.some((frame) => frame.type === "ready"), 10_000, "ready");
    socket.send(JSON.stringify({ type: "join-channel", channelId }));
    // The presence baseline is the server's answer to the join.
    await waitFor(
      () => frames.some((frame) => String(frame.type).startsWith("presence")),
      10_000,
      "the join",
    );
  } catch (error) {
    socket.close();
    throw error;
  }
  return { socket, frames };
}

async function execute(
  api: Api,
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Frame; headers: Headers }> {
  const response = await fetch(`http://127.0.0.1:${api.port}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Frame,
    headers: response.headers,
  };
}

describeDb("forum webhooks between two API processes on the Postgres bus", () => {
  let a: Api | undefined;
  let b: Api | undefined;
  let forumId: string;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    const db = await import("../db.js");
    await db.initDb();
    await db
      .getPool()
      .query(
        `TRUNCATE users, servers, channels, feature_flags, feature_flag_overrides,
                  feature_flag_audit, rate_limit_buckets
         RESTART IDENTITY CASCADE`,
      );
    const { upsertUser } = await import("../services/users.js");
    const { createServer, createChannel } = await import("../services/servers.js");
    const alice = await upsertUser({
      clerkId: "dev_local_user_alice",
      displayName: "Alice",
      avatarUrl: null,
    });
    const bob = await upsertUser({
      clerkId: "dev_local_user_bob",
      displayName: "Bob",
      avatarUrl: null,
    });
    await db
      .getPool()
      .query(`UPDATE users SET age_checked_at = NOW(), age_check_passed = TRUE`);
    const created = await createServer("Feeds", alice.id);
    await db
      .getPool()
      .query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [created.server.id, bob.id],
      );
    forumId = (await createChannel(created.server.id, "noticias", "forum")).id;
    await db.closePool();

    a = await startApi("api-a");
    b = await startApi("api-b");

    const flip = await call(a, "PUT", "/api/admin/flags", TOKEN, {
      key: "forum_channels",
      enabled: true,
    });
    expect(flip.status).toBe(200);
    const deadline = Date.now() + 5_000;
    for (;;) {
      const config = await call<{ enabled: boolean }>(b, "GET", "/api/forum/config", BOB);
      if (config.body.enabled || Date.now() > deadline) {
        expect(config.body.enabled).toBe(true);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, 150_000);

  afterAll(async () => {
    for (const socket of sockets) {
      socket.close();
    }
    await Promise.all([stopApi(a), stopApi(b)]);
  }, 30_000);

  it("a webhook post on api-a reaches a forum viewer on api-b", async () => {
    const reader = await openSocket(b!, BOB, forumId);
    sockets.push(reader.socket);
    const hook = await call<{ webhook: { url: string } }>(
      a!,
      "POST",
      `/api/channels/${forumId}/webhooks`,
      ALICE,
      { name: "RSS" },
    );
    expect(hook.status).toBe(201);

    const answer = await execute(a!, hook.body.webhook.url, {
      content: "Saiu o patch https://jogo.example.com/patch",
      thread_name: "Patch 1.4.2",
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const postId = answer.body.post.id as string;
    await waitFor(
      () =>
        reader.frames.some(
          (f) => f.type === "forum-post-upsert" && f.post.id === postId && f.post.authorIsWebhook,
        ),
      10_000,
      "the webhook post's row on api-b",
    );
  }, 60_000);

  it("the post bucket is one budget for both machines: 10 in all, the 11th refused", async () => {
    const hook = await call<{ webhook: { url: string } }>(
      a!,
      "POST",
      `/api/channels/${forumId}/webhooks`,
      ALICE,
      { name: "Feed" },
    );
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      // Alternate machines: each one's own limiter (20 burst) never trips.
      const api = i % 2 === 0 ? a! : b!;
      const answer = await execute(api, hook.body.webhook.url, {
        content: `item ${i}`,
        thread_name: `Item ${i}`,
      });
      statuses.push(answer.status);
    }
    expect(statuses).toEqual(Array.from({ length: 10 }, () => 200));
    for (const api of [a!, b!]) {
      const refused = await execute(api, hook.body.webhook.url, {
        content: `item extra ${api.name}`,
        thread_name: `Item extra ${api.name}`,
      });
      expect(refused.status).toBe(429);
      expect(refused.body.retry_after).toBe(60);
      expect(refused.headers.get("Retry-After")).toBe("60");
    }
  }, 60_000);
});
