/**
 * party-storm.ts — one configurable, presenter-free watch-party load harness.
 *
 * Born from the 2026-09-12 watch-party post-mortem (docs/plans/
 * WATCH_PARTY_POSTMORTEM_2026-09-12.md, A2/A3) and CLAUDE.md pitfall 17. It
 * drives the tiers of a large watch party that DO NOT need a live SFU/egress:
 *
 *   - WS tier      : N concurrent app sockets, each auth + join-channel +
 *                    join-voice-room (LiveKit-pinned room, presence/roster
 *                    only, no media), plus a reconnect-storm wave.
 *   - DB tier      : a reconnect storm of cold-browser bootstraps from many
 *                    distinct load-test identities, to saturate the Postgres
 *                    pool and prove the circuit breaker (pitfall 17) sheds
 *                    load with fast 503s while /health stays 200.
 *   - HLS tier     : a viewer-poll driver against a CONFIGURABLE playlist base
 *                    (the API origin proxy OR the hls.pqp.gg edge Worker), to
 *                    measure origin-fetch coalescing. Needs a LIVE session
 *                    (a real presenter + egress) to produce real playlists; a
 *                    probe mode validates the path/token when none is live.
 *
 * What this harness CANNOT synthesize: real HLS segments. Those exist only
 * when a real presenter publishes screen-share H.264 to LiveKit and the remux
 * transcodes it. Use `src/index.ts` (synthetic 720p30 presenter + SFU
 * receivers) and `src/hls-audience.ts` for that; this file covers everything
 * else and is the orchestrator for a run without a presenter.
 *
 * TARGET IS FULLY CONFIGURABLE, WITH A HARD ISOLATION GATE. Point it at
 * staging today, or a Vultr shadow-prod box later, via PQP_LOAD_API_URL /
 * PQP_LOAD_WS_URL / PQP_LOAD_HLS_BASE_URL. The gate REFUSES the real
 * production names (pqp.gg / api.pqp.gg / hls.pqp.gg / *.pqp.gg) and any
 * Postgres-looking host, full stop. It also requires https:/wss: (this
 * harness attaches LOAD_TEST_TOKEN and ADMIN_METRICS_TOKEN to every request)
 * and refuses private-use/link-local/cloud-metadata addresses, both with a
 * loopback exemption for local dev and an explicit
 * PQP_LOAD_ALLOW_PRIVATE_HOST=1 opt-out for a genuinely private shadow box.
 * It uses only HTTP + WebSocket; it never opens a database connection, so
 * the DB it hits never sees more than the server's own pool of connections
 * no matter how hard this pushes.
 *
 * Usage (tsx):
 *   PQP_LOAD_TARGET=staging LOAD_TEST_TOKEN=... ADMIN_METRICS_TOKEN=... \
 *   pnpm exec tsx src/party-storm.ts <command> [flags]
 *
 * Commands:
 *   provision  --out <manifest.json>            create server+channels+invite
 *   db-storm   [--manifest f] --concurrency N --seconds S   pool/breaker storm
 *   ws-storm   --manifest f --sockets N --hold S [--reconnect-at S]
 *   hls        --manifest f --channel <id> --started <ms> --tokens f --viewers N
 *   full       --manifest f --sockets N --db-concurrency N --seconds S
 */

/* eslint-disable no-console -- a CLI report is its stdout */
import { readFileSync, writeFileSync } from "node:fs";
// Uses Node 22+/24 GLOBAL WebSocket and fetch — zero npm dependencies, so it
// runs with `node party-storm.ts` (native TS stripping) without installing the
// package's native LiveKit bindings. The global WebSocket is the WHATWG API:
// no custom headers and no perMessageDeflate option (a browser negotiates
// deflate; this client connects uncompressed, which is a heavier, conservative
// load on the server's fan-out). Machine pinning (fly-force-instance-id) is
// therefore unavailable here; it is only needed for the 2-machine rehearsal,
// and staging runs one machine.

// ------------------------------------------------------------------ config

const DEFAULT_API = "https://pqp-api-staging.fly.dev";
const DEFAULT_WS = "wss://pqp-api-staging.fly.dev/ws";
const HTTP_TIMEOUT_MS = 15_000;
const WELCOME_TIMEOUT_MS = 12_000;

interface Safe {
  apiUrl: string;
  wsUrl: string;
  hlsBaseUrl: string;
  token: string;
  metricsToken: string;
  machineIds?: string[];
}

/** Loopback hostnames, allowed to stay on a plain http:/ws: scheme for local dev. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Whether `host` is a private-use, link-local, or cloud-metadata address
 * (RFC 1918, RFC 3927/4291, and the well-known 169.254.169.254 / *.internal
 * metadata endpoints every cloud provider answers on). None of those are
 * "staging" or "a shadow box" — they are exactly the addresses a
 * misconfigured or attacker-controlled env var would use to redirect this
 * harness's bearer/admin tokens off the intended target (Farol review, PR
 * #663). Loopback is handled separately and is not private for this check.
 */
function isPrivateOrMetadataHost(host: string): boolean {
  if (host === "metadata.google.internal" || host === "metadata") {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 127) return true; // loopback range beyond 127.0.0.1
    if (a === 0) return true; // "this network"
  }
  if (host.startsWith("fd") || host.startsWith("fc") || host.startsWith("fe80:")) {
    return true; // IPv6 unique-local / link-local
  }
  return false;
}

/** Hosts that must never be load-tested, whatever the flags say. */
function assertNotProduction(u: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error(`${label} is not a valid URL: ${u}`);
  }
  // Canonicalize: lowercase, and strip a trailing dot (a bare hostname and
  // its FQDN form with a trailing "." resolve identically but would
  // otherwise dodge a plain string comparison below).
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  // The production edge, API and apex, and anything under the real zone.
  if (host === "pqp.gg" || host.endsWith(".pqp.gg")) {
    throw new Error(
      `refusing a production host for ${label}: ${host}. This harness is for staging or a shadow box only.`,
    );
  }
  // A Postgres endpoint must never be a target: this harness speaks HTTP/WS,
  // never SQL, and pointing it at a DB host is always a mistake.
  if (
    host.includes("flympg") ||
    host.includes("pqp-db") ||
    /:(5432|16751)(\/|$)/.test(u) ||
    u.startsWith("postgres://") ||
    u.startsWith("postgresql://")
  ) {
    throw new Error(`refusing a database host for ${label}: ${u}`);
  }
  const isLoopback = LOOPBACK_HOSTS.has(host);
  // This harness attaches LOAD_TEST_TOKEN and ADMIN_METRICS_TOKEN to every
  // request; a plain http:/ws: target puts both on the wire in the clear.
  // Loopback is exempt so local dev against `pnpm dev` keeps working.
  const scheme = parsed.protocol;
  const isSecureScheme = scheme === "https:" || scheme === "wss:";
  if (!isSecureScheme && !isLoopback) {
    throw new Error(
      `${label} must use https:// or wss:// (got ${scheme}) unless the host is loopback: ${u}`,
    );
  }
  // Private/link-local/metadata addresses are refused by default: a real
  // staging or shadow-prod target has a public DNS name and a real cert, not
  // an internal address the harness's tokens should never reach. An operator
  // who genuinely runs a shadow box on a private network can opt in.
  if (!isLoopback && isPrivateOrMetadataHost(host) && process.env.PQP_LOAD_ALLOW_PRIVATE_HOST !== "1") {
    throw new Error(
      `refusing a private/link-local/metadata host for ${label}: ${host}. Set PQP_LOAD_ALLOW_PRIVATE_HOST=1 to override for an intentionally private shadow box.`,
    );
  }
}

function assertSafe(): Safe {
  const target = process.env.PQP_LOAD_TARGET;
  if (!target) {
    throw new Error(
      "set PQP_LOAD_TARGET (e.g. 'staging' or 'shadow') to acknowledge this is not production",
    );
  }
  const token = process.env.LOAD_TEST_TOKEN;
  if (!token || token.length < 32) {
    throw new Error("LOAD_TEST_TOKEN must be set (>=32 chars); it only works on -staging Fly apps / non-production hosts");
  }
  const apiUrl = (process.env.PQP_LOAD_API_URL ?? DEFAULT_API).replace(/\/$/, "");
  const wsUrl = process.env.PQP_LOAD_WS_URL ?? DEFAULT_WS;
  const hlsBaseUrl = (process.env.PQP_LOAD_HLS_BASE_URL ?? `${apiUrl}/api/voice/hls-playlist`).replace(/\/$/, "");
  assertNotProduction(apiUrl, "PQP_LOAD_API_URL");
  assertNotProduction(wsUrl, "PQP_LOAD_WS_URL");
  assertNotProduction(hlsBaseUrl, "PQP_LOAD_HLS_BASE_URL");
  const machineIdsRaw = process.env.PQP_LOAD_MACHINE_IDS;
  const machineIds = machineIdsRaw
    ? machineIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  return {
    apiUrl,
    wsUrl,
    hlsBaseUrl,
    token,
    metricsToken: process.env.ADMIN_METRICS_TOKEN ?? "",
    machineIds,
  };
}

// --------------------------------------------------------------------- args

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}
function numArg(name: string, fallback: number): number {
  const v = arg(name);
  return v === "" ? fallback : Number(v);
}
function required(name: string): string {
  const v = arg(name);
  if (!v) throw new Error(`missing required flag ${name}`);
  return v;
}
function tokenFor(safe: Safe, suffix: string): string {
  return `${safe.token}:${suffix}`;
}
const RUN_ID = process.env.TEST_RUN_ID || `ps${Date.now().toString(36)}`;

// --------------------------------------------------------------------- http

interface HttpResult {
  status: number;
  ms: number;
  retryAfter: string | null;
  body?: unknown;
  error?: string;
}
async function api(
  base: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  const started = Date.now();
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    const retryAfter = res.headers.get("retry-after");
    const text = await res.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text.slice(0, 200);
    }
    return { status: res.status, ms, retryAfter, body: parsed };
  } catch (e) {
    return {
      status: 0,
      ms: Date.now() - started,
      retryAfter: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Throws on a genuine setup failure (network error, timeout, auth failure,
 * server error) instead of letting the caller silently open a WS seat that
 * never actually passed the age gate (Farol review, PR #663) — a failure
 * here must count as a join failure, not disappear into a later, unrelated-
 * looking socket error.
 */
async function passAgeGate(base: string, token: string): Promise<void> {
  const me = await api(base, token, "GET", "/api/me");
  if (me.status !== 200) {
    throw new Error(`age-gate check failed: GET /api/me -> ${me.status}`);
  }
  const ageGate = (me.body as { ageGate?: string } | undefined)?.ageGate;
  if (ageGate !== "passed") {
    const res = await api(base, token, "POST", "/api/me/age-check", { dateOfBirth: "1990-01-01" });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`age-gate POST failed: ${res.status}`);
    }
  }
}

// ---------------------------------------------------------------- manifest

interface Manifest {
  version: 1;
  runId: string;
  apiUrl: string;
  wsUrl: string;
  serverId: string;
  textChannelId: string;
  voiceChannelId: string;
  inviteCode: string;
  createdAt: string;
}
function readManifest(): Manifest {
  return JSON.parse(readFileSync(required("--manifest"), "utf8")) as Manifest;
}

// ------------------------------------------------------------------ metrics

interface MetricSample {
  atMs: number;
  health: number | null;
  ready: number | null;
  readyQueued: number | null;
  poolBusy: number | null;
  poolWaiting: number | null;
  poolMax: number | null;
  peakWaiting: number | null;
  breakerState: string | null;
  breakerOpened: number | null;
  breakerRejected: number | null;
  cacheHits: number | null;
  cacheMisses: number | null;
  cacheCoalesced: number | null;
  cacheStale: number | null;
  sockets: number | null;
  canaryStatus: number | null;
  canaryMs: number | null;
}

// Partial shapes of the two JSON bodies this sampler reads. Only the fields
// used below; everything is optional because a breaker-open /ready or a
// truncated metrics payload legitimately omits them.
interface AdminMetricsBody {
  runtime?: {
    pool?: { busy?: number; waiting?: number; max?: number };
    peakPoolWaiting?: number;
    db?: { breaker?: { state?: string; opened?: number; rejected?: number } };
    sockets?: number;
  };
  readCache?: { hits?: number; misses?: number; coalesced?: number; staleServed?: number };
}
interface ReadyBody {
  checks?: { pool?: { queued?: number } };
}

async function sampleOnce(safe: Safe): Promise<MetricSample> {
  const at = Date.now();
  const [health, ready, metrics, canary] = await Promise.all([
    fetch(`${safe.apiUrl}/health`, { signal: AbortSignal.timeout(8000) })
      .then((r) => r.status)
      .catch(() => null),
    fetch(`${safe.apiUrl}/ready`, { signal: AbortSignal.timeout(8000) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
      .catch(() => null),
    safe.metricsToken
      ? api(safe.apiUrl, safe.metricsToken, "GET", "/api/admin/metrics").catch(() => null)
      : Promise.resolve(null),
    // A canary DB-dependent request from a fresh identity: when the breaker is
    // open this should come back as a fast 503, not a 30s hang.
    api(safe.apiUrl, tokenFor(safe, `canary_${at % 100000}`), "GET", "/api/me"),
  ]);
  const m = ((metrics && (metrics as HttpResult).body) ?? null) as AdminMetricsBody | null;
  const runtime = m?.runtime ?? {};
  const pool = runtime.pool ?? {};
  const breaker = runtime.db?.breaker ?? {};
  const cache = m?.readCache ?? {};
  const readyBody = (((ready as { body?: unknown } | null)?.body ?? null) as ReadyBody | null);
  return {
    atMs: at,
    health: health as number | null,
    ready: (ready as { status?: number } | null)?.status ?? null,
    readyQueued: readyBody?.checks?.pool?.queued ?? null,
    poolBusy: pool.busy ?? null,
    poolWaiting: pool.waiting ?? null,
    poolMax: pool.max ?? null,
    peakWaiting: runtime.peakPoolWaiting ?? null,
    breakerState: breaker.state ?? null,
    breakerOpened: breaker.opened ?? null,
    breakerRejected: breaker.rejected ?? null,
    cacheHits: cache.hits ?? null,
    cacheMisses: cache.misses ?? null,
    cacheCoalesced: cache.coalesced ?? null,
    cacheStale: cache.staleServed ?? null,
    sockets: runtime.sockets ?? null,
    canaryStatus: (canary as HttpResult).status,
    canaryMs: (canary as HttpResult).ms,
  };
}

function startSampler(safe: Safe, everyMs: number): { stop: () => MetricSample[] } {
  const samples: MetricSample[] = [];
  let running = true;
  (async () => {
    while (running) {
      const s = await sampleOnce(safe);
      samples.push(s);
      const line =
        `t+${((s.atMs - samples[0]!.atMs) / 1000).toFixed(0)}s ` +
        `health=${s.health} ready=${s.ready} ` +
        `pool busy=${s.poolBusy}/${s.poolMax} wait=${s.poolWaiting} (peak ${s.peakWaiting}) ` +
        `breaker=${s.breakerState} opened=${s.breakerOpened} rejected=${s.breakerRejected} ` +
        `cache h/m/coal=${s.cacheHits}/${s.cacheMisses}/${s.cacheCoalesced} ` +
        `sockets=${s.sockets} canary=${s.canaryStatus}@${s.canaryMs}ms`;
      console.log(line);
      await sleep(everyMs);
    }
  })();
  return {
    stop: () => {
      running = false;
      return samples;
    },
  };
}

// -------------------------------------------------------------------- utils

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i]!;
}

// ---------------------------------------------------------------- provision

async function provision(safe: Safe): Promise<void> {
  const out = required("--out");
  const owner = tokenFor(safe, `owner_${RUN_ID}`);
  await passAgeGate(safe.apiUrl, owner);
  const created = await api(safe.apiUrl, owner, "POST", "/api/servers", { name: `Load ${RUN_ID}` });
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`create server failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const cb = created.body as { server: { id: string }; channels: Array<{ id: string; type: string }> };
  const text = cb.channels.find((c) => c.type === "text");
  const voice = cb.channels.find((c) => c.type === "voice");
  if (!text || !voice) throw new Error("server did not come with a text and a voice channel");
  // Every step from here on operates on an already-created server. A
  // transient failure in any of them used to leave that server behind on
  // the target forever (Farol review, PR #663) — best-effort clean it up
  // before rethrowing.
  const rollback = async (cause: unknown): Promise<never> => {
    console.warn(`[warn] provisioning failed after server ${cb.server.id} was created; deleting it`);
    await api(safe.apiUrl, owner, "DELETE", `/api/servers/${cb.server.id}`).catch(() => {
      /* best-effort: a failed cleanup must not mask the original error */
    });
    throw cause instanceof Error ? cause : new Error(String(cause));
  };
  try {
    // Pin the voice room to LiveKit: mesh caps at MESH_VOICE_LIMIT (8), so a
    // presence room of hundreds must be an SFU room or every joiner past 8
    // is refused with voice-room-full. A failed pin makes the manifest
    // describe a mesh room instead of the SFU room the run intended to
    // measure, so this is a provisioning failure, not a warning: retry once,
    // then give up.
    let patched = await api(safe.apiUrl, owner, "PATCH", `/api/channels/${voice.id}`, {
      voiceTransport: "livekit",
    });
    if (patched.status !== 200) {
      patched = await api(safe.apiUrl, owner, "PATCH", `/api/channels/${voice.id}`, {
        voiceTransport: "livekit",
      });
    }
    if (patched.status !== 200) {
      throw new Error(`pin voice channel to livekit failed: ${patched.status} ${JSON.stringify(patched.body)}`);
    }
    const invite = await api(safe.apiUrl, owner, "POST", `/api/servers/${cb.server.id}/invites`, {});
    const code = (invite.body as { invite?: { code?: string } } | undefined)?.invite?.code;
    if (!code) throw new Error(`create invite failed: ${invite.status} ${JSON.stringify(invite.body)}`);
    const manifest: Manifest = {
      version: 1,
      runId: RUN_ID,
      apiUrl: safe.apiUrl,
      wsUrl: safe.wsUrl,
      serverId: cb.server.id,
      textChannelId: text.id,
      voiceChannelId: voice.id,
      inviteCode: code,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ provisioned: true, manifest: out, ...manifest }, null, 2));
  } catch (e) {
    await rollback(e);
  }
}

// ------------------------------------------------------------------ db-storm

/**
 * The reconnect storm. Each virtual reconnecting tab is a distinct load-test
 * identity that joins the party server once, then repeatedly runs the cold
 * browser bootstrap — the ~11-request first load a tab issues on every
 * reconnect (`coldBootstrap` in server/scripts/load-fanout.ts and index.ts).
 * Distinct identities defeat the read cache's per-viewer auth (never cached)
 * and the read-receipt POST is an uncached write, so concurrency here turns
 * directly into Postgres pool pressure.
 */
async function dbStorm(safe: Safe): Promise<void> {
  const manifest = arg("--manifest") ? readManifest() : null;
  const concurrency = numArg("--concurrency", 200);
  const rampSeconds = numArg("--ramp-seconds", 15);
  const durationMs = numArg("--seconds", 90) * 1000;
  const out = arg("--out", `./party-storm-db-${RUN_ID}.json`);
  console.log(
    `[db-storm] ${concurrency} concurrent bootstrap loops, ramp ${rampSeconds}s, hold ${durationMs / 1000}s against ${safe.apiUrl}`,
  );
  const sampler = startSampler(safe, 1000);
  const started = Date.now();
  const stats = {
    requests: 0,
    ok: 0,
    status503: 0,
    dbUnavailable: 0,
    status5xx: 0,
    status429: 0,
    status401: 0,
    errors: 0,
    latencies: [] as number[],
    r503latencies: [] as number[],
  };

  async function bootstrapOnce(token: string): Promise<void> {
    const reqs: Array<[string, string, unknown?]> = [
      ["GET", "/api/me"],
      ["GET", "/api/servers"],
      ["GET", "/api/community-home/config"],
    ];
    if (manifest) {
      reqs.push(
        ["GET", `/api/servers/${manifest.serverId}/channels`],
        ["GET", `/api/servers/${manifest.serverId}/unread`],
        ["GET", `/api/servers/${manifest.serverId}/members`],
        ["GET", `/api/servers/${manifest.serverId}/roles`],
        ["GET", `/api/servers/${manifest.serverId}/permissions`],
        ["GET", `/api/channels/${manifest.voiceChannelId}/messages`],
        ["GET", "/api/gifs/config"],
        ["POST", `/api/channels/${manifest.voiceChannelId}/read`, {}],
      );
    }
    for (const [method, path, body] of reqs) {
      const r = await api(safe.apiUrl, token, method, path, body);
      stats.requests += 1;
      stats.latencies.push(r.ms);
      if (r.status === 0) stats.errors += 1;
      else if (r.status >= 200 && r.status < 400) stats.ok += 1;
      else if (r.status === 503) {
        stats.status503 += 1;
        stats.r503latencies.push(r.ms);
        const err = (r.body as { error?: string } | undefined)?.error;
        if (err === "database_unavailable") stats.dbUnavailable += 1;
      } else if (r.status === 429) stats.status429 += 1;
      else if (r.status === 401) stats.status401 += 1;
      else if (r.status >= 500) stats.status5xx += 1;
    }
  }

  let active = true;
  async function worker(idx: number): Promise<void> {
    const token = tokenFor(safe, `st_${RUN_ID}_${idx}`);
    // Stagger arrivals across the ramp.
    await sleep((idx / concurrency) * rampSeconds * 1000);
    // Join the party server once (so bootstrap reads return real data).
    if (manifest) {
      await passAgeGate(safe.apiUrl, token);
      await api(safe.apiUrl, token, "POST", `/api/invites/${manifest.inviteCode}/join`);
    }
    while (active && Date.now() - started < durationMs) {
      await bootstrapOnce(token).catch(() => {
        stats.errors += 1;
      });
    }
  }

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i));
  await sleep(durationMs);
  active = false;
  await Promise.allSettled(workers);
  const samples = sampler.stop();

  const sortedLat = [...stats.latencies].sort((a, b) => a - b);
  const sorted503 = [...stats.r503latencies].sort((a, b) => a - b);
  const peakWaiting = Math.max(0, ...samples.map((s) => s.poolWaiting ?? 0));
  const anyOpen = samples.some((s) => s.breakerState === "open" || s.breakerState === "half-open");
  const healthMin = Math.min(...samples.map((s) => s.health ?? 0).filter((v) => v > 0));
  const readyBad = samples.filter((s) => s.ready === 503).length;
  const breakerOpenedMax = Math.max(0, ...samples.map((s) => s.breakerOpened ?? 0));
  const rejectedMax = Math.max(0, ...samples.map((s) => s.breakerRejected ?? 0));
  const canaryOpen = samples.filter((s) => s.canaryStatus === 503);

  const report = {
    kind: "db-storm",
    target: safe.apiUrl,
    concurrency,
    durationSeconds: durationMs / 1000,
    requests: stats.requests,
    ok: stats.ok,
    status503: stats.status503,
    dbUnavailable: stats.dbUnavailable,
    status5xx: stats.status5xx,
    status429: stats.status429,
    status401: stats.status401,
    errors: stats.errors,
    latencyMs: { p50: pct(sortedLat, 50), p90: pct(sortedLat, 90), p99: pct(sortedLat, 99), max: sortedLat.at(-1) ?? 0 },
    breaker503LatencyMs: { p50: pct(sorted503, 50), p90: pct(sorted503, 90), max: sorted503.at(-1) ?? 0 },
    poolPeakWaiting: peakWaiting,
    breakerEverOpen: anyOpen,
    breakerOpenedCount: breakerOpenedMax,
    breakerRejectedCount: rejectedMax,
    healthMinCode: Number.isFinite(healthMin) ? healthMin : null,
    readySample503Count: readyBad,
    canary503Count: canaryOpen.length,
    samples,
  };
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log("\n===== db-storm summary =====");
  console.log(
    JSON.stringify(
      { ...report, samples: `${samples.length} samples (see ${out})` },
      null,
      2,
    ),
  );
}

// ------------------------------------------------------------------ ws-storm

interface WsSeat {
  socket: WebSocket;
  peerId: string;
}
async function joinSeat(safe: Safe, manifest: Manifest, token: string, _machineId?: string): Promise<WsSeat> {
  await passAgeGate(safe.apiUrl, token);
  await api(safe.apiUrl, token, "POST", `/api/invites/${manifest.inviteCode}/join`);
  return await new Promise<WsSeat>((resolve, reject) => {
    const socket = new WebSocket(safe.wsUrl);
    let settled = false;
    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error("no welcome within timeout")), WELCOME_TIMEOUT_MS + HTTP_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "auth", token, caps: ["voice-roster-delta", "presence-delta"] }));
    });
    socket.addEventListener("message", (ev: MessageEvent) => {
      let frame: { type?: string; peerId?: string };
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (frame.type === "ready") {
        socket.send(JSON.stringify({ type: "join-channel", channelId: manifest.textChannelId }));
        socket.send(
          JSON.stringify({ type: "join-voice-room", voiceChannelId: manifest.voiceChannelId, transports: ["livekit"], resume: false }),
        );
      } else if (frame.type === "welcome") {
        if (!frame.peerId) return fail(new Error("welcome missing peer id"));
        settled = true;
        clearTimeout(timer);
        resolve({ socket, peerId: frame.peerId });
      } else if (["voice-join-refused", "voice-room-full", "voice-transport-unsupported"].includes(frame.type ?? "")) {
        fail(new Error(frame.type));
      }
    });
    socket.addEventListener("error", () => fail(new Error("socket error")));
    socket.addEventListener("close", (ev: CloseEvent) => fail(new Error(`closed before welcome: code=${ev.code} reason=${ev.reason}`)));
  });
}

async function wsStorm(safe: Safe): Promise<void> {
  const manifest = readManifest();
  const sockets = numArg("--sockets", 300);
  const rampSeconds = numArg("--ramp-seconds", 30);
  const holdSeconds = numArg("--hold", 60);
  const reconnectAt = numArg("--reconnect-at", -1); // seconds into hold to drop+rejoin all
  const joinConcurrency = numArg("--join-concurrency", 20);
  const presenceEveryMs = numArg("--presence-every-ms", 45_000);
  const out = arg("--out", `./party-storm-ws-${RUN_ID}.json`);
  console.log(`[ws-storm] ${sockets} sockets, ramp ${rampSeconds}s, hold ${holdSeconds}s, reconnect-at ${reconnectAt}s`);
  const sampler = startSampler(safe, 1000);

  const welcomeLatencies: number[] = [];
  const seats: (WsSeat | null)[] = new Array(sockets).fill(null);
  const result = { joined: 0, failed: 0, reconnected: 0, reconnectFailed: 0, closeCodes: {} as Record<string, number> };

  function trackCloseCodes(seat: WsSeat): void {
    seat.socket.addEventListener("close", (ev: CloseEvent) => {
      result.closeCodes[String(ev.code)] = (result.closeCodes[String(ev.code)] ?? 0) + 1;
    });
  }

  let cursor = 0;
  const rampMs = rampSeconds * 1000;
  const rampStart = Date.now();
  async function joinPump(): Promise<void> {
    while (cursor < sockets) {
      const idx = cursor++;
      // Global schedule, not a per-pump sleep: seat `idx` is due at
      // idx/sockets of the way through the ramp, wall-clock, no matter how
      // many pumps are running. Sleeping rampMs/sockets AFTER every join,
      // inside each of `joinConcurrency` pumps running in parallel, produced
      // roughly `joinConcurrency` times the intended join rate — 300 sockets
      // over a configured 30s ramp landed in under 2s with the default 20
      // pumps (Farol review, PR #663).
      const dueAt = rampStart + (idx / sockets) * rampMs;
      const waitMs = dueAt - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      const token = tokenFor(safe, `ws_${RUN_ID}_${idx}`);
      const machineId = safe.machineIds ? safe.machineIds[idx % safe.machineIds.length] : undefined;
      const t0 = Date.now();
      try {
        const seat = await joinSeat(safe, manifest, token, machineId);
        seats[idx] = seat;
        welcomeLatencies.push(Date.now() - t0);
        result.joined += 1;
        trackCloseCodes(seat);
      } catch (e) {
        result.failed += 1;
        const msg = e instanceof Error ? e.message : String(e);
        const key = msg.slice(0, 40);
        result.closeCodes[key] = (result.closeCodes[key] ?? 0) + 1;
      }
    }
  }
  await Promise.all(Array.from({ length: joinConcurrency }, () => joinPump()));
  console.log(`[ws-storm] ramp complete: joined=${result.joined} failed=${result.failed}`);

  // Presence churn during hold.
  const presenceTimer = setInterval(() => {
    for (const seat of seats) {
      if (seat && seat.socket.readyState === WebSocket.OPEN) {
        const muted = Math.random() < 0.5;
        try {
          seat.socket.send(JSON.stringify({ type: "set-voice-state", muted, deafened: false }));
        } catch {
          /* ignore */
        }
      }
    }
  }, presenceEveryMs);

  // Optional reconnect storm: drop every socket at once, then rejoin — the
  // 2026-09-12 failure mode where each recovery re-triggered the collapse.
  if (reconnectAt >= 0) {
    await sleep(reconnectAt * 1000);
    console.log(`[ws-storm] RECONNECT STORM: dropping ${result.joined} sockets`);
    for (const seat of seats) {
      try {
        seat?.socket.close();
      } catch {
        /* ignore */
      }
    }
    await sleep(500);
    // Rejoin all at once (no pacing) — the thundering herd.
    const rejoins = seats.map(async (_, idx) => {
      const token = tokenFor(safe, `ws_${RUN_ID}_${idx}`);
      const machineId = safe.machineIds ? safe.machineIds[idx % safe.machineIds.length] : undefined;
      const t0 = Date.now();
      try {
        const seat = await joinSeat(safe, manifest, token, machineId);
        seats[idx] = seat;
        welcomeLatencies.push(Date.now() - t0);
        result.reconnected += 1;
        // The initial join loop tracks close codes for every seat; a seat
        // replaced here needs the same tracking, or a reconnected socket
        // that the server later drops during hold silently reads as a
        // still-successful recovery (Farol review, PR #663).
        trackCloseCodes(seat);
      } catch {
        result.reconnectFailed += 1;
      }
    });
    await Promise.allSettled(rejoins);
    console.log(`[ws-storm] reconnect: ok=${result.reconnected} failed=${result.reconnectFailed}`);
  }

  // `--hold` is the total time sockets stay up after the ramp, not extra time
  // tacked on after a mid-hold reconnect: with `--reconnect-at` set, only the
  // remaining hold (holdSeconds - reconnectAt) is left to sleep here, or a
  // run configured for a 25s hold with a reconnect at 15s stayed up for 40s
  // instead (Farol review, PR #663).
  const remainingHoldMs = reconnectAt >= 0
    ? Math.max(0, holdSeconds - reconnectAt) * 1000
    : holdSeconds * 1000;
  await sleep(remainingHoldMs);
  clearInterval(presenceTimer);
  for (const seat of seats) {
    try {
      seat?.socket.send(JSON.stringify({ type: "leave-voice-room" }));
      seat?.socket.close();
    } catch {
      /* ignore */
    }
  }
  const samples = sampler.stop();
  const sortedW = [...welcomeLatencies].sort((a, b) => a - b);
  const report = {
    kind: "ws-storm",
    target: safe.wsUrl,
    sockets,
    ...result,
    welcomeLatencyMs: { p50: pct(sortedW, 50), p90: pct(sortedW, 90), p99: pct(sortedW, 99), max: sortedW.at(-1) ?? 0 },
    peakSockets: Math.max(0, ...samples.map((s) => s.sockets ?? 0)),
    poolPeakWaiting: Math.max(0, ...samples.map((s) => s.poolWaiting ?? 0)),
    breakerEverOpen: samples.some((s) => s.breakerState !== "closed" && s.breakerState != null),
    healthMinCode: Math.min(...samples.map((s) => s.health ?? 200).filter((v) => v > 0)),
    samples,
  };
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log("\n===== ws-storm summary =====");
  console.log(JSON.stringify({ ...report, samples: `${samples.length} samples (see ${out})` }, null, 2));
}

// ---------------------------------------------------------------------- hls

/**
 * HLS viewer poll. `--url` (or PQP_LOAD_HLS_BASE_URL) is the playlist base; a
 * viewer appends `/<channelId>/<startedAt>` and its own `?t=` token. Point it
 * at the API origin proxy OR the hls.pqp.gg edge Worker to compare. Real
 * playlists only exist while a presenter is live; without --channel/--started
 * this runs a single unauth probe and reports that a live session is required.
 */
async function hls(safe: Safe): Promise<void> {
  const channel = arg("--channel");
  const started = arg("--started");
  const tokensFile = arg("--tokens");
  const viewers = numArg("--viewers", 500);
  const seconds = numArg("--seconds", 120);
  const pollMin = numArg("--poll-min-ms", 2000);
  const pollMax = numArg("--poll-max-ms", 4000);
  const out = arg("--out", `./party-storm-hls-${RUN_ID}.json`);

  if (!channel || !started) {
    console.log(
      "[hls] no --channel/--started given: probing the path only. A real HLS run needs a LIVE presenter+egress session.",
    );
    const probe = await fetch(`${safe.hlsBaseUrl}/probe/0`, { signal: AbortSignal.timeout(8000) })
      .then((r) => r.status)
      .catch((e) => String(e));
    console.log(
      JSON.stringify(
        {
          kind: "hls-probe",
          hlsBaseUrl: safe.hlsBaseUrl,
          pathShape: `${safe.hlsBaseUrl}/<channelId>/<startedAt>?t=<viewerToken>`,
          probeStatus: probe,
          note:
            "Origin proxy path is server/src/voice/hls-playlist-proxy.ts. Edge path is hls.pqp.gg (LIVE_HLS_PLAYLIST_BASE_URL). Provide --channel --started --tokens from a live party to measure viewer polling + origin coalescing.",
        },
        null,
        2,
      ),
    );
    return;
  }

  const tokens = tokensFile
    ? readFileSync(tokensFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
    : [];
  const n = tokens.length > 0 ? Math.min(viewers, tokens.length) : viewers;
  console.log(`[hls] ${n} viewers polling ${safe.hlsBaseUrl}/${channel}/${started} every ${pollMin}-${pollMax}ms for ${seconds}s`);
  const sampler = startSampler(safe, 1000);
  const startedAt = Date.now();
  const stats = { polls: 0, ok: 0, notModified: 0, s503: 0, s4xx: 0, errors: 0, latencies: [] as number[] };

  async function viewer(i: number): Promise<void> {
    const t = tokens[i] ? `?t=${encodeURIComponent(tokens[i]!)}` : "";
    const url = `${safe.hlsBaseUrl}/${channel}/${started}${t}`;
    while (Date.now() - startedAt < seconds * 1000) {
      const t0 = Date.now();
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        await r.text().catch(() => "");
        stats.polls += 1;
        stats.latencies.push(Date.now() - t0);
        if (r.status === 200) stats.ok += 1;
        else if (r.status === 304) stats.notModified += 1;
        else if (r.status === 503) stats.s503 += 1;
        else if (r.status >= 400) stats.s4xx += 1;
      } catch {
        stats.errors += 1;
      }
      await sleep(pollMin + Math.random() * (pollMax - pollMin));
    }
  }
  await Promise.all(Array.from({ length: n }, (_, i) => viewer(i)));
  const samples = sampler.stop();
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const report = {
    kind: "hls",
    hlsBaseUrl: safe.hlsBaseUrl,
    viewers: n,
    ...stats,
    latencies: undefined,
    latencyMs: { p50: pct(sorted, 50), p90: pct(sorted, 90), p99: pct(sorted, 99) },
    note: "To prove edge coalescing, watch origin readCache/pool while viewers poll the EDGE base; origin fetches should stay ~1/rung/2s regardless of viewer count.",
    samples,
  };
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log("\n===== hls summary =====");
  console.log(JSON.stringify({ ...report, samples: `${samples.length} samples (see ${out})` }, null, 2));
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const command = process.argv[2];
  const safe = assertSafe();
  console.log(`[party-storm] target api=${safe.apiUrl} ws=${safe.wsUrl} hls=${safe.hlsBaseUrl} run=${RUN_ID}`);
  switch (command) {
    case "provision":
      return provision(safe);
    case "db-storm":
      return dbStorm(safe);
    case "ws-storm":
      return wsStorm(safe);
    case "hls":
      return hls(safe);
    default:
      console.log(
        "commands: provision --out <f> | db-storm [--manifest f] --concurrency N --seconds S | " +
          "ws-storm --manifest f --sockets N --hold S [--reconnect-at S] | hls --channel <id> --started <ms> [--tokens f]",
      );
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
