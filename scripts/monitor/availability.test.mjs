/**
 * The `/ready` judges, pinned.
 *
 * Production left Fly on 2026-09-17 and three monitors went on reporting about
 * apps nobody ran. What replaced them reads `/ready`, so the part worth
 * pinning is (a) that each judge reads the field the server really emits, and
 * (b) that one incident opens one issue: `api-ready` must not also fail for the
 * pool or the watch-party bucket, which have keys of their own.
 *
 * The sample bodies below are the shape in `server/src/services/ready.ts`
 * (`ReadyReport`), and the contract test at the bottom reads that file so a
 * rename there cannot leave these judges matching a field nobody emits, which
 * would present as a permanent green.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  POOL_WARN_FRACTION,
  judgePool,
  judgeReadyDependencies,
  judgeRegions,
  maxAgeFor,
  retiredAvailabilityKeys,
} from "./availability.mjs";
import { retiredErrorKeys, runErrorChecks } from "./errors.mjs";
import { retiredLimitKeys } from "./limits.mjs";
import { retiredIssues } from "./alert.mjs";

const healthy = () => ({
  ok: true,
  checks: {
    postgres: { ok: true, ms: 3 },
    pool: { ok: true, inUse: 2, max: 22, queued: 0 },
    livekit: { ok: true, ms: 41, host: "sfu.pqp.gg" },
    storage: { ok: true, ms: 80 },
    liveHls: { ok: true, ms: 90 },
  },
  version: "abc1234",
});

describe("judgeReadyDependencies", () => {
  test("a healthy report passes", () => {
    assert.deepEqual(judgeReadyDependencies(healthy()), { ok: true, failing: [] });
  });

  test("skipped dependencies are ok, which is the endpoint's own contract", () => {
    const report = healthy();
    report.checks.livekit = { ok: true, skipped: true };
    report.checks.storage = { ok: true, skipped: true };
    assert.equal(judgeReadyDependencies(report).ok, true);
  });

  test("names each failing dependency", () => {
    const report = healthy();
    report.checks.postgres = { ok: false, ms: 2000 };
    report.checks.storage = { ok: false, ms: 3000 };
    assert.deepEqual(judgeReadyDependencies(report), { ok: false, failing: ["postgres", "storage"] });
  });

  test("a pool or watch-party failure is NOT this check's: one incident, one issue", () => {
    const report = healthy();
    report.ok = false;
    report.checks.pool = { ok: false, inUse: 22, max: 22, queued: 9 };
    report.checks.liveHls = { ok: false, ms: 3000 };
    assert.equal(judgeReadyDependencies(report).ok, true);
  });

  test("a body that is not a report (a Cloudflare error page) fails rather than passing", () => {
    assert.equal(judgeReadyDependencies(null).ok, false);
    assert.equal(judgeReadyDependencies({}).ok, false);
    assert.equal(judgeReadyDependencies({ checks: "x" }).ok, false);
  });

  test("a dependency missing from the report is not assumed healthy", () => {
    const report = healthy();
    delete report.checks.postgres;
    assert.deepEqual(judgeReadyDependencies(report).failing, ["postgres"]);
  });
});

describe("judgePool", () => {
  test("plenty of headroom is ok", () => {
    assert.equal(judgePool({ ok: true, inUse: 2, max: 22, queued: 0 }).level, "ok");
  });

  test("the server's own verdict (queue stuck, pool pinned) is a fail", () => {
    const v = judgePool({ ok: false, inUse: 22, max: 22, queued: 4 });
    assert.equal(v.level, "fail");
    assert.match(v.note, /inUse 22\/22, queued 4/);
  });

  test("nearly full but still serving is a warn, at the configured fraction", () => {
    const inUse = Math.ceil(22 * POOL_WARN_FRACTION);
    assert.equal(judgePool({ ok: true, inUse, max: 22, queued: 0 }).level, "warn");
    assert.equal(judgePool({ ok: true, inUse: inUse - 3, max: 22, queued: 0 }).level, "ok");
  });

  test("a cold process (max 0) has nothing to be short of", () => {
    assert.equal(judgePool({ ok: true, inUse: 0, max: 0, queued: 0 }).level, "ok");
  });

  test("no pool block is a skip, never a pass", () => {
    assert.equal(judgePool(undefined).level, "skip");
    assert.equal(judgePool({}).level, "skip");
  });
});

describe("the shared /ready read", () => {
  test("the first attempt may share a recent read, a retry never does", () => {
    assert.ok(maxAgeFor(1) > 0);
    assert.equal(maxAgeFor(2), 0);
    assert.equal(maxAgeFor(3), 0);
  });
});

describe("judgeRegions", () => {
  test("absent (single-region) is a skip", () => {
    assert.equal(judgeRegions(undefined).level, "skip");
    assert.equal(judgeRegions({}).level, "skip");
  });

  test("all regions up passes and lists them with their hosts", () => {
    const v = judgeRegions({ mia: { ok: true, ms: 50, host: "mia.sfu.pqp.gg" }, lon: { ok: true, ms: 70 } });
    assert.equal(v.level, "ok");
    assert.deepEqual(v.all, ["mia=ok (mia.sfu.pqp.gg)", "lon=ok"]);
  });

  test("one region down fails and names it", () => {
    const v = judgeRegions({ mia: { ok: false, ms: 3000, host: "mia.sfu.pqp.gg" }, lon: { ok: true, ms: 70 } });
    assert.equal(v.level, "fail");
    assert.deepEqual(v.down, ["mia"]);
  });
});

describe("the Fly checks are rollback-only", () => {
  const saved = process.env.MONITOR_FLY_ROLLBACK;
  afterEach(() => {
    if (saved === undefined) delete process.env.MONITOR_FLY_ROLLBACK;
    else process.env.MONITOR_FLY_ROLLBACK = saved;
  });

  test("by default they are retired, so their open issues get closed", () => {
    delete process.env.MONITOR_FLY_ROLLBACK;
    assert.deepEqual(retiredAvailabilityKeys(), ["fly-machines", "worker-image-drift"]);
    assert.deepEqual(retiredErrorKeys(), ["api-error-rate"]);
  });

  test("a declared rollback un-retires them, so they are judged again", () => {
    process.env.MONITOR_FLY_ROLLBACK = "true";
    assert.deepEqual(retiredAvailabilityKeys(), []);
    assert.deepEqual(retiredErrorKeys(), []);
  });

  test("anything but the exact string true is off (a typo must not revive them)", () => {
    process.env.MONITOR_FLY_ROLLBACK = "1";
    assert.deepEqual(retiredErrorKeys(), ["api-error-rate"]);
  });

  test("the errors group runs only the support-bot check by default", async () => {
    delete process.env.MONITOR_FLY_ROLLBACK;
    delete process.env.FLY_API_TOKEN;
    delete process.env.FLY_ORG_TOKEN;
    delete process.env.MONITOR_FLY_LOCAL;
    const results = await runErrorChecks();
    assert.deepEqual(
      results.map((r) => r.key),
      ["support-bot-alive"],
    );
    assert.equal(results[0].status, "skip");
  });

  test("the postgres-disk check is gone for good", () => {
    assert.deepEqual(retiredLimitKeys(), ["postgres-disk"]);
  });
});

describe("retiredIssues", () => {
  const existing = new Map([
    ["fly-machines", { number: 607 }],
    ["api-error-rate", { number: 695 }],
    ["tls-expiry", { number: 1 }],
  ]);

  test("picks the open issues of retired keys, and only those", () => {
    const found = retiredIssues(existing, [{ key: "api-health" }], ["fly-machines", "api-error-rate", "worker-image-drift"]);
    assert.deepEqual(found.map((f) => [f.key, f.issue.number]), [
      ["fly-machines", 607],
      ["api-error-rate", 695],
    ]);
  });

  test("a key that this run still reports is never retired (a rollback revived it)", () => {
    const found = retiredIssues(existing, [{ key: "fly-machines", status: "fail" }], ["fly-machines"]);
    assert.deepEqual(found, []);
  });

  test("no retired keys, nothing to do", () => {
    assert.deepEqual(retiredIssues(existing, [], []), []);
    assert.deepEqual(retiredIssues(existing, []), []);
  });
});

describe("contract with the server's /ready", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../server/src/services/ready.ts", import.meta.url)),
    "utf8",
  );

  test("the report still names the checks and pool fields these judges read", () => {
    for (const field of ["postgres", "pool", "livekit", "storage", "liveHls", "livekitRegions"]) {
      assert.match(source, new RegExp(`\\b${field}\\b`), `ready.ts no longer mentions ${field}`);
    }
    for (const field of ["inUse", "max", "queued"]) {
      assert.match(source, new RegExp(`\\b${field}\\b`), `ready.ts PoolCheck lost ${field}`);
    }
  });

  test("livekitRegions stays outside the endpoint's own ok, which is why sfu-regions exists", () => {
    assert.match(source, /DELIBERATELY NOT PART OF `ok`/);
  });
});
