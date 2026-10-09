import { strict as assert } from "node:assert";
import test from "node:test";
import "../site/insights.js";

/**
 * The three verdicts on "agora".
 *
 * A wrong number on this dashboard is visible; a wrong verdict is believed.
 * "storage está a 3× o normal dele" is a sentence somebody acts on and cannot
 * check by looking at it, so the arithmetic behind each one is pinned here,
 * including the two claims these functions are forbidden from making: that a
 * pool queue alone means exhaustion, and that the three daily voice maxima
 * are a split of one another.
 */
const {
  latencyInsight, poolInsight, voiceInsight, buildInsights, liveHlsState,
  liveHlsLlState, audienceBucketLabel, waitlistBucketHistogram, waitlistStatusLabel
} = globalThis.PQPInsights;

const NAMES = { api: "api", database: "postgres", storage: "storage (r2)", voice: "voz", gifs: "gifs" };

function components(over) {
  return [
    { key: "api", label: "API", state: "operational", uptime24h: 1 },
    { key: "database", label: "Database", state: "operational", latencyMs: 7 },
    { key: "storage", label: "File attachments", state: "operational", latencyMs: 241 },
    ...(over || [])
  ];
}

function history(over) {
  return {
    windowHours: 24, bucketMinutes: 30,
    components: [
      { key: "database", points: [], p50: 6, p95: 15 },
      { key: "storage", points: [], p50: 236, p95: 322 },
      ...(over || [])
    ]
  };
}

/* ------------------------------------------------------------------ *
 * latency: a component against its own median
 * ------------------------------------------------------------------ */

test("the slowest component reads as normal when it sits on its own median", () => {
  const i = latencyInsight({ components: components(), history: history(), names: NAMES });
  assert.equal(i.state, "ok");
  assert.match(i.head, /storage \(r2\) é o mais lento/);
  // The useful sentence when nothing is wrong is the reassuring one: this
  // number is high on purpose and can be ignored.
  assert.match(i.head, /normal dele/);
  assert.deepEqual(i.figs, [["agora", "241 ms"], ["p50 24 h", "236 ms"], ["p95 24 h", "322 ms"]]);
});

test("a component at 1,4x its own median is a warning", () => {
  const i = latencyInsight({
    components: components().map((c) => (c.key === "storage" ? { ...c, latencyMs: 340 } : c)),
    history: history(), names: NAMES
  });
  assert.equal(i.state, "warn");
  assert.match(i.head, /1,4× o normal dele/);
});

test("a component at double its own median is bad, not merely slow", () => {
  const i = latencyInsight({
    components: components().map((c) => (c.key === "storage" ? { ...c, latencyMs: 472 } : c)),
    history: history(), names: NAMES
  });
  assert.equal(i.state, "bad");
  assert.match(i.head, /2,0× o normal dele/);
});

test("being slower than every other component is not, by itself, a warning", () => {
  // 241 ms next to a database at 7 ms is 34 times slower and completely fine.
  // Judging components against each other rather than against themselves is
  // the exact mistake this insight exists to avoid.
  const i = latencyInsight({ components: components(), history: history(), names: NAMES });
  assert.notEqual(i.state, "warn");
  assert.notEqual(i.state, "bad");
});

test("a fast component that doubled beats a slow one that did not", () => {
  const i = latencyInsight({
    components: components().map((c) => (c.key === "database" ? { ...c, latencyMs: 30 } : c)),
    history: history(), names: NAMES
  });
  // postgres at 30 ms is still eight times faster than storage at 241 and is
  // the one in trouble: 5x its own median against storage's 1.02x.
  assert.equal(i.state, "bad");
  assert.match(i.head, /^postgres /);
});

test("a reading inside the component's own p95 is not an alarm, however high the ratio", () => {
  // The real first reading this card ever took against production: the SFU
  // probe is bimodal, p50 33 ms and p95 235 ms, and 220 ms is 6,7x the median
  // while sitting *below* the p95. Red there is a false alarm, and a strip
  // that cries wolf on day one is worse than no strip.
  const i = latencyInsight({
    components: [{ key: "voice", label: "Voice", state: "operational", latencyMs: 220 }],
    history: { components: [{ key: "voice", p50: 33, p95: 235 }] }, names: NAMES
  });
  assert.equal(i.state, "ok");
  assert.match(i.head, /dentro da faixa dele/);
  assert.match(i.body, /distribuição torta, não incidente/);
});

test("one millisecond above p95 of a bimodal probe is still the slow cluster, not an incident", () => {
  // The pair used to treat any overshoot of p95 as "above the whole day's
  // band". For a bimodal probe p95 *is* the slow cluster, so 236 vs 235 is
  // rounding, the same cold listRooms the 220-vs-235 case already called
  // fine. Production on 2026-09-10 was this shape: 173 vs p50 22 / p95 171.
  const i = latencyInsight({
    components: [{ key: "voice", label: "Voice", state: "operational", latencyMs: 236 }],
    history: { components: [{ key: "voice", p50: 33, p95: 235 }] }, names: NAMES
  });
  assert.equal(i.state, "ok");
  assert.match(i.head, /dentro da faixa dele/);
  assert.match(i.body, /distribuição torta, não incidente/);
});

test("a bimodal probe past 1,5× its own p95 still alarms when there is no recent window", () => {
  const i = latencyInsight({
    components: [{ key: "voice", label: "Voice", state: "operational", latencyMs: 400 }],
    history: { components: [{ key: "voice", p50: 33, p95: 235 }] }, names: NAMES
  });
  assert.equal(i.state, "bad");
  assert.match(i.head, /12,1× o normal dele/);
  assert.match(i.body, /400 ms agora/);
});

test("a hair above p95 but barely off the median is not an alarm either", () => {
  // The other half of the pair. p95 is exceeded 5% of the time by
  // definition, so crossing it alone happens several times an hour on a
  // healthy component and means nothing without the ratio behind it.
  const i = latencyInsight({
    components: [{ key: "storage", label: "File attachments", state: "operational", latencyMs: 250 }],
    history: { components: [{ key: "storage", p50: 236, p95: 240 }] }, names: NAMES
  });
  assert.equal(i.state, "ok");
  assert.match(i.head, /normal dele/);
});

test("with no p95 at all the ratio decides on its own", () => {
  const i = latencyInsight({
    components: [{ key: "voice", label: "Voice", state: "operational", latencyMs: 220 }],
    history: { components: [{ key: "voice", p50: 33, p95: null }] }, names: NAMES
  });
  assert.equal(i.state, "bad");
});

test("no history yet gives raw figures and says why, never a weaker verdict", () => {
  const i = latencyInsight({ components: components(), history: null, names: NAMES });
  assert.equal(i.state, "raw");
  assert.match(i.body, /p50 de 24 h ainda não chegou/);
  assert.deepEqual(i.figs, [["mais lento agora", "241 ms"]]);
});

test("a component with no latencyMs is never treated as 0 ms", () => {
  // `api` is unprobed on purpose and carries no field. Reading absent as zero
  // would make it the fastest thing on the page forever.
  const i = latencyInsight({ components: components(), history: history(), names: NAMES });
  assert.doesNotMatch(i.body, /\bapi\b/);
  assert.match(i.body, /7 ms de postgres/);
});

test("nothing measured at all is raw, not a claim about health", () => {
  const i = latencyInsight({
    components: [{ key: "api", label: "API", state: "operational" }], history: history(), names: NAMES
  });
  assert.equal(i.state, "raw");
  assert.match(i.head, /nenhum componente foi medido/);
});

test("a p50 of zero is not used as a divisor", () => {
  const i = latencyInsight({
    components: [{ key: "database", label: "Database", state: "operational", latencyMs: 7 }],
    history: { components: [{ key: "database", p50: 0, p95: 0 }] }, names: NAMES
  });
  assert.equal(i.state, "raw");
});

function voiceBuckets(lastMs, lastSamples = 20) {
  const points = Array.from({ length: 48 }, () => ({ ms: 22, fails: 0, samples: 30 }));
  points[points.length - 1] = { ms: lastMs, fails: 0, samples: lastSamples };
  return points;
}

test("a cold listRooms peek does not alarm when the last half hour is still the warm cluster", () => {
  // Production 2026-09-10: dashboard "agora" 173 ms, p50 22, p95 171. The
  // live peek is the slow mode of the SFU probe (cold TLS); the bucket the
  // sampler has been writing is still ~22 ms. Red there is the card crying
  // wolf at whoever is looking at it.
  const i = latencyInsight({
    components: [{ key: "voice", label: "Voice", state: "operational", latencyMs: 173 }],
    history: { components: [{ key: "voice", p50: 22, p95: 171, points: voiceBuckets(28) }] },
    names: NAMES
  });
  assert.equal(i.state, "ok");
  assert.match(i.head, /normal dele|dentro da faixa/);
  assert.deepEqual(i.figs, [
    ["agora", "173 ms"],
    ["últimos 30 min", "28 ms"],
    ["p50 24 h", "22 ms"],
    ["p95 24 h", "171 ms"]
  ]);
});

test("a half hour stuck in the slow cluster does alarm, even if this peek is warm", () => {
  const i = latencyInsight({
    components: [{ key: "voice", label: "Voice", state: "operational", latencyMs: 19 }],
    history: { components: [{ key: "voice", p50: 22, p95: 171, points: voiceBuckets(180, 30) }] },
    names: NAMES
  });
  assert.equal(i.state, "bad");
  assert.match(i.head, /voz está respondendo a/);
  assert.match(i.body, /média de 180 ms nos últimos 30 min/);
  assert.match(i.body, /a leitura de agora é 19 ms/);
});

test("too few recent samples fall back to the live peek rather than a 1-probe mean", () => {
  const i = latencyInsight({
    components: [{ key: "voice", label: "Voice", state: "operational", latencyMs: 173 }],
    history: {
      components: [{
        key: "voice", p50: 22, p95: 171,
        points: [{ ms: 200, fails: 0, samples: 3 }]
      }]
    },
    names: NAMES
  });
  // 3 samples is not a window. 173 vs p95 171 on a skewed probe is the slow
  // cluster, so this stays ok the same way the 1 ms overshoot does.
  assert.equal(i.state, "ok");
  assert.deepEqual(i.figs.map((f) => f[0]), ["agora", "p50 24 h", "p95 24 h"]);
});

test("an empty newest bucket is not filled in from older healthy ones", () => {
  // A stopped sampler and a quiet night both look like empty recent buckets.
  // Walking past the gap into yesterday's 22 ms would hide a live 400 ms
  // slowdown, which is the shape this function is forbidden from drawing.
  const points = voiceBuckets(22, 30);
  points[points.length - 1] = { ms: null, fails: 0, samples: 0 };
  const i = latencyInsight({
    components: [{ key: "voice", label: "Voice", state: "operational", latencyMs: 400 }],
    history: { components: [{ key: "voice", p50: 22, p95: 171, points }] },
    names: NAMES
  });
  assert.equal(i.state, "bad");
  assert.match(i.body, /400 ms agora/);
  assert.deepEqual(i.figs.map((f) => f[0]), ["agora", "p50 24 h", "p95 24 h"]);
});

test("a gap inside the window stops the mean rather than skipping to older buckets", () => {
  const points = voiceBuckets(22, 30);
  points[points.length - 1] = { ms: 24, fails: 0, samples: 4 };
  points[points.length - 2] = { ms: null, fails: 0, samples: 0 };
  const i = latencyInsight({
    components: [{ key: "voice", label: "Voice", state: "operational", latencyMs: 400 }],
    history: { components: [{ key: "voice", p50: 22, p95: 171, points }] },
    names: NAMES
  });
  // 4 samples in the newest bucket, then a gap: not a window. Live peek.
  assert.equal(i.state, "bad");
  assert.match(i.body, /400 ms agora/);
});

/* ------------------------------------------------------------------ *
 * pool: a burst absorbed against the ceiling
 * ------------------------------------------------------------------ */

function runtime(over) {
  return {
    sockets: 34, peakSockets: 212,
    pool: { max: 20, total: 5, idle: 2, busy: 3, waiting: 0, pressure: "ok" },
    peakPoolWaiting: 0, peakPoolBusy: 4,
    peakTrackedSince: "2026-09-08T03:00:00.000Z",
    ...(over || {})
  };
}

test("a queue with the pool full is the wall, and the only red", () => {
  const i = poolInsight(runtime({ pool: { max: 20, total: 20, idle: 0, busy: 20, waiting: 7 } }));
  assert.equal(i.state, "bad");
  assert.match(i.head, /isso é o teto/);
  assert.match(i.body, /PG_POOL_MAX/);
});

test("a queue with room left in the pool is a burst, not the wall", () => {
  // pg queues whenever it cannot hand over a connection in the same tick,
  // including every cold start. Painting that red would make red meaningless.
  const i = poolInsight(runtime({ pool: { max: 20, total: 6, idle: 0, busy: 6, waiting: 4 } }));
  assert.equal(i.state, "warn");
  assert.match(i.body, /rajada sendo absorvida/);
  assert.match(i.body, /sobram 14 conexões/);
});

test("a ceiling touched earlier today is still reported while calm", () => {
  const i = poolInsight(runtime({ peakPoolBusy: 20, peakPoolWaiting: 3 }));
  assert.equal(i.state, "warn");
  assert.match(i.head, /encostou no teto hoje/);
});

function poolWait(over) {
  return {
    feltWaitMs: 1000,
    lastMinute: { checkouts: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, waitedOver1s: 0, maxBusy: 0, maxWaiting: 0 },
    last5Minutes: { checkouts: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, waitedOver1s: 0, maxBusy: 0, maxWaiting: 0 },
    lastHour: { checkouts: 4000, p50Ms: 1, p95Ms: 2, maxMs: 9, waitedOver1s: 0, maxBusy: 22, maxWaiting: 161 },
    perMinute: [{ at: "2026-09-30T23:33:00.000Z", checkouts: 3000, maxBusy: 22, maxWaiting: 161, maxWaitMs: 9, p95Ms: 2, waitedOver1s: 0 }],
    ...(over || {})
  };
}

test("a deploy burst that touched the ceiling but kept every wait short is informational", () => {
  const i = poolInsight(runtime({
    pool: { max: 22, total: 3, idle: 3, busy: 0, waiting: 0 },
    peakPoolBusy: 22, peakPoolWaiting: 161,
    poolWait: poolWait()
  }));
  assert.equal(i.state, "ok");
  assert.match(i.head, /encheu por um instante e esvaziou sem ninguém esperar/);
  assert.match(i.body, /22 de 22/);
  assert.match(i.body, /máxima 9 ms/);
});

test("somebody waiting a second or more for a connection is yellow, with the minute", () => {
  const i = poolInsight(runtime({
    pool: { max: 22, total: 3, idle: 3, busy: 0, waiting: 0 },
    peakPoolBusy: 22, peakPoolWaiting: 161,
    poolWait: poolWait({
      lastHour: { checkouts: 4000, p50Ms: 1, p95Ms: 250, maxMs: 3200, waitedOver1s: 12, maxBusy: 22, maxWaiting: 161 },
      perMinute: [{ at: "2026-09-30T20:03:00.000Z", checkouts: 3000, maxBusy: 22, maxWaiting: 161, maxWaitMs: 3200, p95Ms: 250, waitedOver1s: 12 }]
    })
  }));
  assert.equal(i.state, "warn");
  assert.match(i.head, /12 pedidos esperaram mais de 1 s/);
  assert.match(i.body, /3200 ms, às 20:03 UTC/);
});

test("a queue right now still outranks the hour's verdict", () => {
  const i = poolInsight(runtime({
    pool: { max: 22, total: 22, idle: 0, busy: 22, waiting: 5 },
    poolWait: poolWait()
  }));
  assert.equal(i.state, "bad");
});

test("a queue peak with the ceiling never touched is green and explains itself", () => {
  const i = poolInsight(runtime({ peakPoolWaiting: 14, peakPoolBusy: 9 }));
  assert.equal(i.state, "ok");
  assert.match(i.head, /encostou em 14 hoje, sem o pool nunca ter enchido/);
  assert.match(i.body, /parede não foi tocada/);
});

test("a pool that never queued says so plainly", () => {
  const i = poolInsight(runtime());
  assert.equal(i.state, "ok");
  assert.match(i.head, /nunca teve fila/);
});

test("busy is derived from total minus idle when the API does not send it", () => {
  const i = poolInsight(runtime({ pool: { max: 20, total: 11, idle: 2, waiting: 3 } }));
  assert.equal(i.figs.find((f) => f[0] === "em uso")[1], "9 / 20");
  assert.match(i.body, /sobram 11 conexões/);
});

test("a payload with no runtime block is raw, never assumed healthy", () => {
  assert.equal(poolInsight(undefined).state, "raw");
  assert.equal(poolInsight({}).state, "raw");
});

/* ------------------------------------------------------------------ *
 * voice: today against the last seven days
 * ------------------------------------------------------------------ */

function day(at, participants, mesh, livekit) {
  return { at, participants, mesh, livekit, rooms: 1, meshRooms: 0, livekitRooms: 0, largestRoom: participants };
}

const WEEK = [
  day("2026-09-01", 6, 3, 5), day("2026-09-02", 8, 2, 7), day("2026-09-03", 7, 4, 6),
  day("2026-09-04", 5, 2, 4), day("2026-09-05", 9, 3, 8), day("2026-09-06", 8, 2, 7),
  day("2026-09-07", 6, 3, 5)
];

test("today above the seven day average is reported as a percentage of it", () => {
  const i = voiceInsight({ points: [...WEEK, day("2026-09-08", 12, 3, 9)] });
  // mean of 6,8,7,5,9,8,6 is 7; 12/7 is 1.714
  assert.match(i.head, /71% acima da média de 7 dias/);
  assert.deepEqual(i.figs, [["pico hoje", "12"], ["média 7 d", "7,0"], ["pico pelo sfu", "9"]]);
});

test("the three daily maxima are never presented as a split of each other", () => {
  const i = voiceInsight({ points: [...WEEK, day("2026-09-08", 12, 3, 9)] });
  // 9 + 3 is 12 here by coincidence, which is exactly when a reader would
  // assume they sum. The sentence has to refuse the assumption out loud.
  assert.match(i.body, /máximos independentes e não somam/);
  assert.match(i.body, /cada um medido no seu próprio minuto/);
  assert.doesNotMatch(i.body, /das 12/);
  assert.doesNotMatch(i.body, /de 12 passaram/);
});

test("today below the average says below, not a negative percentage", () => {
  const i = voiceInsight({ points: [...WEEK, day("2026-09-08", 3, 1, 2)] });
  assert.match(i.head, /57% abaixo da média/);
  assert.doesNotMatch(i.head, /-/);
});

test("a big spike is a warning, so it is seen the evening it happens", () => {
  const i = voiceInsight({ points: [...WEEK, day("2026-09-08", 212, 40, 180)] });
  assert.equal(i.state, "warn");
});

test("a small room doubling the average is not an event", () => {
  // 1 -> 3 people is +200% and means nothing. Without a floor this card would
  // cry wolf on every quiet week.
  const quiet = WEEK.map((d, n) => day(d.at, n < 4 ? 1 : 2, 1, 0));
  const i = voiceInsight({ points: [...quiet, day("2026-09-08", 4, 4, 0)] });
  assert.equal(i.state, "ok");
});

test("a week of zeros is a result, not a broken sampler", () => {
  const empty = WEEK.map((d) => day(d.at, 0, 0, 0));
  const i = voiceInsight({ points: [...empty, day("2026-09-08", 0, 0, 0)] });
  assert.equal(i.state, "ok");
  assert.match(i.body, /não porque o amostrador parou/);
});

test("first day of traffic after an empty week does not divide by zero", () => {
  const empty = WEEK.map((d) => day(d.at, 0, 0, 0));
  const i = voiceInsight({ points: [...empty, day("2026-09-08", 12, 3, 9)] });
  assert.equal(i.state, "warn");
  assert.doesNotMatch(i.head, /Infinity|NaN/);
  assert.match(i.head, /dias vazios/);
});

test("fewer than two days is raw and says how many there are", () => {
  const i = voiceInsight({ points: [day("2026-09-08", 12, 3, 9)] });
  assert.equal(i.state, "raw");
  assert.match(i.body, /há 1/);
});

test("the average uses at most seven prior days, never today", () => {
  const long = [];
  for (let n = 0; n < 20; n++) long.push(day("2026-08-" + (10 + n), 100, 0, 0));
  for (let n = 0; n < 7; n++) long.push(day("2026-09-0" + (1 + n), 10, 0, 0));
  const i = voiceInsight({ points: [...long, day("2026-09-08", 20, 0, 0)] });
  // Against the last seven (10) and not the twenty at 100 before them.
  assert.match(i.head, /100% acima da média de 7 dias/);
});

/* ------------------------------------------------------------------ *
 * the strip as a whole
 * ------------------------------------------------------------------ */

test("three verdicts always come back, in fixed slots, whatever is missing", () => {
  // Pills that appear and vanish cannot be scanned by position, which is the
  // one thing a strip like this is for.
  const empty = buildInsights({});
  assert.equal(empty.length, 3);
  assert.deepEqual(empty.map((i) => i.key), ["pool", "latency", "voice"]);
  assert.ok(empty.every((i) => i.state === "raw"));
  assert.ok(empty.every((i) => i.head && i.body));

  const full = buildInsights({
    runtime: runtime({ peakPoolWaiting: 14, peakPoolBusy: 9 }),
    components: components(), history: history(), names: NAMES,
    occupancy: [...WEEK, day("2026-09-08", 12, 3, 9)]
  });
  assert.deepEqual(full.map((i) => i.key), ["pool", "latency", "voice"]);
  assert.ok(full.every((i) => i.state !== "raw"));
});

test("no verdict mentions money, which has no source in this payload", () => {
  const all = buildInsights({
    runtime: runtime(), components: components(), history: history(), names: NAMES,
    occupancy: [...WEEK, day("2026-09-08", 12, 3, 9)]
  });
  for (const i of all) {
    assert.doesNotMatch(i.head + " " + i.body, /custo|custou|R\$|fatura|reais|dólar/i);
  }
});

/**
 * The one sentence on **controles** that is a conclusion rather than a fact.
 *
 * Getting it backwards is not a cosmetic bug: "está na variável" on a server
 * the variable does not name sends an operator off to edit a Fly secret an
 * hour before a show, and nothing on screen contradicts it. So every one of
 * the four sources the API can report is pinned, in both directions.
 *
 * The sources come from `resolveLiveHlsForServer` on the API; this function
 * is forbidden from re-deriving the rule from the environment, because the
 * page has no idea what the environment says.
 */
test("a server that is ON says which of the three inputs turned it on", () => {
  assert.deepEqual(liveHlsState({ liveHlsEffective: true, liveHlsSource: "server" }), {
    tone: "on",
    label: "ligado",
    why: "decisão desta página"
  });
  assert.deepEqual(liveHlsState({ liveHlsEffective: true, liveHlsSource: "allowlist" }), {
    tone: "on",
    label: "ligado",
    why: "está na variável"
  });
  assert.deepEqual(liveHlsState({ liveHlsEffective: true, liveHlsSource: "open" }), {
    tone: "on",
    label: "ligado",
    why: "sem allowlist: todo servidor"
  });
});

test("a server that is OFF says WHY, and the three whys are different actions", () => {
  // The master switch: a deploy. Nothing on this page can fix it.
  assert.deepEqual(liveHlsState({ liveHlsEffective: false, liveHlsSource: "master-off" }), {
    tone: "off",
    label: "api sem hls",
    why: "LIVE_HLS_ENABLED ou o bucket faltando"
  });
  // Somebody turned it off here. The fix is the button next to it.
  assert.deepEqual(liveHlsState({ liveHlsEffective: false, liveHlsSource: "server" }), {
    tone: "off",
    label: "desligado",
    why: "decisão desta página"
  });
  // Nobody decided, and the variable does not name it. Also the button.
  assert.deepEqual(liveHlsState({ liveHlsEffective: false, liveHlsSource: "allowlist" }), {
    tone: "off",
    label: "desligado",
    why: "não está na variável"
  });
});

test("effective decides the tone, never the source", () => {
  // A FALSE row on a server the variable names: the API resolved it to off,
  // and the page must say off. Reading `liveHlsSource` first would print
  // "ligado · está na variável" over a server that cannot stream.
  assert.equal(
    liveHlsState({ liveHlsEffective: false, liveHlsSource: "server" }).tone,
    "off"
  );
  // And the mirror: a TRUE row on a server the variable leaves out.
  assert.equal(
    liveHlsState({ liveHlsEffective: true, liveHlsSource: "server" }).tone,
    "on"
  );
});

test("a row from an API that does not send the field is off, not on", () => {
  // An API older than this page. Same rule as everywhere else here: what is
  // not known is never drawn as the reassuring answer.
  assert.equal(liveHlsState(null).tone, "off");
  assert.equal(liveHlsState({}).tone, "off");
});

/* ------------------------------------------------------------------ *
 * liveHlsLlState: the low-latency switch, same four sources as above,
 * but its own function because the two switches can disagree.
 * ------------------------------------------------------------------ */

test("low latency ON says which of the three inputs turned it on", () => {
  assert.deepEqual(liveHlsLlState({ liveHlsLlEffective: true, liveHlsLlSource: "server" }), {
    tone: "on",
    label: "ligada",
    why: "decisão desta página"
  });
  assert.deepEqual(liveHlsLlState({ liveHlsLlEffective: true, liveHlsLlSource: "allowlist" }), {
    tone: "on",
    label: "ligada",
    why: "está na variável"
  });
  assert.deepEqual(liveHlsLlState({ liveHlsLlEffective: true, liveHlsLlSource: "open" }), {
    tone: "on",
    label: "ligada",
    why: "sem allowlist: todo servidor"
  });
});

test("low latency OFF says why, same three whys as the availability switch", () => {
  assert.deepEqual(liveHlsLlState({ liveHlsLlEffective: false, liveHlsLlSource: "master-off" }), {
    tone: "off",
    label: "sem baixa latência",
    why: "watch party desligado ou sem suporte"
  });
  assert.deepEqual(liveHlsLlState({ liveHlsLlEffective: false, liveHlsLlSource: "server" }), {
    tone: "off",
    label: "desligada",
    why: "decisão desta página"
  });
  assert.deepEqual(liveHlsLlState({ liveHlsLlEffective: false, liveHlsLlSource: "allowlist" }), {
    tone: "off",
    label: "desligada",
    why: "não está na variável"
  });
});

test("low latency effective decides the tone, never the source, and an older API is off", () => {
  assert.equal(
    liveHlsLlState({ liveHlsLlEffective: false, liveHlsLlSource: "server" }).tone,
    "off"
  );
  assert.equal(
    liveHlsLlState({ liveHlsLlEffective: true, liveHlsLlSource: "server" }).tone,
    "on"
  );
  assert.equal(liveHlsLlState(null).tone, "off");
  assert.equal(liveHlsLlState({}).tone, "off");
});

/* ------------------------------------------------------------------ *
 * audienceBucketLabel / waitlistBucketHistogram / waitlistStatusLabel:
 * pure formatting for the "lista de espera" table on controles.
 * ------------------------------------------------------------------ */

test("audienceBucketLabel covers all five survey buckets in Portuguese", () => {
  assert.equal(audienceBucketLabel("under-20"), "até 20");
  assert.equal(audienceBucketLabel("20-50"), "20 a 50");
  assert.equal(audienceBucketLabel("50-150"), "50 a 150");
  assert.equal(audienceBucketLabel("150-500"), "150 a 500");
  assert.equal(audienceBucketLabel("500-plus"), "mais de 500");
});

test("audienceBucketLabel is empty for a skipped or unrecognized bucket", () => {
  assert.equal(audienceBucketLabel(null), "");
  assert.equal(audienceBucketLabel(undefined), "");
  assert.equal(audienceBucketLabel("whatever"), "");
});

test("waitlistBucketHistogram sorts the biggest group first", () => {
  assert.equal(
    waitlistBucketHistogram({ "20-50": 1, "50-150": 2 }),
    "50 a 150 ×2 · 20 a 50 ×1"
  );
});

test("waitlistBucketHistogram breaks a tie by the survey's own order", () => {
  // Same count on two buckets: the smaller-audience bucket comes first,
  // matching the ladder a requester picked from, not insertion order.
  assert.equal(
    waitlistBucketHistogram({ "500-plus": 1, "under-20": 1 }),
    "até 20 ×1 · mais de 500 ×1"
  );
});

test("waitlistBucketHistogram drops zero counts and is empty for nothing at all", () => {
  assert.equal(waitlistBucketHistogram({ "under-20": 0, "50-150": 3 }), "50 a 150 ×3");
  assert.equal(waitlistBucketHistogram({}), "");
  assert.equal(waitlistBucketHistogram(null), "");
  assert.equal(waitlistBucketHistogram(undefined), "");
});

test("waitlistStatusLabel covers all three states and falls back to the raw value", () => {
  assert.equal(waitlistStatusLabel("waiting"), "esperando");
  assert.equal(waitlistStatusLabel("approved"), "liberado");
  assert.equal(waitlistStatusLabel("declined"), "recusado");
  assert.equal(waitlistStatusLabel("whatever"), "whatever");
  assert.equal(waitlistStatusLabel(null), "");
});

/**
 * The "mensagens de voz" panel. What it flags is a claim an operator acts on
 * ("the worker is down"), so the thresholds are pinned here, including the two
 * things it must not do: call a retry in backoff stuck (the API already leaves
 * those out of `oldestQueuedSeconds`, so a value is always "due and unclaimed")
 * and read a feature that is off as a healthy row of zeroes.
 */
const { voiceNoteHealth, ageLabel } = globalThis.PQPInsights;

function queueStats(over) {
  return { queued: 0, running: 0, retrying: 0, oldestQueuedSeconds: 0, expiredLeases: 0, ...(over || {}) };
}
function outcomes(over) {
  return { ok24h: 0, skipped24h: 0, failed24h: 0, successRate24h: null, p50Seconds: null, p95Seconds: null, ...(over || {}) };
}
function voiceNotes(over) {
  const base = {
    usage: { minted7d: 12, sent7d: 10 },
    health: {
      queue: { transcode: queueStats(), transcription: queueStats() },
      jobs: { transcode: outcomes(), transcription: outcomes() },
      budget: { dailySeconds: 36000, usedSeconds: 100, calls: 3, refused: 0, usedShare: 0.003, exhausted: false }
    },
    refusals: {}
  };
  return { ...base, ...(over || {}), health: { ...base.health, ...((over && over.health) || {}) } };
}
const FLAG_ON = { values: { voice_notes: { effective: true, serverOverrides: 0 } } };
const FLAG_OFF = { values: { voice_notes: { effective: false, serverOverrides: 0 } } };

test("voiceNoteHealth: a missing block is raw, never a healthy zero", () => {
  assert.equal(voiceNoteHealth(undefined, FLAG_ON).state, "raw");
  assert.equal(voiceNoteHealth({ usage: {} }, FLAG_ON).state, "raw");
});

test("voiceNoteHealth: a quiet, healthy pipeline is ok with nothing to flag", () => {
  const v = voiceNoteHealth(voiceNotes(), FLAG_ON);
  assert.equal(v.state, "ok");
  assert.deepEqual(v.items, []);
});

test("voiceNoteHealth: the oldest due job is warn at 2 min and bad at 5 min", () => {
  const at = (s) => voiceNoteHealth(voiceNotes({
    health: { queue: { transcode: queueStats({ queued: 3, oldestQueuedSeconds: s }), transcription: queueStats() } }
  }), FLAG_ON);
  assert.equal(at(119).state, "ok");
  assert.equal(at(120).state, "warn");
  assert.equal(at(299).state, "warn");
  const bad = at(300);
  assert.equal(bad.state, "bad");
  assert.equal(bad.queue.transcode, "bad");
  assert.equal(bad.queue.transcription, "ok");
  assert.match(bad.items[0].text, /5 min/);
});

test("voiceNoteHealth: an expired lease is a warn even when nothing has waited long", () => {
  const v = voiceNoteHealth(voiceNotes({
    health: { queue: { transcode: queueStats(), transcription: queueStats({ running: 1, expiredLeases: 1 }) } }
  }), FLAG_ON);
  assert.equal(v.state, "warn");
  assert.equal(v.queue.transcription, "warn");
  assert.match(v.items[0].text, /lease vencida/);
});

test("voiceNoteHealth: a failure rate is judged only from 5 settled jobs up", () => {
  const rate = (ok, failed) => voiceNoteHealth(voiceNotes({
    health: { jobs: {
      transcode: outcomes({ ok24h: ok, failed24h: failed, successRate24h: ok / (ok + failed) }),
      transcription: outcomes()
    } }
  }), FLAG_ON);
  // One failure in two jobs is a sample too small to call bad, but it is shown.
  assert.equal(rate(1, 1).state, "warn");
  // Five or more: under 90% warns, under 50% is bad.
  assert.equal(rate(9, 1).state, "ok");
  assert.equal(rate(8, 2).state, "warn");
  assert.equal(rate(2, 3).state, "bad");
  assert.equal(rate(10, 0).state, "ok");
});

test("voiceNoteHealth: skipped jobs and a clean day are not failures", () => {
  const v = voiceNoteHealth(voiceNotes({
    health: { jobs: { transcode: outcomes({ ok24h: 4, skipped24h: 9, failed24h: 0, successRate24h: 1 }), transcription: outcomes() } }
  }), FLAG_ON);
  assert.equal(v.state, "ok");
});

test("voiceNoteHealth: the budget warns when spent and from 80% used, and says which", () => {
  const budget = (over) => voiceNoteHealth(voiceNotes({
    health: { budget: { dailySeconds: 1000, usedSeconds: 0, calls: 0, refused: 0, usedShare: 0, exhausted: false, ...over } }
  }), FLAG_ON);
  assert.equal(budget({ usedShare: 0.79 }).state, "ok");
  const near = budget({ usedShare: 0.8, usedSeconds: 800 });
  assert.equal(near.state, "warn");
  assert.match(near.items[0].text, /80%/);
  const spent = budget({ usedShare: 0.99, refused: 4, exhausted: true });
  assert.equal(spent.state, "warn");
  assert.match(spent.items[0].text, /esgotado/);
  // A budget of zero has no share: it is configuration, not a warning.
  assert.equal(budget({ dailySeconds: 0, usedShare: null }).state, "ok");
});

test("voiceNoteHealth: the worst item leads, and bad outranks warn", () => {
  const v = voiceNoteHealth(voiceNotes({
    health: {
      queue: { transcode: queueStats({ queued: 1, oldestQueuedSeconds: 900 }), transcription: queueStats() },
      jobs: { transcode: outcomes(), transcription: outcomes({ ok24h: 8, failed24h: 2, successRate24h: 0.8 }) },
      budget: { dailySeconds: 1000, usedSeconds: 1000, calls: 5, refused: 2, usedShare: 1, exhausted: true }
    }
  }), FLAG_ON);
  assert.equal(v.state, "bad");
  assert.equal(v.items[0].state, "bad");
  assert.equal(v.items.length, 3);
});

test("voiceNoteHealth: the flag off with nothing sent is off, not healthy", () => {
  const quiet = voiceNotes({ usage: { minted7d: 0, sent7d: 0 } });
  assert.equal(voiceNoteHealth(quiet, FLAG_OFF).state, "off");
  // On for one server through an override: the zeros are a result.
  const override = { values: { voice_notes: { effective: false, serverOverrides: 1 } } };
  assert.equal(voiceNoteHealth(quiet, override).state, "ok");
  // Off now but used last week: the history still counts, and so do its problems.
  assert.equal(voiceNoteHealth(voiceNotes(), FLAG_OFF).state, "ok");
  // Without the flags block there is no claim that it is off.
  assert.equal(voiceNoteHealth(quiet, undefined).state, "ok");
  // Off does not hide a problem left over from before: a stuck job is still bad.
  const stuck = voiceNotes({
    usage: { minted7d: 0, sent7d: 0 },
    health: { queue: { transcode: queueStats({ oldestQueuedSeconds: 900 }), transcription: queueStats() } }
  });
  assert.equal(voiceNoteHealth(stuck, FLAG_OFF).state, "bad");
});

test("ageLabel: seconds, minutes, then hours", () => {
  assert.equal(ageLabel(0), "0 s");
  assert.equal(ageLabel(45), "45 s");
  assert.equal(ageLabel(60), "1 min");
  assert.equal(ageLabel(7 * 60 + 20), "7 min");
  assert.equal(ageLabel(2 * 3600 + 5 * 60), "2 h 5 min");
  assert.equal(ageLabel(3600), "1 h");
});
