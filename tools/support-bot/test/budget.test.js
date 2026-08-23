import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, localDate } from "../src/budget.js";

function tmp() {
  return join(mkdtempSync(join(tmpdir(), "pqp-budget-")), "budget.json");
}

describe("Budget", () => {
  test("counts down from the call ceiling", () => {
    const budget = new Budget({ maxCallsPerDay: 3, maxUsdPerDay: 100 });
    assert.equal(budget.remaining(), 3);
    budget.record(0.001);
    assert.equal(budget.remaining(), 2);
    budget.record(0.001);
    budget.record(0.001);
    assert.equal(budget.remaining(), 0);
    assert.equal(budget.exhausted(), true);
  });

  test("the dollar ceiling binds first when calls get expensive", () => {
    // Two ceilings because they fail differently: the call count is what an
    // operator can reason about, the dollar figure is what stays true if the
    // model or the pricing changes underneath it.
    const budget = new Budget({ maxCallsPerDay: 1000, maxUsdPerDay: 1.0 });
    budget.record(0.5);
    // Half the money for one call, so roughly one call left, not 999.
    assert.equal(budget.remaining(), 1);
    budget.record(0.5);
    assert.equal(budget.exhausted(), true);
  });

  test("survives a restart, because restart is what happens when it goes wrong", () => {
    // The failure this guards is a loop that burns a month of budget in an
    // afternoon while the process crashes and comes back a dozen times. An
    // in-memory counter survives none of those restarts.
    const path = tmp();
    const first = new Budget({ path, maxCallsPerDay: 5, maxUsdPerDay: 100 });
    first.record(0.01);
    first.record(0.01);
    const second = new Budget({ path, maxCallsPerDay: 5, maxUsdPerDay: 100 });
    assert.equal(second.remaining(), 3);
    assert.equal(second.snapshot().calls, 2);
  });

  test("a ledger from yesterday rolls over instead of blocking today", () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ date: "2000-01-01", calls: 999, usd: 99 }));
    const budget = new Budget({ path, maxCallsPerDay: 5, maxUsdPerDay: 1 });
    assert.equal(budget.remaining(), 5);
    assert.equal(budget.snapshot().date, localDate());
  });

  test("a corrupt ledger opens a fresh day rather than refusing to start", () => {
    // Losing a state file should not be an outage. The worst case of starting
    // fresh is one extra day of budget; the worst case of throwing is a bot
    // that is down until somebody notices.
    const path = tmp();
    writeFileSync(path, "{not json");
    const budget = new Budget({ path, maxCallsPerDay: 5, maxUsdPerDay: 1 });
    assert.equal(budget.remaining(), 5);
  });

  test("writes the ledger on every call, not on shutdown", () => {
    const path = tmp();
    const budget = new Budget({ path, maxCallsPerDay: 5, maxUsdPerDay: 1 });
    budget.record(0.02);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).calls, 1);
  });

  test("keeps nothing on disk when there is no path", () => {
    // Dry runs and tests must not touch the real ledger.
    const budget = new Budget({ path: null, maxCallsPerDay: 2, maxUsdPerDay: 1 });
    budget.record(0.01);
    assert.equal(budget.remaining(), 1);
  });
});

describe("localDate", () => {
  test("is the São Paulo calendar day, not the UTC one", () => {
    // 2026-08-24T01:00Z is still the 23rd in São Paulo. A UTC day rolls over at
    // 21:00 local, in the middle of the busiest hour, and would reset the
    // budget mid-evening.
    const at = new Date("2026-08-24T01:00:00Z");
    assert.equal(localDate(at, "America/Sao_Paulo"), "2026-08-23");
    assert.equal(localDate(at, "UTC"), "2026-08-24");
  });
});

describe("model pricing", () => {
  test("prices a dated model id the same as its alias", async () => {
    // The bug the first live run found. The request sends an alias, the
    // response reports the dated id it resolved to, so pricing off the response
    // missed the table on every call and billed Opus rates for Haiku work.
    const { priceFor, estimateCostUsd, normalizeModelId } = await import(
      "../src/generate.js"
    );
    assert.equal(normalizeModelId("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
    assert.deepEqual(
      priceFor("claude-haiku-4-5-20251001"),
      priceFor("claude-haiku-4-5"),
    );

    // The real shape of a live call, measured: ~2300 in, ~70 out.
    const usage = { input_tokens: 2300, output_tokens: 70 };
    const cost = estimateCostUsd(usage, "claude-haiku-4-5-20251001");
    assert.ok(cost > 0.002 && cost < 0.004, `got ${cost}`);
  });

  test("still bills an unknown model at the conservative rate", async () => {
    // The fallback is not a bug and must survive the fix: overspending is the
    // unrecoverable direction, so a model nobody priced bills high on purpose.
    const { priceFor } = await import("../src/generate.js");
    assert.equal(priceFor("claude-something-9-0-20991231").input, 15.0);
  });
});
