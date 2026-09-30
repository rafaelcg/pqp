import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * TWO REAL API PROCESSES, configured the way production's two replicas are:
 * `CLUSTER_BUS=postgres` and `VOICE_REGISTRY=postgres`, one database. The
 * operator's flip goes to A through the dashboard's machine token; the
 * question is asked of B through an ordinary signed-in product route
 * (`GET /api/watch-party/waitlist`, whose `campaign` IS the
 * `watch_party_waitlist` flag). Both run with a ten minute flag TTL, so B
 * answering the new value inside a couple of seconds can only be the bus.
 *
 * Pitfall 12 is why this exists beside `flags-cluster.test.ts`: the flags
 * that production sets are the flags the test has to run with, in the
 * processes production runs.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(SERVER_DIR, "node_modules", ".bin", "tsx");
const TOKEN = "feedfacefeedfacefeedfacefeedface";

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
    FEATURE_FLAGS_TTL_MS: String(10 * 60_000),
    // Nothing here needs a media server or storage; empty beats whatever a
    // developer's .env points at (dotenv never overrides a set variable).
    LIVEKIT_URL: "",
    LIVE_HLS_ENABLED: "",
    S3_BUCKET: "",
    WATCH_PARTY_WAITLIST: "",
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

describeDb("a flip on one API process, read on the other", () => {
  let a: Api | undefined;
  let b: Api | undefined;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    const db = await import("../db.js");
    await db.initDb();
    await db
      .getPool()
      .query(`TRUNCATE feature_flags, feature_flag_overrides, feature_flag_audit`);
    await db.closePool();
    // One at a time: two boots running schema.sql at once contend for locks.
    a = await startApi("api-a");
    b = await startApi("api-b");
  }, 150_000);

  afterAll(async () => {
    await Promise.all([stopApi(a), stopApi(b)]);
  }, 30_000);

  it("both processes run the production cluster configuration", () => {
    for (const api of [a!, b!]) {
      const log = api.log.join("");
      expect(log).toContain("bus.enabled");
      expect(log).toContain("voice.registryEnabled");
      expect(log).toMatch(/flags\.started loaded=true/);
    }
  });

  it("B answers A's flip in well under the ten minute TTL, both ways", async () => {
    const campaignOn = async (api: Api) => {
      const answer = await call<{ campaign: boolean }>(
        api,
        "GET",
        "/api/watch-party/waitlist",
        "dev-local-token",
      );
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      return answer.body.campaign;
    };

    // The dev account B's first request creates, past the 18+ gate (a
    // declaration nobody has made yet is `pending`, which is never cached).
    await call(b!, "GET", "/api/me", "dev-local-token");
    const db = await import("../db.js");
    await db
      .getPool()
      .query(
        `UPDATE users SET age_checked_at = NOW(), age_check_passed = TRUE
          WHERE age_checked_at IS NULL`,
      );
    await db.closePool();

    // Default: no row, no variable, no live HLS here, so the campaign is off.
    expect(await campaignOn(b!)).toBe(false);

    for (const enabled of [true, null] as const) {
      const flippedAt = Date.now();
      const write = await call<{ key: string; effective: boolean }>(
        a!,
        "PUT",
        "/api/admin/flags",
        TOKEN,
        { key: "watch_party_waitlist", enabled },
      );
      expect(write.status).toBe(200);
      expect(write.body).toMatchObject({
        key: "watch_party_waitlist",
        effective: enabled === true,
      });
      const want = enabled === true;
      let observed = await campaignOn(b!);
      while (observed !== want && Date.now() - flippedAt < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        observed = await campaignOn(b!);
      }
      expect(observed).toBe(want);
      const tookMs = Date.now() - flippedAt;
      console.log(`[flags] api-b answered enabled=${enabled} ${tookMs} ms after the PUT to api-a`);
      expect(tookMs).toBeLessThan(5_000);
    }

    // The machine token reached the write and the audit says so.
    const list = await call<{
      audit: { key: string; next: boolean | null; actorKind: string }[];
      cache: { busInvalidations: number; ttlMs: number };
    }>(b!, "GET", "/api/admin/flags", TOKEN);
    // And it was the bus that told B, twice, not its ten minute timer.
    expect(list.body.cache.ttlMs).toBe(10 * 60_000);
    expect(list.body.cache.busInvalidations).toBe(2);
    expect(list.body.audit.slice(0, 2)).toEqual([
      expect.objectContaining({ key: "watch_party_waitlist", next: null, actorKind: "dashboard" }),
      expect.objectContaining({ key: "watch_party_waitlist", next: true, actorKind: "dashboard" }),
    ]);
  }, 30_000);
});
