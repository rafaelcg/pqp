// The local stack a scene runs against, started and stopped as one unit:
//
//   scratch Postgres database -> API (server/dist, dev auth bypass)
//   static server for a production build of the client (SPA fallback)
//   livekit-server --dev      (SFU scenes; skipped, and said so, if not installed)
//   fake S3 + ffmpeg HLS      (the watch party scene, lib/hls-source.mjs)
//
// Every process this module starts is tracked by pid and stopped by pid (its own
// process group where it has one). Nothing here ever matches a process by name:
// the owner's own pqp desktop app may be running on the same machine.
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeS3 } from "../../db-blip-harness/fake-s3.mjs";
import { startHlsSource } from "./hls-source.mjs";
import { assertScratchDatabase, seed } from "../seed.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, "../../..");
const pg = createRequire(path.join(repo, "server", "package.json"))("pg");

export const PORTS = {
  api: Number(process.env.BENCH_API_PORT ?? 3971),
  app: Number(process.env.BENCH_APP_PORT ?? 4183),
  s3: Number(process.env.BENCH_S3_PORT ?? 3973),
  livekit: 7880,
};
const BUCKET = "pqp-live-bench";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function waitFor(what, check, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(300);
  }
}

function stopChild(child) {
  return new Promise((done) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return done();
    child.once("exit", () => done());
    try {
      // Detached children lead their own group: take the whole group, by pid.
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, 5_000).unref();
  });
}

/** A static server for the client's `dist`, with the SPA fallback `vite preview` has. */
function startStatic(root, port) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".wasm": "application/wasm",
    ".ico": "image/x-icon",
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    let isFile = false;
    try {
      isFile = statSync(file).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) file = path.join(root, "index.html");
    const ext = path.extname(file);
    res.writeHead(200, {
      "Content-Type": types[ext] ?? "application/octet-stream",
      "Cache-Control": file.endsWith("index.html") || file.endsWith("sw.js") ? "no-cache" : "public, max-age=3600",
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

/** Build the client for the bench stack unless a build is supplied. */
export function buildClient({ outDir, log }) {
  const env = {
    ...process.env,
    VITE_DEV_AUTH_BYPASS: "true",
    VITE_API_URL: `http://127.0.0.1:${PORTS.api}`,
    VITE_WS_URL: `ws://127.0.0.1:${PORTS.api}/ws`,
    VITE_PQP_BUILD_ID: "desktop-bench",
  };
  log(`building the client into ${outDir}`);
  const r = spawnSync("pnpm", ["--filter", "@pqp/client", "exec", "vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: repo,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (r.status !== 0) throw new Error("client build failed (is @pqp/shared built? pnpm --filter @pqp/shared build)");
}

export function livekitInstalled() {
  return spawnSync("livekit-server", ["--version"], { stdio: "ignore" }).status === 0;
}

/**
 * @param {object} o
 * @param {string} o.pgAdminUrl   admin URL of a LOCAL Postgres (the stack creates and drops its own database)
 * @param {string} o.clientDist   a built client (see buildClient)
 * @param {(m: string) => void} o.log
 */
export async function startStack({ pgAdminUrl, clientDist, log }) {
  const admin = new URL(pgAdminUrl);
  if (!["127.0.0.1", "localhost", "::1"].includes(admin.hostname)) {
    throw new Error(`desktop-bench refuses a non-local Postgres: ${admin.hostname}`);
  }
  for (const [name, port] of Object.entries(PORTS)) {
    if (name === "livekit") continue;
    if (!(await portFree(port))) throw new Error(`port ${port} (${name}) is in use; set BENCH_${name.toUpperCase()}_PORT`);
  }
  const serverEntry = path.join(repo, "server", "dist", "index.js");
  if (!existsSync(serverEntry)) {
    throw new Error("server/dist is missing: pnpm --filter @pqp/shared build && pnpm --filter @pqp/server build");
  }

  const cleanups = [];
  const stop = async () => {
    for (const step of cleanups.splice(0).reverse()) {
      try {
        await step();
      } catch (error) {
        console.error("[stack] cleanup step failed:", error?.message ?? error);
      }
    }
  };
  try {
    // Database.
    const dbName = `pqp_bench_${Date.now().toString(36)}`;
    const adminClient = new pg.Client({ connectionString: pgAdminUrl });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE ${dbName}`);
    await adminClient.end();
    cleanups.push(async () => {
      const c = new pg.Client({ connectionString: pgAdminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await c.end();
    });
    const dbUrl = new URL(pgAdminUrl);
    dbUrl.pathname = `/${dbName}`;
    const databaseUrl = dbUrl.toString();
    assertScratchDatabase(databaseUrl);
    log(`scratch database ${dbName}`);

    const scratch = mkdtempSync(path.join(tmpdir(), "pqp-desktop-bench-"));
    cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
    const s3Root = path.join(scratch, "s3");
    mkdirSync(s3Root, { recursive: true });

    // Fake S3 for the watch party's HLS.
    const s3 = await startFakeS3({ port: PORTS.s3, root: s3Root, bucket: BUCKET });
    cleanups.push(() => s3.stop());

    // SFU.
    let livekit = null;
    if (livekitInstalled()) {
      const lk = spawn("livekit-server", ["--dev"], { detached: true, stdio: "ignore" });
      cleanups.push(() => stopChild(lk));
      await waitFor("livekit-server", async () => (await fetch(`http://127.0.0.1:${PORTS.livekit}`)).ok, 20_000);
      livekit = { url: `ws://127.0.0.1:${PORTS.livekit}`, pid: lk.pid };
      log(`livekit-server --dev up (pid ${lk.pid})`);
    } else {
      log("livekit-server is not installed: the SFU scenes (S4 to S6) cannot run");
    }

    // API.
    const apiLog = path.join(scratch, "api.log");
    const apiOut = [];
    const api = spawn("node", ["dist/index.js"], {
      cwd: path.join(repo, "server"),
      detached: true,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: "development",
        PORT: String(PORTS.api),
        DATABASE_URL: databaseUrl,
        DEV_AUTH_BYPASS: "true",
        ...(livekit
          ? { LIVEKIT_URL: livekit.url, LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret" }
          : {}),
        LIVE_HLS_ENABLED: "true",
        LIVE_HLS_S3_BUCKET: BUCKET,
        LIVE_HLS_S3_ACCESS_KEY_ID: "bench",
        LIVE_HLS_S3_SECRET_ACCESS_KEY: "bench",
        LIVE_HLS_S3_ENDPOINT: `http://127.0.0.1:${PORTS.s3}`,
        LIVE_HLS_S3_FORCE_PATH_STYLE: "true",
        LIVE_HLS_S3_REGION: "auto",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (chunk) => apiOut.push(chunk.toString());
    api.stdout.on("data", keep);
    api.stderr.on("data", keep);
    cleanups.push(async () => {
      await stopChild(api);
      writeFileSync(apiLog, apiOut.join(""));
    });
    await waitFor("API /health", async () => (await fetch(`http://127.0.0.1:${PORTS.api}/health`)).ok, 90_000);
    log(`API up on ${PORTS.api} (pid ${api.pid})`);

    // Client.
    const staticServer = await startStatic(clientDist, PORTS.app);
    cleanups.push(() => new Promise((done) => staticServer.close(() => done())));

    const apiUrl = `http://127.0.0.1:${PORTS.api}`;
    const ids = await seed({ apiUrl, databaseUrl, log });

    // The watch party's picture.
    const hls = await startHlsSource({ s3Root, databaseUrl, channelId: ids.partyChannelId, log });
    cleanups.push(() => hls.stop());
    // The API memoises "no stream" for a minute, and a viewer must find one:
    // wait until it answers with the playlist.
    await waitFor(
      "the watch party stream",
      async () => {
        const r = await fetch(`${apiUrl}/api/channels/${ids.partyChannelId}/live`, {
          headers: { Authorization: "Bearer dev-local-token" },
        });
        return Boolean((await r.json()).stream);
      },
      120_000,
    );
    log("watch party stream is live through the playlist proxy");

    return {
      apiUrl,
      appUrl: `http://127.0.0.1:${PORTS.app}`,
      wsUrl: `ws://127.0.0.1:${PORTS.api}/ws`,
      databaseUrl,
      ids,
      livekit,
      pids: { api: api.pid, livekit: livekit?.pid ?? null, ffmpeg: hls.pid },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
