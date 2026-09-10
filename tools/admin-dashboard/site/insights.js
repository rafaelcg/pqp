/**
 * The three verdicts on the "agora" screen.
 *
 * WHY THIS IS ITS OWN FILE. Everything else on this dashboard is a number
 * rendered next to a label: if the arithmetic is wrong the reader can usually
 * see it. A verdict is different. "storage está três vezes mais lento que o
 * normal dele" is believed, acted on, and cannot be checked by looking at it,
 * so a wrong insight is worse than no insight. These are therefore pure
 * functions of a payload — no DOM, no fetch, no clock unless it is passed in
 * — and they are tested (`test/insights.test.js`, run by CI).
 *
 * THE RULES THEY OBEY.
 *
 *  1. **A verdict or nothing.** When the data cannot support a sentence, the
 *     function returns `state: "raw"` with the reason. The page then shows the
 *     raw figures and says why there is no reading, rather than reaching for a
 *     weaker claim. The three slots are fixed so a scan can learn their
 *     positions.
 *  2. **Compare a thing to itself.** 241 ms means nothing beside a database at
 *     7 ms and everything beside storage's own median.
 *  3. **Never sum independent maxima.** The daily voice rollup holds three
 *     separate peaks over the same day; the busiest minute for the SFU is
 *     almost never the busiest minute overall, so `mesh + livekit` is not
 *     `participants` and no sentence here may imply it is.
 *  4. **No money.** There is no billing source, no R2 byte count and no SFU
 *     minute count anywhere in this payload. An invented cost figure would
 *     outlive every caveat around it.
 *
 * Shape of a verdict:
 *   { key, state: "ok" | "warn" | "bad" | "raw", head, body,
 *     figs: [[label, value], ...], source }
 */
(function (root) {
  "use strict";

  function pct(n) {
    return String(Math.round(n)).replace(".", ",");
  }
  function dec(n, places) {
    return n.toFixed(places === undefined ? 1 : places).replace(".", ",");
  }
  function times(n) {
    return dec(n) + "×";
  }

  /**
   * How many recent probes it takes before we trust a 30-minute mean more
   * than the live peek. Ten is a few minutes of the once-a-minute sampler,
   * enough that a single cold `listRooms` cannot pull the average into the
   * slow cluster of a bimodal probe.
   */
  var RECENT_MIN_SAMPLES = 10;

  /**
   * Mean latency of the newest *contiguous* buckets that together hold
   * `RECENT_MIN_SAMPLES` probes. Null when the history has no points (tests,
   * an API older than this field), when the newest bucket is empty, or when
   * the sampler has not written enough yet — the caller then falls back to
   * the live peek.
   *
   * `points` are oldest-first, one per 30 minutes, with gaps filled as
   * `{ ms: null, samples: 0 }`. An empty newest bucket is what a stopped
   * sampler looks like, and walking past it into yesterday's healthy
   * buckets would hide a live slowdown. Skip nothing: a gap ends the
   * window. `ms` is already the mean of that bucket, so this re-weights
   * by `samples`.
   */
  function recentMeanMs(componentHistory) {
    if (!componentHistory || !Array.isArray(componentHistory.points)) {
      return null;
    }
    var points = componentHistory.points;
    if (points.length === 0) {
      return null;
    }
    var weighted = 0;
    var samples = 0;
    for (var i = points.length - 1; i >= 0; i--) {
      var point = points[i];
      if (!point || typeof point.ms !== "number" || !(point.samples > 0)) {
        break;
      }
      weighted += point.ms * point.samples;
      samples += point.samples;
      if (samples >= RECENT_MIN_SAMPLES) {
        return Math.round(weighted / samples);
      }
    }
    return null;
  }

  /**
   * Latency against each component's own normal.
   *
   * `components` is `/status.json`'s array; `history` is `statusHistory` from
   * `/api/admin/metrics` (24 h of buckets plus a p50 and p95 per component).
   * `names` maps a component key to what this page calls it.
   */
  function latencyInsight(input) {
    var components = (input && input.components) || [];
    var history = input && input.history;
    var names = (input && input.names) || {};
    var byKey = {};
    if (history && Array.isArray(history.components)) {
      history.components.forEach(function (c) { byKey[c.key] = c; });
    }
    var nameOf = function (c) { return names[c.key] || c.label || c.key; };

    var measured = components.filter(function (c) {
      return typeof c.latencyMs === "number";
    });
    // A component with no latency was never probed. `api` is the permanent
    // case: a process cannot time its own round trip. Not a gap to report.
    if (!measured.length) {
      return {
        key: "latency", state: "raw", source: "status.json",
        head: "nenhum componente foi medido nesta leitura",
        body: "a saúde de todos eles está sendo inferida, não cronometrada, então não há latência para comparar com nada. os estados abaixo continuam válidos.",
        figs: []
      };
    }

    var rated = measured
      .map(function (c) {
        var h = byKey[c.key];
        var p50 = h && typeof h.p50 === "number" && h.p50 > 0 ? h.p50 : null;
        var p95 = h && typeof h.p95 === "number" ? h.p95 : null;
        var live = c.latencyMs;
        var recent = recentMeanMs(h);
        // Judge the last half hour when we have it. The live peek is one
        // `listRooms` (or one HEAD, or one SELECT 1); for the SFU that number
        // is bimodal — warm ~20 ms, cold TLS ~170 ms — and pinning a verdict
        // to whichever the last probe happened to be is how this card spent
        // an evening saying voz was at 7,9× while /ready's own listRooms
        // was answering in 10 ms on the same process.
        var compared = recent !== null ? recent : live;
        return {
          name: nameOf(c), live: live, compared: compared, recent: recent,
          p50: p50, p95: p95,
          ratio: p50 === null ? null : compared / p50
        };
      });
    var comparable = rated.filter(function (r) { return r.ratio !== null; });

    // No history yet: 30 days of samples exist, but the p50 arrives with
    // /metrics and the page may be reading before it, or the API may be older
    // than this field. Say what is known and stop there.
    if (!comparable.length) {
      var slowestRaw = rated.slice().sort(function (a, b) { return b.live - a.live; })[0];
      return {
        key: "latency", state: "raw", source: "status.json",
        head: "sem histórico para comparar, só a leitura de agora",
        body: "o mais lento nesta leitura é " + slowestRaw.name + ", com " + slowestRaw.live +
          " ms. isso sozinho não diz nada: um número só vira sintoma quando comparado com o normal do próprio componente, e o p50 de 24 h ainda não chegou nesta página.",
        figs: [["mais lento agora", slowestRaw.live + " ms"]]
      };
    }

    var worst = comparable.slice().sort(function (a, b) { return b.ratio - a.ratio; })[0];
    var figsFor = function (c) {
      return [["agora", c.live + " ms"]]
        .concat(c.recent === null ? [] : [["últimos 30 min", c.recent + " ms"]])
        .concat([["p50 24 h", c.p50 + " ms"]])
        .concat(c.p95 === null ? [] : [["p95 24 h", c.p95 + " ms"]]);
    };

    /*
     * TWO CONDITIONS, NOT ONE, and a third lesson from watching the card
     * against production.
     *
     * The SFU probe is bimodal: p50 ~20 ms (warm HTTP), p95 ~170 ms (cold
     * TLS). A reading of 220 ms is 6,7x the median and would have gone red
     * while sitting *below* the p95 — the component had already spent a
     * chunk of the day up there. That is a false alarm, and a strip that
     * cries wolf on day one is worse than no strip.
     *
     * So a component is only off its band when it is both a multiple of its
     * own median AND above its own p95. The ratio says "unusual for the
     * middle of the distribution"; the p95 says "unusual for the whole of
     * it", and only the pair is worth waking somebody for.
     *
     * THE THIRD LESSON (2026-09-10). p95 of a bimodal probe *is* the slow
     * cluster. 173 ms against a p50 of 22 and a p95 of 171 is 7,9× and 2 ms
     * over the p95 — red by the pair above — while /ready's own listRooms
     * on the same process was answering in 10 ms. The live peek is one
     * probe; the slow mode of this probe *is* a cold handshake, not voz
     * falling over. Two refinements:
     *
     *  1. Judge the newest ~30 min mean when `statusHistory` has enough
     *     samples. A cold trip lasts one probe; a real slowdown lasts a
     *     bucket.
     *  2. When we only have the live peek, a skewed probe (p95 ≥ 3× p50)
     *     has to clear 1,5× its own p95, not 1 ms. The slow cluster lives
     *     around p95; 2 ms over it is rounding, not an incident.
     */
    var skewed = worst.p50 > 0 && worst.p95 !== null && worst.p95 / worst.p50 >= 3;
    var overBand = worst.p95 === null || (skewed && worst.recent === null
      ? worst.compared > worst.p95 * 1.5
      : worst.compared > worst.p95);
    if (worst.ratio >= 1.4 && overBand) {
      var bad = worst.ratio >= 2;
      var alarmLead = worst.recent === null
        ? worst.live + " ms agora"
        : "média de " + worst.recent + " ms nos últimos 30 min";
      return {
        key: "latency", state: bad ? "bad" : "warn", source: "statusHistory",
        head: worst.name + " está respondendo a " + times(worst.ratio) + " o normal dele",
        body: alarmLead + ", contra um p50 de " + worst.p50 + " ms nas últimas 24 h" +
          (worst.p95 === null ? "" : " e um p95 de " + worst.p95 + " ms") +
          (worst.recent === null ? "" : ". a leitura de agora é " + worst.live + " ms") +
          ". o que importa aqui não é ele ser o mais lento do painel, é ele estar lento em relação a si mesmo.",
        figs: figsFor(worst)
      };
    }
    // High against the middle of its own distribution and still inside the
    // whole of it. Worth saying out loud, because the number looks alarming
    // and the conclusion is that it is not.
    if (worst.ratio >= 1.4) {
      return {
        key: "latency", state: "ok", source: "statusHistory",
        head: worst.name + " está bem acima da mediana, mas dentro da faixa dele",
        body: worst.live + " ms agora contra um p50 de " + worst.p50 +
          " ms, o que parece muito. mas o p95 das últimas 24 h é " + worst.p95 +
          " ms" +
          (worst.recent === null ? "" : " e a média dos últimos 30 min é " + worst.recent + " ms") +
          ", então este valor está dentro da faixa que o próprio componente já mostrou hoje. uma mediana muito abaixo do p95 quer dizer distribuição torta, não incidente.",
        figs: figsFor(worst)
      };
    }

    // Nothing is off its own band, so the useful sentence is the opposite one:
    // the slowest component on the page is slow on purpose and can be ignored.
    var slowest = comparable.slice().sort(function (a, b) { return b.live - a.live; })[0];
    var fastest = rated.slice().sort(function (a, b) { return a.live - b.live; })[0];
    return {
      key: "latency", state: "ok", source: "statusHistory",
      head: slowest.name + " é o mais lento e isso é o normal dele",
      body: slowest.live + " ms agora, contra " + fastest.live + " ms de " + fastest.name +
        ". mas o p50 do próprio " + slowest.name + " nas últimas 24 h é " + slowest.p50 + " ms" +
        (slowest.p95 === null ? "" : " e o p95 é " + slowest.p95 + " ms") +
        (slowest.recent === null ? "" : "; a média dos últimos 30 min é " + slowest.recent + " ms") +
        ", então esse número não é sintoma de nada. o alarme é ele dobrar em relação a si mesmo, não ficar acima dos outros.",
      figs: figsFor(slowest)
    };
  }

  /**
   * The connection pool: a burst absorbed, or the ceiling.
   *
   * The distinction this exists to draw (see README): pg queues a request
   * whenever it cannot hand over a connection *in the same tick*, including
   * while the pool is still opening its first connections. So a queue on its
   * own is normal after every deploy. A queue **while the pool is full** is
   * the wall, and only that earns red.
   */
  function poolInsight(runtime) {
    if (!runtime || !runtime.pool || typeof runtime.pool.max !== "number") {
      return {
        key: "pool", state: "raw", source: "runtime",
        head: "sem leitura de capacidade nesta resposta",
        body: "o bloco `runtime` não veio no payload, então não dá para dizer nada sobre pressão de pool. a api provavelmente é mais velha que este campo.",
        figs: []
      };
    }
    var p = runtime.pool;
    var max = p.max;
    var busy = typeof p.busy === "number" ? p.busy : Math.max(0, (p.total || 0) - (p.idle || 0));
    var waiting = p.waiting || 0;
    var peakWaiting = runtime.peakPoolWaiting || 0;
    var peakBusy = runtime.peakPoolBusy || 0;
    var full = busy >= max;
    var figs = [
      ["na fila agora", String(waiting)],
      ["em uso", busy + " / " + max],
      ["pico da fila", String(peakWaiting)]
    ];

    if (waiting > 0 && full) {
      return {
        key: "pool", state: "bad", source: "runtime",
        head: "a fila do pool está em " + waiting + " com o pool cheio: isso é o teto",
        body: "todas as " + max + " conexões que este processo pode segurar estão em uso e ainda há gente esperando. não é rajada sendo absorvida, é `PG_POOL_MAX` sendo o limite. é este par, e só este par, que justifica vermelho.",
        figs: figs
      };
    }
    if (waiting > 0) {
      return {
        key: "pool", state: "warn", source: "runtime",
        head: "há " + waiting + " na fila do pool, com " + busy + " de " + max + " em uso",
        body: "rajada sendo absorvida, não teto. o pg enfileira sempre que não entrega conexão no mesmo tick, o que inclui todo início a frio, e ainda sobram " + (max - busy) + " conexões. vira vermelho só quando a fila e o pool cheio aparecem juntos.",
        figs: figs
      };
    }
    if (peakBusy >= max) {
      return {
        key: "pool", state: "warn", source: "runtime",
        head: "o pool encostou no teto hoje, mesmo estando calmo agora",
        body: "o pico em uso chegou a " + peakBusy + " de " + max + " desde que a contagem começou, ou seja, houve pelo menos um instante em que a parede foi tocada. agora está em " + busy + " e sem fila.",
        figs: [["pico em uso", peakBusy + " / " + max], ["em uso agora", String(busy)], ["pico da fila", String(peakWaiting)]]
      };
    }
    if (peakWaiting > 0) {
      return {
        key: "pool", state: "ok", source: "runtime",
        head: "a fila do pool encostou em " + peakWaiting + " hoje, sem o pool nunca ter enchido",
        body: "rajada absorvida. o pico em uso ficou em " + peakBusy + " de " + max + ", então a parede não foi tocada em momento nenhum. um pico de fila logo depois de um deploy é o comportamento normal do pg, não um sintoma.",
        figs: [["pico da fila", String(peakWaiting)], ["pico em uso", peakBusy + " / " + max], ["em uso agora", String(busy)]]
      };
    }
    return {
      key: "pool", state: "ok", source: "runtime",
      head: "o pool nunca teve fila desde que a contagem começou",
      body: "pico de " + peakBusy + " conexões em uso de " + max + " disponíveis, e nenhuma requisição esperou por uma. este é o estado em que este cartão passa a maior parte do tempo, e é para ele deixar de estar assim que ele existe.",
      figs: [["pico em uso", peakBusy + " / " + max], ["em uso agora", String(busy)], ["pico da fila", "0"]]
    };
  }

  /**
   * Today's voice peak against the last seven days.
   *
   * `points` are the **daily** occupancy points, oldest first, each the peak
   * of its own day. `participants`, `mesh` and `livekit` on one point are
   * three independent maxima over that day, so no sentence here adds them or
   * calls one a share of another.
   */
  function voiceInsight(input) {
    var points = (input && input.points) || [];
    var days = points.filter(function (p) { return p && typeof p.participants === "number"; });
    if (days.length < 2) {
      return {
        key: "voice", state: "raw", source: "voice-occupancy",
        head: "histórico de voz curto demais para comparar",
        body: "são necessários pelo menos dois dias de amostras para dizer se hoje está acima ou abaixo do normal, e há " + days.length + ". o gráfico de 30 dias continua sendo a leitura honesta enquanto isso.",
        figs: []
      };
    }
    var today = days[days.length - 1];
    var prior = days.slice(Math.max(0, days.length - 8), days.length - 1);
    var sum = prior.reduce(function (a, p) { return a + p.participants; }, 0);
    var avg = sum / prior.length;
    var figs = [
      ["pico hoje", String(today.participants)],
      ["média " + prior.length + " d", dec(avg)],
      ["pico pelo sfu", String(today.livekit || 0)]
    ];
    // Both maxima are per-path and per-minute, so this sentence always says
    // so: they are not a split of the total and they do not sum to it.
    var split = "o pico pelo servidor de mídia foi " + (today.livekit || 0) +
      " e o ponto a ponto " + (today.mesh || 0) +
      ", cada um medido no seu próprio minuto: são três máximos independentes e não somam.";

    if (avg === 0) {
      return {
        key: "voice", state: today.participants > 0 ? "warn" : "ok", source: "voice-occupancy",
        head: today.participants > 0
          ? "hoje tem gente em chamada depois de " + prior.length + " dias vazios"
          : "ninguém entrou em chamada hoje, nem nos " + prior.length + " dias anteriores",
        body: today.participants > 0
          ? "o pico de hoje é " + today.participants + " e a média dos " + prior.length +
            " dias anteriores é zero, então não há proporção a calcular. " + split
          : "o gráfico está plano porque não houve chamada, não porque o amostrador parou: ele continua escrevendo uma linha por minuto. " + split,
        figs: figs
      };
    }

    var ratio = today.participants / avg;
    var deltaPct = (ratio - 1) * 100;
    var direction = deltaPct >= 0 ? "acima" : "abaixo";
    // A peak well above the recent norm is worth a look even though nobody is
    // broken: it is the shape the 2026-09-05 spike had, and knowing early is
    // the whole point. The floor stops a jump from 1 to 3 people reading as
    // an event.
    var notable = ratio >= 2 && today.participants >= 10;
    return {
      key: "voice", state: notable ? "warn" : "ok", source: "voice-occupancy",
      head: "o pico de voz de hoje está " + pct(Math.abs(deltaPct)) + "% " + direction +
        " da média de " + prior.length + " dias",
      body: today.participants + " pessoas no minuto mais cheio de hoje, contra uma média de " +
        dec(avg) + " nos últimos " + prior.length + " dias. " + split,
      figs: figs
    };
  }

  /**
   * Why one server on **controles** is on or off, in the operator's words.
   *
   * IT LIVES HERE FOR RULE 1 ABOVE. Every other cell in that table is a fact
   * next to its label; this one is a sentence somebody acts on before an
   * event, and getting it backwards ("está na variável" on a server the
   * variable does not name) would be read as truth and cannot be checked by
   * looking at it. It is a pure function of the row the API sends, and the
   * API sends `liveHlsSource` precisely so this never re-derives the rule.
   *
   * The four sources, from `resolveLiveHlsForServer` on the API:
   *   master-off  LIVE_HLS_ENABLED, LiveKit or the bucket is missing
   *   server      `servers.live_hls_enabled` decided, either way
   *   allowlist   nobody decided; LIVE_HLS_SERVER_ALLOWLIST did
   *   open        nobody decided and there is no allowlist at all
   *
   * Returns { tone: "on" | "off", label, why }.
   */
  function liveHlsState(row) {
    var source = row && row.liveHlsSource;
    if (!row || !row.liveHlsEffective) {
      if (source === "master-off") {
        return { tone: "off", label: "api sem hls", why: "LIVE_HLS_ENABLED ou o bucket faltando" };
      }
      if (source === "server") {
        return { tone: "off", label: "desligado", why: "decisão desta página" };
      }
      return { tone: "off", label: "desligado", why: "não está na variável" };
    }
    if (source === "server") {
      return { tone: "on", label: "ligado", why: "decisão desta página" };
    }
    if (source === "open") {
      return { tone: "on", label: "ligado", why: "sem allowlist: todo servidor" };
    }
    return { tone: "on", label: "ligado", why: "está na variável" };
  }

  /** The three, in incident order, always three, always in these slots. */
  function buildInsights(input) {
    return [
      poolInsight(input && input.runtime),
      latencyInsight({
        components: input && input.components,
        history: input && input.history,
        names: input && input.names
      }),
      voiceInsight({ points: input && input.occupancy })
    ];
  }

  root.PQPInsights = {
    latencyInsight: latencyInsight,
    poolInsight: poolInsight,
    voiceInsight: voiceInsight,
    buildInsights: buildInsights,
    liveHlsState: liveHlsState
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
