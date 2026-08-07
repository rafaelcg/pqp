#!/usr/bin/env node
/**
 * The single entry point for every monitor.
 *
 *   node scripts/monitor/run.mjs availability            # print a report
 *   node scripts/monitor/run.mjs limits --json           # machine-readable
 *   node scripts/monitor/run.mjs availability --alert    # reconcile GitHub Issues
 *   node scripts/monitor/run.mjs availability --alert --dry-run
 *
 * Runs identically on a laptop and on a runner, which is the point: a check
 * you can only exercise by pushing a workflow and waiting for cron is a check
 * nobody debugs, so it rots.
 *
 * EXIT CODES
 *   0  every check passed, or the only non-passing ones were skipped
 *   1  at least one check failed or warned
 *   2  the monitor itself broke (bad arguments, alerting failed)
 *
 * Exit 1 is deliberately NOT what raises the alarm — the GitHub issue is. The
 * code is there for a human running this by hand and for `&&` chains.
 */

import { reconcile } from "./alert.mjs";
import { runAvailabilityChecks } from "./availability.mjs";
import { LIMITS_NOT_AUTOMATED, runLimitChecks } from "./limits.mjs";

const GROUPS = {
  availability: {
    run: runAvailabilityChecks,
    // Every 10 minutes, so nagging every 6h is roughly 1 comment per 36 runs.
    // Enough to keep an unread email thread alive, quiet enough to not train
    // anyone to ignore it.
    reminderHours: Number(process.env.MONITOR_REMINDER_HOURS ?? 6),
  },
  limits: {
    run: runLimitChecks,
    // Daily checks. A quota does not become more urgent by being restated, so
    // this only speaks up once every three days.
    reminderHours: Number(process.env.MONITOR_REMINDER_HOURS ?? 72),
  },
};

const ICON = { ok: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };

function report(results) {
  const width = Math.max(...results.map((r) => r.key.length));
  const lines = [];
  for (const r of results) {
    lines.push(`${ICON[r.status]}  ${r.key.padEnd(width)}  ${r.summary}`);
    if (r.detail && r.status !== "ok") {
      for (const line of String(r.detail).split("\n")) {
        lines.push(`      ${" ".repeat(width)}  ${line}`);
      }
    }
  }
  return lines.join("\n");
}

async function main() {
  const [group, ...flags] = process.argv.slice(2);
  const config = GROUPS[group];
  if (!config) {
    console.error(`usage: run.mjs <${Object.keys(GROUPS).join("|")}> [--alert] [--json] [--dry-run]`);
    process.exit(2);
  }
  const asJson = flags.includes("--json");
  const alert = flags.includes("--alert");
  const dryRun = flags.includes("--dry-run");

  const results = await config.run();

  if (asJson) {
    console.log(JSON.stringify({ group, checkedAt: new Date().toISOString(), results }, null, 2));
  } else {
    console.log(`pqp monitor — ${group} — ${new Date().toISOString()}`);
    console.log(report(results));
    if (group === "limits") {
      // Printed every single run, on purpose. A gap that only lives in a
      // markdown file is a gap that gets forgotten; this one is in front of
      // whoever opens the run log.
      console.log("\nNOT AUTOMATED — check these by hand:");
      for (const gap of LIMITS_NOT_AUTOMATED) {
        console.log(`  - ${gap.what} (${gap.limit}) — ${gap.cadence}`);
      }
    }
  }

  // Silencing one check, without turning off the monitor.
  //
  // The instinct during a known-broken week is to close the issue or disable
  // the workflow, and both are traps: the issue reopens, and disabling the
  // workflow silently drops every OTHER check too. `MONITOR_MUTED` is the
  // supported way — a repository variable listing check keys, set with
  // `gh variable set MONITOR_MUTED --body "r2-usage"`. Muted checks still run
  // and are still printed, so the mute is visible in every run log rather than
  // being a setting nobody remembers changing.
  const muted = new Set(
    (process.env.MONITOR_MUTED ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
  if (muted.size && !asJson) {
    console.log(`\nmuted (still checked, will not alert): ${[...muted].join(", ")}`);
  }

  if (alert) {
    const repo = process.env.MONITOR_REPO ?? "rafaelcg/pqp";
    try {
      const actions = await reconcile({
        repo,
        results: results.filter((r) => !muted.has(r.key)),
        reminderHours: config.reminderHours,
        runUrl:
          process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
            ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
            : undefined,
        dryRun,
      });
      console.log(`\nalerting (${dryRun ? "dry run" : "live"}, repo ${repo}):`);
      for (const action of actions) {
        console.log(`  ${action.key}: ${action.action}`);
      }
    } catch (error) {
      // Alerting failing is its own emergency, and it must not be swallowed:
      // exit 2 fails the workflow run, and GitHub emails the owner about a
      // failed scheduled workflow by default. That default is the only reason
      // a broken monitor is noticed at all.
      console.error(`\nALERTING FAILED: ${error.message}`);
      process.exit(2);
    }
  }

  process.exit(results.some((r) => r.status === "fail" || r.status === "warn") ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
