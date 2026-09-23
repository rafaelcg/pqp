import "./env.js";
import { noteSocketCountry } from "./voice/regions.js";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { handleApi } from "./api/index.js";
import {
  assertAuthConfig,
  isDevAuthBypassEnabled,
  sweepAuthCaches,
} from "./auth/clerk.js";
import { closePool, initDb, startDbBreakerSampler } from "./db.js";
import { closeApnsSessions } from "./services/apns.js";
import { seedDevHall } from "./services/dev-seed.js";
import { closeBus, INSTANCE_ID, setBusTransport } from "./lib/bus.js";
import { createPostgresBusTransport } from "./lib/bus-postgres.js";
import {
  clusterTopologyTracked,
  startVoiceInstanceHeartbeat,
  sweepDeadVoiceInstances,
  voiceConfigHash,
} from "./voice/registry.js";
import { startVoiceHello } from "./ws/voice-hello.js";
import {
  IDLE_ALONE_SWEEP_MS,
  localVoicePeerCount,
  runVoiceReconcile,
  sweepIdleAloneSeats,
  sweepVoiceChannelAccessCache,
} from "./ws/voice.js";
import {
  assertCorsConfig,
  corsHeaders,
  handleCors,
  SECURITY_HEADERS,
  sendError,
} from "./lib/http.js";
import {
  beginDrain,
  closeSocketsInBatches,
  DRAIN_SETTLE_MS,
  healthVerdict,
} from "./lib/drain.js";
import { logEvent } from "./lib/log.js";
import { registerInstanceSnapshot } from "./lib/instance-snapshot.js";
import {
  noteRuntimeSample,
  registerCompressedSocketCount,
  registerSocketCount,
  runtimeSnapshot,
} from "./lib/runtime.js";
import { claimSingletonTickOrRun } from "./lib/singleton-lease.js";
import { wsPerMessageDeflate } from "./lib/ws-compression.js";
import {
  clientAddress,
  createRateLimiter,
  sweepRateLimits,
} from "./lib/rate-limit.js";
import {
  isCommunityHomeEnabled,
  publishDueCommunityHomePosts,
} from "./services/community-home.js";
import { sweepChannelAudiences } from "./services/servers.js";
import { startColdJobs, type ColdJobs } from "./jobs.js";
import { reconcileStaleHlsSessions } from "./voice/hls-cleanup.js";
import { adoptLlHlsSessions, isLiveHlsLLEnabled } from "./voice/hls-remux.js";
import {
  isLiveHlsEnabled,
  liveHlsActivity,
  startLiveHlsMonitor,
  stopLiveHlsMonitor,
} from "./voice/hls-egress.js";
import { hlsViewerCounter } from "./voice/hls-viewer-counts.js";
import { processRole, runsColdJobs, servesTraffic } from "./lib/process-role.js";
import { checkReadiness, READINESS_PATH } from "./services/readiness.js";
import {
  READY_PATH,
  readyHandler,
  startReadySampler,
} from "./services/ready.js";
import {
  getStatusSummary,
  pruneStatusSamples,
  recordStatusSamples,
} from "./services/status.js";
import {
  handleWsConnection,
  HEARTBEAT_INTERVAL_MS,
  notifyCommunityHomeUpdate,
  startClusterPresenceRefresh,
  startClusterStatusRefresh,
  startHeartbeat,
} from "./ws/index.js";

const PORT = Number(process.env.PORT ?? 3001);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = resolve(join(__dirname, "../../client/dist"));

/** WebRTC SDP offers are a few KB; anything larger is not a real client. */
const MAX_WS_PAYLOAD_BYTES = 128 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  json: "application/json; charset=utf-8",
  xml: "application/xml",
  txt: "text/plain; charset=utf-8",
  map: "application/json; charset=utf-8",
};

/** SPA routes that contain a dot (e.g. an invite code) still need index.html. */
const ASSET_EXTENSION = /\.[a-z0-9]{1,8}$/i;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function serveStatic(
  pathname: string,
  res: import("node:http").ServerResponse,
): Promise<boolean> {
  if (!existsSync(CLIENT_DIST)) {
    return false;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }

  const requested = resolve(join(CLIENT_DIST, normalize(decoded)));
  // normalize() collapses `..`, but a crafted path can still resolve outside
  // the root (e.g. `/../secrets`); confirm containment before reading.
  const withinRoot =
    requested === CLIENT_DIST || requested.startsWith(CLIENT_DIST + sep);
  if (!withinRoot) {
    return false;
  }

  const indexHtml = join(CLIENT_DIST, "index.html");
  let filePath = decoded === "/" ? indexHtml : requested;

  if (!(await isFile(filePath))) {
    // Unknown path with no file extension is an SPA route, not a missing asset.
    if (ASSET_EXTENSION.test(decoded)) {
      return false;
    }
    filePath = indexHtml;
    if (!(await isFile(filePath))) {
      return false;
    }
  }

  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const body = await readFile(filePath);

  // Only Vite's own output under /assets/ is content-hashed. Everything else —
  // robots.txt, sitemap.xml, images copied from public/ — keeps its name across
  // deploys and must stay revalidated.
  const isFingerprinted = decoded.startsWith("/assets/");

  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    "Cache-Control": isFingerprinted
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300, must-revalidate",
    ...SECURITY_HEADERS,
  });
  res.end(body);
  return true;
}

const handleReady = readyHandler();

const httpServer = createServer((req, res) => {
  void (async () => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const pathname = url.pathname;

    if (pathname === "/health") {
      // FLY'S CHECK (fly.toml) AND THE VULTR BOX'S (tools/api-host/compose.yaml,
      // Caddyfile). PROCESS LIVENESS ONLY — A3.1 of docs/plans/ALWAYS_ON.md.
      //
      // This used to run a real `SELECT 1` here, so a 200 meant "process up
      // AND database reachable". On 2026-09-12 that coupling was the whole
      // incident: Postgres collapsed, the pool saturated, this endpoint
      // failed with it, and the platform stopped routing here at all —
      // taking WebSockets, the HLS playlist proxy and every cached read down
      // too, none of which needed Postgres at that instant. The database's
      // health now belongs entirely to `/ready`, which external monitors
      // poll (`services/ready.ts`); a DB-dependent route answers its own 503
      // via the breaker in `db.ts` instead of borrowing this one's verdict.
      //
      // What is left to check here has no query in it: `isDraining()`
      // (`lib/drain.ts`, flips the instant SIGTERM lands, so a rolling
      // deploy's proxy sends reconnects to the machine staying up) and
      // whether this HTTP server is the one actually accepting connections
      // — which a request reaching this handler at all already proves, so
      // `httpServer.listening` mostly documents the claim.
      //
      // The 200 body still carries the deployed commit, so "is the API
      // actually running this code?" has an answer from outside — see
      // CLAUDE.md pitfall #8's history on why that line exists.
      const verdict = healthVerdict(httpServer.listening);
      res.writeHead(verdict.status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...SECURITY_HEADERS,
      });
      res.end(JSON.stringify(verdict.body));
      return;
    }

    if (pathname === READINESS_PATH) {
      // The external-monitor endpoint. The status code IS the payload; the
      // body is a constant. `services/readiness.ts` holds the whole decision,
      // including why a saturated pool and a draining process are both 200.
      //
      // Answered before `serveStatic`, so a self-hosted deployment that serves
      // the SPA from this process cannot shadow it with a client-side route.
      // No CORS on purpose: this is for a monitor, not for a browser.
      const verdict = await checkReadiness();
      res.writeHead(verdict.status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...SECURITY_HEADERS,
      });
      res.end(JSON.stringify({ ok: verdict.ok }));
      return;
    }

    if (pathname === READY_PATH) {
      // The deep check for external monitors: Postgres, the pool's shape over
      // time, LiveKit and storage when configured. 503 when any is not ok.
      // Rate limit, timeouts and caches all live in services/ready.ts.
      await handleReady(req, res);
      return;
    }

    if (pathname === "/status.json") {
      // This route is answered before `handleApi`, which is where every /api/
      // route picks up CORS — so it has to do it itself. Without this the
      // status page is broken in exactly one environment: production, where
      // the SPA and the API are on different origins. It works locally either
      // way, which is what makes it easy to ship.
      if (handleCors(req, res)) {
        return;
      }
      // Unauthenticated and therefore scriptable by anyone. Keyed by address
      // rather than identity because there is no identity here; the budget is
      // generous for a page that polls itself, hostile to a scraper.
      if (!statusLimiter.take(clientAddress(req))) {
        res.writeHead(429, {
          ...corsHeaders(req),
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          ...SECURITY_HEADERS,
        });
        res.end(JSON.stringify({ error: "Too many requests" }));
        return;
      }
      try {
        const summary = await getStatusSummary();
        res.writeHead(200, {
          ...corsHeaders(req),
          "Content-Type": "application/json",
          // Short, not none: a status page is what people refresh during an
          // incident, and that is exactly when the origin is least able to
          // absorb it.
          "Cache-Control": "public, max-age=15",
          ...SECURITY_HEADERS,
        });
        res.end(JSON.stringify(summary));
      } catch {
        // Deliberately opaque — the reason a status check failed is not
        // something an unauthenticated caller gets to learn.
        res.writeHead(503, {
          ...corsHeaders(req),
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          ...SECURITY_HEADERS,
        });
        res.end(JSON.stringify({ error: "status unavailable" }));
      }
      return;
    }

    if (pathname.startsWith("/api/")) {
      try {
        await handleApi(req, res, pathname);
      } catch (error) {
        console.error(error);
        sendError(res, 500, "Internal server error");
      }
      return;
    }

    if (await serveStatic(pathname, res)) {
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      ...SECURITY_HEADERS,
    });
    res.end("pqp server");
  })().catch((error) => {
    console.error("[http] request failed:", error);
    if (!res.headersSent) {
      sendError(res, 500, "Internal server error", req);
    } else {
      res.end();
    }
  });
});

// `maxPayload` keeps its meaning under compression and gains one: `ws` passes
// it into the extension, which stops inflating once the DECOMPRESSED size
// crosses it. So a client cannot turn a small frame into a large allocation.
const wss = new WebSocketServer({
  server: httpServer,
  path: "/ws",
  maxPayload: MAX_WS_PAYLOAD_BYTES,
  perMessageDeflate: wsPerMessageDeflate(),
});

// One live number for the operator dashboard: every signed-in client holds a
// socket open for its whole session, so this is the closest thing the process
// has to "people connected". A Set's `size`, read only when the dashboard asks.
registerSocketCount(() => wss.clients.size);

// How many of those sockets actually negotiated compression.
//
// Pitfall 9 in CLAUDE.md is Cloudflare TURN: configured, deployed, and never
// once used, because nothing reported which relay answered. Compression has the
// same shape — a client that does not offer the extension is served
// uncompressed and looks identical to one that does — so the fraction is the
// only thing that tells "working" from "silently off for everybody". Counted on
// demand, when the dashboard asks, never on a timer.
registerCompressedSocketCount(() => {
  let compressed = 0;
  for (const socket of wss.clients) {
    // `extensions` is the negotiated list as a comma-joined string, "" when
    // nothing was negotiated.
    if (socket.extensions.includes("permessage-deflate")) {
      compressed += 1;
    }
  }
  return compressed;
});

// The same three numbers, plus the pool, written into this instance's
// `voice_instances` row on every heartbeat so the dashboard can SUM them.
//
// Read at beat time (15 s) rather than at request time, because the request
// only ever reaches one machine and that is the whole problem. The local
// reading stays exactly where it was, as `runtime`; this is what lets
// `cluster` sit beside it. See lib/instance-snapshot.ts.
registerInstanceSnapshot(() => {
  const local = runtimeSnapshot();
  return {
    sockets: local.sockets,
    compressedSockets: local.compressedSockets,
    voiceParticipants: localVoicePeerCount(),
    hlsSessions: liveHlsActivity().sessions,
    poolBusy: local.pool.busy,
    poolMax: local.pool.max,
    role: processRole(),
    version: process.env.APP_VERSION?.trim() || null,
  };
});

wss.on("connection", (socket, req) => {
  // Take a peak sample here rather than on a timer: the maximum number of
  // concurrent sockets is always reached immediately after one opens, so
  // sampling on this event makes `peakSockets` exact rather than sampled.
  noteRuntimeSample();
  // The upgrade's `CF-IPCountry`, kept for the socket's life: the voice
  // join reads it to pick a room's SFU region (`voice/regions.ts`). Recorded
  // on every deployment so the dashboard can prove the header arrives before
  // any region is routed on it; nothing reads it without `LIVEKIT_REGIONS`.
  noteSocketCountry(socket, req.headers);
  // Liveness bookkeeping lives in `handleWsConnection`
  // (`trackSocketLiveness`), which is the half `startHeartbeat` below reads.
  handleWsConnection(socket, clientAddress(req as never));
});

wss.on("error", (error) => {
  console.error("[ws] server error:", error);
});

// Protocol-level heartbeat: browsers auto-reply pong, so this both reaps dead
// connections and keeps proxy idle timers (e.g. Railway edge) from closing
// quiet sockets. Reaping a socket is what eventually frees a voice seat, so
// this is the first link in that chain.
//
// IT IS ONE FUNCTION NOW. This used to be a second, inline copy of the loop
// in `ws/index.ts`, and the copy is the one that ran: the two-strike rule
// written after the moonkase stream reaped live users, together with its
// whole test file, sat in `ws/index.ts` being imported by nobody. A reaper
// with two implementations has one that is tested and one that is true. The
// tick callback keeps the pool high-water marks moving on a quiet server,
// which is the only thing the inline copy did that the shared one did not.
const stopHeartbeat = startHeartbeat(
  wss.clients,
  HEARTBEAT_INTERVAL_MS,
  noteRuntimeSample,
);

wss.on("close", () => stopHeartbeat());

// Drop expired rate-limit windows so the map doesn't grow unbounded.
const rateLimitSweep = setInterval(() => {
  sweepRateLimits();
  // Same cadence, same reason: all three are maps that only shrink if swept.
  // The audience cache is capped as well as swept, so this is about returning
  // memory after a busy server goes quiet, not about bounding it.
  sweepAuthCaches();
  sweepChannelAudiences();
  sweepVoiceChannelAccessCache();
}, 60_000);
rateLimitSweep.unref?.();

/** One probe a minute: fine enough to catch a short outage, cheap enough to
 * keep 30 days of history small. */
const STATUS_SAMPLE_INTERVAL_MS = 60_000;

const statusLimiter = createRateLimiter({ capacity: 60, refillPerSecond: 1 });

// Feeds /ready's "queued for more than 10 s" and "full for more than 30 s"
// clocks once a second, so those windows mean continuous and not "seen at two
// instants a minute apart".
const stopReadySampler = startReadySampler();

// A3.1's circuit breaker: its own `SELECT 1` timer, independent of whether
// any external monitor is polling `/ready`. See `lib/db-breaker.ts`.
const stopDbBreakerSampler = startDbBreakerSampler();

/**
 * ONE SAMPLE A MINUTE MEANS ONE, ACROSS THE WHOLE CLUSTER.
 *
 * These two timers used to be plain `setInterval`s, which is the same thing as
 * "run on every process that loads this file". With two API machines and a
 * worker that was three probes a minute writing three rows, and the damage is
 * not the disk: `status_samples` is AVERAGED into the uptime figure on
 * `/status.json`, so one machine failing a probe while the other two passed
 * read as a service that was two thirds up. An outage of half the cluster is
 * not a two-thirds-healthy service, and an outage of one machine out of two
 * showing as 50% uptime is worse still — it is a number that looks measured.
 *
 * THE GATE IS `servesTraffic`, NOT `runsColdJobs`, and that is the whole
 * design decision. Every other periodic job in this codebase moved to
 * `jobs.ts` and runs on the worker; this one must not, because the first
 * probe in the list is `api` and it answers `ok: true` unconditionally on the
 * grounds that "reaching this line means the API is serving". Run it on
 * `pqp-worker` and that sentence quietly becomes "the worker is serving",
 * which is a green tile with nothing behind it — the exact shape of pitfalls 9
 * and 12. The banner at the top of `jobs.ts` already said so; this is it
 * enforced rather than merely written down.
 *
 * So the sampler stays with the processes that serve traffic, and the LEASE is
 * what makes them one sampler instead of two. It fails OPEN — a tick that
 * cannot claim because the database is unreachable is still attempted, because
 * a duplicate row is noise and a missing row is a hole in the history that can
 * never be filled in afterwards.
 */
/**
 * The lease is short of the interval so the next tick is always claimable —
 * a lease that outlived its own tick would let a minute go unsampled, and a
 * hole in the history is the one failure that cannot be repaired afterwards.
 * Five seconds of margin is enough because the sample itself is BOUNDED well
 * under it: the GIF probe has an 8 s ceiling and is not awaited, the SFU read
 * is cached, and the write is one INSERT. `sampling` closes the remaining
 * window from this side, so a tick can never start a second sample beside one
 * this process is still running; two processes overlapping needs a sample to
 * take longer than 55 s, which would mean the probes themselves are wedged.
 */
let sampling = false;
const STATUS_SAMPLE_LEASE_KEY = "status.sample";
const STATUS_PRUNE_LEASE_KEY = "status.prune";
const STATUS_PRUNE_INTERVAL_MS = 24 * 60 * 60_000;

const statusSampler = setInterval(() => {
  if (!servesTraffic(processRole()) || sampling) {
    return;
  }
  sampling = true;
  void claimSingletonTickOrRun(
    STATUS_SAMPLE_LEASE_KEY,
    STATUS_SAMPLE_INTERVAL_MS - 5_000,
  )
    .then((mine) => (mine ? recordStatusSamples() : undefined))
    .catch((error: unknown) => {
      console.error("[status] sample failed:", error);
    })
    .finally(() => {
      sampling = false;
    });
}, STATUS_SAMPLE_INTERVAL_MS);
statusSampler.unref?.();

const statusPrune = setInterval(() => {
  if (!servesTraffic(processRole())) {
    return;
  }
  void claimSingletonTickOrRun(
    STATUS_PRUNE_LEASE_KEY,
    STATUS_PRUNE_INTERVAL_MS - 60_000,
  )
    .then((mine) => (mine ? pruneStatusSamples() : undefined))
    .catch((error: unknown) => {
      console.error("[status] prune failed:", error);
    });
}, STATUS_PRUNE_INTERVAL_MS);
statusPrune.unref?.();

/**
 * Community Home schedule catch-up.
 *
 * Every 30s flip due `scheduled` rows to `published` and nudge connected
 * members. Correctness does not depend on the interval staying up: a redeploy
 * that misses a tick catches up on the next one (and on boot below).
 *
 * This one stays with the sockets even when a worker exists, because the
 * nudge is a WebSocket push and the worker has no sockets. The media orphan
 * sweep that used to share this timer lives in `jobs.ts`.
 */
const COMMUNITY_HOME_SCHEDULE_MS = 30_000;

async function sweepCommunityHomeSchedule(): Promise<void> {
  // Flag off: nothing to publish. Read per tick so a restart with the
  // variable set picks it up without touching this code.
  if (!isCommunityHomeEnabled()) {
    return;
  }
  try {
    const serverIds = await publishDueCommunityHomePosts();
    for (const serverId of serverIds) {
      await notifyCommunityHomeUpdate(serverId);
    }
    if (serverIds.length > 0) {
      console.log(
        `[community-home] published scheduled posts on ${serverIds.length} server(s)`,
      );
    }
  } catch (error) {
    console.error("[community-home] schedule sweep failed:", error);
  }
}

const communityHomeSweep = setInterval(() => {
  void sweepCommunityHomeSchedule();
}, COMMUNITY_HOME_SCHEDULE_MS);
communityHomeSweep.unref?.();

// The idle hangup (`VOICE_IDLE_ALONE_MINUTES`): somebody alone in a voice
// room past the limit is warned, then disconnected. See `sweepIdleAloneSeats`.
const idleAloneSweep = setInterval(() => {
  void sweepIdleAloneSeats();
}, IDLE_ALONE_SWEEP_MS);
idleAloneSweep.unref?.();

/**
 * Multi-instance chat, off by default.
 *
 * Unset (or `off`) leaves every fan-out purely in-process — exactly what this
 * server has always done, and the only supported configuration for **mesh
 * voice**, whose peer registry and per-room ceiling are per-process and are
 * deliberately *not* on the bus (see `server/src/ws/voice.ts`).
 *
 * Turning it on shares chat: broadcasts, presence, typing, unread badges and
 * evictions. It does not share rate-limit buckets — see the note in
 * `lib/rate-limit.ts` for what that multiplies.
 */
function startClusterBus(): (() => void) | null {
  const mode = process.env.CLUSTER_BUS ?? "off";
  if (mode === "off") {
    return null;
  }
  if (mode !== "postgres") {
    console.warn(
      `[bus] unknown CLUSTER_BUS=${mode} — staying single-instance. ` +
        `Supported: "postgres", "off".`,
    );
    return null;
  }
  const transport = createPostgresBusTransport();
  setBusTransport(transport);
  logEvent("bus.enabled", { transport: "postgres", instance: INSTANCE_ID });
  // Boot-time proof that LISTEN really delivers on this connection: publish
  // `voice.hello` once connected and require our own echo (see
  // ws/voice-hello.ts). Logs loudly on silence; failing /health on it is M5.
  const stopHello = startVoiceHello(transport.whenConnected());
  // Two independent re-announce loops, because they answer two different
  // questions: channel presence is "who is looking at channel X", user status is
  // "is this person around at all". Both need the same guarantee — an instance
  // that is SIGKILLed must age out rather than leave ghosts — and both implement
  // it the same way, but neither can be derived from the other.
  const stopPresence = startClusterPresenceRefresh();
  const stopStatus = startClusterStatusRefresh();
  return () => {
    stopPresence();
    stopStatus();
    stopHello();
  };
}

let stopPresenceRefresh: (() => void) | null = null;
let coldJobs: ColdJobs | null = null;

/**
 * The voice registry (`voice/registry.ts`), off by default.
 *
 * `postgres` makes `ws/voice.ts` copy its peer map and transport pins into
 * the `voice_*` tables and announce this instance every 15 s. It is
 * independent of `CLUSTER_BUS`: the registry is state, the bus is fan-out,
 * and a deployment can turn either on first. Neither is enough for two
 * machines on its own; `docs/plans/MULTI_INSTANCE_VOICE.md` lists what each
 * milestone adds and when scaling past one is safe.
 */
function startVoiceRegistry(): (() => Promise<void>) | null {
  const raw = process.env.VOICE_REGISTRY ?? "off";
  if (raw !== "off" && raw !== "postgres") {
    console.warn(
      `[voice] unknown VOICE_REGISTRY=${raw}: registry stays off. ` +
        `Supported: "postgres", "off".`,
    );
  }
  if (raw !== "postgres") {
    // The registry is off. The LEASE may still be worth writing: with
    // `CLUSTER_BUS=postgres` this deployment expects siblings, and the lease
    // is the only thing that can say how many there are — which the divided
    // rate limiters divide by and the dashboard sums over. No reconcile,
    // because there are no peer rows to reconcile; just the beat, the
    // snapshot, and a sweep of leases nobody is renewing, since without the
    // reconcile nothing else would age them out.
    if (!clusterTopologyTracked()) {
      return null;
    }
    logEvent("voice.instanceLeaseOnly", { instance: INSTANCE_ID });
    return startVoiceInstanceHeartbeat(undefined, sweepDeadVoiceInstances);
  }
  logEvent("voice.registryEnabled", {
    instance: INSTANCE_ID,
    configHash: voiceConfigHash(),
  });
  // After every beat: the lease's consequences (ws/voice.ts).
  return startVoiceInstanceHeartbeat(undefined, runVoiceReconcile);
}

let stopVoiceHeartbeat: (() => Promise<void>) | null = null;
let stopHlsViewerCounter: (() => Promise<void>) | null = null;

async function main() {
  // `WORKER_MODE=worker` on this entry point means "be the worker": hand off
  // before anything below binds a port or opens a socket. The batch half has
  // its own file so the split is visible in `ps`, not just in the env.
  const role = processRole();
  if (role === "worker") {
    await import("./worker.js");
    return;
  }
  // Only the API drains sockets on SIGTERM; the worker installs its own.
  installSignalHandlers();

  assertAuthConfig();
  assertCorsConfig();
  if (isDevAuthBypassEnabled()) {
    console.warn(
      "[auth] DEV_AUTH_BYPASS is ON — anyone with the token 'dev-local-token' " +
        "can sign in as the shared dev account. Never enable this on a public host.",
    );
  }

  await initDb();

  // After initDb: the bus spills oversize frames into a table that has to
  // exist, and before listen() so the first connected client is already served
  // by an instance that can hear the rest of the cluster.
  stopPresenceRefresh = startClusterBus();
  // Same ordering reason: the heartbeat writes a `voice_instances` row that
  // initDb just created.
  stopVoiceHeartbeat = startVoiceRegistry();

  // Live HLS: a restart does not stop the media box, so before anything else
  // this process ADOPTS the egresses still running for sessions it owns (a
  // deploy therefore does not interrupt a live watch party), stops any nobody
  // owns, and ends only the rows with nothing behind them so retention can
  // run. Then the monitor watches every egress from here on. API process
  // only: the rooms live in this process.
  if (isLiveHlsEnabled()) {
    const reconciled = await reconcileStaleHlsSessions().catch(
      (error: unknown) => {
        console.error("[hls] boot reconcile failed:", error);
        return null;
      },
    );
    if (reconciled && (reconciled.adopted || reconciled.stopped)) {
      console.log(
        `[hls] boot: adopted ${reconciled.adopted} live session(s), ` +
          `stopped ${reconciled.stopped} orphan egress(es), ` +
          `ended ${reconciled.ended} stale row(s)`,
      );
    }
    startLiveHlsMonitor();
  }
  // LL-HLS (`docs/plans/LL_HLS.md` L1.5), same reasoning as the conventional
  // adoption above, one process behind it: `pqp-remux` runs on the egress
  // box, not in this process, so a `pqp-api` restart never touches a live
  // low-latency party either. Independent flag, independent boot step -- a
  // deployment with `LIVE_HLS_LL` unset never calls the control API at all.
  if (isLiveHlsLLEnabled()) {
    const reconciledLl = await adoptLlHlsSessions().catch((error: unknown) => {
      console.error("[hls-ll] boot reconcile failed:", error);
      return null;
    });
    if (reconciledLl && (reconciledLl.adopted || reconciledLl.stopped)) {
      console.log(
        `[hls-ll] boot: adopted ${reconciledLl.adopted} live LL session(s), ` +
          `stopped ${reconciledLl.stopped} orphan remux session(s), ` +
          `ended ${reconciledLl.ended} stale row(s)`,
      );
    }
  }

  // The cold paths (attachment sweeps, prunes, retention, the webhook outbox:
  // jobs.ts) run here unless a separate worker owns them. After initDb so
  // nothing races schema creation. `WORKER_MODE=api` is the only value that
  // skips this, and it is only correct once `pqp-worker` exists; unset keeps
  // the single-process behaviour every self-host and local dev has.
  // Watch party viewer counts: this process's heartbeat map, flushed at most
  // once a minute per broadcast. Wherever the HTTP routes run, since that is
  // where the heartbeats land.
  stopHlsViewerCounter = hlsViewerCounter.start();

  if (runsColdJobs(role)) {
    coldJobs = startColdJobs();
  } else {
    console.log(
      `[role] WORKER_MODE=${role}: batch jobs left to the worker process`,
    );
  }
  // One publish per boot, on top of the interval, for the same reason the
  // boot sweeps in jobs.ts exist: a process that restarts more often than the
  // interval never reaches its first tick.
  void sweepCommunityHomeSchedule();

  httpServer.listen(PORT, () => {
    console.log(`pqp server listening on http://localhost:${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}/ws`);
    void seedDevHall({ port: PORT }).catch((error) => {
      console.error("[dev-seed] failed:", error);
    });
  });
}

// Last-resort guards: log instead of letting a stray rejection take down
// every connected WebSocket (Railway restarts show up client-side as
// "connection closed" for all users at once).
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandled rejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[process] uncaught exception:", error);
});

/**
 * Well inside `kill_timeout` in fly.toml (30 s). Whatever is still open at
 * this point is closed by the SIGKILL that follows; the lease row is
 * already withdrawn and everything else ages out on its own. Unref'd so it
 * cannot itself be the reason the process lingers.
 */
const SHUTDOWN_DEADLINE_MS = 25_000;

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[shutdown] ${signal} — draining`);
  const deadline = setTimeout(() => {
    console.error("[shutdown] deadline reached, exiting");
    process.exit(0);
  }, SHUTDOWN_DEADLINE_MS);
  deadline.unref?.();

  // First, before anything is closed: `/health` answers 503 from here on, so
  // fly-proxy stops routing new connections to this machine and the
  // reconnects that the closes below produce land on the sibling.
  beginDrain();
  stopHeartbeat();
  stopReadySampler();
  stopDbBreakerSampler();
  clearInterval(rateLimitSweep);
  clearInterval(communityHomeSweep);
  coldJobs?.stop();
  stopPresenceRefresh?.();
  // Withdraw this instance's liveness row EARLY, ahead of the socket closes:
  // the other machine stops counting this one among the live leases the
  // moment the row is gone, and a resume landing there adopts the seat on
  // sight. Peer
  // rows are left in place on purpose: they are what a client resuming onto
  // the other machine is matched against. A clean shutdown is therefore
  // never read as a crash for the next 45 s.
  stopLiveHlsMonitor();
  await stopVoiceHeartbeat?.();
  // Let the check turn red before the first client is sent away. With the
  // check at 10 s the proxy is at worst one interval behind, and a reconnect
  // that still lands here is refused by the closed listener a moment later.
  await new Promise<void>((done) => {
    setTimeout(done, DRAIN_SETTLE_MS);
  });
  // Then the sockets, in batches with a little jitter (`lib/drain.ts`), so
  // the machine staying up sees a ramp of reconnects, not a stampede.
  const total = wss.clients.size;
  const closed = await closeSocketsInBatches(wss.clients, {
    onBatch: (batch, remaining) => {
      logEvent("ws.drainBatch", { batch, remaining, total });
    },
  });
  logEvent("ws.drained", { closed, total });
  await new Promise<void>((done) => httpServer.close(() => done()));
  // The long-lived HTTP/2 connection to Apple. It is `unref`ed, so it cannot
  // hold the loop open on its own; closing it politely is still better than
  // having the process exit mid-stream on a push that was in flight.
  closeApnsSessions();
  // The last minute of viewer sightings, before the pool goes.
  await stopHlsViewerCounter?.();
  // Last, so the presence withdrawals that closing those sockets produces still
  // have a bus to travel on. Best-effort — anything that misses the window is
  // covered by the contribution TTL on the other instances.
  await closeBus();
  await closePool();
  process.exit(0);
}

function installSignalHandlers(): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
