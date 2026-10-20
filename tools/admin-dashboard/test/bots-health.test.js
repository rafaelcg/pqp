import { strict as assert } from "node:assert";
import test from "node:test";
import "../site/insights.js";

/**
 * The verdict on "bots · beta": healthy, spending fast, or failing a lot.
 *
 * Like the three on "agora", a wrong sentence here is believed and cannot be
 * checked by looking at it. So what is pinned is each way it could mislead:
 * a rate with no sample behind it, dollars with no ceiling beside them, a
 * projection made twenty minutes into the day, and a quiet week read as a
 * healthy one.
 */
const { botsHealth } = globalThis.PQPInsights;

// 2026-10-13 15:00 in Sao Paulo is 18:00Z; the bot day began 15 hours before.
const NOW = Date.parse("2026-10-13T18:00:00Z");
const RESET = "2026-10-14T03:00:00.000Z";

function days(n, make) {
  return Array.from({ length: n }, (_, i) => make(i, n));
}

function report(over) {
  const o = over || {};
  const todayUsd = o.cost && o.cost.todayUsd !== undefined ? o.cost.todayUsd : 1;
  // An ordinary day costs 3, so a spike needs 9 and the cases below do not
  // trip it by accident. Today's row is the todayUsd the report states.
  const costDays = days(31, (i, n) => ({ day: "d" + i, usd: i === n - 1 ? todayUsd : 3 }));
  const usageDay = (i, n) =>
    Object.assign({ day: "d" + i, runs: 10, replies: 9, failed: 0 }, (o.usageDay && o.usageDay(i, n)) || {});
  return {
    adoption: Object.assign({ bots: 3 }, o.adoption),
    usage: { days: days(31, usageDay) },
    cost: Object.assign(
      {
        ceilingUsd: 10,
        todayUsd: 1,
        nextResetAt: RESET,
        days: costDays
      },
      o.cost
    ),
    limits: Object.assign({ refusedCallsToday: 0 }, o.limits)
  };
}

test("an API without the block is raw", () => {
  assert.equal(botsHealth(undefined, NOW).state, "raw");
  assert.equal(botsHealth({}, NOW).state, "raw");
  assert.equal(botsHealth({ usage: { days: [] }, cost: { days: [] }, adoption: {} }, NOW).state, "raw");
});

test("no bots and no runs is off, and so is a week of silence", () => {
  const none = report({ adoption: { bots: 0 }, usageDay: () => ({ runs: 0, replies: 0 }) });
  assert.equal(botsHealth(none, NOW).state, "off");
  assert.match(botsHealth(none, NOW).head, /nenhum bot/);
  // Used a month ago, silent for the last seven days.
  const quiet = report({ usageDay: (i, n) => (i >= n - 7 ? { runs: 0, replies: 0 } : {}) });
  const v = botsHealth(quiet, NOW);
  assert.equal(v.state, "off");
  assert.match(v.head, /7 dias/);
});

test("working, cheap and answering is healthy", () => {
  const v = botsHealth(report(), NOW);
  assert.equal(v.state, "ok");
  assert.equal(v.head, "bots saudáveis");
  assert.deepEqual(v.items, []);
  assert.equal(v.figs[0][1], "US$ 1,00 de US$ 10,00");
});

test("failures need a sample, warn at 10% and are bad at 25%", () => {
  // One failure in two runs for the week is not "failing a lot".
  const tiny = report({
    usageDay: (i, n) =>
      i >= n - 7 ? { runs: i === n - 1 ? 2 : 0, replies: 0, failed: i === n - 1 ? 1 : 0 } : {}
  });
  assert.equal(botsHealth(tiny, NOW).state, "ok");
  // 70 runs in the week, 10 failed: 14%.
  const warn = botsHealth(report({ usageDay: (i, n) => (i === n - 1 ? { failed: 10 } : {}) }), NOW);
  assert.equal(warn.state, "bad", "ten failures in today's ten runs is a bad day");
  const spread = botsHealth(
    report({ usageDay: (i, n) => (i >= n - 7 && i < n - 1 ? { failed: 2 } : {}) }),
    NOW
  );
  assert.equal(spread.state, "warn");
  assert.equal(spread.head, "falhando muito");
  assert.match(spread.body, /últimos 7 dias/);
  // 3 of today's 10 runs failed inside an otherwise calm week.
  const day = botsHealth(report({ usageDay: (i, n) => (i === n - 1 ? { failed: 3 } : {}) }), NOW);
  assert.equal(day.state, "bad");
  assert.match(day.body, /hoje/);
});

test("spending fast is judged against the ceiling", () => {
  const share = botsHealth(report({ cost: { todayUsd: 7.5 } }), NOW);
  assert.equal(share.state, "warn");
  assert.equal(share.head, "gastando rápido");
  assert.match(share.body, /75%/);
  // The same dollars under a bigger ceiling are fine.
  assert.equal(botsHealth(report({ cost: { todayUsd: 3, ceilingUsd: 50 } }), NOW).state, "ok");
});

test("a projection needs hours behind it and a real share spent", () => {
  // 3.5 of 10 after 15 hours projects to 5.6: fine.
  assert.equal(botsHealth(report({ cost: { todayUsd: 3.5 } }), NOW).state, "ok");
  // 6.5 of 10 after 15 hours projects to 10.4: over the ceiling, under 70%.
  const pace = botsHealth(report({ cost: { todayUsd: 6.5 } }), NOW);
  assert.equal(pace.state, "warn");
  assert.match(pace.body, /neste ritmo/);
  // The same spend twenty minutes into the day is not a projection yet.
  const early = Date.parse("2026-10-13T03:20:00Z");
  assert.equal(botsHealth(report({ cost: { todayUsd: 6.5 } }), early).state, "ok");
});

test("three times the usual day is a spike, and small money never is", () => {
  const spike = days(31, (i, n) => ({ day: "d" + i, usd: i === n - 1 ? 3 : 0.5 }));
  const v = botsHealth(report({ cost: { todayUsd: 3, ceilingUsd: 100, days: spike } }), NOW);
  assert.equal(v.state, "warn");
  assert.match(v.body, /6,0×/);
  const tiny = days(31, (i, n) => ({ day: "d" + i, usd: i === n - 1 ? 0.4 : 0.05 }));
  assert.equal(
    botsHealth(report({ cost: { todayUsd: 0.4, ceilingUsd: 100, days: tiny } }), NOW).state,
    "ok"
  );
});

test("a refused call or a spent ceiling is bad and beats a failure warning", () => {
  const refused = report({
    cost: { todayUsd: 9 },
    limits: { refusedCallsToday: 4 },
    usageDay: (i, n) => (i === n - 1 ? { failed: 2 } : {})
  });
  const v = botsHealth(refused, NOW);
  assert.equal(v.state, "bad");
  assert.equal(v.head, "teto de gasto do dia atingido");
  assert.match(v.body, /4 chamadas recusadas/);
  assert.equal(v.items[0].key, "ceiling");
  assert.equal(botsHealth(report({ cost: { todayUsd: 10 } }), NOW).state, "bad");
  // No ceiling configured as zero: nothing to divide by, so no money verdict.
  assert.equal(botsHealth(report({ cost: { ceilingUsd: 0, todayUsd: 0 } }), NOW).state, "ok");
});
