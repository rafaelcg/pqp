import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BusFrame } from "../lib/bus.js";
import {
  createPostgresBusTransport,
  type PostgresBusTransport,
} from "../lib/bus-postgres.js";

/**
 * TWO REAL API PROCESSES, configured the way production's two replicas are:
 * `CLUSTER_BUS=postgres` and `VOICE_REGISTRY=postgres`, one database. An
 * operator's apps write goes to A through the dashboard's machine token and
 * the test asks two questions of what happened:
 *
 *  - B's own operator read shows the write (no per-process copy of the apps
 *    tables, so the dashboard behind a load balancer cannot show two answers);
 *  - an `apps.changed` frame arrives on the cluster bus for each committed
 *    change and for nothing else, which is the hint a sibling's availability
 *    cache drops on. The test process listens on the same Postgres bus as a
 *    third instance and sees exactly what B would.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(SERVER_DIR, "node_modules", ".bin", "tsx");
const TOKEN = "feedfacefeedfacefeedfacefeedface";
const SHA = "a".repeat(64);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
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
    // Nothing here needs a media server or storage; empty beats whatever a
    // developer's .env points at (dotenv never overrides a set variable).
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
    if (ok && log.join("").includes("bus.enabled")) {
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

async function call<T>(
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

const manifest = {
  manifestVersion: 1,
  id: "enquete",
  version: "1.0.0",
  publisher: "pqp",
  platformApi: 1,
  name: "name",
  description: "description",
  icon: "gamepad",
  category: "tool",
  channelTypes: ["text", "voice"],
  players: { min: 1, max: 4, spectators: true, maxSpectators: 50 },
  requires: { start: "USE_APPS", join: "VIEW_CHANNEL" },
  capabilities: { identity: "display", share: "none", localFiles: { allowed: false }, peer: "none" },
  content: { userText: false, userImages: false },
  license: { spdx: "AGPL-3.0-only", source: "https://github.com/rafaelcg/pqp" },
  i18n: {
    "pt-BR": { name: "Enquete", description: "Enquete ao vivo" },
    en: { name: "Poll", description: "A live poll" },
    es: { name: "Encuesta", description: "Una encuesta" },
  },
};

describeDb("an apps write on one API process, seen from the other and on the bus", () => {
  let a: Api | undefined;
  let b: Api | undefined;
  let serverId = "";
  const frames: BusFrame[] = [];
  let observer: PostgresBusTransport | undefined;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    const db = await import("../db.js");
    await db.initDb();
    const pool = db.getPool();
    await pool.query(`DELETE FROM apps`);
    await pool.query(
      `INSERT INTO app_publishers (id, display_name, kind)
       VALUES ('pqp', 'pqp', 'first_party') ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(`INSERT INTO apps (id, publisher_id) VALUES ('enquete', 'pqp')`);
    await pool.query(
      `INSERT INTO app_versions (app_id, version, manifest, manifest_sha256, entry_sha256)
       VALUES ('enquete', '1.0.0', $1::jsonb, $2, $2)`,
      [JSON.stringify(manifest), SHA],
    );
    await pool.query(`UPDATE apps SET current_version = '1.0.0' WHERE id = 'enquete'`);
    const owner = await pool.query<{ id: string }>(
      `INSERT INTO users (clerk_id, username, discriminator, display_name)
       VALUES ('clerk-apps-2p', 'apps2p', '0001', 'Apps 2p')
       ON CONFLICT (clerk_id) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
    );
    const server = await pool.query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('Apps 2p', $1) RETURNING id`,
      [owner.rows[0]!.id],
    );
    serverId = server.rows[0]!.id;
    await db.closePool();

    observer = createPostgresBusTransport(DATABASE_URL);
    observer.onFrame((frame) => {
      if (frame.topic === "apps.changed") {
        frames.push(frame);
      }
    });
    await observer.whenConnected();
    // One at a time: two boots running schema.sql at once contend for locks.
    a = await startApi("api-a");
    b = await startApi("api-b");
  }, 150_000);

  afterAll(async () => {
    await observer?.close();
    await Promise.all([stopApi(a), stopApi(b)]);
    const db = await import("../db.js");
    await db.getPool().query(`DELETE FROM servers WHERE id = $1`, [serverId]);
    await db.closePool();
  }, 30_000);

  async function waitForFrames(count: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (frames.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("both processes run the production cluster configuration", () => {
    for (const api of [a!, b!]) {
      const log = api.log.join("");
      expect(log).toContain("bus.enabled");
      expect(log).toContain("voice.registryEnabled");
    }
  });

  it("B's read shows A's writes, and the bus carried one hint for each change and none for a no-op", async () => {
    const put = (path: string, body: unknown) => call<{ error?: string }>(a!, "PUT", path, TOKEN, body);

    const refused = await put("/api/admin/apps", { appId: "enquete", status: "live" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("not-reviewed");

    const review = await put("/api/admin/app-review", {
      appId: "enquete",
      version: "1.0.0",
      reviewStatus: "approved",
      checklist: { sandbox: true, noNetwork: true, license: true, i18n: true, presence: true },
    });
    expect(review.status).toBe(200);
    const live = await put("/api/admin/apps", {
      appId: "enquete",
      status: "live",
      globalEnabled: true,
    });
    expect(live.status).toBe(200);
    const server = await put("/api/admin/server-apps", {
      serverId,
      appId: "enquete",
      operatorEnabled: true,
    });
    expect(server.status).toBe(200);
    const noop = await put("/api/admin/server-apps", {
      serverId,
      appId: "enquete",
      operatorEnabled: true,
    });
    expect(noop.status).toBe(200);

    await waitForFrames(3);
    // Give a stray fourth frame (the refused write, the no-op) time to show.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(frames.map((f) => f.data)).toEqual([
      { appId: "enquete", serverId: null },
      { appId: "enquete", serverId: null },
      { appId: "enquete", serverId },
    ]);

    const list = await call<{
      apps: { id: string; status: string; globalEnabled: boolean; serversOn: number }[];
      audit: { action: string; actorKind: string }[];
    }>(b!, "GET", "/api/admin/apps", TOKEN);
    expect(list.status).toBe(200);
    expect(list.body.apps).toEqual([
      expect.objectContaining({ id: "enquete", status: "live", globalEnabled: true, serversOn: 1 }),
    ]);
    expect(list.body.audit.map((row) => row.action)).toEqual([
      "operator-server",
      "global",
      "status",
      "review",
    ]);
    expect(list.body.audit.every((row) => row.actorKind === "dashboard")).toBe(true);
  }, 30_000);
});
