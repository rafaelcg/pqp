/**
 * "Is it down?" — the checks that run every ten minutes.
 *
 * Each one returns { key, title, status, summary, detail?, runbook? } where
 * status is ok | fail | warn | skip. `key` is permanent: it is the identity of
 * the alert issue, so renaming one orphans an open incident.
 *
 * Every probe here is wrapped in `untilOk` (3 attempts over ~40s) because a
 * rolling deploy of the API replicas makes all of them fail briefly on every
 * release. See the note on `untilOk` in net.mjs.
 *
 * WHERE PRODUCTION RUNS: the Vultr box behind Cloudflare since 2026-09-17
 * (docs/deploy-vultr.md). Everything below reads only what a GitHub runner can
 * reach with no secret: `/health`, `/ready`, `/status.json`, the WebSocket and
 * the public site. The Fly-only checks (`fly-machines`, `worker-image-drift`,
 * and the `fly logs` reader in errors.mjs) were removed when the Fly rollback
 * apps were destroyed on 2026-10-22.
 */

import { httpGet, untilOk, wsProbe } from "./net.mjs";

export const API_ORIGIN = process.env.MONITOR_API_ORIGIN ?? "https://api.pqp.gg";
export const WEB_ORIGIN = process.env.MONITOR_WEB_ORIGIN ?? "https://pqp.gg";

// Overridable only so the failure path can be exercised in seconds instead of
// two minutes. Leave it alone in CI — the spacing is what makes a deploy
// invisible to these probes.
const RETRY = {
  attempts: 3,
  delayMs: Number(process.env.MONITOR_RETRY_DELAY_MS ?? 20_000),
};

function trail(tries) {
  return tries.map((t, i) => `attempt ${i + 1}: ${t.note}`).join("\n");
}

async function checkApiHealth() {
  const result = await untilOk(async () => {
    const res = await httpGet(`${API_ORIGIN}/health`, { timeoutMs: 10_000 });
    let parsed = null;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      /* reported below as a non-JSON body */
    }
    const ok = res.status === 200 && parsed?.ok === true;
    return {
      ok,
      version: parsed?.version,
      note: `HTTP ${res.status} in ${res.ms}ms — ${res.body.slice(0, 160)}`,
    };
  }, RETRY);

  return {
    key: "api-health",
    title: `API health (${API_ORIGIN}/health)`,
    status: result.ok ? "ok" : "fail",
    // /health is process liveness only (no query; docs/plans/ALWAYS_ON.md A3.1):
    // a 200 is "up and not draining". The database is `api-ready`'s business.
    summary: result.ok
      ? `200 ok:true, serving ${result.version ?? "unknown"} (attempt ${result.attempt})`
      : `No healthy response after ${result.tries.length} attempts over ~40s.`,
    detail: trail(result.tries),
    runbook: [
      "1. `ssh root@<box>` (address: docs/deploy-vultr.md), then `cd /opt/pqp && COMPOSE_PROFILES=replicas docker compose ps`.",
      "2. `docker compose logs --tail=200 api-a api-b worker caddy`; the same lines are in Grafana Loki under `{container=~\"api.*|worker\"}`.",
      "3. A Cloudflare 52x/502 with a healthy `docker compose ps` means Caddy or the origin firewall (443 is open to Cloudflare ranges only); a 5xx from the app itself means a replica is crash-looping, read `docker compose logs api-a`.",
      "4. Do NOT run a bare `docker compose up` (docs/deploy-vultr.md section 8): recreate one replica at a time with `APP_IMAGE_TAG` set, never during a live watch party.",
      "5. If the box itself is gone, the rollback to Fly is in docs/deploy-vultr.md (\"Rollback\").",
    ].join("\n"),
  };
}

async function checkWebsite() {
  const result = await untilOk(async () => {
    const res = await httpGet(`${WEB_ORIGIN}/`, { timeoutMs: 10_000 });
    return {
      ok: res.status === 200,
      note: `HTTP ${res.status} in ${res.ms}ms (${res.body.length} bytes)`,
    };
  }, RETRY);

  return {
    key: "web-app",
    title: `Website (${WEB_ORIGIN})`,
    status: result.ok ? "ok" : "fail",
    summary: result.ok
      ? `200 (attempt ${result.attempt})`
      : `No 200 after ${result.tries.length} attempts over ~40s.`,
    detail: trail(result.tries),
    runbook:
      "The SPA is static on Cloudflare Pages. Check the Pages project's latest deployment, then the pqp.gg DNS records.",
  };
}

/**
 * The one a plain HTTP check misses.
 *
 * Chat, presence and voice signalling all ride `/ws`. `/health` can return 200
 * while every WebSocket is dead — that is not hypothetical, it is CLAUDE.md
 * pitfall #9, where the API looked fine and the whole app was unusable.
 *
 * The probe sends a deliberately invalid auth token. A healthy server answers
 * with close code 4401, which is only reachable if the upgrade succeeded, the
 * socket message loop ran, and the token was actually put through Clerk. No
 * credential is needed to get that answer, so this check needs no secret at
 * all — a monitor that cannot be run because it needs a login is a monitor
 * that stops being run.
 */
async function checkWebsocket() {
  const wsUrl = `${API_ORIGIN.replace(/^http/, "ws")}/ws`;
  const result = await untilOk(async () => {
    const res = await wsProbe(wsUrl, {
      send: JSON.stringify({ type: "auth", token: "pqp-monitor-probe-invalid" }),
      timeoutMs: 15_000,
    });
    if (!res.accepted) {
      return { ok: false, note: `no upgrade — server answered HTTP ${res.status}` };
    }
    if (!res.frame) {
      // Upgraded, then silence. This is the shape of a wedged message loop:
      // the listener accepts sockets but nothing services them.
      return { ok: false, note: "upgraded (101) but the server never sent a frame" };
    }
    if (res.frame.kind === "close" && res.frame.code === 4401) {
      return { ok: true, note: `101 upgrade, close 4401 "${res.frame.reason}" in ${res.ms}ms` };
    }
    return {
      ok: false,
      note: `unexpected reply: ${JSON.stringify(res.frame)}`,
    };
  }, RETRY);

  return {
    key: "websocket",
    title: `WebSocket handshake (${wsUrl})`,
    status: result.ok ? "ok" : "fail",
    summary: result.ok
      ? `Upgrade and auth handshake answered (attempt ${result.attempt}).`
      : `The WebSocket endpoint did not complete a handshake after ${result.tries.length} attempts.`,
    detail: trail(result.tries),
    runbook: [
      "Chat, presence and voice signalling all ride this socket, so this being down is a total outage even while /health is green.",
      "1. `ssh root@<box>`, then `cd /opt/pqp && docker compose logs --tail=300 api-a api-b | grep '\\[pqp\\] ws\\.'`, `ws.connect` with no `ws.auth` means the auth path is broken, no `ws.connect` at all means the upgrade never reaches the app.",
      "2. api.pqp.gg is proxied by Cloudflare and terminated again by Caddy: check the Cloudflare dashboard for WebSocket and rule changes, and `docker compose logs caddy` for upgrade errors.",
    ].join("\n"),
  };
}

/**
 * Reads the app's own component probes rather than duplicating them.
 *
 * server/src/services/status.ts already samples the database, object storage,
 * voice backend and GIF search every minute and keeps 30 days of history. This
 * check is the bridge from that data to a notification: without it the status
 * page is something you have to remember to look at.
 *
 * `disabled` components are ignored — off on purpose is not broken.
 */
async function checkStatusComponents() {
  const result = await untilOk(
    async () => {
      const res = await httpGet(`${API_ORIGIN}/status.json`, { timeoutMs: 15_000 });
      if (res.status !== 200) {
        return { ok: false, note: `HTTP ${res.status}` };
      }
      const summary = JSON.parse(res.body);
      const live = summary.components.filter((c) => c.state !== "disabled");
      const broken = live.filter((c) => c.state !== "operational");
      return {
        ok: broken.length === 0,
        broken,
        note: live
          .map(
            (c) =>
              `${c.key}=${c.state}${c.latencyMs === undefined ? "" : ` (${c.latencyMs}ms)`}` +
              (c.uptime24h === null ? "" : ` 24h=${(c.uptime24h * 100).toFixed(2)}%`),
          )
          .join(", "),
      };
    },
    { attempts: 2, delayMs: RETRY.delayMs },
  );

  return {
    key: "status-components",
    title: "Component probes (/status.json)",
    status: result.ok ? "ok" : "fail",
    summary: result.ok
      ? `All components operational: ${result.note}`
      : // Two different failures wear the same status, and confusing them
        // costs real minutes during an incident: a component reporting `down`
        // means the app is up and a dependency is not, while an unreachable
        // /status.json means the API itself is gone.
        result.broken?.length
        ? `Degraded or down: ${result.broken.map((c) => `${c.label} (${c.state})`).join(", ")}`
        : `Could not read /status.json — ${result.note}`,
    detail: trail(result.tries),
    runbook: [
      "These are the app's own probes (server/src/services/status.ts), sampled every minute.",
      "`database`, the pg pool cannot `SELECT 1`; check the managed Postgres cluster in the Vultr dashboard (the box has no database of its own), then `ssh root@<box>` and `docker compose logs --tail=200 api-a | grep -i 'connection\\|pool'`.",
      "`storage`, the R2 bucket rejected a HEAD; check the S3_* values in `/opt/pqp/.env` on the box and the R2 dashboard. Attachments break, the rest of the app does not.",
      "`voice` — only ever fails when LIVEKIT_* is half-configured.",
    ].join("\n"),
  };
}

/**
 * `/ready`, read once and shared.
 *
 * Four checks below look at different fields of the same report. Fetching it
 * four times would be four `SELECT 1`s and, worse, four draws on the endpoint's
 * rate limit (5 burst, 2/s per address, and behind Cloudflare the address the
 * app sees can be a shared edge one), so the FIRST attempt of each check reuses
 * a read up to 60 seconds old. Every RETRY (attempt 2 onwards) asks for a fresh
 * one via `maxAgeMs: 0`: a retry exists to see whether the condition persists,
 * and answering it from the sample that raised the doubt would count one
 * reading three times (a brief pool spike would look sustained, and each retry
 * would wait 20 seconds for no new evidence). `api-ready` always reads fresh.
 */
let readyMemo = null;

export function resetReadyMemo() {
  readyMemo = null;
}

const SHARED_READ_MS = 60_000;

/** Attempt 1 may share a recent read; a retry must see a new one. */
export const maxAgeFor = (attempt) => (attempt > 1 ? 0 : SHARED_READ_MS);

async function readReady({ maxAgeMs = SHARED_READ_MS } = {}) {
  if (readyMemo && Date.now() - readyMemo.at < maxAgeMs) {
    return readyMemo.value;
  }
  const res = await httpGet(`${API_ORIGIN}/ready`, { timeoutMs: 10_000 });
  let parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    /* a Cloudflare error page, or a proxy 5xx: reported by the caller */
  }
  const value = { status: res.status, ms: res.ms, parsed, body: res.body };
  readyMemo = { at: Date.now(), value };
  return value;
}

const readyNote = (r) =>
  `HTTP ${r.status} in ${r.ms}ms${r.parsed ? "" : ` (not JSON: ${r.body.slice(0, 120).replace(/\s+/g, " ")})`}`;

/**
 * Which of postgres / livekit / storage is not ok, from a parsed `/ready`.
 *
 * Deliberately NOT `pool` and NOT `liveHls`: each has its own check key
 * (`api-pool`, `live-hls`), and one incident should open one issue, not two.
 * `skipped` entries are `ok: true` by the endpoint's own contract.
 */
export function judgeReadyDependencies(parsed) {
  const checks = parsed?.checks;
  if (!checks || typeof checks !== "object") {
    return { ok: false, failing: ["no usable report"] };
  }
  const failing = ["postgres", "livekit", "storage"].filter((name) => checks[name]?.ok !== true);
  return { ok: failing.length === 0, failing };
}

/** Warn when this fraction of one replica's pool is checked out. */
export const POOL_WARN_FRACTION = Number(process.env.MONITOR_POOL_WARN_FRACTION ?? 0.85);

/** `ok`, `warn` (headroom nearly gone), `fail` (the endpoint says it is not serving) or `skip`. */
export function judgePool(pool) {
  if (!pool || typeof pool.ok !== "boolean") {
    return { level: "skip", note: "no pool block in /ready" };
  }
  const { inUse = 0, max = 0, queued = 0 } = pool;
  const note = `inUse ${inUse}/${max}, queued ${queued}`;
  if (!pool.ok) {
    return { level: "fail", note };
  }
  // max 0 means "no pool yet" (a cold process); there is nothing to be short of.
  if (max > 0 && inUse / max >= POOL_WARN_FRACTION) {
    return { level: "warn", note };
  }
  return { level: "ok", note };
}

/** Every non-home SFU region that is down, from `checks.livekitRegions`. */
export function judgeRegions(regions) {
  if (!regions || typeof regions !== "object" || Object.keys(regions).length === 0) {
    return { level: "skip", down: [], all: [] };
  }
  const entries = Object.entries(regions);
  const down = entries.filter(([, check]) => check?.ok !== true).map(([id]) => id);
  return {
    level: down.length ? "fail" : "ok",
    down,
    all: entries.map(
      ([id, check]) =>
        `${id}=${check?.ok === true ? "ok" : "down"}${check?.host ? ` (${check.host})` : ""}`,
    ),
  };
}

/**
 * The deep check: can the API reach Postgres, the SFU and the attachment
 * bucket right now?
 *
 * `/health` is liveness only by design, so until this existed nothing in the
 * repo's own probes asked the database a question: `status-components` reads
 * the app's own once-a-minute samples, which lag. `/ready` is the endpoint
 * built for an external monitor (services/ready.ts).
 *
 * A run in which every attempt was a 429 is a SKIP: the limiter protects
 * Postgres from a scraper, and "the limiter said slow down" is not evidence
 * about the database.
 */
async function checkApiReady() {
  const result = await untilOk(async () => {
    const r = await readReady({ maxAgeMs: 0 });
    if (r.status === 429) {
      return { ok: false, limited: true, note: "HTTP 429, rate limited" };
    }
    const verdict = judgeReadyDependencies(r.parsed);
    return {
      ok: verdict.ok,
      failing: verdict.failing,
      version: r.parsed?.version,
      host: r.parsed?.checks?.livekit?.host,
      note: `${readyNote(r)}; ${verdict.ok ? "postgres, livekit, storage ok" : `failing: ${verdict.failing.join(", ")}`}`,
    };
  }, RETRY);

  const title = `API dependencies (${API_ORIGIN}/ready)`;
  if (!result.ok && result.tries.every((t) => t.limited)) {
    return {
      key: "api-ready",
      title,
      status: "skip",
      summary: "Skipped: /ready rate-limited every attempt (HTTP 429), so there is no reading.",
      detail: trail(result.tries),
    };
  }

  return {
    key: "api-ready",
    title,
    status: result.ok ? "ok" : "fail",
    summary: result.ok
      ? `Postgres, SFU and attachment storage all answer (attempt ${result.attempt}), serving ${result.version ?? "unknown"}${result.host ? `, SFU ${result.host}` : ""}.`
      : !result.failing || result.failing[0] === "no usable report"
        ? "/ready did not return a usable report (no connection, a proxy error page, or a malformed body)."
        : `/ready says the API cannot reach: ${result.failing.join(", ")}.`,
    detail: trail(result.tries),
    runbook: [
      "`/ready` names the dependency. `api-health` green with this red means the process is fine and something behind it is not.",
      "`postgres`: the managed cluster is in the Vultr dashboard (the box has no database of its own). Also `ssh root@<box>`, then `cd /opt/pqp && docker compose logs --tail=200 api-a | grep -i 'connection\\|pool\\|ECONN'`. Never resize the cluster during a live event (docs/DB_RUNBOOK.md).",
      "`livekit`: the SFU box (`sfu.pqp.gg`) is a separate machine with its own Grafana alerts; see 'The SFU box' in docs/MONITORING.md.",
      "`storage`: the ATTACHMENT bucket (`S3_*` in `/opt/pqp/.env`) rejected a signed HEAD; the watch-party bucket is `live-hls`.",
      "A failing `livekit` or `storage` does not stop chat; a failing `postgres` stops nearly everything.",
    ].join("\n"),
  };
}

/**
 * The pool, from the same report. The server already does the hard part: it
 * samples the pool once a second and flips `pool.ok` only when the queue has
 * been non-empty for 10s or every connection has been checked out for 30s
 * (`POOL_QUEUE_GRACE_MS`, `POOL_FULL_GRACE_MS`). This check adds the half that
 * is only visible from outside: HEADROOM. A pool still pinned near its maximum
 * on a fresh reading 40 seconds after the first is not yet "not serving" and is
 * how 2026-09-05 and 2026-09-12 started.
 *
 * It reads ONE replica: Caddy balances across api-a and api-b, and each has its
 * own pool (`PG_POOL_MAX` is split per replica by `pqp-deploy`), so `max` here
 * is that replica's, not the cluster's.
 *
 * This lives in the 10-minute group, not the daily limits one: a pool reading
 * taken at 08:17 in Sao Paulo describes the quietest hour of the day.
 */
async function checkApiPool() {
  const result = await untilOk(async (attempt) => {
    const r = await readReady({ maxAgeMs: maxAgeFor(attempt) });
    if (r.status === 429) {
      return { ok: false, limited: true, level: "skip", note: "HTTP 429, rate limited" };
    }
    const verdict = judgePool(r.parsed?.checks?.pool);
    return {
      ok: verdict.level === "ok" || verdict.level === "skip",
      level: verdict.level,
      pool: verdict.note,
      note: `${readyNote(r)}; pool ${verdict.note}`,
    };
  }, RETRY);

  const title = "API database pool (/ready checks.pool)";
  // No level at all means the request itself threw (no connection, timeout):
  // that is `api-health` and `api-ready`'s outage, not a pool reading.
  if (result.level === "skip" || result.level === undefined) {
    return {
      key: "api-pool",
      title,
      status: "skip",
      summary:
        "Skipped: /ready gave no pool reading (rate limited, or unreachable, which `api-ready` owns).",
      detail: trail(result.tries),
    };
  }
  const limit = `warn at ${Math.round(POOL_WARN_FRACTION * 100)}% in use`;
  return {
    key: "api-pool",
    title,
    status: result.level,
    summary:
      result.level === "ok"
        ? `Pool has headroom (${result.pool}).`
        : result.level === "warn"
          ? `Pool nearly exhausted on every attempt (${result.pool}; ${limit}).`
          : `The pool is not serving: queue not draining for >10s, or every connection held for >30s (${result.pool}).`,
    detail: trail(result.tries),
    runbook: [
      "A saturated pool shows as slow or failing requests while `/health` stays green (the 2026-09-05 and 2026-09-12 shape).",
      "1. `ssh root@<box>`, then `cd /opt/pqp && docker compose logs --tail=300 api-a api-b worker | grep -i 'pool\\|Connection terminated\\|timeout'`.",
      "2. Grafana Loki: the `Connection terminated` panel on the pqp API events dashboard shows the shape over time.",
      "3. Budget: `PG_POOL_MAX` is the TOTAL across API replicas and is split by `pqp-deploy` (docs/DB_RUNBOOK.md). Never raise it past the managed cluster's connection limit during a live event.",
      "4. A pool full of hung connections usually clears with a rolling restart, one replica at a time (docs/deploy-vultr.md section 8), but find the slow query first or it comes back.",
    ].join("\n"),
  };
}

/**
 * The extra SFU regions, which `/ready` deliberately keeps OUT of its own
 * verdict (a Miami box being down must not fail an API deploy gate in Sao
 * Paulo), and which therefore nothing else here sees. `skip` while
 * `LIVEKIT_REGIONS` is unset, which is a single-region deployment.
 */
async function checkSfuRegions() {
  const result = await untilOk(async (attempt) => {
    const r = await readReady({ maxAgeMs: maxAgeFor(attempt) });
    if (r.status === 429) {
      return { ok: false, limited: true, level: "skip", note: "HTTP 429, rate limited" };
    }
    const verdict = judgeRegions(r.parsed?.checks?.livekitRegions);
    return {
      ok: verdict.level !== "fail",
      level: r.parsed ? verdict.level : "skip",
      down: verdict.down,
      regions: verdict.all.join(", "),
      note: `${readyNote(r)}; regions ${verdict.all.join(", ") || "none"}`,
    };
  }, RETRY);

  const title = "SFU regions (/ready checks.livekitRegions)";
  if (result.level === "skip" || result.level === undefined) {
    return {
      key: "sfu-regions",
      title,
      status: "skip",
      summary:
        "Skipped: no extra SFU regions in /ready (LIVEKIT_REGIONS unset), or no readable report.",
    };
  }
  return {
    key: "sfu-regions",
    title,
    status: result.ok ? "ok" : "fail",
    summary: result.ok
      ? `Every extra SFU region answers: ${result.regions}.`
      : `SFU region(s) down: ${result.down.join(", ")}. Rooms already pinned there are down with it.`,
    detail: trail(result.tries),
    runbook: [
      "The home SFU is part of `api-ready`; this is the OTHER regions, which `/ready` keeps out of its verdict on purpose.",
      "Rooms already pinned to a dead region are that region's outage. The runbook is docs/plans/SFU_REGIONS.md: route its countries home.",
      "The region boxes have their own Grafana alerts (see 'The SFU box' in docs/MONITORING.md).",
    ].join("\n"),
  };
}

/**
 * The watch-party bucket, through `/ready`.
 *
 * It is deliberately NOT covered by anything above. `api-health` reads
 * `/health`, which is shallow by design; `status-components` reads
 * `/status.json`, whose `storage` probe is the ATTACHMENT bucket. Live HLS
 * writes to a second bucket with a second key pair (`LIVE_HLS_S3_*`), and one
 * being green has never implied anything about the other: production ran a
 * week with the HLS secrets deployed and every existing check green.
 *
 * `skip` while the feature is off, which is what `/ready` reports as
 * `{ skipped: true }`. That is the state on merge, so this opens nothing until
 * somebody sets `LIVE_HLS_ENABLED`, and it starts watching by itself the
 * moment they do. There is nothing to remember to turn on.
 */
async function checkLiveHls() {
  const result = await untilOk(async (attempt) => {
    const res = await readReady({ maxAgeMs: maxAgeFor(attempt) });
    const check = res.parsed?.checks?.liveHls;
    // A 503 for some OTHER dependency still carries a truthful liveHls block,
    // and blaming the bucket for a Postgres outage would send somebody to the
    // wrong dashboard. So this reads its own field and ignores the envelope.
    return {
      ok: check === undefined || check.skipped === true || check.ok === true,
      state:
        check === undefined
          ? "absent"
          : check.skipped
            ? "skipped"
            : check.ok
              ? "ok"
              : "failing",
      ms: check?.ms,
      note: `${readyNote(res)}, liveHls=${JSON.stringify(check ?? null)}`,
    };
  }, RETRY);

  // `absent` is an API older than the check, not an outage. No state at all
  // means the request itself threw, which is `api-health`'s outage to report:
  // an unreachable API says nothing about the bucket.
  if (result.state === undefined || result.state === "absent" || result.state === "skipped") {
    return {
      key: "live-hls",
      title: "Watch party HLS bucket (/ready checks.liveHls)",
      status: "skip",
      summary:
        result.state === undefined
          ? "Skipped: /ready could not be read (the API itself is unreachable, which api-health reports)."
          : result.state === "absent"
            ? "The deployed API has no liveHls check yet."
            : "LIVE_HLS_ENABLED is off, so there is no bucket to watch.",
    };
  }

  return {
    key: "live-hls",
    title: "Watch party HLS bucket (/ready checks.liveHls)",
    status: result.ok ? "ok" : "fail",
    summary: result.ok
      ? `Bucket reachable and the key pair accepted${result.ms === undefined ? "" : ` (${result.ms}ms)`}.`
      : "Live HLS is ON and the API cannot reach its bucket. No segment can be written, so every watch party is a blank pane.",
    detail: trail(result.tries),
    runbook: [
      "This is the LIVE_HLS_S3_* bucket, not the attachment S3_* one. `status-components` -> storage watches the other.",
      "The probe is a signed HEAD of a key that cannot exist, so a 404 passes.",
      "403 means the key pair was rejected or lost its grant on the bucket: check the R2 API token in the Cloudflare dashboard and the `LIVE_HLS_S3_*` values in `/opt/pqp/.env` on the box (`ssh root@<box>`).",
      "A transport failure means R2 or the endpoint is unreachable: check the Cloudflare status page.",
      "To turn the feature off while fixing it, prefer the per-server switch in the operator dashboard (`servers.live_hls_enabled`, no deploy). The master switch `LIVE_HLS_ENABLED` is in `/opt/pqp/.env` and needs a rolling deploy to take effect (docs/deploy-vultr.md section 8), never a bare `docker compose up`.",
      "Full runbook: docs/WATCH_PARTY.md, 'Turning it on in production'.",
    ].join("\n"),
  };
}

/**
 * Every URL the live service worker precaches answers 200.
 *
 * One non-200 entry fails the worker's whole install, in every browser, and
 * nothing on the page shows it. From 2026-09-30 to 2026-10-10 three precached
 * pages were 308'd by Pages' pretty URLs to a path the edge middleware 404'd:
 * no new visitor got a worker (so no web push), and old workers served the old
 * build on every plain reload. The deploy checks its own deployment URL
 * (`client/scripts/check-precache.mjs`); this checks pqp.gg itself, where a
 * zone rule changed in the dashboard could do the same with no deploy at all.
 *
 * GET, never HEAD: Pages answered HEAD with 200 for exactly the paths the
 * middleware 404'd on GET. `Range: bytes=0-0` keeps it to a byte per file, so
 * 206 counts as present.
 */
async function fetchFollowing(url, hops = 3) {
  let target = url;
  for (let hop = 0; ; hop += 1) {
    const res = await httpGet(target, { timeoutMs: 10_000, headers: { range: "bytes=0-0" } });
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location && hop < hops) {
      target = new URL(location, target).toString();
      continue;
    }
    return res;
  }
}

async function checkPrecache() {
  const result = await untilOk(async () => {
    const sw = await httpGet(`${WEB_ORIGIN}/sw.js`, { timeoutMs: 10_000 });
    if (sw.status !== 200) {
      return { ok: false, note: `sw.js answered HTTP ${sw.status}` };
    }
    const paths = [...sw.body.matchAll(/\{url:"([^"]+)",revision:/g)].map((m) => m[1]);
    if (paths.length === 0) {
      return { ok: false, note: "no precache entries found in sw.js (manifest format changed?)" };
    }
    const failed = [];
    let next = 0;
    async function lane() {
      while (next < paths.length) {
        const path = paths[next++];
        try {
          const res = await fetchFollowing(`${WEB_ORIGIN}/${path}`);
          if (res.status !== 200 && res.status !== 206) {
            failed.push(`${path} ${res.status}`);
          }
        } catch (error) {
          failed.push(`${path} ${error.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: 6 }, lane));
    return {
      ok: failed.length === 0,
      count: paths.length,
      failed,
      note:
        failed.length === 0
          ? `all ${paths.length} entries answer`
          : `${failed.length} of ${paths.length} do not answer 200: ${failed.slice(0, 5).join(", ")}`,
    };
  }, RETRY);

  return {
    key: "sw-precache",
    title: `Service worker precache (${WEB_ORIGIN}/sw.js)`,
    status: result.ok ? "ok" : "fail",
    summary: result.ok
      ? `All ${result.count} precached files answer (attempt ${result.attempt})`
      : "The service worker cannot install: a precached file does not answer 200.",
    detail: trail(result.tries),
    runbook: [
      "Every browser drops the new worker while this fails: no web push for new visitors, and old workers keep serving the old build.",
      "1. `node client/scripts/check-precache.mjs https://pqp.gg <path to the live sw.js>` lists the failing files.",
      "2. A 404 after a 308 is Pages' pretty URL meeting the edge middleware's unknown-path 404 (`client/src/lib/spa-routes.ts`).",
      "3. See docs/PWA.md, 'A precache entry that 404s'.",
    ].join("\n"),
  };
}

/**
 * Issue keys this group used to own and no longer reports. `run.mjs` closes any
 * that are still open, with a comment saying so: a check that is removed
 * leaves its last alert open forever otherwise (issue #607, `fly-machines`,
 * sat open and red for a month against a Fly app nobody was running).
 */
export function retiredAvailabilityKeys() {
  return ["fly-machines", "worker-image-drift"];
}

export async function runAvailabilityChecks() {
  // Sequential on purpose. Running five probes in parallel against one small
  // machine means the monitor's own load is part of what it is measuring, and
  // the whole set still finishes well inside the schedule interval.
  const checks = [
    ["api-health", checkApiHealth],
    ["web-app", checkWebsite],
    ["sw-precache", checkPrecache],
    ["websocket", checkWebsocket],
    ["api-ready", checkApiReady],
    ["api-pool", checkApiPool],
    ["status-components", checkStatusComponents],
    ["live-hls", checkLiveHls],
    ["sfu-regions", checkSfuRegions],
  ];
  const results = [];
  for (const [key, check] of checks) {
    try {
      results.push(await check());
    } catch (error) {
      // A check that throws is a bug in the check, not an outage. Report it as
      // `skip` — visible in the run log, opens nothing, and (because `skip`
      // touches no issue state) cannot close an incident that is still live.
      results.push({
        key,
        title: key,
        status: "skip",
        summary: `Check threw: ${error.message}`,
      });
    }
  }
  return results;
}
