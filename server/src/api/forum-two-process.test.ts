import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

/**
 * TWO REAL API PROCESSES on the Postgres bus, the way production's two
 * replicas run (`CLUSTER_BUS=postgres`, one database, `read_cache` at its
 * default). Alice writes on api-a; Bob reads on api-b. Every forum frame Bob
 * gets on b could only have come over NOTIFY, which is what the two-graph
 * test (`ws/forum-cluster.test.ts`) cannot prove: the in-memory hub never
 * serialises a payload the way `pg_notify` does.
 *
 * The flag is a row flipped through the dashboard's door, never the
 * environment (pitfall 12).
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
  socket.send(JSON.stringify({ type: "auth", token }));
  await waitFor(() => frames.some((frame) => frame.type === "ready"), 10_000, "ready");
  socket.send(JSON.stringify({ type: "join-channel", channelId }));
  // The presence baseline is the server's answer to the join.
  await waitFor(
    () => frames.some((frame) => String(frame.type).startsWith("presence")),
    10_000,
    "the join",
  );
  return { socket, frames };
}

describeDb("forum frames between two API processes on the Postgres bus", () => {
  let a: Api | undefined;
  let b: Api | undefined;
  let forumId: string;
  let generalId: string;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    const db = await import("../db.js");
    await db.initDb();
    await db
      .getPool()
      .query(
        `TRUNCATE users, servers, channels, feature_flags, feature_flag_overrides,
                  feature_flag_audit
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
    const created = await createServer("Fórum", alice.id);
    await db
      .getPool()
      .query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [created.server.id, bob.id],
      );
    generalId = created.channels.find((channel) => channel.type === "text")!.id;
    forumId = (await createChannel(created.server.id, "ajuda", "forum")).id;
    await db.closePool();

    // One at a time: two boots running schema.sql at once contend for locks.
    a = await startApi("api-a");
    b = await startApi("api-b");

    const flip = await call(a, "PUT", "/api/admin/flags", TOKEN, {
      key: "forum_channels",
      enabled: true,
    });
    expect(flip.status).toBe(200);
    // B hears the flip over the bus, not its ten minute timer.
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

  it("a post, a reply and a delete on api-a all reach Bob on api-b", async () => {
    const reader = await openSocket(b!, BOB, forumId);
    const sidebar = await openSocket(b!, BOB, generalId);
    sockets.push(reader.socket, sidebar.socket);

    const created = await call<{ post: { id: string; title: string } }>(
      a!,
      "POST",
      `/api/channels/${forumId}/posts`,
      ALICE,
      { title: "Notebook não liga", body: "Já tentei de tudo", nonce: "two-process-1" },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const postId = created.body.post.id;

    await waitFor(
      () => reader.frames.some((f) => f.type === "forum-post-upsert" && f.post.id === postId),
      10_000,
      "the new post's row on api-b",
    );
    expect(
      reader.frames.find((f) => f.type === "forum-post-upsert")!.post.title,
    ).toBe("Notebook não liga");
    // The sidebar socket is not looking at the forum: it gets the dot.
    await waitFor(
      () =>
        sidebar.frames.some(
          (f) => f.type === "channel-activity" && f.channelId === forumId,
        ),
      10_000,
      "the forum's activity frame on api-b",
    );

    // A reply on A bumps the post; the fresh row (one reply) reaches B.
    const replier = await openSocket(a!, ALICE, postId);
    sockets.push(replier.socket);
    replier.socket.send(
      JSON.stringify({ type: "message-create", channelId: postId, body: "Tenta segurar o botão 30 s" }),
    );
    await waitFor(
      () =>
        reader.frames.some(
          (f) => f.type === "forum-post-upsert" && f.post.id === postId && f.post.replyCount === 1,
        ),
      10_000,
      "the bumped row on api-b",
    );

    // Bob reads the post on B; staff deletes it on A; both B sockets hear it.
    const postReader = await openSocket(b!, BOB, postId);
    sockets.push(postReader.socket);
    const deleted = await call(a!, "DELETE", `/api/forum-posts/${postId}`, ALICE);
    expect(deleted.status).toBe(204);
    const removed = { type: "forum-post-removed", forumId, postId };
    await waitFor(
      () => reader.frames.some((f) => f.type === "forum-post-removed"),
      10_000,
      "the removal on the forum, api-b",
    );
    await waitFor(
      () => postReader.frames.some((f) => f.type === "forum-post-removed"),
      10_000,
      "the removal on the open post, api-b",
    );
    expect(reader.frames.filter((f) => f.type === "forum-post-removed")).toEqual([removed]);

    // And B's own read agrees.
    const list = await call<{ posts: unknown[] }>(b!, "GET", `/api/channels/${forumId}/posts`, BOB);
    expect(list.body.posts).toEqual([]);
  }, 60_000);
});
