import { strict as assert } from "node:assert";
import test from "node:test";
import "../site/novo-model.js";

/**
 * The redesigned dashboard's data layer. What is pinned here is the part a
 * reader cannot check by looking: which number a card shows before tracking
 * exists, what counts as needing attention, and that the live feed only ever
 * reports a real difference between two reads.
 */
const M = globalThis.PQPNovo;

function metrics(over) {
  return Object.assign({
    users: { total: 5535, last24h: 251, byHour: [1, 2, 3] },
    servers: { total: 1677, last24h: 37 },
    messages: { last24h: 2035, previous24h: 491, lastHour: 13, byHour: [4, 5, 6] },
    voice: { participants: 77, activeRooms: 30, largestRoomNow: 5, rooms: [] },
    moderation: { reports: { open: 0, last24h: 0 }, feedback: { open: 20, confirmed: 0, last24h: 3 } },
    callRatings: { total: 98, average: 4.5, distribution: { 1: 2, 2: 3, 3: 7, 4: 25, 5: 61 }, byTransport: [], recentNotes: [] },
    runtime: { db: { breaker: { state: "closed", rejected: 0 } } },
    liveHls: { silentSessions: 0 },
    userDetail: { withHandle: 2000, withAvatar: 3000, withBanner: 500, ageChecked: 5200 }
  }, over || {});
}

function activity(days, over) {
  return Object.assign({ trackingSince: "2026-09-28", days: days, operatingCost: { monthlyUsd: 310 } }, over || {});
}

test("before tracking, the actives card shows who wrote and says so", () => {
  const a = activity([
    { day: "2026-09-26", dau: null, wau: null, mau: null, postedDau: 188, postedWau: 630, postedMau: 1883 },
    { day: "2026-09-27", dau: null, wau: null, mau: null, postedDau: 90, postedWau: 640, postedMau: 1890 }
  ]);
  const h = M.activityHeadline(a);
  assert.equal(h.label, "escreveram ontem");
  assert.equal(h.value, 188);
  assert.match(h.badge.text, /28\/09/);
  assert.equal(M.costPerActive(a).text, "—");
});

test("once tracked, yesterday's actives and cost per active are real", () => {
  const a = activity([
    { day: "2026-10-28", dau: 900, wau: 2000, mau: 3100, postedDau: 190, postedWau: 640, postedMau: 1890 },
    { day: "2026-10-29", dau: 300, wau: 2000, mau: 3100, postedDau: 90, postedWau: 640, postedMau: 1890 }
  ]);
  const h = M.activityHeadline(a);
  assert.equal(h.label, "ativos ontem");
  assert.equal(h.value, 900);
  assert.equal(M.costPerActive(a).text, "US$ 0,10");
});

test("the KPI trend lines come only from real series", () => {
  const k = M.hojeKpis(metrics(), null, null);
  const byKey = Object.fromEntries(k.map((x) => [x.key, x]));
  assert.equal(byKey.voice.series, null, "no occupancy read yet: no invented line");
  assert.deepEqual(byKey.msgs.series, [4, 5, 6]);
  assert.equal(byKey.cost.series, null);
  assert.equal(byKey.msgs.badge.text, "+314%");
});

test("attention lists the queue and low ratings, and never a calm sentence beside a warning", () => {
  const list = M.attention(metrics(), [{ state: "ok", head: "fine" }], { components: [] });
  const titles = list.map((a) => a.title);
  assert.ok(titles.some((t) => /20 feedbacks abertos/.test(t)));
  assert.ok(titles.some((t) => /12 notas baixas/.test(t)));
  assert.ok(!titles.includes("Nada pedindo atenção"));
});

test("attention says nothing needs you when nothing does", () => {
  const calm = metrics({ moderation: { reports: { open: 0 }, feedback: { open: 0 } }, callRatings: null });
  const list = M.attention(calm, [], { components: [] });
  assert.deepEqual(list.map((a) => a.tone), ["ok"]);
});

test("a degraded component and an open breaker come first", () => {
  const m = metrics({ runtime: { db: { breaker: { state: "open", rejected: 40 } } } });
  const list = M.attention(m, [], { components: [{ label: "Database", state: "degraded" }] });
  assert.equal(list[0].tone, "bad");
  assert.ok(list.slice(0, 2).some((a) => /instável/.test(a.title)));
});

test("the feed reports only real differences between two reads", () => {
  const a = metrics();
  assert.deepEqual(M.feedDiff(a, a), []);
  const b = metrics({
    users: { total: 5537 },
    voice: { rooms: [{ server: "Cinemoon", channel: "sala", participants: 3 }] },
    moderation: { reports: { last24h: 0 }, feedback: { last24h: 4 } }
  });
  const kinds = M.feedDiff(a, b, "t").map((e) => e.kind);
  assert.deepEqual(kinds, ["signup", "room", "feedback"]);
});

test("the heatmap averages minute samples by São Paulo weekday and hour", () => {
  // 2026-09-26 is a Saturday; 01:30Z is 22:30 in São Paulo.
  const h = M.heatmap([{ day: "2026-09-26", points: [
    { at: "2026-09-27T01:30:00Z", participants: 100 },
    { at: "2026-09-27T01:31:00Z", participants: 60 }
  ] }]);
  assert.equal(h.cells[5][22], 80);
  assert.equal(h.max, 80);
  assert.equal(h.cells[0][0], null);
});

test("the funnel is shares of the signup cohort, with the drop per step", () => {
  const f = M.funnel({ window30d: { signup: 200, ageGate: 180, handle: 10, firstJoin: 150, firstMessage: 80, firstVoice: 60, firstWatchParty: 20 } });
  assert.equal(f[0].pct, 100);
  assert.equal(f[1].pct, 90);
  assert.equal(f[1].drop, 10);
  // The optional @handle is not a step: no fake cliff before "entrou num servidor".
  assert.ok(!f.some((x) => /@/.test(x.label)));
  assert.equal(f[2].drop, 15);
  assert.equal(f.length, 6);
});

test("a step that grows never shows a negative drop", () => {
  const f = M.funnel({ window30d: { signup: 10, ageGate: 5, firstJoin: 8, firstMessage: 1, firstVoice: 1, firstWatchParty: 0 } });
  assert.equal(f[2].drop, null);
});

test("attention details are cut at a word, never mid-word", () => {
  const long = "o pico em uso chegou a 10 de 10 desde que a contagem começou, ou seja, houve pelo menos um instante em que a parede foi tocada. agora está em 2 e sem fila.";
  const list = M.attention({ moderation: {}, runtime: {} }, [{ state: "warn", head: "pool", body: long }], { components: [] });
  assert.match(list[0].detail, /…$/);
  assert.ok(!/ e…$/.test(list[0].detail) || long.includes(list[0].detail.slice(0, -1)));
  assert.ok(long.startsWith(list[0].detail.slice(0, -1)));
});

test("sources join signups with how many came back", () => {
  const s = M.sources({ total: 300 }, { activeWindowDays: 7, rows: [
    { channel: null, signups: 100, retained: 20 }, { channel: "reddit", signups: 40, retained: 18 }
  ] });
  assert.equal(s.rows[0].name, "sem origem");
  assert.equal(s.rows[1].rate, 45);
  assert.equal(s.max, 100);
});

test("rating distribution sums to the scores that exist", () => {
  const r = M.ratingDistribution(metrics().callRatings);
  assert.equal(r.total, 98);
  assert.equal(r.rows[0].stars, 5);
  assert.equal(r.rows[0].pct, 62.2);
});

test("two DM calls are two rooms, and a DM call reads cleanly", () => {
  const one = metrics({ voice: { rooms: [{ server: null, channel: null, participants: 2, openedAt: "2026-09-27T10:00:00Z" }] } });
  const two = metrics({ voice: { rooms: [
    { server: null, channel: null, participants: 2, openedAt: "2026-09-27T10:00:00Z" },
    { server: null, channel: null, participants: 2, openedAt: "2026-09-27T10:05:00Z" }
  ] } });
  const ev = M.feedDiff(one, two, "t");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].detail, "conversa direta · 2 pessoas");
});

test("the actives trend line ends on yesterday, like the number", () => {
  const a = activity([
    { day: "2026-10-27", dau: 800, postedDau: 100 },
    { day: "2026-10-28", dau: 900, postedDau: 190 },
    { day: "2026-10-29", dau: 300, postedDau: 90 }
  ]);
  const h = M.activityHeadline(a);
  assert.equal(h.value, 900);
  assert.equal(h.series[h.series.length - 1], 900);
});

test("one open feedback is singular", () => {
  const m = metrics({ moderation: { reports: { open: 0 }, feedback: { open: 1, confirmed: 0, last24h: 0 } }, callRatings: null });
  assert.ok(M.attention(m, [], { components: [] }).some((a) => a.title === "1 feedback aberto"));
});

test("a pool peak that has passed is history, and the system reads ok", () => {
  const m = metrics({ runtime: { db: { breaker: { state: "closed" } }, pool: { waiting: 0, busy: 1, max: 10 }, peakTrackedSince: "2026-09-27T22:09:00Z" } });
  const verdicts = [{ key: "pool", state: "warn", head: "o pool encostou no teto hoje", body: "..." }];
  const list = M.attention(m, verdicts, { components: [] });
  const pool = list.find((a) => /limite de conexões/.test(a.title));
  assert.equal(pool.tone, "info");
  assert.match(pool.title, /desde as 19:09/);
  assert.deepEqual(M.systemStatus(m, verdicts, { components: [] }), { tone: "ok", text: "sistema ok" });
});

test("a pool queue right now, a down service or an open breaker is not ok", () => {
  const busy = metrics({ runtime: { db: { breaker: { state: "closed" } }, pool: { waiting: 3, busy: 10, max: 10 } } });
  assert.equal(M.systemStatus(busy, [{ key: "pool", state: "bad", head: "x" }], { components: [] }).tone, "bad");
  assert.equal(M.systemStatus(metrics(), [], { components: [{ label: "Database", state: "down" }] }).text, "Database fora do ar");
  const open = metrics({ runtime: { db: { breaker: { state: "open" } }, pool: {} } });
  assert.equal(M.systemStatus(open, [], { components: [] }).text, "banco recusando consultas");
});

test("the same report sent three times is one group of three", () => {
  const g = M.groupFeedback([
    { id: "14", kind: "bug", body: "it is too loud" },
    { id: "13", kind: "idea", body: "make it louder" },
    { id: "8", kind: "bug", body: "It is too loud!" },
    { id: "2", kind: "bug", body: "it  is too loud" }
  ]);
  assert.equal(g.length, 2);
  assert.equal(g[0].item.id, "14");
  assert.deepEqual(g[0].others.map((x) => x.id), ["8", "2"]);
});

test("the actives chart ends on yesterday, never on the partial day", () => {
  const s = M.activitySeries(activity([
    { day: "2026-10-27", dau: 800, mau: 3000, postedDau: 100, postedMau: 900 },
    { day: "2026-10-28", dau: 900, mau: 3100, postedDau: 190, postedMau: 910 },
    { day: "2026-10-29", dau: 30, mau: 3100, postedDau: 9, postedMau: 910 }
  ]));
  assert.equal(s.labels.length, 2);
  assert.equal(s.dau[s.dau.length - 1], 900);
});

test("a failed activity read says so instead of loading forever", () => {
  const failed = { _err: "HTTP 502" };
  assert.equal(M.activityHeadline(failed).badge.text, "leitura falhou");
  assert.equal(M.costPerActive(failed).badge.text, "leitura falhou");
});

test("live now lists every watch party with an audience and voice rooms of 20 or more", () => {
  const m = metrics({
    voice: { rooms: [
      { server: "Cinemoon", channel: "sessão", participants: 4, sharingScreen: 1, transport: "livekit", openedAt: null },
      { server: "Os Crias", channel: "geral", participants: 23, sharingScreen: 0, transport: "livekit", openedAt: "2026-09-27T20:00:00Z", community: { slug: "os-crias", listed: true, suspended: false } },
      { server: "Resenha", channel: "papo", participants: 19, sharingScreen: 0, transport: "livekit", openedAt: null }
    ] },
    liveHls: { viewers: { live: [
      { server: "Cinemoon", channel: "sessão", startedAt: Date.parse("2026-09-27T19:30:00Z"), liveViewers: 140, peakViewers: 180, uniqueViewers: 300 },
      { server: "Resenha", channel: "cinema", startedAt: 1, liveViewers: 0, peakViewers: 3, uniqueViewers: 3 }
    ] } }
  });
  const live = M.liveNow(m);
  assert.deepEqual(live.rows.map((r) => r.kind + ":" + r.channel), ["party:sessão", "voice:geral"]);
  assert.equal(live.rows[0].inCall, 4);
  assert.equal(live.rows[0].audience, 140);
  assert.equal(live.rows[0].total, 144);
  assert.equal(live.rows[0].sharing, 1);
  assert.equal(live.largest.channel, "geral");
  assert.equal(live.rows[0].community, null);
  assert.deepEqual(M.communityBadge(live.rows[1].community), { text: "comunidade", tone: "accent", href: "https://pqp.gg/c/os-crias" });
  assert.equal(M.communityBadge({ slug: "x", listed: false, suspended: true }).text, "comunidade suspensa");
});

test("live now is empty, and names the biggest room, when nothing is big", () => {
  const live = M.liveNow(metrics({ voice: { rooms: [{ server: "Resenha", channel: "papo", participants: 6 }] }, liveHls: { viewers: { live: null } } }));
  assert.equal(live.rows.length, 0);
  assert.equal(live.largest.total, 6);
});
