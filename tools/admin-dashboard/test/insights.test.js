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
const { latencyInsight, poolInsight, voiceInsight, buildInsights, liveHlsState } =
  globalThis.PQPInsights;

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

test("the same ratio one millisecond above p95 is an alarm", () => {
  // The pair is the rule: a multiple of the median AND outside the whole
  // distribution. Either one alone is not worth waking somebody for.
  const i = latencyInsight({
    components: [{ key: "voice", label: "Voice", state: "operational", latencyMs: 236 }],
    history: { components: [{ key: "voice", p50: 33, p95: 235 }] }, names: NAMES
  });
  assert.equal(i.state, "bad");
  assert.match(i.body, /acima de tudo que ele mostrou hoje/);
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
