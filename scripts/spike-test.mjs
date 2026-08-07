#!/usr/bin/env node
/**
 * Launch-day spike harness — the shapes `chat-load.mjs` does not cover.
 *
 * `chat-load.mjs` answers "how many sockets, at what message rate, with what
 * fan-out latency". That is steady state. This answers what happens at the
 * edges: the first ten seconds of a launch (everyone signing up at once), the
 * worst ten seconds (everyone reconnecting at once after a restart), and the
 * two ceilings underneath both (the Postgres pool, and memory over hours).
 *
 * Every mode spawns its own built server, so a run is self-contained and
 * leaves nothing behind but rows in DATABASE_URL.
 *
 * Usage (server must be built: `pnpm --filter @pqp/server build`):
 *   MODE=signup DATABASE_URL=... PORT=3951 node scripts/spike-test.mjs
 *
 *   MODE       signup | reconnect | pool | mixed | soak   (default signup)
 *   PORT       port for the spawned server                (default 3951)
 *   DATABASE_URL                                          (default local pqp)
 *   PG_POOL_MAX  passed through to the server's pg pool   (server default 10)
 *   FIXED_IP   put every simulated client behind ONE client address, the way
 *              a carrier NAT does. Every IP-keyed limit then applies to the
 *              whole population at once.
 *
 * MODE=signup — N brand-new accounts created concurrently.
 *   SIGNUPS    distinct-display-name first-time signups   (default 200)
 *   SAME_NAME  signups that all slug to ONE username      (default 256)
 *   SEED_TAKEN discriminators to pre-seed on a hot name   (default 9998)
 *   Distinct names exercise the cheap path; SAME_NAME exercises
 *   `allocateDiscriminator` contention (server/src/services/users.ts:63) —
 *   many identities racing for numbers inside one name. SEED_TAKEN measures
 *   the same allocation with the space nearly exhausted.
 *
 * MODE=reconnect — everyone comes back at once after the server goes away.
 *   CLIENTS    sockets to establish first                 (default 500)
 *   RESTART    sigkill | sigterm                          (default sigkill)
 *   DOWNTIME_MS  how long the server stays down            (default 10000)
 *   DISTINCT_IPS  1 = per-client X-Forwarded-For (models  (default 1)
 *              production behind a proxy with TRUST_PROXY); 0 = every client
 *              shares one address bucket, which is what localhost really is.
 *   Clients reconnect on the real client's schedule:
 *   min(1000 * 2^attempt, 30000) + random*500 — see client/src/lib/realtime.ts.
 *
 * MODE=pool — where Postgres becomes the bottleneck.
 *   POOL_SIZES comma-separated PG_POOL_MAX values         (default 5,10,25)
 *   CONCURRENCY in-flight HTTP requests per sweep         (default 200)
 *   SEED_MESSAGES rows to make the read endpoint real     (default 2000)
 *
 * MODE=mixed — joins + messages + typing + reactions + channel switching.
 *   CLIENTS    sockets                                    (default 300)
 *   SENDERS    how many post messages                     (default 30)
 *   TYPERS     how many send typing frames                (default 150)
 *   REACTORS   how many toggle reactions                  (default 30)
 *   SWITCHERS  how many hop channels on a timer           (default 50)
 *   CHANNELS   channels to spread over                    (default 5)
 *   SECONDS    measurement window                         (default 60)
 *   SEED_MEMBERS extra members on the server who are NOT  (default 0)
 *              connected. Every message pays for them anyway — see the
 *              comment on the seeding block below.
 *
 * MODE=soak — moderate load for a long time, watching memory.
 *   CLIENTS    sockets                                    (default 300)
 *   SECONDS    soak duration                              (default 600)
 *   CHURN_ROUNDS  connect/disconnect waves after the soak (default 3)
 *   CHURN_SIZE    sockets per wave                        (default 500)
 *   Samples RSS externally and heapUsed after a forced GC over the inspector
 *   protocol, so a leak is distinguishable from allocator retention.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, "..", "server");
const require = createRequire(join(SERVER_DIR, "package.json"));
const WS = require("ws");
const { Pool } = require("pg");

/**
 * Which build to run, relative to `server/`. Defaults to the normal build
 * output; point it at a copy (`cp -R server/dist server/.stress-dist`) when
 * somebody else is rebuilding the same tree, so a run measures one known
 * commit end to end instead of whatever landed halfway through it.
 */
const SERVER_ENTRY = process.env.SERVER_ENTRY ?? "dist/index.js";
const MODE = process.env.MODE ?? "signup";
const PORT = Number(process.env.PORT ?? 3951);
const INSPECT_PORT = Number(process.env.INSPECT_PORT ?? PORT + 20);
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://pqp@127.0.0.1:5432/pqp";
const OWNER_TOKEN = "dev-local-token";
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

const t0 = Date.now();
const log = (m) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const num = (name, fallback) => Number(process.env[name] ?? fallback);

// ---------------------------------------------------------------- primitives

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1],
  };
}

const fmt = (s) =>
  `p50 ${Math.round(s.p50)}ms  p95 ${Math.round(s.p95)}ms  p99 ${Math.round(
    s.p99,
  )}ms  max ${Math.round(s.max)}ms  (n=${s.n})`;

/**
 * A fresh fake client address per call, so IP-keyed limiters do not collapse
 * every simulated client into one bucket. Only honoured because the server is
 * spawned with TRUST_PROXY=true.
 *
 * Set FIXED_IP to put every simulated client behind ONE address, which is what
 * a carrier-grade NAT actually is: `anonLimiter` (api/index.ts:218) and
 * `socketLimiter` (ws/index.ts:60) are keyed by client address, so a whole
 * mobile carrier's worth of users shares a single bucket. With the userbase in
 * `primary_region = "gru"` being mobile-heavy, that is not a hypothetical.
 */
const FIXED_IP = process.env.FIXED_IP || null;

const fakeIp = () =>
  FIXED_IP ??
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(
    Math.random() * 250,
  )}.${Math.floor(Math.random() * 250)}`;

/** Run `jobs` with at most `width` in flight. Returns results in order. */
async function pooled(jobs, width) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, jobs.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        results[i] = await jobs[i]();
      }
    }),
  );
  return results;
}

// ------------------------------------------------------------- server control

let server = null;

function spawnServer(extraEnv = {}) {
  server = spawn("node", ["--expose-gc", `--inspect=${INSPECT_PORT}`, SERVER_ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      DATABASE_URL,
      DEV_AUTH_BYPASS: "true",
      NODE_ENV: "development",
      PORT: String(PORT),
      TRUST_PROXY: "true",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverLog.length = 0;
  const capture = (chunk) => {
    const text = String(chunk);
    serverLog.push(text);
    if (process.env.SERVER_STDERR === "1") process.stderr.write(text);
  };
  server.stdout.on("data", capture);
  server.stderr.on("data", capture);
  return server;
}

const serverLog = [];

async function waitHealthy(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return true;
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  throw new Error("server never became healthy");
}

function killServer(signal = "SIGKILL") {
  if (server && !server.killed) server.kill(signal);
}

// --------------------------------------------------------------- HTTP client

/**
 * Unbounded HTTP agent, deliberately not `fetch`.
 *
 * Node's global fetch queues above its own connection ceiling, which silently
 * caps how much concurrency ever reaches the server — the pool queue stays
 * short while the wait shows up in client-side latency instead, so the numbers
 * look like a server limit and are not one. `maxSockets: Infinity` moves the
 * queue back where the measurement wants it.
 */
const httpAgent = new (require("node:http").Agent)({
  keepAlive: true,
  maxSockets: Infinity,
  maxFreeSockets: 4096,
});

function rawRequest(path, { method, token, body }) {
  const http = require("node:http");
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path,
        method,
        agent: httpAgent,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
          "X-Forwarded-For": fakeIp(),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function api(path, { method = "GET", token = OWNER_TOKEN, body } = {}) {
  const started = Date.now();
  const res = await rawRequest(path, { method, token, body });
  const text = res.text;
  const elapsed = Date.now() - started;
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`${method} ${path} → HTTP ${res.status} ${text}`);
    err.status = res.status;
    err.elapsed = elapsed;
    err.bodyText = text;
    throw err;
  }
  return { elapsed, json: text ? JSON.parse(text) : null };
}

/** Like `api` but never throws — returns {status, elapsed, body}. */
async function tryApi(path, opts = {}) {
  try {
    const { elapsed, json } = await api(path, opts);
    return { status: 200, elapsed, body: json };
  } catch (error) {
    if (error.status) {
      return { status: error.status, elapsed: error.elapsed, body: error.bodyText };
    }
    return { status: 0, elapsed: 0, body: String(error.message) };
  }
}

// ----------------------------------------------------------- inspector probe

/**
 * Evaluate an expression inside the running server over the inspector
 * protocol. Read-only observation that needs no change to server code — the
 * point of `--expose-gc` is that heapUsed can be sampled after a real
 * collection, so retained memory is distinguishable from garbage not yet swept.
 */
async function withInspector(fn) {
  const list = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`)).json();
  const url = list[0]?.webSocketDebuggerUrl;
  if (!url) throw new Error("no inspector target");
  const ws = new WS(url);
  let id = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(myId)) reject(new Error(`inspector timeout on ${method}`));
      }, 60_000);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  try {
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    return await fn(send);
  } finally {
    ws.close();
  }
}

async function inspectorEval(expression) {
  return withInspector(async (send) => {
    const res = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? "eval failed");
    }
    return res.result?.value;
  });
}

/**
 * Every live `Map` in the server process, with its size and a preview of its
 * first key.
 *
 * `Runtime.queryObjects` walks the heap for objects with a given prototype
 * after a collection, so this sees module-private state — `connections` and
 * `channelPresence` in ws/chat.ts, `userCache` in auth/clerk.ts, the token
 * buckets inside each `createRateLimiter` closure — none of which is exported
 * and none of which any amount of RSS sampling could tell apart. The first key
 * is what identifies them: a clerk id, a channel uuid and an IP address look
 * nothing alike.
 */
async function liveMaps(prototype = "Map.prototype") {
  return withInspector(async (send) => {
    const proto = await send("Runtime.evaluate", { expression: prototype });
    const all = await send("Runtime.queryObjects", {
      prototypeObjectId: proto.result.objectId,
    });
    const res = await send("Runtime.callFunctionOn", {
      objectId: all.objects.objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        return this
          .filter(m => m.size > 0)
          .map(m => {
            let key;
            for (const k of m.keys()) { key = k; break; }
            let preview;
            try { preview = typeof key === "object" ? (key === null ? "null" : key.constructor && key.constructor.name) : String(key); }
            catch { preview = "?"; }
            return { size: m.size, key: String(preview).slice(0, 44) };
          })
          .sort((a, b) => b.size - a.size)
          .slice(0, 14);
      }`,
    });
    return res.result?.value ?? [];
  });
}

const mapLine = (maps) =>
  maps.map((m) => `${m.size}[${m.key}]`).join(" ");

/** heapUsed after a forced full GC, plus external/rss, from inside the process. */
async function heapAfterGc() {
  return inspectorEval(
    `(async () => { globalThis.gc(); await new Promise(r => setTimeout(r, 50)); globalThis.gc();
      const m = process.memoryUsage();
      return { heapUsed: m.heapUsed, rss: m.rss, external: m.external }; })()`,
  );
}

/**
 * CPU cores the server process is actually burning, sampled over `windowMs`.
 *
 * The single most important number for translating any of this to the real
 * deploy: fly.toml runs one `shared-cpu-1x` machine, so anything that reads
 * above ~1.0 here does not fit there at all, and this dev machine has 18 cores
 * to hide that behind. `process.cpuUsage()` counts user+system microseconds of
 * the process itself, so unlike `ps` it is a rate over a window I choose rather
 * than an average since boot.
 */
async function cpuCores(windowMs = 3000) {
  const read = () =>
    inspectorEval(`(() => { const c = process.cpuUsage(); return c.user + c.system; })()`);
  const before = await read();
  const t = Date.now();
  await sleep(windowMs);
  const after = await read();
  return (after - before) / 1000 / (Date.now() - t);
}

/** Open TCP sockets the process still holds (pg pool and inspector included). */
async function liveSocketCount() {
  return inspectorEval(
    `process._getActiveHandles().filter(h => h && h.constructor && h.constructor.name === "Socket").length`,
  );
}

function rssKb() {
  const { execSync } = require("node:child_process");
  try {
    return Number(execSync(`ps -o rss= -p ${server.pid}`).toString().trim());
  } catch {
    return NaN;
  }
}

// ------------------------------------------------------------- socket client

/**
 * One simulated client. Resolves once the server says `ready`; resolves null if
 * the socket closed first — a refused client is a data point about capacity,
 * not a broken harness.
 */
function connect({ token, ip, onMessage, timeoutMs = 30_000, refused }) {
  return new Promise((resolve) => {
    const ws = new WS(WS_URL, ip ? { headers: { "x-forwarded-for": ip } } : {});
    const st = { ws, token, ip, closed: false, closeCode: null, userId: null };
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      // Distinguish "the server refused me" from "nothing ever came back" —
      // during a reconnect storm those have very different causes.
      refused?.set("timeout", (refused.get("timeout") ?? 0) + 1);
      ws.terminate?.();
      finish(null);
    }, timeoutMs);

    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.type === "ready") finish(st);
      onMessage?.(m, st);
    });
    ws.on("close", (code) => {
      st.closed = true;
      st.closeCode = code;
      if (!settled) refused?.set(code, (refused.get(code) ?? 0) + 1);
      finish(null);
    });
    ws.on("unexpected-response", (_req, res) => {
      refused?.set(`http${res.statusCode}`, (refused.get(`http${res.statusCode}`) ?? 0) + 1);
      finish(null);
    });
    ws.on("error", () => {});
    st.ws = ws;
  });
}

// ------------------------------------------------------------------ fixtures

/** A server with `channels` text channels and an open invite, owned by the
 *  default dev account. Returns { serverId, channels, code }. */
async function createFixture(channelCount = 1) {
  const { json: created } = await api("/api/servers", {
    method: "POST",
    body: { name: `Spike ${Date.now()}` },
  });
  const serverId = created.id ?? created.server?.id;
  const channels = (created.channels ?? []).filter((c) => c.type === "text");
  while (channels.length < channelCount) {
    const { json: extra } = await api(`/api/servers/${serverId}/channels`, {
      method: "POST",
      body: { name: `spike-${channels.length}`, type: "text" },
    });
    channels.push(extra.channel ?? extra);
  }
  const { json: invite } = await api(`/api/servers/${serverId}/invites`, {
    method: "POST",
    body: {},
  });
  const code = invite.invite?.code ?? invite.code;
  if (!serverId || !code) throw new Error("fixture setup failed");
  return { serverId, channels, code };
}

/** Join `tokens` to the invite and return each one's user id. */
async function joinAll(code, tokens, width = 40) {
  const ids = await pooled(
    tokens.map((token) => async () => {
      await tryApi(`/api/invites/${code}/join`, { method: "POST", token });
      const me = await tryApi("/api/me", { token });
      return me.body?.id ?? null;
    }),
    width,
  );
  return ids;
}

// ---------------------------------------------------------------------- modes

/**
 * Suffixes that produce DISTINCT clerk ids but the SAME slugified username.
 *
 * The dev bypass derives the display name from the token suffix
 * (`Dev User <suffix>`, auth/clerk.ts:265), so two simulated accounts normally
 * cannot share a name — which would leave the contended half of
 * `allocateDiscriminator` untested. `slugifyUsername` folds `-` to `_`
 * (users.ts:44) while the token alphabet keeps them distinct, so one separator
 * position is one bit of identity that the username does not see: n positions
 * give 2^n accounts all competing for numbers inside a single name, exactly
 * like 256 people called João signing up in the same minute.
 */
function sameNameSuffixes(count, tag) {
  const letters = "qwertyuiopasdfgh";
  const bits = Math.ceil(Math.log2(Math.max(2, count)));
  if (bits > letters.length) throw new Error("SAME_NAME too large");
  const suffixes = Array.from({ length: count }, (_, i) => {
    let s = tag;
    for (let b = 0; b < bits; b++) {
      s += ((i >> b) & 1 ? "-" : "_") + letters[b];
    }
    return s;
  });
  // The one username they all land on. Every separator is already folded to
  // `_` here, which is the whole trick — so the seeded name and the name the
  // signups actually derive cannot drift apart.
  const username = `dev_user_${suffixes[0].replace(/-/g, "_")}`;
  return { suffixes, username };
}

async function modeSignup() {
  const SIGNUPS = num("SIGNUPS", 200);
  const SAME_NAME = num("SAME_NAME", 256);
  const SEED_TAKEN = num("SEED_TAKEN", 9998);
  const run = Math.floor(Math.random() * 1e6).toString(36);

  spawnServer();
  await waitHealthy();
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

  const before = await pool.query("SELECT count(*)::int AS n FROM users");
  log(`users table starts at ${before.rows[0].n}`);

  // ---- A. distinct display names, all first-time, all at once -------------
  const distinctTokens = Array.from(
    { length: SIGNUPS },
    (_, i) => `${OWNER_TOKEN}:d${run}${i}`,
  );
  log(`A: ${SIGNUPS} concurrent first-time signups, distinct names`);
  const startA = Date.now();
  const resA = await Promise.all(
    distinctTokens.map((token) => tryApi("/api/me", { token })),
  );
  const wallA = (Date.now() - startA) / 1000;
  const byStatusA = resA.reduce(
    (m, r) => m.set(r.status, (m.get(r.status) ?? 0) + 1),
    new Map(),
  );
  log(
    `A: ${SIGNUPS} in ${wallA.toFixed(2)}s (${(SIGNUPS / wallA).toFixed(0)}/s)  ` +
      `statuses ${[...byStatusA].map(([s, n]) => `${s}×${n}`).join(" ")}`,
  );
  log(`A: latency ${fmt(stats(resA.map((r) => r.elapsed)))}`);

  // ---- B. one shared username, all at once --------------------------------
  const sameName = sameNameSuffixes(SAME_NAME, `h${run}`);
  const sameTokens = sameName.suffixes.map((s) => `${OWNER_TOKEN}:${s}`);
  log(`B: ${SAME_NAME} concurrent first-time signups that all slug to "${sameName.username}"`);
  const startB = Date.now();
  const resB = await Promise.all(
    sameTokens.map((token) => tryApi("/api/me", { token })),
  );
  const wallB = (Date.now() - startB) / 1000;
  const byStatusB = resB.reduce(
    (m, r) => m.set(r.status, (m.get(r.status) ?? 0) + 1),
    new Map(),
  );
  const tagsB = resB.filter((r) => r.status === 200).map((r) => r.body.tag);
  log(
    `B: ${SAME_NAME} in ${wallB.toFixed(2)}s (${(SAME_NAME / wallB).toFixed(0)}/s)  ` +
      `statuses ${[...byStatusB].map(([s, n]) => `${s}×${n}`).join(" ")}`,
  );
  log(`B: latency ${fmt(stats(resB.map((r) => r.elapsed)))}`);
  log(
    `B: distinct tags ${new Set(tagsB).size}/${tagsB.length}  ` +
      `distinct usernames ${new Set(tagsB.map((t) => t.split("#")[0])).size}`,
  );

  // ---- C. one signup onto a name whose number space is nearly gone --------
  // The username has to be the one the signup will actually slug to, so the
  // suffix and the seeded name are derived from each other rather than typed
  // twice — seeding a name nobody signs up on measures nothing.
  const seedName = async (suffix, taken, name) => {
    const username = name ?? `dev_user_${suffix}`;
    await pool.query(
      `INSERT INTO users (clerk_id, display_name, username, discriminator)
       SELECT 'seed-${run}-' || $1 || '-' || d, 'Seed', $1, lpad(d::text, 4, '0')
       FROM generate_series(1, $2) AS d
       ON CONFLICT DO NOTHING`,
      [username, taken],
    );
    return username;
  };

  const hotSuffix = `f${run}`;
  await seedName(hotSuffix, SEED_TAKEN);
  const resC = await tryApi("/api/me", { token: `${OWNER_TOKEN}:${hotSuffix}` });
  log(
    `C: signup onto "dev_user_${hotSuffix}" with ${SEED_TAKEN}/9999 taken → ` +
      `${resC.status} in ${resC.elapsed}ms  tag=${resC.body?.tag}`,
  );

  // ---- D. the name is genuinely exhausted: the widen path -----------------
  const fullSuffix = `g${run}`;
  await seedName(fullSuffix, 9999);
  const resD = await tryApi("/api/me", { token: `${OWNER_TOKEN}:${fullSuffix}` });
  log(
    `D: signup onto "dev_user_${fullSuffix}" with 9999/9999 taken → ` +
      `${resD.status} in ${resD.elapsed}ms  tag=${resD.body?.tag}`,
  );

  // ---- F. the launch-day worst case: a spike onto a nearly-full name ------
  // A popular name and a signup spike at the same time. Seeded so there are
  // only just enough numbers left for the whole batch, which is what forces
  // the random probes (users.ts:74) to miss and the linear sweep (users.ts:83)
  // to run — the path that only exists because the old 40-probe version
  // failed here.
  const spike = sameNameSuffixes(SAME_NAME, `k${run}`);
  const free = num("SPIKE_FREE", SAME_NAME + 20);
  await seedName(null, 9999 - free, spike.username);
  const spikeTokens = spike.suffixes.map((s) => `${OWNER_TOKEN}:${s}`);
  log(`F: ${SAME_NAME} concurrent signups onto "${spike.username}" with only ${free} numbers left`);
  const startF = Date.now();
  const resF = await Promise.all(spikeTokens.map((token) => tryApi("/api/me", { token })));
  const wallF = (Date.now() - startF) / 1000;
  const byStatusF = resF.reduce((m, r) => m.set(r.status, (m.get(r.status) ?? 0) + 1), new Map());
  const tagsF = resF.filter((r) => r.status === 200).map((r) => r.body.tag);
  log(
    `F: ${SAME_NAME} in ${wallF.toFixed(2)}s (${(SAME_NAME / wallF).toFixed(0)}/s)  ` +
      `statuses ${[...byStatusF].map(([s, n]) => `${s}×${n}`).join(" ")}`,
  );
  log(`F: latency ${fmt(stats(resF.map((r) => r.elapsed)))}`);
  log(
    `F: distinct tags ${new Set(tagsF).size}/${tagsF.length}  ` +
      `kept the base username: ${tagsF.filter((t) => t.split("#")[0] === spike.username).length}`,
  );

  // ---- integrity ----------------------------------------------------------
  const dupTags = await pool.query(
    `SELECT username, discriminator, count(*) AS n FROM users
     WHERE username IS NOT NULL AND discriminator IS NOT NULL
     GROUP BY 1,2 HAVING count(*) > 1`,
  );
  const dupClerk = await pool.query(
    `SELECT clerk_id, count(*) AS n FROM users GROUP BY 1 HAVING count(*) > 1`,
  );
  const noHandle = await pool.query(
    `SELECT count(*)::int AS n FROM users WHERE username IS NULL OR discriminator IS NULL`,
  );
  log(`integrity: duplicate tags ${dupTags.rowCount}, duplicate clerk_ids ${dupClerk.rowCount}, handle-less rows ${noHandle.rows[0].n}`);

  const text = serverLog.join("");
  const errors = text.match(/Error|error:/g)?.length ?? 0;
  log(`server log lines mentioning an error: ${errors}`);
  const distinctErrors = new Map();
  for (const line of text.split("\n")) {
    const m = /(Error:.*|\[auth\] resolve failed:.*)/.exec(line);
    if (m) distinctErrors.set(m[1].slice(0, 120), (distinctErrors.get(m[1].slice(0, 120)) ?? 0) + 1);
  }
  for (const [msg, n] of distinctErrors) log(`  server error ×${n}: ${msg}`);
  await pool.end();
}

async function modeReconnect() {
  const CLIENTS = num("CLIENTS", 500);
  const RESTART = process.env.RESTART ?? "sigkill";
  const DISTINCT_IPS = process.env.DISTINCT_IPS !== "0";
  const DOWNTIME_MS = num("DOWNTIME_MS", 10_000);
  const run = Math.floor(Math.random() * 1e6).toString(36);

  spawnServer();
  await waitHealthy();
  const { channels, code } = await createFixture(1);
  const channelId = channels[0].id;

  const tokens = Array.from(
    { length: CLIENTS },
    (_, i) => `${OWNER_TOKEN}:r${run}${i}`,
  );
  log(`joining ${CLIENTS} users`);
  await joinAll(code, tokens);

  const ips = tokens.map(() => (DISTINCT_IPS ? fakeIp() : "10.0.0.1"));
  log(`opening ${CLIENTS} sockets (distinct client IPs: ${DISTINCT_IPS})`);
  const clients = [];
  for (let i = 0; i < CLIENTS; i++) {
    const c = await connect({ token: tokens[i], ip: ips[i] });
    if (c) {
      c.ws.send(JSON.stringify({ type: "join-channel", channelId }));
      clients.push({ token: tokens[i], ip: ips[i] });
    }
  }
  log(`${clients.length}/${CLIENTS} sockets established`);
  log(`server maps before the kill: ${mapLine(await liveMaps())}`);

  // ---- the event ----------------------------------------------------------
  log(`--- ${RESTART.toUpperCase()} the server ---`);
  const downAt = Date.now();
  // `child.killed` only means "a signal was sent", not "the process is gone",
  // so the fallback has to be driven off the exit event or it never fires.
  const exited = new Promise((r) => server.once("exit", r));
  let drainNote = "";
  if (RESTART === "sigterm") {
    killServer("SIGTERM");
    // fly.toml sets kill_timeout = 30, so 30s is exactly how long the platform
    // waits before it stops being polite. Measuring against the same number is
    // the point: a drain that does not finish inside it is a hard kill on
    // every single deploy.
    const outcome = await Promise.race([
      exited.then(() => "exited"),
      sleep(30_000).then(() => "timeout"),
    ]);
    if (outcome === "timeout") {
      drainNote = " — SIGTERM DID NOT DRAIN IN 30s; escalated to SIGKILL (fly kill_timeout would do the same)";
      killServer("SIGKILL");
    }
  } else {
    killServer("SIGKILL");
  }
  await exited;
  log(`server exited after ${Date.now() - downAt}ms${drainNote}`);

  // ---- clients reconnect on the real schedule -----------------------------
  const recovered = [];
  const refused = new Map();
  let stuck = 0;
  const RECONNECT_DEADLINE_MS = 180_000;

  const runs = clients.map(async (c) => {
    let attempt = 0;
    const started = Date.now();
    for (;;) {
      // client/src/lib/realtime.ts:148 — min(1000 * 2^attempt, 30000) + rand*500
      const delay = Math.min(1000 * 2 ** attempt, 30_000) + Math.random() * 500;
      await sleep(delay);
      if (Date.now() - started > RECONNECT_DEADLINE_MS) {
        stuck++;
        return;
      }
      const st = await connect({ token: c.token, ip: c.ip, timeoutMs: 20_000, refused });
      if (st) {
        recovered.push({ ms: Date.now() - downAt, attempts: attempt + 1 });
        st.ws.send(JSON.stringify({ type: "join-channel", channelId }));
        return;
      }
      attempt++;
    }
  });

  // Restart while the clients are already backing off, the way a deploy or an
  // OOM-kill really goes: the outage has a duration, it is not instantaneous.
  // A container that comes back in 200ms is the easy case and flatters the
  // result — every client is still on attempt 0, so the backoff spreads them
  // for free. A real rollout is seconds, by which point they have escalated
  // and their retries have started to line up.
  await sleep(DOWNTIME_MS);
  spawnServer();
  await waitHealthy();
  const upAt = Date.now();
  log(`server healthy again ${upAt - downAt}ms after it died`);

  await Promise.all(runs);

  const s = stats(recovered.map((r) => r.ms));
  const attempts = recovered.reduce((m, r) => m.set(r.attempts, (m.get(r.attempts) ?? 0) + 1), new Map());
  log("");
  log(`=== RECONNECT (${clients.length} clients, ${RESTART}, distinct IPs ${DISTINCT_IPS}) ===`);
  log(`downtime            ${upAt - downAt}ms (requested ${DOWNTIME_MS}ms)`);
  log(`recovered           ${recovered.length}/${clients.length}   never recovered: ${stuck}`);
  log(`time to back online (from the kill) ${fmt(s)}`);
  log(`attempts needed     ${[...attempts].sort((a, b) => a[0] - b[0]).map(([a, n]) => `${a}→${n}`).join("  ")}`);
  if (refused.size) log(`refusals ${[...refused].map(([c, n]) => `${c}×${n}`).join(" ")}`);
  log(`server maps after recovery:  ${mapLine(await liveMaps())}`);
  // Which server-side guard fired matters: addressLimit is the shared bucket,
  // authTimeout is the 10s AUTH_TIMEOUT_MS (ws/index.ts:34) expiring before a
  // DB-backed auth could finish, and they call for opposite fixes.
  const text = serverLog.join("");
  for (const event of ["ws.addressLimit", "ws.authTimeout", "ws.authFail", "ws.flood", "ws.heartbeatTerminate"]) {
    // `logEvent` emits `[pqp] ws.addressLimit connId=…` — key=value, not JSON
    // (server/src/lib/log.ts), so match the prefix rather than quotes.
    const n = text.match(new RegExp(`\\[pqp\\] ${event.replace(".", "\\.")}\\b`, "g"))?.length ?? 0;
    if (n) log(`server event ${event}: ${n}`);
  }
}

async function modePool() {
  const POOL_SIZES = (process.env.POOL_SIZES ?? "5,10,25")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter(Boolean);
  const CONCURRENCY = num("CONCURRENCY", 200);
  const SEED_MESSAGES = num("SEED_MESSAGES", 2000);
  const REQUESTS = num("REQUESTS", 1500);
  const run = Math.floor(Math.random() * 1e6).toString(36);

  // Seed once, outside the measured servers, so every pool size reads the same
  // data and the numbers are comparable.
  spawnServer({ PG_POOL_MAX: "10" });
  await waitHealthy();
  const { channels, code } = await createFixture(1);
  const channelId = channels[0].id;
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE clerk_id = 'dev_local_user'`,
  );
  await pool.query(
    `INSERT INTO messages (channel_id, author_id, body)
     SELECT $1, $2, 'seed message ' || d FROM generate_series(1, $3) AS d`,
    [channelId, rows[0].id, SEED_MESSAGES],
  );
  log(`seeded ${SEED_MESSAGES} messages in channel ${channelId}`);
  const tokens = Array.from({ length: 50 }, (_, i) => `${OWNER_TOKEN}:p${run}${i}`);
  await joinAll(code, tokens);
  killServer();
  await new Promise((r) => server.once("exit", r));

  const results = [];
  for (const poolMax of POOL_SIZES) {
    spawnServer({ PG_POOL_MAX: String(poolMax) });
    await waitHealthy();
    log(`--- PG_POOL_MAX=${poolMax}, ${REQUESTS} requests, ${CONCURRENCY} in flight ---`);

    const jobs = Array.from({ length: REQUESTS }, (_, i) => () =>
      tryApi(`/api/channels/${channelId}/messages?limit=50`, {
        token: tokens[i % tokens.length],
      }),
    );
    // Sample how many TCP connections the server has actually accepted while
    // the sweep runs. If this stays far below CONCURRENCY, the requests are
    // queued in front of the process (kernel accept backlog / event loop) and
    // never reach the pool's own wait queue — which is the difference between
    // "the pool is the bottleneck" and "the pool is merely downstream of it".
    let peakSockets = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        try {
          peakSockets = Math.max(peakSockets, await liveSocketCount());
        } catch {
          /* inspector busy */
        }
        await sleep(150);
      }
    })();

    const started = Date.now();
    const res = await pooled(jobs, CONCURRENCY);
    const wall = (Date.now() - started) / 1000;
    sampling = false;
    await sampler;

    const byStatus = res.reduce((m, r) => m.set(r.status, (m.get(r.status) ?? 0) + 1), new Map());
    const ok = res.filter((r) => r.status === 200);
    const pgActive = await (async () => {
      const p = new Pool({ connectionString: DATABASE_URL, max: 2 });
      const q = await p.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`,
      );
      await p.end();
      return q.rows[0].n;
    })();
    const row = {
      poolMax,
      rps: REQUESTS / wall,
      byStatus: [...byStatus].map(([s, n]) => `${s}×${n}`).join(" "),
      latency: stats(ok.map((r) => r.elapsed)),
      pgActive,
      sampleError: res.find((r) => r.status >= 500)?.body,
    };
    results.push(row);
    log(
      `PG_POOL_MAX=${poolMax}  ${row.rps.toFixed(0)} req/s  statuses ${row.byStatus}  ` +
        `pg backends ${pgActive}  peak accepted sockets ${peakSockets}`,
    );
    log(`  latency ${fmt(row.latency)}`);
    if (row.sampleError) log(`  first 5xx body: ${row.sampleError}`);
    const timeouts =
      serverLog.join("").match(/timeout exceeded when trying to connect/g)?.length ?? 0;
    log(`  pool connection timeouts logged: ${timeouts}`);
    killServer();
    await new Promise((r) => server.once("exit", r));
    await sleep(500);
  }

  log("");
  log("=== POOL SATURATION ===");
  for (const r of results) {
    log(
      `PG_POOL_MAX=${String(r.poolMax).padStart(3)}  ${r.rps.toFixed(0).padStart(5)} req/s  ` +
        `${fmt(r.latency)}  ${r.byStatus}`,
    );
  }
  await pool.end();
}

async function modeMixed() {
  const CLIENTS = num("CLIENTS", 300);
  const SENDERS = num("SENDERS", 30);
  const TYPERS = num("TYPERS", 150);
  const REACTORS = num("REACTORS", 30);
  const SWITCHERS = num("SWITCHERS", 50);
  const CHANNELS = num("CHANNELS", 5);
  const SECONDS = num("SECONDS", 60);
  const run = Math.floor(Math.random() * 1e6).toString(36);

  spawnServer();
  await waitHealthy();
  const { serverId, channels, code } = await createFixture(CHANNELS);

  // Members who are not connected still cost something on every single
  // message: `notifyChannelActivity` (ws/chat.ts) calls `getChannelAudience`
  // (services/servers.ts:717), which is uncached and returns ONE ROW PER
  // MEMBER of the server. SEED_MEMBERS is how you find out what a 5,000-member
  // community server does to message throughput without needing 5,000 sockets.
  const SEED_MEMBERS = num("SEED_MEMBERS", 0);
  if (SEED_MEMBERS > 0) {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await pool.query(
      `INSERT INTO users (clerk_id, display_name, username, discriminator)
       SELECT 'ghost-${run}-' || d, 'Ghost', 'ghost_${run}_' || d, lpad(((d % 9999) + 1)::text, 4, '0')
       FROM generate_series(1, $1) AS d`,
      [SEED_MEMBERS],
    );
    await pool.query(
      `INSERT INTO server_members (server_id, user_id, role)
       SELECT $1, id, 'member' FROM users WHERE clerk_id LIKE 'ghost-${run}-%'
       ON CONFLICT DO NOTHING`,
      [serverId],
    );
    await pool.end();
    log(`seeded ${SEED_MEMBERS} additional (disconnected) members on the server`);
  }

  const tokens = Array.from({ length: CLIENTS }, (_, i) => `${OWNER_TOKEN}:m${run}${i}`);
  log(`joining ${CLIENTS} users to ${CHANNELS} channels`);
  const userIds = await joinAll(code, tokens);

  const counters = {
    msgSent: 0,
    msgRecv: 0,
    typingSent: 0,
    typingRecv: 0,
    reactSent: 0,
    reactRecv: 0,
    joinsSent: 0,
    presenceRecv: 0,
    activityRecv: 0,
    errors: 0,
  };
  const msgLatency = [];
  const typingLatency = [];
  /** userId → when that user's last typing frame left the harness. */
  const typingStamp = new Map();
  const lastMessageId = new Map();

  const clients = [];
  for (let i = 0; i < CLIENTS; i++) {
    const channel = channels[i % CHANNELS];
    const st = await connect({
      token: tokens[i],
      ip: fakeIp(),
      onMessage: (m) => {
        if (m.type === "message-broadcast") {
          counters.msgRecv++;
          const stamp = Number(String(m.message?.body ?? "").split("|")[1]);
          if (Number.isFinite(stamp)) msgLatency.push(Date.now() - stamp);
          lastMessageId.set(m.message.channelId ?? channel.id, m.message.id);
        } else if (m.type === "typing-broadcast") {
          counters.typingRecv++;
          const sentAt = typingStamp.get(m.userId);
          if (sentAt) typingLatency.push(Date.now() - sentAt);
        } else if (m.type === "reaction-broadcast") {
          counters.reactRecv++;
        } else if (m.type === "presence-update") {
          counters.presenceRecv++;
        } else if (m.type === "channel-activity") {
          counters.activityRecv++;
        } else if (m.type === "error") {
          counters.errors++;
        }
      },
    });
    if (st) {
      st.userId = userIds[i];
      st.channelId = channel.id;
      st.ws.send(JSON.stringify({ type: "join-channel", channelId: channel.id }));
      clients.push(st);
    }
  }
  log(`${clients.length}/${CLIENTS} sockets open`);
  await sleep(1000);

  const timers = [];
  const alive = (c) => c.ws.readyState === 1;

  // Messages: 1/s each, under the 2/s per-user server limit.
  for (let i = 0; i < SENDERS; i++) {
    const c = clients[i];
    timers.push(
      setInterval(() => {
        if (!alive(c)) return;
        c.ws.send(
          JSON.stringify({
            type: "message-create",
            channelId: c.channelId,
            body: `mix|${Date.now()}`,
          }),
        );
        counters.msgSent++;
      }, 1000),
    );
  }

  // Typing: the app's highest-frequency frame. `typingLimiter` is capacity 5 /
  // refill 1 per second per user (ws/chat.ts:43), so 2/s deliberately runs it
  // slightly over budget — a real person typing does exactly that.
  for (let i = 0; i < TYPERS; i++) {
    const c = clients[(i + SENDERS) % clients.length];
    timers.push(
      setInterval(() => {
        if (!alive(c)) return;
        typingStamp.set(c.userId, Date.now());
        c.ws.send(JSON.stringify({ type: "typing", channelId: c.channelId }));
        counters.typingSent++;
      }, 500),
    );
  }

  // Reactions: toggled on whatever message that channel last saw.
  for (let i = 0; i < REACTORS; i++) {
    const c = clients[(i + SENDERS + TYPERS) % clients.length];
    timers.push(
      setInterval(() => {
        if (!alive(c)) return;
        const messageId = lastMessageId.get(c.channelId);
        if (!messageId) return;
        c.ws.send(
          JSON.stringify({
            type: "reaction-toggle",
            channelId: c.channelId,
            messageId,
            emoji: "🔥",
          }),
        );
        counters.reactSent++;
      }, 1000),
    );
  }

  // Channel switching: leave + join, which re-runs canAccessChannel and
  // republishes presence to both rosters.
  for (let i = 0; i < SWITCHERS; i++) {
    const c = clients[(i + SENDERS + TYPERS + REACTORS) % clients.length];
    let n = 0;
    timers.push(
      setInterval(() => {
        if (!alive(c)) return;
        const next = channels[++n % CHANNELS];
        c.channelId = next.id;
        c.ws.send(JSON.stringify({ type: "join-channel", channelId: next.id }));
        counters.joinsSent++;
      }, 3000),
    );
  }

  const started = Date.now();
  while (Date.now() - started < SECONDS * 1000) {
    await sleep(5000);
    log(
      `msg ${counters.msgSent}/${counters.msgRecv}  typing ${counters.typingSent}/${counters.typingRecv}  ` +
        `react ${counters.reactSent}/${counters.reactRecv}  switch ${counters.joinsSent}  ` +
        `open ${clients.filter(alive).length}/${clients.length}  rss ${(rssKb() / 1024).toFixed(0)}MB  ` +
        `cpu ${(await cpuCores(1000)).toFixed(2)} cores`,
    );
  }
  const cpu = await cpuCores(5000);
  const maps = await liveMaps();
  timers.forEach(clearInterval);
  await sleep(2000);
  const elapsed = (Date.now() - started) / 1000;

  log("");
  log(`=== MIXED WORKLOAD (${clients.length} sockets, ${CHANNELS} channels, ${SECONDS}s) ===`);
  const per = (n) => `${n} (${(n / elapsed).toFixed(0)}/s)`;
  log(`messages    sent ${per(counters.msgSent)}   fanned out ${per(counters.msgRecv)}`);
  log(`typing      sent ${per(counters.typingSent)}   fanned out ${per(counters.typingRecv)}`);
  log(`reactions   sent ${per(counters.reactSent)}   fanned out ${per(counters.reactRecv)}`);
  log(`presence    ${per(counters.presenceRecv)}   channel-activity ${per(counters.activityRecv)}`);
  log(`channel switches ${per(counters.joinsSent)}`);
  log(`total frames out ${per(counters.msgRecv + counters.typingRecv + counters.reactRecv + counters.presenceRecv + counters.activityRecv)}`);
  log(`message latency ${fmt(stats(msgLatency))}`);
  log(`typing  latency ${fmt(stats(typingLatency))}`);
  log(`sockets still open ${clients.filter(alive).length}/${clients.length}   ws errors ${counters.errors}`);
  log(`server CPU under this load: ${cpu.toFixed(2)} cores  (fly.toml runs ONE shared-cpu-1x)`);
  log(`server maps: ${mapLine(maps)}`);
}

async function modeSoak() {
  const CLIENTS = num("CLIENTS", 300);
  const SECONDS = num("SECONDS", 600);
  const CHURN_ROUNDS = num("CHURN_ROUNDS", 3);
  const CHURN_SIZE = num("CHURN_SIZE", 500);
  const CHANNELS = num("CHANNELS", 5);
  const run = Math.floor(Math.random() * 1e6).toString(36);

  spawnServer();
  await waitHealthy();
  const { channels, code } = await createFixture(CHANNELS);
  const tokens = Array.from({ length: CLIENTS }, (_, i) => `${OWNER_TOKEN}:s${run}${i}`);
  await joinAll(code, tokens);

  const baseline = await heapAfterGc();
  log(`baseline (no sockets): heapUsed ${(baseline.heapUsed / 1e6).toFixed(1)}MB  rss ${(baseline.rss / 1e6).toFixed(0)}MB`);

  let recv = 0;
  const clients = [];
  for (let i = 0; i < CLIENTS; i++) {
    const channel = channels[i % CHANNELS];
    const st = await connect({
      token: tokens[i],
      ip: fakeIp(),
      onMessage: () => recv++,
    });
    if (st) {
      st.channelId = channel.id;
      st.ws.send(JSON.stringify({ type: "join-channel", channelId: channel.id }));
      clients.push(st);
    }
  }
  log(`${clients.length}/${CLIENTS} sockets open`);

  const timers = [];
  for (let i = 0; i < Math.min(30, clients.length); i++) {
    const c = clients[i];
    timers.push(
      setInterval(() => {
        if (c.ws.readyState !== 1) return;
        c.ws.send(
          JSON.stringify({ type: "message-create", channelId: c.channelId, body: `soak|${Date.now()}` }),
        );
      }, 1000),
    );
  }
  for (let i = 0; i < Math.min(150, clients.length); i++) {
    const c = clients[i];
    timers.push(
      setInterval(() => {
        if (c.ws.readyState !== 1) return;
        c.ws.send(JSON.stringify({ type: "typing", channelId: c.channelId }));
      }, 500),
    );
  }

  const samples = [];
  const started = Date.now();
  while (Date.now() - started < SECONDS * 1000) {
    await sleep(30_000);
    const mem = await heapAfterGc();
    const sockets = await liveSocketCount();
    const maps = await liveMaps();
    samples.push({ t: (Date.now() - started) / 1000, ...mem, sockets, maps });
    log(
      `t+${((Date.now() - started) / 1000).toFixed(0)}s  heapUsed ${(mem.heapUsed / 1e6).toFixed(1)}MB  ` +
        `rss ${(mem.rss / 1e6).toFixed(0)}MB  tcp ${sockets}  frames in ${recv}\n        maps ${mapLine(maps)}`,
    );
  }
  timers.forEach(clearInterval);

  const steady = await heapAfterGc();
  log(`after ${SECONDS}s of load: heapUsed ${(steady.heapUsed / 1e6).toFixed(1)}MB  rss ${(steady.rss / 1e6).toFixed(0)}MB`);

  // ---- disconnect everyone: does the process give the memory back? --------
  for (const c of clients) c.ws.close();
  await sleep(5000);
  const drained = await heapAfterGc();
  const drainedSockets = await liveSocketCount();
  log(
    `after every socket closed: heapUsed ${(drained.heapUsed / 1e6).toFixed(1)}MB  ` +
      `rss ${(drained.rss / 1e6).toFixed(0)}MB  tcp sockets ${drainedSockets}`,
  );
  log(`maps after drain: ${mapLine(await liveMaps())}`);
  log(`sets  after drain: ${mapLine(await liveMaps("Set.prototype"))}`);

  // ---- churn: N distinct accounts connect and immediately leave -----------
  // Distinct accounts, because the maps that could leak are keyed by identity
  // (`userCache` in auth/clerk.ts:190, the per-user rate-limit buckets), not by
  // socket — reconnecting the same 300 users would never show it.
  for (let round = 0; round < CHURN_ROUNDS; round++) {
    const churnTokens = Array.from(
      { length: CHURN_SIZE },
      (_, i) => `${OWNER_TOKEN}:c${run}${round}x${i}`,
    );
    const batch = [];
    for (const token of churnTokens) {
      const st = await connect({ token, ip: fakeIp(), timeoutMs: 20_000 });
      if (st) batch.push(st);
    }
    for (const c of batch) c.ws.close();
    await sleep(3000);
    const mem = await heapAfterGc();
    const socks = await liveSocketCount();
    log(
      `churn round ${round + 1}: +${batch.length} accounts connected and gone  ` +
        `heapUsed ${(mem.heapUsed / 1e6).toFixed(1)}MB  rss ${(mem.rss / 1e6).toFixed(0)}MB  tcp ${socks}\n        maps ${mapLine(await liveMaps())}`,
    );
  }

  log("");
  log("=== SOAK ===");
  log(`baseline heapUsed   ${(baseline.heapUsed / 1e6).toFixed(1)}MB`);
  log(`under load          ${(steady.heapUsed / 1e6).toFixed(1)}MB`);
  log(`all sockets closed  ${(drained.heapUsed / 1e6).toFixed(1)}MB`);
  for (const s of samples) {
    log(`  t+${String(Math.round(s.t)).padStart(4)}s  heap ${(s.heapUsed / 1e6).toFixed(1)}MB  rss ${(s.rss / 1e6).toFixed(0)}MB  tcp ${s.sockets}`);
  }
}

// ------------------------------------------------------------------------ go

const MODES = {
  signup: modeSignup,
  reconnect: modeReconnect,
  pool: modePool,
  mixed: modeMixed,
  soak: modeSoak,
};

try {
  const fn = MODES[MODE];
  if (!fn) throw new Error(`unknown MODE=${MODE}; one of ${Object.keys(MODES).join(", ")}`);
  log(`MODE=${MODE}  PORT=${PORT}  DATABASE_URL=${DATABASE_URL.replace(/:[^:@/]*@/, ":***@")}`);
  await fn();
} catch (error) {
  log(`HARNESS ERROR ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  killServer();
  await sleep(200);
  process.exit(process.exitCode ?? 0);
}
