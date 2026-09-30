/* eslint-disable no-console -- a CLI harness: its output is the report. */
/**
 * RESTART HARNESS: does a watch party's audience ride through a transcode
 * restart without re-attaching?
 *
 * Reproduces 2026-09-24 07:42:32 locally: the ladder's egress dies mid-show
 * and a new one is started. Since the in-place restart (`hls-runs.ts`) the new
 * egress writes a new RUN under the SAME session, the rung's row records it,
 * and the playlist proxy stitches the runs with `#EXT-X-DISCONTINUITY`. This
 * asserts, against the real API build and stock hls.js in headless Chromium:
 *
 *  1. one hls.js instance and one master load for the whole run: nobody
 *     re-attached;
 *  2. no fatal error, and the playhead moves again after every seam;
 *  3. one sequence line: a media sequence number always names the same
 *     segment and the newest listed never runs backwards, across two API
 *     processes (one booted AFTER the first restart and never saw the first
 *     run live) that a viewer bounces between, the way Cloudflare does with no
 *     session affinity.
 *
 * WHAT IS REAL: the API (`server/dist`), Postgres, the playlist proxy and its
 * run stitching, the ENDLIST a stopped transcoder writes, a transcoder that
 * starts its MPEG-TS clock over, hls.js. WHAT IS NOT: LiveKit. ffmpeg stands
 * in for the egress (same names, same five-entry live window, same
 * program-date-time), and the harness writes the row's `runs` the way
 * `finishInPlaceRestart` does. The control-plane half (stopping, starting,
 * computing the base, adoption) is pinned by `hls-egress-in-place.test.ts`
 * and `voice-hls-rolling-deploy.test.ts` against a real Postgres.
 *
 * Usage (from the repo root, server built with `pnpm --filter @pqp/server build`):
 *   HARNESS_PG_URL=postgres://pqp:pqp@127.0.0.1:5432/postgres \
 *   pnpm --filter @pqp/server exec tsx ../tools/restart-harness/run.ts
 *
 * Env: HARNESS_PG_URL (an admin URL to a LOCAL Postgres; the harness creates
 * and drops its own database), SEAM_SECONDS (default 15, the dead time
 * between runs), RUN_SECONDS (default 30, how long each run plays),
 * RESTARTS (default 2).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type PgModule from "pg";
import type { Browser } from "playwright";
import { startFakeS3 } from "../db-blip-harness/fake-s3.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SERVER_DIR = process.env.HARNESS_SERVER_DIR ?? join(REPO, "server");
const pg = createRequire(join(REPO, "server", "package.json"))("pg") as typeof PgModule;
const { chromium } = createRequire(join(REPO, "client", "package.json"))(
  "@playwright/test",
) as { chromium: { launch(options: { headless: boolean }): Promise<Browser> } };

const SEAM_SECONDS = Number(process.env.SEAM_SECONDS ?? 15);
const RUN_SECONDS = Number(process.env.RUN_SECONDS ?? 30);
const RESTARTS = Number(process.env.RESTARTS ?? 2);
const ADMIN_URL = process.env.HARNESS_PG_URL;
if (!ADMIN_URL) {
  throw new Error("HARNESS_PG_URL is required (an admin URL to a LOCAL Postgres)");
}
const admin = new URL(ADMIN_URL);
if (!["127.0.0.1", "localhost", "::1"].includes(admin.hostname)) {
  throw new Error(`refusing a non-local Postgres: ${admin.hostname}`);
}

const API_A_PORT = 3970;
const API_B_PORT = 3973;
const EDGE_PORT = 3974;
const S3_PORT = 3971;
const PAGE_PORT = 3972;
const BUCKET = "pqp-live-harness";
const RUNG = "720p30";
const DB_NAME = `pqp_restart_${process.pid}`;
const API_A = `http://127.0.0.1:${API_A_PORT}`;
const API_B = `http://127.0.0.1:${API_B_PORT}`;
const EDGE = `http://127.0.0.1:${EDGE_PORT}`;

const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const log = (message: string) => console.log(`[${stamp()}s] ${message}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const cleanups: (() => Promise<void> | void)[] = [];
async function cleanupAll() {
  for (const step of cleanups.reverse()) {
    try {
      await step();
    } catch (error) {
      console.error("cleanup step failed:", error);
    }
  }
}

function kill(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  return new Promise<void>((done) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      done();
      return;
    }
    child.once("exit", () => done());
    child.kill(signal);
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  });
}

async function createDatabase(): Promise<string> {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  await client.query(`CREATE DATABASE ${DB_NAME}`);
  await client.end();
  cleanups.push(async () => {
    const c = new pg.Client({ connectionString: ADMIN_URL });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await c.end();
  });
  const direct = new URL(ADMIN_URL!);
  direct.pathname = `/${DB_NAME}`;
  return direct.toString();
}

/**
 * One egress run: `<startedAt>-<rung><suffix>` names, a five-entry live
 * window, a program date time per segment, and (unlike the db-blip harness)
 * no deletion, because a LiveKit egress never deletes what it wrote. Each run
 * starts its clock at zero, exactly like a new egress.
 */
function startRun(root: string, channelId: string, startedAt: number, suffix: string): ChildProcess {
  const dir = join(root, "live", channelId);
  mkdirSync(dir, { recursive: true });
  const base = `${startedAt}-${RUNG}${suffix}`;
  return spawn(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-re",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440",
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
      "-g", "120", "-keyint_min", "120", "-sc_threshold", "0",
      "-c:a", "aac",
      "-f", "hls", "-hls_time", "4", "-hls_list_size", "5",
      "-hls_flags", "program_date_time+temp_file",
      "-hls_segment_filename", join(dir, `${base}_%05d.ts`),
      join(dir, `${base}.m3u8`),
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
}

/** Segments a run's final live playlist says it wrote: `segmentsWritten`. */
function segmentsWrittenOnDisk(root: string, channelId: string, startedAt: number, suffix: string): number {
  const body = readFileSync(join(root, "live", channelId, `${startedAt}-${RUNG}${suffix}.m3u8`), "utf8");
  const sequence = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(body)?.[1] ?? 0);
  const entries = body.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#")).length;
  return sequence + entries;
}

function startApi(databaseUrl: string, name: string, port: number): ChildProcess {
  const api = spawn("node", ["dist/index.js"], {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "development",
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      DEV_AUTH_BYPASS: "true",
      DEV_SEED: "false",
      LIVE_HLS_S3_BUCKET: BUCKET,
      LIVE_HLS_S3_ACCESS_KEY_ID: "harness",
      LIVE_HLS_S3_SECRET_ACCESS_KEY: "harness",
      LIVE_HLS_S3_ENDPOINT: `http://127.0.0.1:${S3_PORT}`,
      LIVE_HLS_S3_FORCE_PATH_STYLE: "true",
      LIVE_HLS_S3_REGION: "auto",
      LIVE_HLS_SEGMENT_SECONDS: "4",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const forward = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim() && /hlsPlaylist|error|Error/i.test(line)) {
        console.log(`[${stamp()}s]   ${name}| ${line.slice(0, 300)}`);
      }
    }
  };
  api.stdout!.on("data", forward);
  api.stderr!.on("data", forward);
  return api;
}

/**
 * The edge with no session affinity: every request goes to the next API in
 * turn, so a viewer's consecutive playlist polls land on different processes.
 */
function startRoundRobin(targets: () => number[]): Promise<() => Promise<void>> {
  let turn = 0;
  const server = http.createServer((req, res) => {
    const ports = targets();
    const port = ports[turn++ % ports.length]!;
    const upstream = http.request(
      { host: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, {
          ...answer.headers,
          "access-control-allow-origin": "*",
          "x-harness-api": String(port),
        });
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  return new Promise((resolve) =>
    server.listen(EDGE_PORT, "127.0.0.1", () =>
      resolve(() => new Promise((done) => server.close(() => done()))),
    ),
  );
}

function startViewerPage(): Promise<() => Promise<void>> {
  const hlsJs = readFileSync(join(REPO, "client", "node_modules", "hls.js", "dist", "hls.min.js"));
  const page = readFileSync(join(HERE, "..", "db-blip-harness", "viewer.html"));
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/hls.min.js")) {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(hlsJs);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(page);
  });
  return new Promise((resolve) =>
    server.listen(PAGE_PORT, "127.0.0.1", () =>
      resolve(() => new Promise((done) => server.close(() => done()))),
    ),
  );
}

async function waitFor(what: string, check: () => Promise<boolean>, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // not yet
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_A}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${response.status} ${text}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

interface ViewerReport {
  instances: number;
  manifestLoads: number;
  fatal: string[];
  nonFatal: Record<string, number>;
  levelLoaded: number;
  samples: { t: number; currentTime: number; buffered: number; waiting: boolean }[];
  waitingEvents: number;
}

async function main() {
  const databaseUrl = await createDatabase();
  const root = mkdtempSync(join(tmpdir(), "pqp-restart-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const s3 = await startFakeS3({ port: S3_PORT, root, bucket: BUCKET });
  cleanups.push(() => s3.stop());
  cleanups.push(await startViewerPage());
  const apiPorts = [API_A_PORT];
  cleanups.push(await startRoundRobin(() => apiPorts));

  const apiA = startApi(databaseUrl, "apiA", API_A_PORT);
  cleanups.push(() => kill(apiA));
  await waitFor("API A /health", async () => (await fetch(`${API_A}/health`)).ok, 60_000);
  log(`API A up, server build ${SERVER_DIR}`);

  const alice = "dev-local-token:alice";
  await api("/api/me/age-check", alice, { method: "POST", body: JSON.stringify({ dateOfBirth: "1990-01-01" }) });
  const created = await api<{ id?: string; server?: { id: string }; channels: { id: string; type: string }[] }>(
    "/api/servers",
    alice,
    { method: "POST", body: JSON.stringify({ name: "Restart party" }) },
  );
  const channelId = created.channels.find((c) => c.type === "voice")!.id;

  const startedAt = Date.now();
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  cleanups.push(() => db.end());
  const aliceRow = await db.query<{ id: string }>(`SELECT id FROM users WHERE clerk_id = 'dev_local_user_alice'`);
  await db.query(
    `INSERT INTO hls_sessions (channel_id, object_prefix, started_at, rung)
     VALUES ($1, $2, to_timestamp($3 / 1000.0), $4)`,
    [channelId, `live/${channelId}/${startedAt}-${RUNG}`, startedAt, RUNG],
  );
  let run = startRun(root, channelId, startedAt, "");
  let runSuffix = "";
  let runs: { suffix: string; base: number }[] = [{ suffix: "", base: 0 }];
  cleanups.push(() => kill(run));

  process.env.DEV_AUTH_BYPASS = "true";
  const { mintHlsViewerToken } = await import("../../server/src/voice/hls-viewer-token.ts");
  const token = mintHlsViewerToken({ userId: aliceRow.rows[0]!.id, channelId, startedAt });
  const q = `?t=${encodeURIComponent(token!)}`;
  const masterUrl = `${EDGE}/api/voice/hls-playlist/${channelId}/${startedAt}${q}`;
  const renditionPath = `/api/voice/hls-playlist/${channelId}/${startedAt}/${RUNG}${q}`;
  await waitFor("the first playlist", async () => (await fetch(`${API_A}${renditionPath}`)).ok, 30_000);
  log(`session ${startedAt} live on channel ${channelId}`);

  const browser = await chromium.launch({ headless: true });
  cleanups.push(() => browser.close());
  const page = await browser.newPage();
  page.on("console", (message) => {
    if (message.text().startsWith("[viewer]")) log(message.text());
  });
  await page.goto(`http://127.0.0.1:${PAGE_PORT}/viewer.html#${encodeURIComponent(masterUrl)}`);
  await page.waitForFunction(
    () => (window as unknown as { viewer?: { playing: boolean } }).viewer?.playing === true,
    null,
    { timeout: 45_000 },
  );
  log("viewer is playing (through the round-robin edge)");
  const readViewer = () =>
    page.evaluate(() => (window as unknown as { viewer: ViewerReport }).viewer) as Promise<ViewerReport>;

  // Every playlist any API serves the viewer, sampled: the sequence line.
  const sequences: {
    at: number;
    api: number;
    sequence: number;
    newest: number;
    discontinuities: number;
    dseq: number;
  }[] = [];
  // Which object each media sequence number named, across every render from
  // every process: one number must always be one segment.
  const named = new Map<number, string>();
  const conflicts: string[] = [];
  let polling = true;
  const poll = (async () => {
    while (polling) {
      for (const port of [...apiPorts]) {
        try {
          const body = await (await fetch(`http://127.0.0.1:${port}${renditionPath}`)).text();
          const sequence = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(body)?.[1] ?? NaN);
          if (Number.isFinite(sequence)) {
            const objects = body
              .split("\n")
              .filter((line) => line.trim() !== "" && !line.startsWith("#"))
              .map((line) => new URL(line).pathname.split("/").pop()!);
            objects.forEach((object, index) => {
              const seen = named.get(sequence + index);
              if (seen === undefined) {
                named.set(sequence + index, object);
              } else if (seen !== object && conflicts.length < 5) {
                conflicts.push(`#${sequence + index} was ${seen}, api ${port} says ${object}`);
              }
            });
            sequences.push({
              at: Date.now(),
              api: port,
              sequence,
              newest: sequence + objects.length - 1,
              discontinuities: (body.match(/^#EXT-X-DISCONTINUITY$/gm) ?? []).length,
              dseq: Number(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(body)?.[1] ?? 0),
            });
          }
          if (/#EXT-X-ENDLIST/.test(body)) {
            log(`!!! API ${port} served an ENDLIST`);
          }
        } catch {
          // not up yet
        }
      }
      await sleep(1_000);
    }
  })();

  await sleep(RUN_SECONDS * 1000);
  const seams: { start: number; end: number; resumedAt: number | null }[] = [];

  for (let restart = 1; restart <= RESTARTS; restart += 1) {
    // ---- the egress dies (a clean stop writes ENDLIST, as LiveKit's does).
    const seamStart = Date.now();
    await kill(run);
    log(`>>> run ${runSuffix || "0"} ended (restart ${restart}); seam of ${SEAM_SECONDS}s`);
    if (restart === 1) {
      // A second API process that never saw run 0 live: the viewer's polls now
      // alternate between the two.
      const apiB = startApi(databaseUrl, "apiB", API_B_PORT);
      cleanups.push(() => kill(apiB));
      await waitFor("API B /health", async () => (await fetch(`${API_B}/health`)).ok, 60_000);
      apiPorts.push(API_B_PORT);
      log("API B up and behind the edge");
    }
    await sleep(Math.max(0, SEAM_SECONDS * 1000 - (Date.now() - seamStart)));
    // ---- the next run: what `finishInPlaceRestart` writes, then the egress.
    const written = segmentsWrittenOnDisk(root, channelId, startedAt, runSuffix);
    const next = { suffix: `-r${Date.now()}`, base: runs.at(-1)!.base + written };
    runs = [...runs, next];
    await db.query(`UPDATE hls_sessions SET runs = $2::jsonb WHERE object_prefix = $1`, [
      `live/${channelId}/${startedAt}-${RUNG}`,
      JSON.stringify(runs),
    ]);
    runSuffix = next.suffix;
    run = startRun(root, channelId, startedAt, runSuffix);
    log(`<<< run ${runSuffix} started, base ${next.base} (previous run wrote ${written})`);
    const seam = { start: seamStart, end: Date.now(), resumedAt: null as number | null };
    seams.push(seam);
    // When does the viewer's playhead move again?
    const before = (await readViewer()).samples.at(-1)!.currentTime;
    const resumeDeadline = Date.now() + 40_000;
    while (Date.now() < resumeDeadline) {
      await sleep(500);
      const now = (await readViewer()).samples.at(-1)!;
      if (now.currentTime > before + 2) {
        seam.resumedAt = Date.now();
        break;
      }
    }
    log(
      seam.resumedAt
        ? `    viewer moving again ${((seam.resumedAt - seam.end) / 1000).toFixed(1)}s after run start ` +
            `(${((seam.resumedAt - seam.start) / 1000).toFixed(1)}s after the old run died)`
        : "    viewer did NOT resume",
    );
    await sleep(RUN_SECONDS * 1000);
  }

  polling = false;
  await poll;
  const report = await readViewer();
  const failures: string[] = [];
  if (report.instances !== 1) failures.push(`viewer rebuilt the player: ${report.instances} instances`);
  if (report.manifestLoads !== 1) failures.push(`viewer reloaded the master ${report.manifestLoads} times`);
  if (report.fatal.length > 0) failures.push(`fatal: ${report.fatal.join(", ")}`);
  for (const [index, seam] of seams.entries()) {
    if (!seam.resumedAt) failures.push(`did not resume after restart ${index + 1}`);
  }
  // ONE SEQUENCE LINE, whichever process answered: a number always names
  // the same segment, and the newest listed never runs backwards by more than
  // the one poll two processes can be apart. (Where each process's window
  // STARTS may differ: a process that booted later remembers fewer segments.
  // That was already true of two machines and is harmless; renumbering is not.)
  failures.push(...conflicts.map((conflict) => `sequence renumbered: ${conflict}`));
  for (let i = 1; i < sequences.length; i += 1) {
    const [a, b] = [sequences[i - 1]!, sequences[i]!];
    if (b.newest < a.newest - 1) {
      failures.push(`newest segment went backwards: ${a.newest} (api ${a.api}) then ${b.newest} (api ${b.api})`);
      break;
    }
  }
  const final = sequences.filter((sample) => sample.at > Date.now() - 3_000);
  const byApi = new Map(final.map((sample) => [sample.api, sample]));
  const maxDiscontinuities = Math.max(...sequences.map((sample) => sample.discontinuities));
  if (maxDiscontinuities < 1) failures.push("never served a discontinuity");
  const end = report.samples.at(-1)!;
  log(
    `RESULT viewer: instances=${report.instances} masterLoads=${report.manifestLoads} fatal=${report.fatal.length} ` +
      `waitingEvents=${report.waitingEvents} currentTime=${end.currentTime.toFixed(1)}s ` +
      `nonFatal=${JSON.stringify(report.nonFatal)}`,
  );
  log(
    `RESULT playlist: ${sequences.length} samples over ${apiPorts.length} APIs, ${named.size} numbered ` +
      `segments, renumbered ${conflicts.length}, newest ${sequences[0]?.newest} -> ${sequences.at(-1)?.newest}, ` +
      `final per API ${JSON.stringify([...byApi.values()].map((s) => ({ api: s.api, seq: s.sequence, newest: s.newest, dseq: s.dseq })))}, ` +
      `runs ${JSON.stringify(runs)}`,
  );
  for (const [index, seam] of seams.entries()) {
    log(
      `RESULT seam ${index + 1}: dead ${((seam.end - seam.start) / 1000).toFixed(1)}s, ` +
        `playhead moving again after ${seam.resumedAt ? ((seam.resumedAt - seam.start) / 1000).toFixed(1) : "never"}s`,
    );
  }
  if (failures.length > 0) {
    log(`FAIL\n  - ${failures.join("\n  - ")}`);
    process.exitCode = 1;
  } else {
    log("PASS");
  }
}

main()
  .catch((error) => {
    log(`HARNESS ERROR ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanupAll();
    process.exit();
  });
