/**
 * "Is it down?" — the checks that run every ten minutes.
 *
 * Each one returns { key, title, status, summary, detail?, runbook? } where
 * status is ok | fail | warn | skip. `key` is permanent: it is the identity of
 * the alert issue, so renaming one orphans an open incident.
 *
 * Every probe here is wrapped in `untilOk` (3 attempts over ~40s) because a
 * rolling deploy of the single Fly machine makes all of them fail briefly on
 * every release. See the note on `untilOk` in net.mjs.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { httpGet, untilOk, wsProbe } from "./net.mjs";

const exec = promisify(execFile);

export const API_ORIGIN = process.env.MONITOR_API_ORIGIN ?? "https://api.pqp.gg";
export const WEB_ORIGIN = process.env.MONITOR_WEB_ORIGIN ?? "https://pqp.gg";
const FLY_APP = process.env.MONITOR_FLY_APP ?? "pqp-api";

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
    // /health does a real `SELECT 1`, so a 200 here is "process up AND database
    // reachable" — which is why this is the check that gates a deploy too.
    summary: result.ok
      ? `200 ok:true, serving ${result.version ?? "unknown"} (attempt ${result.attempt})`
      : `No healthy response after ${result.tries.length} attempts over ~40s.`,
    detail: trail(result.tries),
    runbook: [
      "1. `fly status -a pqp-api` and `fly logs -a pqp-api`.",
      "2. A 503 with `database unavailable` means the process is up and Postgres is not — check `fly mpg status <cluster>`.",
      "3. No response at all means the machine is gone: `fly machines list -a pqp-api`, then `fly machine start <id>`.",
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
      "1. `fly logs -a pqp-api | grep '\\[pqp\\] ws\\.'` — `ws.connect` with no `ws.auth` means the auth path is broken, no `ws.connect` at all means the upgrade never reaches the app.",
      "2. Check nothing new sits in front of Fly (proxied Cloudflare DNS on api.pqp.gg would add its own idle timeout).",
    ].join("\n"),
  };
}

/**
 * Exactly one machine, started, in gru.
 *
 * The machine count is a decision, not a side effect: fly.toml's
 * min_machines_running says what it is (1 today, by choice) and the comment
 * on it plus docs/deploy-fly.md 6a-bis say why. The deploy workflow asserts
 * the number at release time; this asserts it between deploys, because a
 * stray `fly scale count 2` or a machine Fly recreates after a host failure
 * does not go through the deploy workflow. The expected count is hardcoded
 * here on purpose so drift fails loudly: when fly.toml moves to 2, move this
 * in the same PR.
 */
async function checkFlyMachines() {
  if (!process.env.FLY_API_TOKEN && !process.env.MONITOR_FLY_LOCAL) {
    return {
      key: "fly-machines",
      title: "Fly machine count",
      status: "skip",
      summary:
        "Skipped: no FLY_API_TOKEN. Set MONITOR_FLY_LOCAL=1 to use your own `fly auth` session when running by hand.",
    };
  }

  const result = await untilOk(
    async () => {
      const { stdout } = await exec("flyctl", ["machines", "list", "--app", FLY_APP, "--json"], {
        maxBuffer: 8 * 1024 * 1024,
      });
      const machines = JSON.parse(stdout).filter((m) => m.state !== "destroyed");
      const summary = machines.map((m) => `${m.id} ${m.state} ${m.region}`).join("; ") || "none";
      const ok =
        machines.length === 1 && machines[0].state === "started" && machines[0].region === "gru";
      return { ok, count: machines.length, note: summary };
    },
    { attempts: 2, delayMs: RETRY.delayMs },
  );

  return {
    key: "fly-machines",
    title: "Fly machine count (expects exactly 1 started machine in gru)",
    status: result.ok ? "ok" : "fail",
    summary: result.ok
      ? `1 machine, started, gru: ${result.note}`
      : `Expected exactly one started machine in gru, found: ${result.note.replace(/\s+/g, " ").trim()}`,
    detail: trail(result.tries),
    runbook: [
      "More than one machine is a machine nobody decided to run. The bus and the registry share chat, presence and rooms across machines, but the mesh guard hangs up peer-to-peer joins whose room is pinned on the other one (voice.meshRefusedMultiInstance), which is why the count is one today (docs/deploy-fly.md 6a-bis).",
      "Fix: `fly scale count 1 --region gru --app pqp-api`, then confirm with `fly machines list -a pqp-api`.",
      "Zero machines, or one that is `stopped`: `fly machine start <id>` (auto_start_machines is off on purpose, so nothing will do it for you).",
      "See the header of fly.toml before changing anything about machine count.",
    ].join("\n"),
  };
}

const WORKER_APP = process.env.MONITOR_WORKER_FLY_APP ?? "pqp-worker";

/** `.image_ref.digest`, falling back the same way deploy-api-fly.yml's own
 * assertion does, so the two never disagree about what "the image" means. */
function imagesOf(machines) {
  return [
    ...new Set(
      machines
        .filter((m) => m.state === "started")
        .map((m) => m.image_ref?.digest ?? m.image_ref?.tag ?? m.config?.image ?? "unknown"),
    ),
  ];
}

async function listMachines(app) {
  const { stdout } = await exec("flyctl", ["machines", "list", "--app", app, "--json"], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout).filter((m) => m.state !== "destroyed");
}

/**
 * The check this repo did not have on 2026-09-08. `pqp-worker` runs `jobs.ts`
 * (docs/plans/COLD_PATHS.md) — the attachment sweeps, retention, the outgoing
 * webhook outbox, watch-party reminders, the HLS retention sweep, voice
 * occupancy sampling. `deploy-api-fly.yml` deploys the SAME image to it right
 * after the API, under the same commit label, so the two are supposed to be
 * identical at all times.
 *
 * The failure this exists for is exactly what happened: the workflow's
 * "Deploy the worker" step started failing (`FLY_API_TOKEN_WORKER` could not
 * pull the API's image — an app-scoped deploy token cannot read another app's
 * registry ref), CI kept going red on a step everyone had already learned to
 * ignore because of unrelated Electron/size-label noise, and `pqp-worker` sat
 * on a two-day-old image while `pqp-api` redeployed two dozen times. Every job
 * merged in that window — watch-party session reminders, the HLS retention
 * sweep, voice occupancy sampling — was shipped and not running, silently,
 * because nothing compared the two images. This does, every 10 minutes, and
 * it alerts the same way `fly-machines` does: a GitHub issue, not a red CI
 * step nobody reads.
 *
 * Needs an ORG-scoped token: `FLY_API_TOKEN` (the one already used by
 * `fly-machines`) is a deploy token scoped to `pqp-api` alone and cannot list
 * `pqp-worker`'s machines. Reuses `FLY_ORG_TOKEN` — the same one `postgres-disk`
 * and `support-bot-alive` already need to read a second app.
 *
 * A fork or a fresh clone with no `pqp-worker` app skips, same as the deploy
 * workflow does: the API runs every job itself (`WORKER_MODE` unset) and
 * there is nothing to compare.
 */
async function checkWorkerImageDrift() {
  if (!process.env.FLY_API_TOKEN && !process.env.MONITOR_FLY_LOCAL) {
    return {
      key: "worker-image-drift",
      title: "Worker image matches API image",
      status: "skip",
      summary:
        "Skipped: no FLY_API_TOKEN. Set MONITOR_FLY_LOCAL=1 to use your own `fly auth` session when running by hand.",
    };
  }

  const result = await untilOk(
    async () => {
      let apiMachines;
      try {
        apiMachines = await listMachines(FLY_APP);
      } catch (error) {
        return { ok: false, skip: true, note: `could not list ${FLY_APP}: ${error.message}` };
      }

      let workerMachines;
      try {
        workerMachines = await listMachines(WORKER_APP);
      } catch (error) {
        // Deliberately a skip, not a fail: an app-scoped FLY_API_TOKEN cannot
        // see pqp-worker at all (the same asymmetry that broke the deploy
        // step), and a fork with no worker app looks identical from here.
        return {
          ok: false,
          skip: true,
          note: `could not list ${WORKER_APP}: ${error.message}`,
        };
      }

      const apiImages = imagesOf(apiMachines);
      const workerImages = imagesOf(workerMachines);

      if (apiImages.length === 0) {
        // fly-machines already reports zero API machines as a fail; nothing to
        // compare against here.
        return { ok: false, skip: true, note: `${FLY_APP} has no started machines` };
      }
      if (workerImages.length === 0) {
        return {
          ok: false,
          skip: true,
          note: `${WORKER_APP} has no started machines (worker not deployed, or intentionally unused)`,
        };
      }

      const match =
        apiImages.length === 1 && workerImages.length === 1 && apiImages[0] === workerImages[0];
      return {
        ok: match,
        skip: false,
        note: `${FLY_APP}: ${apiImages.join(", ")} — ${WORKER_APP}: ${workerImages.join(", ")}`,
      };
    },
    { attempts: 2, delayMs: RETRY.delayMs },
  );

  if (result.skip) {
    return {
      key: "worker-image-drift",
      title: "Worker image matches API image",
      status: "skip",
      summary: `Skipped: ${result.note}. Cross-app listing needs FLY_ORG_TOKEN — see docs/MONITORING.md Setup.`,
    };
  }

  return {
    key: "worker-image-drift",
    title: "Worker image matches API image",
    status: result.ok ? "ok" : "fail",
    summary: result.ok
      ? `Same image on both apps: ${result.note}`
      : `${WORKER_APP} is not running the same image as ${FLY_APP}: ${result.note}`,
    detail: trail(result.tries),
    runbook: [
      "The worker is stuck on an old image, which means every cold job in server/src/jobs.ts (docs/plans/COLD_PATHS.md) is running old code, or not running the newest jobs at all.",
      "1. Check the latest `Deploy API (Fly)` run's \"Deploy the worker (same image)\" step: `gh run list --workflow=deploy-api-fly.yml` then `gh run view <id> --log-failed`.",
      "2. The usual cause is FLY_API_TOKEN_WORKER: it must be able to pull registry.fly.io/pqp-api:<sha>, which an app-scoped `pqp-worker` deploy token cannot do. Use an org-scoped token: `fly tokens create org -o personal`, then `gh secret set FLY_API_TOKEN_WORKER`.",
      "3. To fix the running machine directly without waiting on CI: `fly deploy --config fly.worker.toml --app pqp-worker --image registry.fly.io/pqp-api:<api's current sha, from fly status -a pqp-api> --ha=false --strategy rolling`.",
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
      "`database` — the pg pool cannot `SELECT 1`; check `fly mpg status <cluster>`.",
      "`storage` — the R2 bucket rejected a HEAD; check the S3_* secrets and the R2 dashboard. Attachments break, the rest of the app does not.",
      "`voice` — only ever fails when LIVEKIT_* is half-configured.",
    ].join("\n"),
  };
}

export async function runAvailabilityChecks() {
  // Sequential on purpose. Running five probes in parallel against one small
  // machine means the monitor's own load is part of what it is measuring, and
  // the whole set still finishes well inside the schedule interval.
  const checks = [
    ["api-health", checkApiHealth],
    ["web-app", checkWebsite],
    ["websocket", checkWebsocket],
    ["fly-machines", checkFlyMachines],
    ["worker-image-drift", checkWorkerImageDrift],
    ["status-components", checkStatusComponents],
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
