/**
 * The redesigned dashboard's data layer: payloads in, view models out.
 *
 * WHY A SEPARATE FILE. Same reason as `insights.js`: a card that says the
 * wrong thing is believed and acted on, so everything that turns a payload
 * into a sentence or a number lives here as pure functions (no DOM, no fetch,
 * no clock unless it is passed in) and is tested in `test/novo-model.test.js`.
 * `novo.js` only draws what these return.
 *
 * THE RULES.
 *  1. Real data or nothing. A card whose source does not exist in the payload
 *     says so; nothing here invents a sample.
 *  2. Never sum independent maxima (see `insights.js`, rule 3).
 *  3. A trend line only from a real series.
 */
(function (root) {
  "use strict";

  var nf = typeof Intl !== "undefined" ? new Intl.NumberFormat("pt-BR") : null;
  function fmt(n) {
    if (typeof n !== "number" || !isFinite(n)) return "—";
    return nf ? nf.format(Math.round(n)) : String(Math.round(n));
  }
  function dec(n, places) {
    if (typeof n !== "number" || !isFinite(n)) return "—";
    return n.toFixed(places == null ? 1 : places).replace(".", ",");
  }
  function pct(part, whole) {
    if (!whole) return null;
    return Math.round((part / whole) * 1000) / 10;
  }
  function fmtPct(p) {
    if (p == null) return "—";
    return (Math.round(p) === p ? fmt(p) : dec(p)) + "%";
  }
  function num(v) {
    return typeof v === "number" && isFinite(v) ? v : 0;
  }

  /** "+314%" / "−12%" / "estável", against the previous window. */
  function deltaLabel(now, before) {
    now = num(now); before = num(before);
    if (!before) return now ? { text: "novo", tone: "flat" } : { text: "estável", tone: "flat" };
    var d = Math.round(((now - before) / before) * 100);
    if (Math.abs(d) < 3) return { text: "estável", tone: "flat" };
    return { text: (d > 0 ? "+" : "−") + fmt(Math.abs(d)) + "%", tone: d > 0 ? "ok" : "warn" };
  }

  /**
   * The five numbers on top of "Hoje". Each carries the series its trend
   * line is drawn from, or null when no real series exists.
   */
  function hojeKpis(m, occupancy, activity) {
    var voice = m.voice || {};
    var msgs = m.messages || {};
    var users = m.users || {};
    var peaks = occupancy && Array.isArray(occupancy.points)
      ? occupancy.points.map(function (p) { return num(p.participants); })
      : null;
    var act = activityHeadline(activity);
    var cost = costPerActive(activity);
    return [
      {
        key: "voice", label: "pessoas em chamada agora", value: num(voice.participants),
        badge: { text: fmt(voice.activeRooms) + (voice.activeRooms === 1 ? " sala" : " salas"), tone: "flat" },
        note: "maior sala agora: " + fmt(voice.largestRoomNow),
        series: peaks && peaks.length > 1 ? peaks : null, seriesNote: "pico por dia, 30 dias", color: "accent"
      },
      {
        key: "msgs", label: "mensagens · 24h", value: num(msgs.last24h),
        badge: deltaLabel(msgs.last24h, msgs.previous24h),
        note: fmt(msgs.lastHour) + " na última hora",
        series: Array.isArray(msgs.byHour) && msgs.byHour.length > 1 ? msgs.byHour : null, seriesNote: "por hora, 24h", color: "series"
      },
      {
        key: "signups", label: "cadastros · 24h", value: num(users.last24h),
        badge: { text: fmt(users.total) + " contas", tone: "flat" },
        note: fmt((m.servers || {}).last24h) + " servidores novos em 24h",
        series: Array.isArray(users.byHour) && users.byHour.length > 1 ? users.byHour : null, seriesNote: "por hora, 24h", color: "accent"
      },
      {
        key: "dau", label: act.label, value: act.value, text: act.text,
        badge: act.badge, note: act.note,
        series: act.series, seriesNote: "por dia", color: "series"
      },
      {
        key: "cost", label: "custo por ativo", value: null, text: cost.text,
        badge: cost.badge, note: cost.note, series: null, color: "faint"
      }
    ];
  }

  /**
   * Yesterday's actives, which is the last complete day. Before tracking has
   * a full day behind it, the honest number is the strict one: people who
   * wrote, labelled as such.
   */
  function activityHeadline(activity) {
    if (!activity || !Array.isArray(activity.days) || activity.days.length < 2) {
      return { label: "ativos ontem", value: null, text: "—", badge: { text: "carregando", tone: "flat" }, note: "abre com a primeira leitura", series: null };
    }
    var days = activity.days;
    var y = days[days.length - 2];
    // The line ends on yesterday, the day the number shows; today is partial.
    var done = days.slice(0, -1);
    var dauSeries = done.map(function (d) { return d.dau; }).filter(function (v) { return v != null; });
    if (y.dau != null) {
      return {
        label: "ativos ontem", value: y.dau, text: null,
        badge: { text: "escreveram " + fmt(y.postedDau), tone: "flat" },
        note: "abriram o app ou escreveram",
        series: dauSeries.length > 1 ? dauSeries : null
      };
    }
    return {
      label: "escreveram ontem", value: y.postedDau, text: null,
      badge: { text: "ativos a partir de " + shortDay(activity.trackingSince), tone: "flat" },
      note: "quem abriu o app começa a contar " + (activity.trackingSince ? "em " + shortDay(activity.trackingSince) : "com o rastreio"),
      series: done.map(function (d) { return d.postedDau; })
    };
  }

  function costPerActive(activity) {
    var cost = activity && activity.operatingCost ? activity.operatingCost.monthlyUsd : null;
    if (!cost) {
      return { text: "—", badge: { text: "sem custo", tone: "flat" }, note: "defina MONTHLY_COST_USD no worker" };
    }
    var days = activity && Array.isArray(activity.days) ? activity.days : [];
    var y = days.length >= 2 ? days[days.length - 2] : null;
    var usd = function (n) { return "US$ " + dec(n, 2); };
    var whole = "US$ " + (Math.round(cost) === cost ? fmt(cost) : dec(cost, 2));
    if (y && y.mau) return { text: usd(cost / y.mau), badge: { text: whole + "/mês", tone: "flat" }, note: "÷ " + fmt(y.mau) + " ativos em 30 dias" };
    if (y && y.wau) return { text: usd(cost / y.wau), badge: { text: whole + "/mês", tone: "flat" }, note: "÷ ativos em 7 dias, até haver 30 dias" };
    return { text: "—", badge: { text: whole + "/mês", tone: "flat" }, note: "sem ativos rastreados ainda" };
  }

  function shortDay(iso) {
    if (!iso) return "—";
    var p = String(iso).split("-");
    return p.length === 3 ? p[2] + "/" + p[1] : iso;
  }

  /**
   * "Precisa de você": everything on the payload that wants a human, most
   * urgent first. Verdicts come from `PQPInsights`, never re-derived here.
   */
  function attention(m, verdicts, health) {
    var out = [];
    var tone = { bad: 0, warn: 1, info: 2, ok: 3 };
    (verdicts || []).forEach(function (v) {
      if (!v || (v.state !== "bad" && v.state !== "warn")) return;
      // A pool peak that has passed is history, not an alarm: the pool is
      // calm now and the counter only goes back to the last restart.
      if (isPastPoolPeak(v, m.runtime)) {
        var since = m.runtime && m.runtime.peakTrackedSince ? hhmm(m.runtime.peakTrackedSince) : null;
        out.push({ tone: "info", title: "O banco chegou ao limite de conexões " + (since ? "desde as " + since : "desde o último reinício"), detail: "agora está calmo, sem fila · o pico conta desde o último reinício", action: "ver leitura", target: "hoje:leituras" });
        return;
      }
      out.push({ tone: v.state, title: v.head, detail: clip(stripTags(v.body), 150), action: "ver leitura", target: "hoje:leituras" });
    });
    var comps = health && Array.isArray(health.components) ? health.components : [];
    comps.forEach(function (c) {
      if (c.state === "degraded" || c.state === "down") {
        out.push({ tone: c.state === "down" ? "bad" : "warn", title: c.label + (c.state === "down" ? " fora do ar" : " instável"), detail: "status.json", action: "ver serviços", target: "sistema" });
      }
    });
    var breaker = m.runtime && m.runtime.db && m.runtime.db.breaker;
    if (breaker && breaker.state !== "closed") {
      out.push({ tone: "bad", title: "Disjuntor do banco " + (breaker.state === "open" ? "aberto" : "testando"), detail: fmt(breaker.rejected) + " consultas recusadas", action: "ver capacidade", target: "sistema" });
    }
    var mod = m.moderation || {};
    var rep = mod.reports || {};
    if (num(rep.open) > 0) {
      out.push({ tone: "warn", title: fmt(rep.open) + (rep.open === 1 ? " denúncia aberta" : " denúncias abertas"), detail: fmt(rep.last24h) + " novas em 24h", action: "abrir denúncias", target: "fila" });
    }
    var fb = mod.feedback || {};
    if (num(fb.open) > 0) {
      out.push({ tone: "warn", title: fmt(fb.open) + (fb.open === 1 ? " feedback aberto" : " feedbacks abertos"), detail: fmt(fb.confirmed) + " confirmados · " + fmt(fb.last24h) + " novos em 24h", action: "abrir a fila", target: "fila" });
    }
    var cr = m.callRatings;
    if (cr && cr.distribution) {
      var low = num(cr.distribution["1"]) + num(cr.distribution["2"]) + num(cr.distribution["3"]);
      if (low > 0) {
        out.push({ tone: "info", title: fmt(low) + (low === 1 ? " nota baixa" : " notas baixas") + " em chamadas", detail: "média " + dec(cr.average) + " em " + fmt(cr.total) + " avaliações", action: "ler as notas", target: "produto" });
      }
    }
    var hls = m.liveHls || {};
    if (num(hls.silentSessions) > 0) {
      out.push({ tone: "warn", title: fmt(hls.silentSessions) + " transmissão sem avançar", detail: "watch party com a playlist parada", action: "ver sistema", target: "sistema" });
    }
    out.sort(function (a, b) { return tone[a.tone] - tone[b.tone]; });
    if (!out.length || !out.some(function (a) { return a.tone === "bad" || a.tone === "warn"; })) {
      out.push({ tone: "ok", title: "Nada pedindo atenção", detail: "sistema, filas e chamadas dentro do normal", action: "", target: "" });
    }
    return out;
  }

  function isPastPoolPeak(v, runtime) {
    var pool = runtime && runtime.pool;
    return v.key === "pool" && v.state === "warn" && pool && !(pool.waiting > 0);
  }
  function hhmm(iso) {
    try { return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); } catch { return null; }
  }

  /**
   * The system half of the header: only what is wrong right now. Queue
   * workload and passed peaks are not "the system is unwell", and mixing
   * them in is how a status light learns to cry wolf.
   */
  function systemStatus(m, verdicts, health) {
    var comps = (health && health.components) || [];
    var down = comps.filter(function (c) { return c.state === "down"; });
    var degraded = comps.filter(function (c) { return c.state === "degraded"; });
    var breaker = m && m.runtime && m.runtime.db && m.runtime.db.breaker;
    var now = (verdicts || []).filter(function (v) { return v && (v.state === "bad" || v.state === "warn") && !isPastPoolPeak(v, m && m.runtime); });
    if (down.length || (breaker && breaker.state === "open") || now.some(function (v) { return v.state === "bad"; })) {
      return { tone: "bad", text: down.length ? down.map(function (c) { return c.label; }).join(", ") + " fora do ar" : breaker && breaker.state === "open" ? "banco recusando consultas" : "sistema com problema" };
    }
    if (degraded.length || (breaker && breaker.state === "half-open") || now.length) {
      return { tone: "warn", text: degraded.length ? degraded.map(function (c) { return c.label; }).join(", ") + " instável" : "sistema pedindo atenção" };
    }
    return { tone: "ok", text: "sistema ok" };
  }

  /**
   * Feedback items that say the same thing, grouped so "it is too loud"
   * sent three times reads as one problem three people have. Same kind and
   * the same text once case, accents, punctuation and spacing are ignored.
   */
  function groupFeedback(items) {
    var norm = function (t) {
      return String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
    };
    var groups = [], byKey = {};
    (items || []).forEach(function (it) {
      var k = it.kind + "|" + norm(it.body);
      if (byKey[k]) { byKey[k].others.push(it); return; }
      var g = { item: it, others: [] };
      byKey[k] = g; groups.push(g);
    });
    return groups;
  }

  /** Shorten at a word boundary, with an ellipsis, never mid-word. */
  function clip(s, max) {
    if (s.length <= max) return s;
    var cut = s.slice(0, max);
    var sp = cut.lastIndexOf(" ");
    return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, "") + "…";
  }

  function stripTags(s) {
    return String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  }

  /**
   * "Nas últimas leituras": what changed between two consecutive /metrics
   * reads. There is no event stream; this is the honest substitute.
   */
  function feedDiff(prev, next, at) {
    if (!prev || !next) return [];
    var ev = [];
    var when = at || new Date().toISOString();
    var d = function (a, b) { return num(b) - num(a); };
    var su = d(prev.users && prev.users.total, next.users && next.users.total);
    if (su > 0) ev.push({ kind: "signup", color: "series", what: su === 1 ? "novo cadastro" : su + " cadastros", detail: fmt(next.users.total) + " contas", at: when });
    var sv = d(prev.servers && prev.servers.total, next.servers && next.servers.total);
    if (sv > 0) ev.push({ kind: "server", color: "series", what: sv === 1 ? "servidor criado" : sv + " servidores criados", detail: fmt(next.servers.total) + " no total", at: when });
    var prevRooms = {};
    // A room is its server, channel and the moment it opened: DM calls have
    // no server or channel, and two of them must still be two rooms.
    var roomKey = function (r) { return (r.server || "") + "/" + (r.channel || "") + "/" + (r.openedAt || ""); };
    ((prev.voice && prev.voice.rooms) || []).forEach(function (r) { prevRooms[roomKey(r)] = r.participants; });
    ((next.voice && next.voice.rooms) || []).forEach(function (r) {
      if (roomKey(r) in prevRooms) return;
      var where = [r.server, r.channel].filter(Boolean).join(" · ") || "conversa direta";
      ev.push({ kind: "room", color: "accent", what: r.server ? "sala aberta" : "chamada começou", detail: where + " · " + fmt(r.participants) + (r.participants === 1 ? " pessoa" : " pessoas"), at: when });
    });
    var fb = d(prev.moderation && prev.moderation.feedback && prev.moderation.feedback.last24h, next.moderation && next.moderation.feedback && next.moderation.feedback.last24h);
    if (fb > 0) ev.push({ kind: "feedback", color: "warn", what: fb === 1 ? "feedback novo" : fb + " feedbacks novos", detail: "na fila do caça-bugs", at: when });
    var rp = d(prev.moderation && prev.moderation.reports && prev.moderation.reports.last24h, next.moderation && next.moderation.reports && next.moderation.reports.last24h);
    if (rp > 0) ev.push({ kind: "report", color: "bad", what: rp === 1 ? "denúncia nova" : rp + " denúncias novas", detail: "na fila de moderação", at: when });
    var cr = d(prev.callRatings && prev.callRatings.total, next.callRatings && next.callRatings.total);
    if (cr > 0) ev.push({ kind: "rating", color: "ok", what: cr === 1 ? "chamada avaliada" : cr + " chamadas avaliadas", detail: "média " + dec(next.callRatings.average), at: when });
    return ev;
  }

  /**
   * Weekday × hour, from minute samples: the mean number of people in calls
   * in each cell over the days fetched. `days` is [{ day: "YYYY-MM-DD",
   * points: [{ at, participants }] }]; times are read in São Paulo.
   */
  function heatmap(days) {
    var sum = [], n = [];
    for (var i = 0; i < 7; i++) { sum.push(new Array(24).fill(0)); n.push(new Array(24).fill(0)); }
    var fmtH = typeof Intl !== "undefined" ? new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23", weekday: "short" }) : null;
    var wk = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
    (days || []).forEach(function (d) {
      (d.points || []).forEach(function (p) {
        var t = new Date(p.at);
        if (isNaN(t) || !fmtH) return;
        var parts = fmtH.formatToParts(t);
        var w = null, h = null;
        parts.forEach(function (x) { if (x.type === "weekday") w = wk[x.value]; if (x.type === "hour") h = Number(x.value); });
        if (w == null || h == null || isNaN(h)) return;
        sum[w][h] += num(p.participants); n[w][h] += 1;
      });
    });
    var max = 0;
    var cells = sum.map(function (row, w) { return row.map(function (s, h) { var v = n[w][h] ? s / n[w][h] : null; if (v != null && v > max) max = v; return v; }); });
    return { cells: cells, max: max };
  }

  /** The activation funnel, as steps with the drop from the previous one. */
  function funnel(activation) {
    if (!activation || !activation.window30d) return null;
    var w = activation.window30d;
    // The @handle is optional and most people skip it, so it is not a step
    // on the way anywhere: counting it would draw the biggest "drop" in the
    // funnel where nobody was lost.
    var steps = [
      ["se cadastrou", w.signup], ["confirmou a idade", w.ageGate],
      ["entrou num servidor", w.firstJoin], ["mandou a 1ª mensagem", w.firstMessage],
      ["entrou numa chamada", w.firstVoice], ["foi a uma watch party", w.firstWatchParty]
    ];
    var base = num(w.signup);
    return steps.map(function (s, i) {
      var p = pct(num(s[1]), base);
      var prev = i ? pct(num(steps[i - 1][1]), base) : null;
      var drop = prev != null && p != null ? Math.round((prev - p) * 10) / 10 : null;
      return { label: s[0], count: num(s[1]), pct: p == null ? 0 : p, drop: drop != null && drop > 0 ? drop : null };
    });
  }

  /** Signup sources joined with how many of them came back. */
  function sources(acquisition, retention) {
    var byChannel = {};
    ((retention && retention.rows) || []).forEach(function (r) { byChannel[r.channel == null ? "" : r.channel] = r; });
    var rows = ((retention && retention.rows) || []).map(function (r) {
      return { name: r.channel || "sem origem", signups: num(r.signups), retained: num(r.retained), rate: pct(num(r.retained), num(r.signups)) };
    });
    rows.sort(function (a, b) { return b.signups - a.signups; });
    var max = rows.reduce(function (m, r) { return Math.max(m, r.signups); }, 0);
    return { rows: rows.slice(0, 7), max: max, total: acquisition ? num(acquisition.total) : null, windowDays: retention ? retention.activeWindowDays : null };
  }

  /** Rolling series for the actives chart, with the untracked stretch null. */
  function activitySeries(activity) {
    if (!activity || !Array.isArray(activity.days)) return null;
    var d = activity.days;
    return {
      labels: d.map(function (x) { return shortDay(x.day); }),
      dau: d.map(function (x) { return x.dau; }), mau: d.map(function (x) { return x.mau; }),
      postedDau: d.map(function (x) { return x.postedDau; }), postedMau: d.map(function (x) { return x.postedMau; }),
      tracked: d.some(function (x) { return x.dau != null; }),
      trackingSince: activity.trackingSince
    };
  }

  /** Profile completeness as shares of every human account. */
  function adoption(m) {
    var ud = m.userDetail || {};
    var total = num((m.users || {}).total);
    return [
      { label: "tem @handle", v: pct(num(ud.withHandle), total) },
      { label: "tem foto", v: pct(num(ud.withAvatar), total) },
      { label: "tem banner", v: pct(num(ud.withBanner), total) },
      { label: "idade conferida", v: pct(num(ud.ageChecked), total) }
    ];
  }

  function ratingDistribution(cr) {
    if (!cr || !cr.distribution) return null;
    var total = 0;
    for (var s = 1; s <= 5; s++) total += num(cr.distribution[String(s)]);
    var rows = [];
    for (var k = 5; k >= 1; k--) rows.push({ stars: k, n: num(cr.distribution[String(k)]), pct: pct(num(cr.distribution[String(k)]), total) || 0 });
    return { rows: rows, total: total };
  }

  var api = {
    fmt: fmt, dec: dec, pct: pct, fmtPct: fmtPct, deltaLabel: deltaLabel, shortDay: shortDay,
    hojeKpis: hojeKpis, activityHeadline: activityHeadline, costPerActive: costPerActive,
    attention: attention, systemStatus: systemStatus, groupFeedback: groupFeedback, feedDiff: feedDiff, heatmap: heatmap, funnel: funnel, sources: sources,
    activitySeries: activitySeries, adoption: adoption, ratingDistribution: ratingDistribution
  };
  root.PQPNovo = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
