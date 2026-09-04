import "./env.js";
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
import { closePool, getPool, initDb } from "./db.js";
import { closeApnsSessions } from "./services/apns.js";
import { seedDevHall } from "./services/dev-seed.js";
import { closeBus, INSTANCE_ID, setBusTransport } from "./lib/bus.js";
import { createPostgresBusTransport } from "./lib/bus-postgres.js";
import {
  assertCorsConfig,
  corsHeaders,
  handleCors,
  SECURITY_HEADERS,
  sendError,
} from "./lib/http.js";
import { logEvent } from "./lib/log.js";
import { noteRuntimeSample, registerSocketCount } from "./lib/runtime.js";
import {
  clientAddress,
  createRateLimiter,
  sweepRateLimits,
} from "./lib/rate-limit.js";
import {
  isAttachmentsConfigured,
  sweepOrphanedAttachments,
  sweepQuarantinedAttachments,
} from "./services/attachments.js";
import {
  isCommunityHomeEnabled,
  publishDueCommunityHomePosts,
  sweepOrphanedCommunityHomeMedia,
} from "./services/community-home.js";
import { sweepPendingAccountDeletions } from "./services/account.js";
import { pruneAuditLog } from "./services/audit.js";
import { pruneResolvedReports } from "./services/reports.js";
import { pruneExpiredTimeouts } from "./services/sanctions.js";
import { sweepMessageRetention } from "./services/retention.js";
import { sweepExpiredConnectionStates } from "./services/connections.js";
import { sweepChannelAudiences } from "./services/servers.js";
import { checkReadiness, READINESS_PATH } from "./services/readiness.js";
import {
  getStatusSummary,
  pruneStatusSamples,
  recordStatusSamples,
} from "./services/status.js";
import {
  getSocketUser,
  handleWsConnection,
  notifyCommunityHomeUpdate,
  startClusterPresenceRefresh,
  startClusterStatusRefresh,
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

const httpServer = createServer((req, res) => {
  void (async () => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const pathname = url.pathname;

    if (pathname === "/health") {
      // Report unhealthy if the DB is unreachable so the platform can restart /
      // route away instead of serving a process with a dead pool.
      try {
        await getPool().query("SELECT 1");
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          ...SECURITY_HEADERS,
        });
        // The deployed commit, so "is the API actually running this code?" has
        // an answer from outside. It did not, and a stalled deploy went
        // unnoticed across five releases: every /api/ route answers 401 before
        // it routes, so a missing route is indistinguishable from an
        // unauthenticated one, and the client degrades quietly enough that the
        // app still looks healthy. `/health` is the only unauthenticated
        // surface, so the version belongs here.
        res.end(
          JSON.stringify({ ok: true, version: process.env.APP_VERSION ?? "dev" }),
        );
      } catch {
        res.writeHead(503, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          ...SECURITY_HEADERS,
        });
        res.end(JSON.stringify({ ok: false, error: "database unavailable" }));
      }
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

const wss = new WebSocketServer({
  server: httpServer,
  path: "/ws",
  maxPayload: MAX_WS_PAYLOAD_BYTES,
});

// Protocol-level heartbeat: browsers auto-reply pong, so this both reaps dead
// connections and keeps proxy idle timers (e.g. Railway edge) from closing
// quiet sockets.
const HEARTBEAT_INTERVAL_MS = 30_000;
const socketLiveness = new WeakMap<import("ws").WebSocket, boolean>();

// One live number for the operator dashboard: every signed-in client holds a
// socket open for its whole session, so this is the closest thing the process
// has to "people connected". A Set's `size`, read only when the dashboard asks.
registerSocketCount(() => wss.clients.size);

wss.on("connection", (socket, req) => {
  // Take a peak sample here rather than on a timer: the maximum number of
  // concurrent sockets is always reached immediately after one opens, so
  // sampling on this event makes `peakSockets` exact rather than sampled.
  noteRuntimeSample();
  socketLiveness.set(socket, true);
  socket.on("pong", () => {
    socketLiveness.set(socket, true);
  });
  handleWsConnection(socket, clientAddress(req as never));
});

wss.on("error", (error) => {
  console.error("[ws] server error:", error);
});

const heartbeat = setInterval(() => {
  // Free ride on a loop that already runs: keeps the pool high-water marks
  // moving on a quiet server, where nothing else is sampling them.
  noteRuntimeSample();
  for (const client of wss.clients) {
    if (socketLiveness.get(client) === false) {
      // Reaping a socket that missed the previous heartbeat — log it so a
      // mystery "kicked out" can be traced to a missed pong vs a real close.
      const user = getSocketUser(client);
      logEvent("ws.heartbeatTerminate", { userId: user?.id });
      client.terminate();
      continue;
    }
    socketLiveness.set(client, false);
    client.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => clearInterval(heartbeat));

// Drop expired rate-limit windows so the map doesn't grow unbounded.
const rateLimitSweep = setInterval(() => {
  sweepRateLimits();
  // Same cadence, same reason: all three are maps that only shrink if swept.
  // The audience cache is capped as well as swept, so this is about returning
  // memory after a busy server goes quiet, not about bounding it.
  sweepAuthCaches();
  sweepChannelAudiences();
}, 60_000);
rateLimitSweep.unref?.();

/**
 * Collect attachments no message claimed — uploads that were never sent, and
 * rows orphaned when a message, channel or server was deleted.
 *
 * Hourly, because the grace period is an hour: running more often only finds
 * rows it is not yet allowed to touch. Skipped outright without storage so a
 * deployment that never enabled the feature does no work at all, and every
 * failure is swallowed — a bucket being unreachable is a cost problem that
 * resolves on the next run, and must never be able to bring the server down.
 */
const ATTACHMENT_SWEEP_INTERVAL_MS = 60 * 60_000;

async function sweepAttachments(): Promise<void> {
  // Quarantine expiry runs whether or not storage is configured, and outside
  // the guard below on purpose: a quarantined row can be a remote GIF, which
  // has no bucket anywhere in its life cycle, and a deployment that turned S3
  // off after scanning had already refused something would otherwise hold those
  // rows forever. `sweepQuarantinedAttachments` never touches an
  // illegal-content row at any age — see its comment.
  try {
    await sweepQuarantinedAttachments();
  } catch (error) {
    console.error("[content-safety] quarantine sweep failed:", error);
  }

  if (!isAttachmentsConfigured()) {
    return;
  }
  try {
    await sweepOrphanedAttachments();
  } catch (error) {
    console.error("[attachments] sweep failed:", error);
  }
}

const attachmentSweep = setInterval(() => {
  void sweepAttachments();
}, ATTACHMENT_SWEEP_INTERVAL_MS);
// Unref'd like the rate-limit sweep: a timer this long must not be the reason
// the process refuses to exit.
attachmentSweep.unref?.();

/** Daily is plenty for a 90-day retention window; a failure here costs
 * nothing but disk, and resolves on the next run. */
const AUDIT_LOG_PRUNE_INTERVAL_MS = 24 * 60 * 60_000;

const auditLogPrune = setInterval(() => {
  void pruneAuditLog().catch((error) => {
    console.error("[audit] prune failed:", error);
  });
}, AUDIT_LOG_PRUNE_INTERVAL_MS);
auditLogPrune.unref?.();

/** Same cadence and the same failure tolerance as the audit prune, but a
 * different reason for existing: a resolved report holds a copy of reported
 * content, so this is a privacy sweep rather than a disk one. Open reports are
 * never touched — see `pruneResolvedReports`. */
const reportPrune = setInterval(() => {
  void pruneResolvedReports().catch((error) => {
    console.error("[reports] prune failed:", error);
  });
}, AUDIT_LOG_PRUNE_INTERVAL_MS);
reportPrune.unref?.();

/**
 * Expired timeouts.
 *
 * The one sweep in this file that NOTHING DEPENDS ON. Every read in
 * services/sanctions.ts filters on `expires_at > NOW()`, so a timeout ends when
 * it says it ends whether or not this timer ever fires; deleting this block
 * would change no behaviour and only leave one dead row per sanction ever
 * issued. It is here for the same reason the audit prune is — disk — and it is
 * worth saying out loud, because a sanction whose *correctness* depended on a
 * cron would be a sanction that quietly outlives its sentence when a deploy
 * restarts the process before the timer fires.
 */
const timeoutPrune = setInterval(() => {
  void pruneExpiredTimeouts().catch((error) => {
    console.error("[sanctions] timeout prune failed:", error);
  });
}, AUDIT_LOG_PRUNE_INTERVAL_MS);
timeoutPrune.unref?.();

/** Daily: retention is measured in days, so nothing is lost by checking once
 * a day rather than continuously. */
const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60_000;

/** One probe a minute: fine enough to catch a short outage, cheap enough to
 * keep 30 days of history small. */
const STATUS_SAMPLE_INTERVAL_MS = 60_000;

const statusLimiter = createRateLimiter({ capacity: 60, refillPerSecond: 1 });

const statusSampler = setInterval(() => {
  void recordStatusSamples().catch((error) => {
    console.error("[status] sample failed:", error);
  });
}, STATUS_SAMPLE_INTERVAL_MS);
statusSampler.unref?.();

const statusPrune = setInterval(() => {
  void pruneStatusSamples().catch((error) => {
    console.error("[status] prune failed:", error);
  });
}, 24 * 60 * 60_000);
statusPrune.unref?.();

const retentionSweep = setInterval(() => {
  void sweepMessageRetention().catch((error) => {
    console.error("[retention] sweep failed:", error);
  });
  void sweepExpiredConnectionStates().catch((error) => {
    console.error("[connections] state sweep failed:", error);
  });
}, RETENTION_SWEEP_INTERVAL_MS);
retentionSweep.unref?.();

/**
 * Finish account deletions that were interrupted between the Clerk call and the
 * local DELETE — see the ordering note on `deleteAccount`.
 *
 * Five minutes rather than daily, and unlike every other sweep in this file it
 * is not about disk: each pending row is an account whose owner has been told
 * their data is gone and whose sign-in already is. A day of that is a day of
 * being wrong about a statutory promise.
 */
const PENDING_DELETION_SWEEP_INTERVAL_MS = 5 * 60_000;

const pendingDeletionSweep = setInterval(() => {
  void sweepPendingAccountDeletions()
    .then((finished) => {
      if (finished > 0) {
        console.warn(`[account] finished ${finished} interrupted deletion(s)`);
      }
    })
    .catch((error) => {
      console.error("[account] pending deletion sweep failed:", error);
    });
}, PENDING_DELETION_SWEEP_INTERVAL_MS);
pendingDeletionSweep.unref?.();

/**
 * Community Home schedule catch-up.
 *
 * Single Node process, no worker, no queue. Every 30s flip due `scheduled`
 * rows to `published` and nudge connected members. Correctness does not
 * depend on the interval staying up — a redeploy that misses a tick catches
 * up on the next one (and on boot below). Staging stays one machine.
 */
const COMMUNITY_HOME_SCHEDULE_MS = 30_000;

async function sweepCommunityHomeSchedule(): Promise<void> {
  // Flag off: nothing to publish and nothing to sweep. Read per tick so a
  // restart with the variable set picks it up without touching this code.
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
  try {
    await sweepOrphanedCommunityHomeMedia();
  } catch (error) {
    console.error("[community-home] media sweep failed:", error);
  }
}

const communityHomeSweep = setInterval(() => {
  void sweepCommunityHomeSchedule();
}, COMMUNITY_HOME_SCHEDULE_MS);
communityHomeSweep.unref?.();

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
  setBusTransport(createPostgresBusTransport());
  logEvent("bus.enabled", { transport: "postgres", instance: INSTANCE_ID });
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
  };
}

let stopPresenceRefresh: (() => void) | null = null;

async function main() {
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

  // One sweep per boot, on top of the interval: a process that redeploys or
  // crash-restarts more often than hourly never reaches the first tick, so on
  // Railway the sweeper could otherwise never run once in the lifetime of a
  // deployment. After initDb so it cannot race schema creation, and unawaited
  // so a bucket that is merely unreachable cannot hold up listen().
  void sweepAttachments();
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

async function shutdown(signal: string) {
  console.log(`[shutdown] ${signal} — draining`);
  clearInterval(heartbeat);
  clearInterval(rateLimitSweep);
  clearInterval(attachmentSweep);
  clearInterval(pendingDeletionSweep);
  clearInterval(communityHomeSweep);
  stopPresenceRefresh?.();
  for (const socket of wss.clients) {
    socket.close(1001, "Server shutting down");
  }
  await new Promise<void>((done) => httpServer.close(() => done()));
  // The long-lived HTTP/2 connection to Apple. It is `unref`ed, so it cannot
  // hold the loop open on its own; closing it politely is still better than
  // having the process exit mid-stream on a push that was in flight.
  closeApnsSessions();
  // Last, so the presence withdrawals that closing those sockets produces still
  // have a bus to travel on. Best-effort — anything that misses the window is
  // covered by the contribution TTL on the other instances.
  await closeBus();
  await closePool();
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
