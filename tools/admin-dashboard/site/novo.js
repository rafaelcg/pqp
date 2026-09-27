/**
 * The redesigned operator dashboard: fetching, routing and drawing.
 *
 * Every sentence and number comes from `novo-model.js` (pure, tested) or from
 * `insights.js` (the verdicts, shared with the classic page). This file only
 * decides when to read and how to draw.
 *
 * CADENCE, same as the classic page: /metrics and /health every 30 s,
 * /occupancy on load and at most every five minutes, /activity when Hoje or
 * Crescimento opens, the feedback queue when Fila opens, the flags when
 * Sistema opens. The minute-level heatmap reads 21 days once per session.
 *
 * MOTION. The entrance plays once per screen per session: `#root.enter` is
 * removed after it, so a 30 s poll updates text in place instead of replaying
 * anything. A number that changed tweens and flashes once. Charts draw at
 * their container's real width and redraw, without animation, on resize.
 */
(function () {
  "use strict";

  var M = window.PQPNovo;
  var I = window.PQPInsights;
  var REFRESH_MS = 30000;
  var OCC_REFRESH_MS = 300000;
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var S = {
    screen: "hoje", visited: {}, metrics: null, prevMetrics: null, health: null,
    occupancy: null, occupancyAt: 0, activity: null, activityDays: 90, heat: null, heatLoading: false,
    feed: [], fb: { kind: "", status: "open", items: [], next: null, sel: null, counts: null, busy: false, loaded: false, seq: 0 },
    flags: null, flagBusy: false, open: {}, numbers: {}, firstDraw: {}
  };

  // ---------------------------------------------------------------- helpers
  function $(id) { return document.getElementById(id); }
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k === "style") el.setAttribute("style", v);
        else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : v);
      });
    }
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return el;
  }
  var SVGNS = "http://www.w3.org/2000/svg";
  function s(tag, attrs) {
    var el = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { if (attrs[k] != null) el.setAttribute(k, attrs[k]); });
    return el;
  }
  function fetchJson(path, init) {
    var ctrl = "AbortController" in window ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 9000);
    return fetch(path, Object.assign({ cache: "no-store", credentials: "same-origin", signal: ctrl ? ctrl.signal : undefined }, init || {}))
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      }, function (e) { clearTimeout(timer); throw e; });
  }
  function color(key) { return { accent: "var(--accent)", series: "var(--series)", warn: "var(--warn)", bad: "var(--bad)", ok: "var(--ok)", faint: "var(--faint)" }[key] || key; }
  function fmt(n) { return M.fmt(n); }
  function stamp(iso) {
    try { return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); } catch { return ""; }
  }
  function ago(iso) {
    var s0 = (Date.now() - Date.parse(iso)) / 1000;
    if (!isFinite(s0)) return "";
    if (s0 < 60) return "agora";
    if (s0 < 3600) return "há " + Math.round(s0 / 60) + " min";
    if (s0 < 86400) return "há " + Math.round(s0 / 3600) + " h";
    var d = Math.round(s0 / 86400);
    return d === 1 ? "há 1 dia" : "há " + d + " dias";
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }
  function firstTime(key) { if (S.firstDraw[key]) return false; S.firstDraw[key] = true; return !reduceMotion; }

  /** Tween a number in place. First sight counts up from zero; a change flashes once. */
  function setNumber(el, key, value, format) {
    format = format || fmt;
    if (value == null || typeof value !== "number") { el.textContent = value == null ? "—" : String(value); return; }
    var prev = S.numbers[key];
    S.numbers[key] = value;
    if (reduceMotion) { el.textContent = format(value); return; }
    var from = prev == null ? 0 : prev;
    if (prev != null && prev === value) { el.textContent = format(value); return; }
    var start = performance.now(), dur = prev == null ? 950 : 600;
    if (prev != null) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
    cancelAnimationFrame(el._raf);
    var step = function (now) {
      var p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = format(from + (value - from) * e);
      if (p < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  }

  function sparkline(series, key, colorKey) {
    var w = 108, hgt = 36;
    var svg = s("svg", { class: "spark", viewBox: "0 0 " + w + " " + hgt, "aria-hidden": "true" });
    if (!series || series.length < 2) return svg;
    var vals = series.map(function (v) { return typeof v === "number" ? v : 0; });
    var mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals), rng = (mx - mn) || 1;
    var pts = vals.map(function (v, i) { return [i * (w / (vals.length - 1)), hgt - 3 - (v - mn) / rng * (hgt - 6)]; });
    var line = pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ");
    var animate = firstTime("spark:" + key);
    svg.appendChild(s("polygon", { points: "0," + hgt + " " + line + " " + w + "," + hgt, fill: color(colorKey), opacity: "0.13", class: animate ? "fadein" : null }));
    svg.appendChild(s("polyline", { points: line, fill: "none", stroke: color(colorKey), "stroke-width": "1.8", "stroke-linejoin": "round", "stroke-linecap": "round", pathLength: "1", class: animate ? "draw" : "drawn" }));
    var last = pts[pts.length - 1];
    svg.appendChild(s("circle", { cx: last[0].toFixed(1), cy: last[1].toFixed(1), r: "3", fill: color(colorKey), class: animate ? "pop" : null, style: animate ? "animation-delay:1000ms" : null }));
    return svg;
  }

  /** KPI cards, keyed: created once, then updated in place on every poll. */
  function renderKpis(host, list, prefix) {
    list.forEach(function (k, i) {
      var id = prefix + k.key;
      var card = document.getElementById(id);
      if (!card) {
        card = h("div", { class: "kpi rise", id: id, style: "animation-delay:" + (120 + i * 60) + "ms" }, [
          h("div", { class: "k-top" }, [h("span", { class: "k-label" }), h("span", { class: "badge" })]),
          h("div", { class: "k-mid" }, [h("span", { class: "k-value num" }), h("span", { class: "k-spark" })]),
          h("span", { class: "k-note" })
        ]);
        host.appendChild(card);
      }
      card.querySelector(".k-label").textContent = k.label;
      var b = card.querySelector(".badge");
      b.textContent = k.badge ? k.badge.text : "";
      b.className = "badge " + (k.badge ? k.badge.tone : "");
      b.hidden = !k.badge || !k.badge.text;
      var v = card.querySelector(".k-value");
      if (k.value != null) setNumber(v, id, k.value, k.format);
      else v.textContent = k.text != null ? k.text : "—";
      card.querySelector(".k-note").textContent = k.note || "";
      var sp = card.querySelector(".k-spark");
      clear(sp).appendChild(sparkline(k.series, id, k.color));
      if (k.series) sp.title = k.seriesNote || "";
    });
  }

  /** A details panel whose rows keep their open state across polls. */
  function details(host, id, note, rows) {
    var panel = document.getElementById(id);
    if (!panel) {
      panel = h("section", { class: "details rise", id: id, style: "animation-delay:500ms", "aria-label": "detalhes" }, [
        h("header", null, [h("h2", { text: "detalhes" }), h("span", { class: "dnote" })])
      ]);
      host.appendChild(panel);
    }
    panel.querySelector(".dnote").textContent = note;
    rows.forEach(function (r) {
      var rid = id + "-" + r.id;
      var row = document.getElementById(rid);
      if (!row) {
        var btn = h("button", { type: "button", "aria-expanded": "false", "aria-controls": rid + "-b" }, [
          h("span", { class: "dt" }), h("span", { class: "ds" }),
          (function () { var c = s("svg", { class: "chev", width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }); c.appendChild(s("polyline", { points: "6 9 12 15 18 9" })); return c; })()
        ]);
        row = h("div", { class: "drow", id: rid }, [btn, h("div", { class: "dbody", id: rid + "-b" }, [h("div", null, [h("div", { class: "dinner" })])])]);
        btn.addEventListener("click", function () {
          S.open[rid] = !S.open[rid];
          row.classList.toggle("open", !!S.open[rid]);
          btn.setAttribute("aria-expanded", S.open[rid] ? "true" : "false");
        });
        if (r.openByDefault && S.open[rid] == null) S.open[rid] = true;
        row.classList.toggle("open", !!S.open[rid]);
        btn.setAttribute("aria-expanded", S.open[rid] ? "true" : "false");
        panel.appendChild(row);
      }
      row.querySelector(".dt").textContent = r.title;
      row.querySelector(".ds").textContent = r.summary;
      var inner = clear(row.querySelector(".dinner"));
      (r.body || []).forEach(function (el) { if (el) inner.appendChild(el); });
    });
  }
  function stats(list) {
    return h("div", { class: "stats" }, list.map(function (x) {
      return h("div", { class: "stat" }, [h("span", { class: "sk", text: x[0] }), h("span", { class: "sv num", text: x[1] }), h("span", { class: "sn", text: x[2] || "" })]);
    }));
  }
  function table(head, rows, right) {
    right = right || [];
    return h("div", { style: "overflow-x:auto" }, [h("table", { class: "t" }, [
      h("thead", null, [h("tr", null, head.map(function (c, i) { return h("th", { class: right.indexOf(i) >= 0 ? "r" : null, text: c }); }))]),
      h("tbody", null, rows.map(function (r) {
        return h("tr", null, r.map(function (c, i) { return h("td", { class: (right.indexOf(i) >= 0 ? "r num " : "") + (i > 0 && right.indexOf(i) < 0 ? "m" : ""), text: c == null ? "—" : String(c) }); }));
      }))
    ])]);
  }
  function para(text) { return h("p", { class: "foot", style: "margin:0;font-size:13px;line-height:1.6;color:var(--muted);max-width:900px", text: text }); }
  function classicLink(hash, text) { return h("a", { href: "/?classico=1#" + hash, style: "font-size:13px;font-weight:600;text-decoration:none", text: text + " →" }); }

  // ---------------------------------------------------------------- charts

  /** Bars at the container's real width, with a hover tooltip. */
  function barChart(host, values, labels, opts) {
    clear(host);
    var W = Math.max(280, host.clientWidth || 600), H = opts.height || 190;
    var n = values.length; if (!n) { host.appendChild(h("p", { class: "empty", text: opts.empty || "sem dados ainda" })); return; }
    var max = Math.max.apply(null, values.concat([1]));
    var peakIdx = values.indexOf(max);
    var animate = firstTime("bars:" + host.id);
    var wrap = h("div", { style: "position:relative;height:" + (H + 24) + "px" });
    [0.5, 1].forEach(function (f) { wrap.appendChild(h("span", { style: "position:absolute;left:0;right:0;top:" + Math.round(H - f * (H - 12)) + "px;border-top:1px dashed var(--line)" })); });
    wrap.appendChild(h("span", { style: "position:absolute;left:0;right:0;top:" + H + "px;border-top:1px solid var(--line2)" }));
    wrap.appendChild(h("span", { class: "axis", style: "position:absolute;left:0;top:" + (12 - 16) + "px;font-size:10.5px;color:var(--faint)", text: fmt(max) }));
    var row = h("div", { role: "img", "aria-label": opts.label, style: "position:absolute;left:0;right:0;top:0;height:" + H + "px;display:flex;align-items:flex-end" });
    var tip = h("div", { class: "tip" });
    var bars = [];
    values.forEach(function (v, i) {
      var bh = Math.max(v > 0 ? 2 : 0, v / max * (H - 12));
      var bar = h("div", { class: animate ? "grow" : null, style: "width:100%;height:" + bh.toFixed(1) + "px;border-radius:4px 4px 2px 2px;background:" + (i === peakIdx ? "var(--accent)" : "var(--series)") + ";opacity:" + (i === peakIdx ? 1 : 0.72) + ";transition:opacity 160ms;animation-delay:" + (i * 18) + "ms" });
      bars.push(bar);
      var col = h("div", { style: "flex:1;height:" + H + "px;display:flex;align-items:flex-end;padding:0 " + (W / n > 14 ? 2 : 1) + "px" }, [bar]);
      col.addEventListener("mouseenter", function () {
        bars.forEach(function (b, j) { b.style.opacity = j === i ? 1 : 0.28; });
        clear(tip).appendChild(h("span", null, [h("b", { class: "num", style: "font-size:14px", text: fmt(v) }), " " + (opts.unit || "")]));
        tip.appendChild(h("span", { class: "tt", text: labels[i] || "" }));
        tip.classList.add("on");
        var x = (i + 0.5) * (W / n);
        tip.style.left = Math.min(W - 150, Math.max(0, x - 70)) + "px";
        tip.style.top = Math.max(0, H - bh - 58) + "px";
      });
      row.appendChild(col);
    });
    row.addEventListener("mouseleave", function () {
      bars.forEach(function (b, j) { b.style.opacity = j === peakIdx ? 1 : 0.72; });
      tip.classList.remove("on");
    });
    wrap.appendChild(row);
    var lab = h("div", { style: "position:absolute;left:0;right:0;top:" + (H + 6) + "px;display:flex" });
    labels.forEach(function (t, i) {
      var show = i === 0 || i === n - 1 || i % Math.ceil(n / 5) === 0;
      lab.appendChild(h("span", { style: "flex:1;text-align:center;font-size:10.5px;color:var(--faint);white-space:nowrap;overflow:visible", text: show ? (i === n - 1 ? "hoje" : t) : "" }));
    });
    wrap.appendChild(lab);
    wrap.appendChild(tip);
    host.appendChild(wrap);
  }

  /** Lines at real width; null values break the line. Crosshair tooltip on hover. */
  function lineChart(host, series, labels, opts) {
    clear(host);
    var W = Math.max(300, host.clientWidth || 700), H = opts.height || 230;
    var n = labels.length;
    if (n < 2) { host.appendChild(h("p", { class: "empty", text: "sem dados ainda" })); return; }
    var max = 1;
    series.forEach(function (sr) { sr.values.forEach(function (v) { if (typeof v === "number" && v > max) max = v; }); });
    max *= 1.08;
    var X = function (i) { return i * (W / (n - 1)); };
    var Y = function (v) { return H - v / max * H; };
    var animate = firstTime("line:" + host.id + ":" + n);
    var svg = s("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": opts.label });
    [0.25, 0.5, 0.75].forEach(function (f) { svg.appendChild(s("line", { x1: 0, x2: W, y1: H * f, y2: H * f, stroke: "var(--line)", "stroke-dasharray": "3 5" })); });
    svg.appendChild(s("line", { x1: 0, x2: W, y1: H, y2: H, stroke: "var(--line2)" }));
    var ylab = s("text", { x: 0, y: 12, class: "axis" }); ylab.textContent = fmt(max / 1.08); svg.appendChild(ylab);
    series.forEach(function (sr, si) {
      var segs = [], cur = [];
      sr.values.forEach(function (v, i) {
        if (typeof v !== "number") { if (cur.length) segs.push(cur); cur = []; return; }
        cur.push(X(i).toFixed(1) + "," + Y(v).toFixed(1));
      });
      if (cur.length) segs.push(cur);
      segs.forEach(function (pts) {
        if (pts.length < 2) return;
        if (sr.area) svg.appendChild(s("polygon", { points: pts[0].split(",")[0] + "," + H + " " + pts.join(" ") + " " + pts[pts.length - 1].split(",")[0] + "," + H, fill: sr.color, opacity: "0.10", class: animate ? "fadein" : null }));
        svg.appendChild(s("polyline", { points: pts.join(" "), fill: "none", stroke: sr.color, "stroke-width": sr.dashed ? "1.6" : "2", "stroke-dasharray": sr.dashed ? "4 4" : null, "stroke-linejoin": "round", pathLength: sr.dashed ? null : "1", class: sr.dashed ? (animate ? "fadein" : null) : (animate ? "draw" : "drawn"), style: animate ? "animation-delay:" + (si * 150) + "ms" : null }));
      });
    });
    if (opts.marker != null && opts.marker > 0 && opts.marker < n) {
      svg.appendChild(s("line", { x1: X(opts.marker), x2: X(opts.marker), y1: 0, y2: H, stroke: "var(--faint)", "stroke-dasharray": "2 4" }));
      var mt = s("text", { x: X(opts.marker) + 6, y: 14, class: "axis" }); mt.textContent = opts.markerLabel || ""; svg.appendChild(mt);
    }
    var wrap = h("div", { style: "position:relative;height:" + (H + 24) + "px" }, [svg]);
    var xl = h("div", { style: "position:absolute;left:0;right:0;top:" + (H + 6) + "px;display:flex;justify-content:space-between;font-size:10.5px;color:var(--faint)" });
    [0, Math.floor(n / 3), Math.floor(2 * n / 3), n - 1].forEach(function (i, k) { xl.appendChild(h("span", { text: k === 3 ? "hoje" : labels[i] })); });
    wrap.appendChild(xl);
    var cross = h("span", { style: "position:absolute;top:0;width:1px;height:" + H + "px;background:var(--muted);pointer-events:none;opacity:0;transition:opacity 120ms" });
    var tip = h("div", { class: "tip" });
    var dots = series.map(function (sr) { var d = h("span", { style: "position:absolute;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:" + sr.color + ";border:2px solid var(--bg);pointer-events:none;opacity:0;transition:opacity 120ms" }); wrap.appendChild(d); return d; });
    wrap.appendChild(cross); wrap.appendChild(tip);
    var hit = h("div", { style: "position:absolute;left:0;top:0;width:" + W + "px;height:" + H + "px;cursor:crosshair" });
    hit.addEventListener("mousemove", function (ev) {
      var r = hit.getBoundingClientRect();
      var i = Math.max(0, Math.min(n - 1, Math.round((ev.clientX - r.left) / (W / (n - 1)))));
      var x = X(i);
      cross.style.left = x + "px"; cross.style.opacity = 1;
      clear(tip).appendChild(h("span", { class: "tt", text: i === n - 1 ? labels[i] + " · hoje, em curso" : labels[i] }));
      series.forEach(function (sr, si) {
        var v = sr.values[i];
        dots[si].style.opacity = typeof v === "number" ? 1 : 0;
        if (typeof v === "number") { dots[si].style.left = x + "px"; dots[si].style.top = Y(v) + "px"; }
        tip.appendChild(h("span", null, [h("b", { class: "num", style: "color:" + sr.color, text: typeof v === "number" ? fmt(v) : "—" }), " " + sr.label]));
      });
      tip.classList.add("on");
      tip.style.left = Math.min(W - 190, x + 14) + "px"; tip.style.top = "8px";
    });
    hit.addEventListener("mouseleave", function () { cross.style.opacity = 0; tip.classList.remove("on"); dots.forEach(function (d) { d.style.opacity = 0; }); });
    wrap.appendChild(hit);
    host.appendChild(wrap);
  }

  // ---------------------------------------------------------------- routing
  var SCREENS = ["hoje", "crescimento", "produto", "fila", "sistema"];
  function show(name) {
    if (SCREENS.indexOf(name) < 0) name = "hoje";
    S.screen = name;
    SCREENS.forEach(function (n) { $("screen-" + n).hidden = n !== name; });
    document.querySelectorAll(".tabs a").forEach(function (a) {
      if (a.getAttribute("data-tab") === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    try { localStorage.setItem("pqp-admin-view", "novo"); } catch { /* storage blocked */ }
    if (!S.visited[name]) {
      S.visited[name] = true;
      var root = $("root");
      root.classList.remove("enter"); void root.offsetWidth; root.classList.add("enter");
      clearTimeout(S.enterTimer);
      S.enterTimer = setTimeout(function () { root.classList.remove("enter"); }, 1700);
    }
    if (name === "hoje" || name === "crescimento") loadActivity(false);
    if (name === "hoje") loadHeat();
    if (name === "fila" && !S.fb.loaded) loadFeedback(false);
    if (name === "sistema" && !S.flags) loadFlags();
    renderScreen(name);
  }
  window.addEventListener("hashchange", function () { show(location.hash.slice(1)); });

  function renderScreen(name) {
    try {
      if (name === "hoje") renderHoje();
      else if (name === "crescimento") renderCrescimento();
      else if (name === "produto") renderProduto();
      else if (name === "fila") renderFila();
      else if (name === "sistema") renderSistema();
    } catch (e) {
      if (window.console) console.error("[novo] render " + name, e);
    }
  }

  // ---------------------------------------------------------------- loading
  function refresh() {
    var metricsReq = fetchJson("/metrics").then(function (d) {
      if (!d || !d.users) throw new Error("payload inesperado");
      var at = new Date().toISOString();
      if (S.metrics) {
        var evs = M.feedDiff(S.metrics, d, at);
        if (evs.length) S.feed = evs.map(function (e) { e.fresh = true; return e; }).concat(S.feed.map(function (e) { e.fresh = false; return e; })).slice(0, 8);
      }
      S.prevMetrics = S.metrics; S.metrics = d;
      $("readAt").textContent = "lido " + stamp(d.generatedAt || at) + " · relê a cada 30 s";
    });
    var healthReq = fetchJson("/health").then(function (d) { S.health = d; }).catch(function () { /* the card says so */ });
    if (!S.occupancy || Date.now() - S.occupancyAt > OCC_REFRESH_MS) {
      fetchJson("/occupancy?days=30").then(function (r) { S.occupancy = r; S.occupancyAt = Date.now(); renderScreen(S.screen); }).catch(function () {});
    }
    return Promise.all([metricsReq, healthReq]).then(function () {
      updateStatus();
      renderScreen(S.screen);
    }).catch(function (e) {
      $("statusText").textContent = "sem leitura da api · " + (e && e.message ? e.message : "erro");
      $("status").className = "status bad";
    });
  }
  function loadActivity(force) {
    if (!force && S.activity && S.activity._days === S.activityDays && Date.now() - S.activity._at < OCC_REFRESH_MS) return;
    var days = S.activityDays;
    fetchJson("/activity?days=" + days + "&weeks=12").then(function (r) {
      r._days = days; r._at = Date.now(); S.activity = r; renderScreen(S.screen);
    }).catch(function (e) {
      S.activity = { _err: e && e.message ? e.message : "erro", _days: days, _at: Date.now() };
      renderScreen(S.screen);
    });
  }
  function loadHeat() {
    if (S.heat || S.heatLoading || !S.occupancy) { if (!S.occupancy) setTimeout(loadHeat, 1500); return; }
    S.heatLoading = true;
    var days = (S.occupancy.points || []).slice(-21).map(function (p) { return p.at; });
    var got = [], i = 0, running = 0;
    var next = function () {
      while (running < 3 && i < days.length) {
        var day = days[i++]; running++;
        fetchJson("/occupancy?day=" + encodeURIComponent(day)).then(function (r) { got.push({ day: r.from, points: r.points || [] }); }, function () {}).then(function () {
          running--;
          S.heat = M.heatmap(got); S.heat._days = got.length;
          if (S.screen === "hoje") renderHeat();
          next();
        });
      }
    };
    next();
  }
  function updateStatus() {
    var m = S.metrics; if (!m) return;
    var verdicts = I ? I.buildInsights({ runtime: m.runtime, components: S.health && S.health.components, history: m.statusHistory, names: NAMES, occupancy: S.occupancy && S.occupancy.points }) : [];
    S.verdicts = verdicts;
    var bad = verdicts.some(function (v) { return v.state === "bad"; }) || (S.health && S.health.components || []).some(function (c) { return c.state === "down"; });
    var warn = verdicts.some(function (v) { return v.state === "warn"; }) || (S.health && S.health.components || []).some(function (c) { return c.state === "degraded"; });
    $("status").className = "status " + (bad ? "bad" : warn ? "warn" : "");
    $("statusText").textContent = bad ? "algo fora do normal" : warn ? "pedindo atenção" : "tudo operacional";
    var open = ((m.moderation || {}).feedback || {}).open + ((m.moderation || {}).reports || {}).open;
    $("tabCount").hidden = !open; $("tabCount").textContent = String(open || 0);
  }
  var NAMES = { api: "api", database: "postgres", storage: "storage (r2)", voice: "voz", gifs: "gifs" };

  // ---------------------------------------------------------------- HOJE
  function renderHoje() {
    var m = S.metrics; if (!m) return;
    var attn = M.attention(m, S.verdicts, S.health);
    var now = new Date();
    var eyebrow = "";
    try { eyebrow = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(now); } catch { eyebrow = ""; }
    $("hEyebrow").textContent = eyebrow;
    var voice = m.voice || {}, msgs = m.messages || {};
    var d = M.deltaLabel(msgs.last24h, msgs.previous24h);
    var hl = $("hHeadline"); clear(hl);
    var msgPart = fmt(msgs.last24h) + (msgs.last24h === 1 ? " mensagem" : " mensagens") + " em 24 h" + (d.text !== "estável" && d.text !== "novo" ? ", " + d.text + " contra o dia anterior." : ".");
    if (voice.participants) {
      hl.appendChild(h("em", { text: fmt(voice.participants) + (voice.participants === 1 ? " pessoa" : " pessoas") }));
      hl.appendChild(document.createTextNode(" em chamada agora, em " + fmt(voice.activeRooms) + (voice.activeRooms === 1 ? " sala" : " salas") + ". " + msgPart));
    } else {
      hl.appendChild(document.createTextNode("Ninguém em chamada agora. "));
      hl.appendChild(h("em", { text: msgPart.charAt(0).toUpperCase() + msgPart.slice(1) }));
    }
    var pressing = attn.filter(function (a) { return a.tone === "bad" || a.tone === "warn"; });
    $("hLede").textContent = pressing.length
      ? (pressing.length === 1 ? "Uma coisa pede atenção: " : pressing.length + " coisas pedem atenção: ") + pressing.slice(0, 3).map(function (a) { return a.title.charAt(0).toLowerCase() + a.title.slice(1); }).join("; ") + "."
      : "Nada pede atenção agora. O sistema, as filas e as chamadas estão dentro do normal.";

    renderKpis($("hKpis"), M.hojeKpis(m, S.occupancy, S.activity && !S.activity._err ? S.activity : null), "hk-");

    var at = clear($("hAttn"));
    var anim = firstTime("attn");
    attn.forEach(function (a, i) {
      var target = a.target ? "#" + a.target.split(":")[0] : null;
      var el = h(target ? "a" : "div", { class: "rowlink" + (anim ? " rise" : ""), href: target, style: "animation-delay:" + (320 + i * 60) + "ms" }, [
        h("span", { class: "sev " + a.tone }),
        h("span", { class: "t" }, [h("b", { text: a.title }), h("span", { text: a.detail })]),
        a.action ? h("span", { class: "go", text: a.action + " →" }) : null
      ]);
      at.appendChild(el);
    });

    var feed = clear($("hFeed"));
    if (!S.feed.length) {
      feed.appendChild(h("p", { class: "empty", text: "Nada mudou desde a primeira leitura. A cada 30 s, o que mudar aparece aqui: cadastros, salas abertas, servidores, feedback, denúncias e avaliações." }));
    } else {
      S.feed.forEach(function (e) {
        feed.appendChild(h("div", { class: "ev" + (e.fresh && !reduceMotion ? " slidein" : "") }, [
          h("span", { class: "sq", style: "background:" + color(e.color) }), h("span", { class: "what", text: e.what }),
          h("span", { class: "detail", text: e.detail }), h("span", { class: "when num", text: ago(e.at) })
        ]));
      });
    }

    var occ = S.occupancy;
    var peaksHost = $("hPeaks");
    if (occ && occ.points) {
      var pts = occ.points.slice(-30);
      barChart(peaksHost, pts.map(function (p) { return p.participants; }), pts.map(function (p) { return M.shortDay(p.at); }), { label: "pico diário de pessoas em chamada", unit: "pessoas no pico" });
      var top = pts.reduce(function (b, p) { return p.participants > b.participants ? p : b; }, pts[0] || { participants: 0 });
      $("hPeaksAside").textContent = pts.length ? "maior: " + fmt(top.participants) + " em " + M.shortDay(top.at) : "";
    } else if (!peaksHost.firstChild) {
      peaksHost.appendChild(h("p", { class: "empty", text: "lendo o histórico de chamadas…" }));
    }
    renderHeat();
    hojeDetails(m);
  }

  function renderHeat() {
    var host = $("hHeat"); if (!host) return;
    var hm = S.heat;
    if (!hm) { if (!host.firstChild) host.appendChild(h("p", { class: "empty", text: "lendo as amostras de um minuto dos últimos 21 dias…" })); return; }
    var names = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];
    var animate = firstTime("heat");
    clear(host);
    var grid = h("div", { class: "heat", role: "img", "aria-label": "média de pessoas em chamada por dia da semana e hora" });
    var cap = $("hHeatCap");
    hm.cells.forEach(function (row, d) {
      var r = h("div", { class: "hr" }, [h("span", { class: "dl", text: names[d] })]);
      row.forEach(function (v, hr) {
        var t = v == null ? 0 : v / (hm.max || 1);
        var c = h("span", { class: "c" + (animate ? " pop" : ""), style: "background:" + (v == null ? "var(--s2)" : "color-mix(in oklch, var(--accent) " + Math.round(8 + t * 88) + "%, transparent)") + ";animation-delay:" + ((d * 24 + hr) * 5) + "ms" });
        c.addEventListener("mouseenter", function () { cap.textContent = names[d] + ", " + hr + "h · " + (v == null ? "sem amostra" : "média de " + M.dec(v) + (Math.round(v) === 1 ? " pessoa" : " pessoas") + " em chamada"); });
        r.appendChild(c);
      });
      grid.appendChild(r);
    });
    var hours = h("div", { class: "hours" });
    for (var i = 0; i < 24; i++) hours.appendChild(h("span", { text: i % 6 === 0 ? String(i) : "" }));
    grid.appendChild(hours);
    grid.addEventListener("mouseleave", function () { cap.textContent = "passe o mouse num quadrado"; });
    host.appendChild(grid);
    $("hHeatAside").textContent = fmt(hm._days || 0) + " dias lidos";
  }

  function hojeDetails(m) {
    var voice = m.voice || {};
    var verdictEls = h("div", { class: "verdicts" }, (S.verdicts || []).map(function (v) {
      return h("div", { class: "verdict" }, [
        h("div", { class: "vh" }, [h("span", { class: "sev " + (v.state === "raw" ? "info" : v.state), style: "width:8px;height:8px;border-radius:50%;box-shadow:none" }), document.createTextNode(v.head || "")]),
        h("p", { text: (v.body || "").replace(/<[^>]*>/g, "") }),
        h("div", { class: "figs" }, (v.figs || []).map(function (f) { return h("span", null, [f[0] + " ", h("b", { class: "num", text: String(f[1]) })]); }))
      ]);
    }));
    var rooms = (voice.rooms || []).slice().sort(function (a, b) { return b.participants - a.participants; });
    var comps = (S.health && S.health.components) || [];
    var hist = {};
    ((m.statusHistory || {}).components || []).forEach(function (c) { hist[c.key] = c; });
    var seats = voice.seats;
    var sfu = m.sfu || {};
    var regions = (m.sfuRegions && m.sfuRegions.regions) || [];
    details($("hDetails"), "hd", "tudo que estava em “agora”, a um clique", [
      { id: "leituras", title: "Leituras do sistema", summary: "pool, latência e voz, com os números por trás de cada frase", openByDefault: true, body: [verdictEls] },
      { id: "salas", title: "Salas abertas agora", summary: fmt(voice.activeRooms) + " salas · " + fmt(voice.participants) + " pessoas · caminho de mídia e há quanto tempo cada uma está no ar",
        body: [rooms.length ? table(["sala", "servidor", "caminho", "pessoas", "compartilhando", "no ar há"], rooms.map(function (r) { return [r.channel || "conversa", r.server || "—", r.transport === "livekit" ? "servidor de mídia" : "ponto a ponto", fmt(r.participants), fmt(r.sharingScreen), r.openedAt ? ago(r.openedAt).replace("há ", "") : "—"]; }), [3, 4]) : para("Ninguém em chamada agora.")] },
      { id: "saude", title: "Saúde dos serviços", summary: comps.filter(function (c) { return c.state === "operational"; }).length + " de " + comps.length + " operacionais · latência agora, normal (p50) e uptime",
        body: [table(["componente", "estado", "agora", "normal (p50)", "p95", "uptime 24 h"], comps.map(function (c) { var hc = hist[c.key] || {}; return [NAMES[c.key] || c.label, { operational: "operacional", degraded: "instável", down: "fora do ar", disabled: "desligado" }[c.state] || c.state, c.latencyMs != null ? fmt(c.latencyMs) + " ms" : "—", hc.p50 != null ? fmt(hc.p50) + " ms" : "—", hc.p95 != null ? fmt(hc.p95) + " ms" : "—", c.uptime24h != null ? M.dec(c.uptime24h * 100, 2) + "%" : "—"]; }), [2, 3, 4, 5])] },
      { id: "voz", title: "Voz hoje", summary: "maior sala hoje: " + fmt(voice.peakRoomSizeToday) + " · contado desde " + (voice.peakTrackedSince ? stamp(voice.peakTrackedSince) : "—"),
        body: [stats([["pessoas agora", fmt(voice.participants), "em " + fmt(voice.activeRooms) + " salas"], ["maior sala agora", fmt(voice.largestRoomNow), ""], ["maior sala hoje", fmt(voice.peakRoomSizeToday), "zera no deploy"], ["caminho padrão", voice.backend === "livekit" ? "servidor" : "p2p", "salas pequenas ficam p2p"]])] },
      { id: "sfu", title: "Servidor de mídia e regiões", summary: (sfu.host || "sem sfu") + (sfu.rooms != null ? " · " + fmt(sfu.rooms) + " salas · " + fmt(sfu.participants) + " pessoas" : "") + (regions.length ? " · " + regions.length + " regiões" : ""),
        body: [regions.length ? table(["região", "host", "responde", "salas", "pessoas"], regions.map(function (r) { return [r.id + (r.home ? " (casa)" : ""), r.host || "—", r.reachable ? fmt(r.ms) + " ms" : "não", r.rooms != null ? fmt(r.rooms) : "—", r.participants != null ? fmt(r.participants) : "—"]; }), [3, 4]) : stats([["host", sfu.host || "—", ""], ["salas", fmt(sfu.rooms), ""], ["pessoas", fmt(sfu.participants), ""], ["sonda", sfu.ms != null ? fmt(sfu.ms) + " ms" : "—", ""]])] },
      { id: "assentos", title: "Assentos parados", summary: seats ? fmt(seats.idleOverAnHour) + " parados há mais de 1 h · " + (seats.oldestIdleMinutes != null ? "o mais antigo há " + fmt(seats.oldestIdleMinutes) + " min" : "nenhum") : "registro de voz desligado",
        body: [seats ? stats([["parados > 1 h", fmt(seats.idleOverAnHour), ""], ["fantasmas removidos", fmt(seats.ghostsSwept), "desde o boot"], ["escritas recusadas", fmt(seats.staleRowWritesRefused), ""], ["sockets com mesh-resume", fmt(seats.meshResumeSockets), "de " + fmt(seats.sockets)]]) : para("O registro de voz está desligado nesta instância.")] }
    ]);
  }

  // ---------------------------------------------------------------- CRESCIMENTO
  function renderCrescimento() {
    var m = S.metrics; var a = S.activity && !S.activity._err ? S.activity : null;
    var act = M.activityHeadline(a);
    var days = a ? a.days : [];
    var y = days.length >= 2 ? days[days.length - 2] : null;
    var tracked = y && y.dau != null;
    var kpis = [
      { key: "dau", label: act.label, value: act.value, badge: act.badge, note: act.note, series: act.series, color: "accent" },
      { key: "wau", label: tracked ? "ativos 7 dias · wau" : "escreveram · 7 dias", value: y ? (tracked ? y.wau : y.postedWau) : null, badge: null, note: "janela móvel de 7 dias", series: days.map(function (x) { return tracked ? x.wau : x.postedWau; }).filter(function (v) { return v != null; }), color: "accent" },
      { key: "mau", label: y && y.mau != null ? "ativos 30 dias · mau" : "escreveram · 30 dias", value: y ? (y.mau != null ? y.mau : y.postedMau) : null, badge: null, note: y && y.mau != null ? "janela móvel de 30 dias" : "ativos a partir de 30 dias de rastreio", series: days.map(function (x) { return x.mau != null ? x.mau : x.postedMau; }), color: "series" },
      { key: "signups", label: "cadastros · 30 dias", value: m && m.activation ? m.activation.window30d.signup : null, badge: m && m.activation ? { text: fmt(m.activation.window7d.signup) + " em 7 dias", tone: "flat" } : null, note: "contas humanas novas", series: m && m.userDetail ? m.userDetail.signupsByDay.map(function (x) { return x.n; }) : null, color: "series" }
    ];
    renderKpis($("cKpis"), kpis, "ck-");
    $("cLede").textContent = a && a.trackingSince
      ? "“Ativos” é quem abriu o app ou escreveu no dia. O rastreio conta desde " + M.shortDay(a.trackingSince) + "; antes disso, só quem escreveu."
      : "“Ativos” é quem abriu o app ou escreveu no dia.";
    // range control
    var seg = $("cRange"), btns = seg.querySelectorAll("button"), ind = seg.querySelector(".ind");
    btns.forEach(function (b) {
      var on = Number(b.getAttribute("data-days")) === S.activityDays;
      b.setAttribute("aria-pressed", on ? "true" : "false");
      if (on) { ind.style.width = b.offsetWidth + "px"; ind.style.transform = "translateX(" + (b.offsetLeft - 4) + "px)"; }
    });
    // chart
    var ser = M.activitySeries(a);
    var chart = $("cChart"), legend = clear($("cLegend"));
    if (!ser) {
      clear(chart).appendChild(h("p", { class: "empty", text: S.activity && S.activity._err ? "a leitura falhou · " + S.activity._err : "lendo…" }));
    } else {
      var series = [];
      if (ser.tracked) {
        series.push({ label: "ativos em 30 dias", values: ser.mau, color: "var(--series)", area: true });
        series.push({ label: "ativos no dia", values: ser.dau, color: "var(--accent)" });
      }
      series.push({ label: "escreveram em 30 dias", values: ser.postedMau, color: "var(--series)", dashed: true });
      series.push({ label: "escreveram no dia", values: ser.postedDau, color: "var(--accent)", dashed: true });
      var marker = ser.trackingSince ? ser.labels.indexOf(M.shortDay(ser.trackingSince)) : -1;
      lineChart(chart, series, ser.labels, { label: "ativos por dia e em 30 dias", marker: marker > 0 ? marker : null, markerLabel: "rastreio começa", height: 400 });
      series.forEach(function (sr) { legend.appendChild(h("span", null, [h("i", { class: sr.dashed ? "dash" : null, style: "background:" + sr.color + ";color:" + sr.color }), sr.label])); });
      if (!ser.tracked) legend.appendChild(h("span", { style: "color:var(--faint)", text: "ativos: a partir de " + M.shortDay(ser.trackingSince) }));
      $("cChartFoot").textContent = "linha cheia: abriram o app ou escreveram · tracejada: só quem escreveu · o último dia está em curso";
    }
    // funnel
    var f = M.funnel(m && m.activation);
    var fh = clear($("cFunnel"));
    var fAnim = firstTime("funnel");
    if (!f) fh.appendChild(h("p", { class: "empty", text: "sem funil nesta api" }));
    else {
      var maxDrop = f.reduce(function (b, x, i) { return i && x.drop > (f[b].drop || 0) ? i : b; }, 1);
      f.forEach(function (x, i) {
        fh.appendChild(h("div", { style: "display:flex;flex-direction:column;gap:6px;margin-bottom:12px" }, [
          h("div", { style: "display:flex;justify-content:space-between;font-size:13.5px" }, [h("span", { text: x.label }), h("span", { class: "num", style: "font-weight:700", text: M.fmtPct(x.pct) + " · " + fmt(x.count) })]),
          h("div", { class: "meter lg" }, [h("i", { class: fAnim ? "growx" : null, style: "width:" + x.pct + "%;opacity:" + (0.35 + x.pct / 160).toFixed(2) + ";animation-delay:" + (300 + i * 90) + "ms" })]),
          i && x.drop != null ? h("span", { style: "font-size:11.5px;color:" + (i === maxDrop ? "var(--warn)" : "var(--faint)"), text: "−" + M.dec(x.drop) + " pontos" + (i === maxDrop ? " · o maior tombo" : "") }) : null
        ]));
      });
    }
    // cohort
    var ch = clear($("cCohort"));
    var cap = $("cCohortCap");
    if (!a || !a.cohorts) ch.appendChild(h("p", { class: "empty", text: "lendo…" }));
    else {
      var cAnim = firstTime("cohort");
      var grid = h("div", { style: "display:grid;grid-template-columns:70px 80px repeat(3, minmax(0, 1fr));gap:6px;align-items:center" });
      ["semana", "cadastros", "dia 1", "semana 1", "mês 1"].forEach(function (t, i) { grid.appendChild(h("span", { style: "font-size:11px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:0.06em;text-align:" + (i === 1 ? "right" : i > 1 ? "center" : "left"), text: t })); });
      var brackets = ["no dia 1", "na semana 1 (dias 7 a 13)", "no mês 1 (dias 30 a 36)"];
      a.cohorts.slice().reverse().forEach(function (c, r) {
        grid.appendChild(h("span", { style: "font-size:13px;color:var(--muted)", text: M.shortDay(c.week) }));
        grid.appendChild(h("span", { class: "num", style: "font-size:13px;text-align:right", text: fmt(c.size) }));
        [c.d1, c.d7, c.d30].forEach(function (b, j) {
          var useActive = b.activeEligible > 0;
          var elig = useActive ? b.activeEligible : b.eligible, got = useActive ? b.active : b.posted;
          var p = elig ? got / elig : null;
          var cell = h("span", { class: "num" + (cAnim ? " pop" : ""), style: "padding:9px 0;border-radius:8px;text-align:center;font-size:13px;font-weight:700;outline:2px solid transparent;outline-offset:1px;transition:outline-color 120ms;animation-delay:" + ((r + j) * 45 + 300) + "ms;" + (p == null ? "color:var(--faint);font-weight:400;font-size:12px;border:1px dashed var(--line)" : "background:color-mix(in oklch, var(--accent) " + Math.round(12 + p * 140) + "%, transparent);color:" + (p > 0.3 ? "var(--accent-ink)" : "var(--text)")), text: p == null ? "ainda não" : Math.round(p * 100) + "%" });
          cell.addEventListener("mouseenter", function () {
            cell.style.outlineColor = "var(--text)";
            cap.textContent = p == null ? "semana de " + M.shortDay(c.week) + ": " + brackets[j] + " ainda não terminou, então não conta como perda"
              : "de " + fmt(elig) + " cadastros da semana de " + M.shortDay(c.week) + " que já passaram " + brackets[j] + ", " + fmt(got) + (useActive ? " voltaram ao app" : " escreveram de novo");
          });
          cell.addEventListener("mouseleave", function () { cell.style.outlineColor = "transparent"; });
          grid.appendChild(cell);
        });
      });
      ch.appendChild(grid);
    }
    // sources
    var src = M.sources(m && m.acquisition, m && m.retention);
    var sh = clear($("cSources"));
    var sAnim = firstTime("sources");
    if (!src.rows.length) sh.appendChild(h("p", { class: "empty", text: "sem cadastros com tempo de voltar ainda" }));
    src.rows.forEach(function (r, i) {
      sh.appendChild(h("div", { class: "bar-row", style: "margin-bottom:14px" }, [
        h("span", { class: "name", text: r.name }),
        h("span", { class: "meter series" }, [h("i", { class: sAnim ? "growx" : null, style: "width:" + (r.signups / (src.max || 1) * 100).toFixed(1) + "%;animation-delay:" + (400 + i * 80) + "ms" })]),
        h("span", { class: "n num", style: "text-align:right;color:var(--muted)", text: fmt(r.signups) }),
        h("span", { class: "num", style: "text-align:right;font-weight:700;color:" + (r.rate == null ? "var(--faint)" : r.rate >= 30 ? "var(--ok)" : "var(--warn)"), text: r.rate == null ? "—" : M.fmtPct(r.rate) + " ficam" })
      ]));
    });
    $("cSourcesFoot").textContent = "cadastros dos últimos 30 dias com mais de 24 h · “ficam”: escreveram nos últimos " + (src.windowDays || 7) + " dias";
    crescDetails(m);
  }

  function crescDetails(m) {
    if (!m) return;
    var acq = m.acquisition || { rows: [], landings: [] };
    var ud = m.userDetail || {};
    details($("cDetails"), "cd", "tudo que estava em “ao longo do tempo” e nos cadastros", [
      { id: "base", title: "A base", summary: "usuários, servidores, quem escreveu e o que fica fora das contagens", openByDefault: true,
        body: [stats([["usuários", fmt(m.users.total), "+" + fmt(m.users.last24h) + " em 24 h"], ["servidores", fmt(m.servers.total), "+" + fmt(m.servers.last24h) + " em 24 h"], ["escreveram · 24 h", fmt(m.distinctSenders24h), "em " + fmt(m.activeTextChannels24h) + " canais de texto"], ["automáticas · 24 h", fmt(m.messages.automated24h), "elenco da casa e webhooks, fora das contagens"]])] },
      { id: "horas", title: "Últimas 24 horas, hora a hora", summary: fmt(m.users.last24h) + " cadastros · " + fmt(m.messages.last24h) + " mensagens",
        body: [(function () { var w = h("div", { class: "grid g-half" }); var a1 = h("div", { class: "chart", id: "cdSignupsH" }), a2 = h("div", { class: "chart", id: "cdMsgsH" }); w.appendChild(h("div", null, [h("div", { class: "foot", text: "cadastros por hora" }), a1])); w.appendChild(h("div", null, [h("div", { class: "foot", text: "mensagens por hora" }), a2])); requestAnimationFrame(function () { var lab = m.users.byHour.map(function (_, i) { return "há " + (m.users.byHour.length - 1 - i) + " h"; }); barChart(a1, m.users.byHour, lab, { label: "cadastros por hora", unit: "cadastros", height: 140 }); barChart(a2, m.messages.byHour, lab, { label: "mensagens por hora", unit: "mensagens", height: 140 }); }); return w; })()] },
      { id: "dias", title: "Cadastros por dia", summary: (ud.signupsByDay || []).length + " dias, fuso de São Paulo",
        body: [(function () { var c = h("div", { class: "chart", id: "cdDays" }); requestAnimationFrame(function () { barChart(c, (ud.signupsByDay || []).map(function (x) { return x.n; }), (ud.signupsByDay || []).map(function (x) { return M.shortDay(x.day); }), { label: "cadastros por dia", unit: "cadastros", height: 150 }); }); return c; })()] },
      { id: "campanha", title: "Primeiro toque, por campanha", summary: fmt(acq.total) + " cadastros em " + fmt(acq.days) + " dias",
        body: [acq.rows.length ? table(["origem", "meio", "campanha", "ref", "cadastros"], acq.rows.map(function (r) { return [r.source || "—", r.medium || "—", r.campaign || "—", r.ref || "—", fmt(r.signups)]; }), [4]) : para("Nenhum cadastro com parâmetros de campanha na janela.")] },
      { id: "entrada", title: "Página de entrada", summary: "por onde cada cadastro chegou",
        body: [(acq.landings || []).length ? table(["página", "cadastros"], acq.landings.map(function (r) { return [r.landing || r.path || "—", fmt(r.signups)]; }), [1]) : para("Sem páginas de entrada registradas na janela.")] },
      { id: "retencao7", title: "Voltaram a escrever em 7 dias", summary: fmt(ud.returning7d && ud.returning7d.active) + " de " + fmt(ud.returning7d && ud.returning7d.eligible) + " contas com mais de 24 h",
        body: [para("Conta quem criou a conta há mais de 24 h e mandou alguma mensagem nos últimos 7 dias. É a medida estrita; os ativos (quem abriu o app) estão no gráfico acima.")] },
      { id: "classico", title: "Pessoas em chamada, minuto a minuto", summary: "abra um dia dos últimos 21 na visão clássica", body: [classicLink("tempo", "abrir o histórico de chamadas na visão clássica")] }
    ]);
  }

  // ---------------------------------------------------------------- PRODUTO
  function renderProduto() {
    var m = S.metrics; if (!m) return;
    var cr = m.callRatings || {};
    var dist = (m.distribution || {});
    var comm = m.communities || {};
    renderKpis($("pKpis"), [
      { key: "rating", label: "nota das chamadas · 7 dias", value: cr.average, format: function (v) { return M.dec(v); }, badge: { text: fmt(cr.total) + " avaliações", tone: "flat" }, note: "de 1 a 5, depois de cada chamada", series: null, color: "accent" },
      { key: "apk", label: "cliques no apk · total", value: dist.apkClicks != null ? dist.apkClicks : null, badge: { text: "+" + fmt(dist.apkClicksToday || 0) + " hoje", tone: dist.apkClicksToday ? "ok" : "flat" }, note: dist.apkDownloads != null ? fmt(dist.apkDownloads) + " downloads no github" : "downloads indisponíveis", series: null, color: "series" },
      { key: "channels", label: "canais de texto ativos · 24h", value: m.activeTextChannels24h, badge: { text: fmt(m.distinctSenders24h) + " pessoas", tone: "flat" }, note: "escreveram neles", series: null, color: "accent" },
      { key: "comm", label: "comunidades listadas", value: comm.enabled ? comm.listed : null, badge: comm.enabled ? { text: fmt(comm.total) + " com endereço", tone: "flat" } : { text: "desligado", tone: "flat" }, note: comm.enabled ? "no diretório público" : "COMMUNITIES_ENABLED desligado", series: null, color: "series" }
    ], "pk-");
    var rd = M.ratingDistribution(cr);
    var rh = clear($("pRating"));
    var rAnim = firstTime("rating");
    rh.appendChild(h("div", { style: "display:flex;align-items:baseline;gap:10px" }, [h("span", { class: "num", style: "font-family:var(--display);font-size:44px;font-weight:600;letter-spacing:-0.03em", text: cr.average != null ? M.dec(cr.average) : "—" }), h("span", { style: "font-size:13px;color:var(--muted)", text: "de 5 · " + fmt(cr.total) + " avaliações" })]));
    if (rd) rd.rows.forEach(function (r, i) {
      rh.appendChild(h("div", { style: "display:grid;grid-template-columns:28px minmax(0,1fr) 44px;gap:10px;align-items:center;font-size:13px;margin-top:8px" }, [
        h("span", { style: "color:var(--muted)", text: r.stars + "★" }),
        h("span", { class: "meter" }, [h("i", { class: rAnim ? "growx" : null, style: "width:" + r.pct + "%;background:" + (r.stars >= 4 ? "var(--accent)" : r.stars === 3 ? "var(--warn)" : "var(--bad)") + ";animation-delay:" + (300 + i * 70) + "ms" })]),
        h("span", { class: "num", style: "text-align:right", text: M.fmtPct(r.pct) })
      ]));
    });
    var bt = h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px" });
    (cr.byTransport || []).forEach(function (t) {
      bt.appendChild(h("div", { class: "stat" }, [h("span", { class: "sk", text: t.transport === "livekit" || t.transport === "sfu" ? "servidor de mídia" : "ponto a ponto" }), h("span", { class: "sv num", text: t.average != null ? M.dec(t.average) : "—" }), h("span", { class: "sn", text: fmt(t.total) + " avaliações" })]));
    });
    rh.appendChild(bt);
    var nh = clear($("pNotes"));
    var notes = cr.recentNotes || [];
    if (!notes.length) nh.appendChild(h("p", { class: "empty", text: "Ninguém deixou nota escrita numa avaliação baixa." }));
    notes.slice(0, 4).forEach(function (n) {
      nh.appendChild(h("div", { class: "note" }, [
        h("div", { class: "nh" }, [h("span", { class: "stars", style: "color:" + (n.rating === 3 ? "var(--warn)" : "var(--bad)"), text: "★".repeat(n.rating) + "☆".repeat(5 - n.rating) }), h("span", { style: "color:var(--faint)", text: ago(n.createdAt) })]),
        h("p", { text: n.note })
      ]));
    });
    var rings = clear($("pRings"));
    var ringAnim = firstTime("rings");
    var rc = ["var(--accent)", "var(--series)", "var(--warn)", "var(--ok)"];
    M.adoption(m).forEach(function (a, i) {
      var v = a.v == null ? 0 : a.v;
      var svg = s("svg", { width: "96", height: "96", viewBox: "0 0 96 96", role: "img", "aria-label": a.label + ": " + M.fmtPct(a.v) });
      svg.appendChild(s("circle", { cx: 48, cy: 48, r: 38, fill: "none", stroke: "var(--s3)", "stroke-width": 9 }));
      if (v > 0) svg.appendChild(s("circle", { cx: 48, cy: 48, r: 38, fill: "none", stroke: rc[i], "stroke-width": 9, "stroke-linecap": "round", transform: "rotate(-90 48 48)", pathLength: "100", "stroke-dasharray": v.toFixed(1) + " 100", "stroke-dashoffset": ringAnim ? v.toFixed(1) : "0", style: ringAnim ? "transition:stroke-dashoffset 1100ms var(--ease) " + (400 + i * 90) + "ms" : null }));
      var t = s("text", { x: 48, y: 54, "text-anchor": "middle" }); t.textContent = a.v == null ? "—" : Math.round(v) + "%"; svg.appendChild(t);
      rings.appendChild(h("div", { class: "ring" }, [svg, h("span", { text: a.label })]));
      if (ringAnim && v > 0) requestAnimationFrame(function () { requestAnimationFrame(function () { svg.lastChild.previousSibling.setAttribute("stroke-dashoffset", "0"); }); });
    });
    var chh = clear($("pChannels"));
    var top = (m.channelDetail && m.channelDetail.topText24h) || [];
    var mx = top.reduce(function (b, c) { return Math.max(b, c.messages24h); }, 1);
    var tAnim = firstTime("topchannels");
    if (!top.length) chh.appendChild(h("p", { class: "empty", text: "Nenhuma mensagem em canais de texto nas últimas 24 h." }));
    top.forEach(function (c, i) {
      chh.appendChild(h("div", { class: "rowlink", style: "display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,2fr) 110px 100px;gap:14px" }, [
        h("span", { style: "font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", text: c.channel }),
        h("span", { style: "color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis", text: c.server }),
        h("span", { class: "meter" }, [h("i", { class: tAnim ? "growx" : null, style: "width:" + (c.messages24h / mx * 100).toFixed(1) + "%;animation-delay:" + (500 + i * 60) + "ms" })]),
        h("span", { class: "num", style: "text-align:right", text: fmt(c.messages24h) + " msgs" }),
        h("span", { class: "num", style: "text-align:right;color:var(--muted)", text: fmt(c.senders24h) + (c.senders24h === 1 ? " pessoa" : " pessoas") })
      ]));
    });
    produtoDetails(m);
  }

  function produtoDetails(m) {
    var comm = m.communities || {}, conn = m.connections || {}, ch = m.channels || {}, cd = m.channelDetail || {}, p = m.product || {}, calls = m.calls || {}, imp = (m.imports || {}).discord || {};
    var provRows = [];
    ["steam", "battlenet", "twitch"].forEach(function (k) { var v = (conn.byProvider || conn)[k]; if (v && typeof v === "object") provRows.push([{ steam: "Steam", battlenet: "Battle.net", twitch: "Twitch" }[k], fmt(v.linked), fmt(v.public)]); });
    details($("pDetails"), "pd", "tudo que estava em “pessoas e conteúdo” sobre uso", [
      { id: "servidores", title: "Servidores mais ativos", summary: "por mensagens nas últimas 24 h",
        body: [(m.topServers24h || []).length ? table(["servidor", "membros", "canais", "mensagens · 24 h"], m.topServers24h.map(function (s0) { return [s0.name, fmt(s0.members), fmt(s0.channels), fmt(s0.messages24h)]; }), [1, 2, 3]) : para("Nenhum servidor com mensagens em 24 h.")] },
      { id: "comunidades", title: "Comunidades", summary: comm.enabled ? fmt(comm.listed) + " listadas · " + fmt(comm.suspended) + " suspensas" : "desligado nesta instância",
        body: [comm.enabled && (comm.list || []).length ? table(["comunidade", "categoria", "membros", "canais", "mensagens · 24 h"], comm.list.map(function (c) { return [c.name + (c.suspended ? " (suspensa)" : ""), c.category, fmt(c.members), fmt(c.channels), fmt(c.messages24h)]; }), [2, 3, 4]) : para(comm.enabled ? "Nenhuma comunidade listada ainda." : "COMMUNITIES_ENABLED está desligado.")] },
      { id: "jogos", title: "Contas de jogo conectadas", summary: "Steam, Battle.net e Twitch",
        body: [provRows.length ? table(["provedor", "vinculadas", "públicas"], provRows, [1, 2]) : para("Sem contas de jogo nesta leitura.")] },
      { id: "forma", title: "Forma da instância", summary: fmt(ch.text) + " canais de texto · " + fmt(ch.voice) + " de voz · " + fmt(cd.serversWithChannels) + " servidores com canais",
        body: [stats([["canais de texto", fmt(ch.text), fmt(cd.privateText) + " privados · " + fmt(cd.emptyText) + " vazios"], ["canais de voz", fmt(ch.voice), fmt(ch.thread) + " tópicos"], ["conversas", fmt((cd.conversations || {}).dm), "diretas · " + fmt((cd.conversations || {}).group) + " em grupo"], ["maior servidor", fmt(cd.maxChannelsInServer), "canais"]])] },
      { id: "apps", title: "Apps e produto", summary: "amizades · anexos · convites · push",
        body: [stats([["amizades", fmt(p.friendships), fmt(p.pendingFriendRequests) + " pedidos em aberto"], ["anexos · 24 h", fmt((p.attachments || {}).last24h), fmt((p.attachments || {}).total) + " no total"], ["convites · 24 h", fmt((p.invites || {}).created24h), fmt((p.invites || {}).uses) + " usos no total"], ["push", fmt((p.push || {}).web), "web · " + fmt((p.push || {}).apns) + " iphone · " + fmt((p.push || {}).fcm) + " android"]])] },
      { id: "chamadas", title: "Chamadas e toques", summary: fmt(calls.joinConnected) + " de " + fmt(calls.joinAttempts) + " entradas conectaram · " + fmt(calls.ringsAnswered) + " de " + fmt(calls.rings) + " toques atendidos",
        body: [stats([["entradas", fmt(calls.joinAttempts), "desde o boot"], ["conectaram", fmt(calls.joinConnected), M.fmtPct(M.pct(calls.joinConnected, calls.joinAttempts))], ["toques", fmt(calls.rings), fmt(calls.ringsDeclined) + " recusados"], ["atendidos", fmt(calls.ringsAnswered), M.fmtPct(M.pct(calls.ringsAnswered, calls.rings))]])] },
      { id: "discord", title: "Importação do Discord", summary: fmt(imp.last7d) + " em 7 dias · " + fmt(imp.total) + " no total",
        body: [stats([["importações", fmt(imp.total), fmt(imp.last24h) + " em 24 h"], ["em 7 dias", fmt(imp.last7d), ""], ["membros que entraram", fmt(imp.membersJoined7d), "em 7 dias"], ["pelo convite da importação", fmt(imp.joinedViaImportInvite7d), "em 7 dias"]])] }
    ]);
  }

  // ---------------------------------------------------------------- FILA
  var KIND = { bug: "bug", idea: "ideia", other: "outro" };
  function loadFeedback(append) {
    var fb = S.fb;
    var seq = ++fb.seq;
    var q = "status=" + fb.status + "&limit=25" + (fb.kind ? "&kind=" + fb.kind : "") + (append && fb.next ? "&before=" + fb.next : "");
    fb.loading = true;
    return fetchJson("/operator/feedback?" + q).then(function (r) {
      if (seq !== fb.seq) return;
      fb.loading = false; fb.loaded = true;
      fb.items = append ? fb.items.concat(r.items) : r.items;
      fb.next = r.next; fb.counts = r.counts;
      if (!fb.items.some(function (x) { return x.id === fb.sel; })) fb.sel = fb.items.length ? fb.items[0].id : null;
      renderFila(true);
    }).catch(function (e) {
      if (seq !== fb.seq) return;
      fb.loading = false; fb.error = e && e.message ? e.message : "erro";
      renderFila(true);
    });
  }
  function renderFila(paneChanged) {
    var fb = S.fb, m = S.metrics;
    var c = fb.counts;
    $("fLede").textContent = c ? fmt(c.open) + " abertos · " + fmt(c.confirmed) + " confirmados · " + fmt(c.closed) + " fechados · " + fmt(c.last24h) + " novos em 24 h" : (fb.error ? "a leitura falhou · " + fb.error : "lendo a fila…");
    var chips = clear($("fChips"));
    var byKind = c ? c.openByKind : { bug: 0, idea: 0, other: 0 };
    [["", "tudo", c ? c.open : 0], ["bug", "bugs", byKind.bug], ["idea", "ideias", byKind.idea], ["other", "outros", byKind.other]].forEach(function (k) {
      chips.appendChild(h("button", { type: "button", class: "chip", "aria-pressed": fb.kind === k[0] ? "true" : "false", text: k[1] + " · " + fmt(k[2]), onclick: function () { fb.kind = k[0]; fb.sel = null; loadFeedback(false); } }));
    });
    chips.appendChild(h("button", { type: "button", class: "chip", "aria-pressed": fb.status === "all" ? "true" : "false", text: fb.status === "all" ? "mostrando todos" : "só abertos", onclick: function () { fb.status = fb.status === "all" ? "open" : "all"; fb.sel = null; loadFeedback(false); } }));
    var list = clear($("fItems"));
    var anim = firstTime("fila-items");
    fb.items.forEach(function (it, i) {
      list.appendChild(h("button", { type: "button", class: "item" + (anim ? " rise" : ""), role: "option", "aria-current": it.id === fb.sel ? "true" : "false", "aria-selected": it.id === fb.sel ? "true" : "false", "data-id": it.id, style: "animation-delay:" + (150 + i * 40) + "ms",
        onclick: function () { if (fb.sel !== it.id) { fb.sel = it.id; renderFila(true); } } }, [
        h("span", { class: "im" }, [h("span", { class: "badge kind " + it.kind, text: KIND[it.kind] || it.kind }), it.status !== "open" ? h("span", { class: "badge " + (it.status === "confirmed" ? "accent" : ""), text: it.status === "confirmed" ? "confirmado" : "fechado" }) : null, "#" + it.id + " · " + ago(it.createdAt)]),
        h("span", { class: "it", text: it.body })
      ]));
    });
    if (!fb.items.length && fb.loaded) list.appendChild(h("p", { class: "empty", text: "Nada aqui com esse filtro. Fila limpa." }));
    $("fMore").hidden = !fb.next;
    var rep = (m && m.moderation) || {};
    var rr = rep.reports || {};
    var reports = clear($("fReports"));
    reports.appendChild(h("div", { class: "nh" }, [h("b", { style: "font-size:13px", text: "Denúncias" }), h("span", { class: "badge " + (rr.open ? "warn" : "ok"), text: fmt(rr.open) + " abertas" })]));
    reports.appendChild(h("p", { text: fmt(rr.last24h) + " novas em 24 h · " + fmt(rep.bans) + " bans · " + fmt(rep.activeTimeouts) + " castigos em vigor" }));
    reports.appendChild(h("a", { href: "https://pqp.gg/app?modAllReports=1", target: "_blank", rel: "noopener", style: "font-size:12.5px;font-weight:600;text-decoration:none", text: "abrir a fila completa, todos os servidores →" }));
    if (paneChanged) renderPane();
  }
  function renderPane() {
    var fb = S.fb, pane = clear($("fPane"));
    var it = fb.items.filter(function (x) { return x.id === fb.sel; })[0];
    if (!it) {
      pane.appendChild(h("div", { class: reduceMotion ? null : "panein", style: "padding-top:60px" }, [h("div", { style: "font-family:var(--display);font-size:26px;font-weight:600", text: fb.loaded ? "Fila limpa." : "Lendo…" }), h("p", { class: "lede", text: fb.loaded ? "Nada esperando por você neste filtro." : "" })]));
      return;
    }
    var wrap = h("div", { class: reduceMotion ? null : "panein", style: "display:flex;flex-direction:column;gap:20px" });
    wrap.appendChild(h("div", { style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap" }, [
      h("span", { class: "badge kind " + it.kind, text: KIND[it.kind] || it.kind }),
      h("span", { class: "badge " + (it.status === "open" ? "warn" : it.status === "confirmed" ? "accent" : ""), text: { open: "aberto", confirmed: "confirmado", closed: "fechado" }[it.status] }),
      h("span", { style: "font-size:12.5px;color:var(--faint)", text: "#" + it.id + " · " + stamp(it.createdAt) })
    ]));
    wrap.appendChild(h("p", { class: "body", text: it.body }));
    var a = it.author;
    wrap.appendChild(h("div", { class: "who" }, [
      h("span", { class: "avatar", text: a ? (a.displayName || a.tag).charAt(0).toUpperCase() : "?" }),
      h("span", { style: "display:flex;flex-direction:column;gap:3px;min-width:0" }, a ? [
        h("span", { style: "font-size:14.5px;font-weight:600" }, [a.displayName ? a.displayName + " · " : "", h("span", { style: "color:var(--muted);font-weight:500", text: a.tag }), a.handle ? " · " : "", a.handle ? h("a", { href: "https://pqp.gg/@" + encodeURIComponent(a.handle), target: "_blank", rel: "noopener", text: "@" + a.handle }) : null]),
        h("span", { style: "font-size:12.5px;color:var(--muted)", text: [ageText(a.accountCreatedAt), fmt(a.sent) + (a.sent === 1 ? " enviado" : " enviados") + (a.confirmed ? ", " + fmt(a.confirmed) + (a.confirmed === 1 ? " confirmado" : " confirmados") : "")].join(" · ") })
      ] : [h("span", { style: "font-size:14px;color:var(--muted)", text: "conta apagada" })])
    ]));
    var ctx = ctxChips(it.context);
    wrap.appendChild(h("div", { style: "display:flex;flex-direction:column;gap:10px" }, [h("div", { class: "foot", style: "font-weight:600;color:var(--muted);font-size:13px", text: "onde a pessoa estava" }), ctx]));
    var actions = h("div", { class: "actions" });
    if (it.status !== "confirmed") actions.appendChild(h("button", { type: "button", class: "btn primary", text: it.kind === "bug" ? "confirmar bug · dá o selo" : "confirmar", onclick: function () { resolve(it, "confirmed"); } }));
    if (it.status !== "closed") actions.appendChild(h("button", { type: "button", class: "btn", text: "fechar", onclick: function () { resolve(it, "closed"); } }));
    actions.appendChild(h("button", { type: "button", class: "btn", style: "color:var(--muted)", text: "próximo ↓", onclick: function () { var i = fb.items.indexOf(it); if (fb.items.length > 1) { fb.sel = fb.items[(i + 1) % fb.items.length].id; renderFila(true); } } }));
    wrap.appendChild(actions);
    pane.appendChild(wrap);
  }
  function ageText(iso) {
    var d = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
    if (!isFinite(d) || d < 0) return "";
    if (d === 0) return "conta criada hoje";
    if (d < 60) return "conta de " + fmt(d) + (d === 1 ? " dia" : " dias");
    return "conta de " + fmt(Math.round(d / 30)) + " meses";
  }
  function agentSummary(ua) {
    if (!ua) return "";
    var b = "", o = "", m;
    if ((m = ua.match(/Electron\/(\d+)/))) b = "app desktop"; else if ((m = ua.match(/Edg\/(\d+)/))) b = "Edge " + m[1]; else if ((m = ua.match(/OPR\/(\d+)/))) b = "Opera " + m[1]; else if ((m = ua.match(/Firefox\/(\d+)/))) b = "Firefox " + m[1]; else if ((m = ua.match(/Chrome\/(\d+)/))) b = "Chrome " + m[1]; else if ((m = ua.match(/Version\/(\d+)[\d.]* .*Safari\//))) b = "Safari " + m[1];
    if (/iPhone|iPad/.test(ua)) o = "iOS"; else if (/Android/.test(ua)) o = "Android"; else if (/Windows NT/.test(ua)) o = "Windows"; else if (/Mac OS X/.test(ua)) o = "macOS"; else if (/Linux/.test(ua)) o = "Linux";
    return (b || "navegador") + (o ? " no " + o : "");
  }
  function ctxChips(c) {
    var box = h("div", { class: "ctx" });
    if (!c) { box.appendChild(h("span", { style: "color:var(--faint)", text: "sem contexto: enviado antes desta versão" })); return box; }
    var list = [];
    if (c.platform) list.push(["plataforma", { web: "web", desktop: "app desktop", ios: "iphone", android: "android" }[c.platform] || c.platform]);
    if (c.userAgent) list.push(["navegador", agentSummary(c.userAgent)]);
    if (c.appVersion) list.push(["versão", c.appVersion]);
    if (c.path) list.push(["tela", c.path]);
    if (c.viewport) list.push(["janela", c.viewport.replace("x", "×")]);
    if (c.locale) list.push(["idioma", c.locale]);
    if (c.voice) list.push(["chamada", c.voice.inCall ? ((c.voice.transport === "livekit" ? "servidor de mídia" : c.voice.transport === "mesh" ? "ponto a ponto" : "em chamada") + (c.voice.watchParty ? " · watch party ao vivo" : "")) : "fora de chamada"]);
    if (c.faroSessionId) list.push(["sessão faro", c.faroSessionId]);
    var anim = !reduceMotion;
    list.forEach(function (x, i) { box.appendChild(h("span", { class: anim ? "pop" : null, style: "animation-delay:" + (100 + i * 40) + "ms" }, [h("i", { text: x[0] }), x[1]])); });
    return box;
  }
  function resolve(it, status) {
    var fb = S.fb; if (fb.busy) return;
    fb.busy = true;
    var pane = $("fPane"); pane.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
    fetch("/operator/feedback-resolve", { method: "PUT", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: String(it.id), status: status }) })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function () {
        var el = document.querySelector('.item[data-id="' + it.id + '"]');
        if (el && !reduceMotion) el.classList.add("leaving");
        toast("#" + it.id + (status === "confirmed" ? (it.kind === "bug" ? " confirmado · o autor ganhou o selo caça-bugs" : " confirmado") : " fechado"));
        setTimeout(function () { fb.busy = false; loadFeedback(false); }, reduceMotion ? 0 : 300);
      })
      .catch(function (e) {
        fb.busy = false;
        pane.querySelectorAll("button").forEach(function (b) { b.disabled = false; });
        toast("não deu pra gravar: " + (e && e.message ? e.message : "erro"), true);
      });
  }
  function toast(text, bad) {
    var t = $("toast");
    $("toastText").textContent = text;
    t.classList.toggle("bad", !!bad);
    t.classList.add("on");
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () { t.classList.remove("on"); }, 4200);
  }

  // ---------------------------------------------------------------- SISTEMA
  function loadFlags() {
    fetchJson("/operator/flags").then(function (r) { S.flags = r; renderSistema(); }).catch(function (e) { S.flags = { _err: e && e.message ? e.message : "erro" }; renderSistema(); });
  }
  function renderSistema() {
    var m = S.metrics; if (!m) return;
    var comps = (S.health && S.health.components) || [];
    var hist = {};
    ((m.statusHistory || {}).components || []).forEach(function (c) { hist[c.key] = c; });
    var cl = m.cluster || {};
    $("sLede").textContent = "commit " + (m.version ? String(m.version).slice(0, 7) : "—") + " · " + fmt(m.instanceCount || cl.instances || 1) + (m.instanceCount === 1 ? " instância" : " instâncias") + " da api · disjuntor do banco " + ((m.runtime && m.runtime.db && m.runtime.db.breaker.state) === "closed" ? "fechado" : "aberto");
    var sv = clear($("sServices"));
    comps.forEach(function (c) {
      var hc = hist[c.key];
      var ms = hc ? hc.points.map(function (p) { return p.ms; }) : null;
      var st = { operational: "ok", degraded: "warn", down: "bad", disabled: "" }[c.state];
      sv.appendChild(h("div", { class: "rowlink svc", style: "display:grid;grid-template-columns:minmax(150px,1fr) 150px 70px 70px 80px 70px;gap:14px;cursor:default" }, [
        h("span", { style: "display:flex;align-items:center;gap:10px" }, [h("span", { class: "sev " + (st || "info"), style: st ? null : "background:var(--faint);box-shadow:none" }), h("b", { style: "font-size:14px", text: NAMES[c.key] || c.label })]),
        ms && ms.some(function (v) { return v != null; }) ? sparkline(ms.map(function (v) { return v == null ? 0 : v; }), "svc-" + c.key, st === "warn" ? "warn" : st === "bad" ? "bad" : "series") : h("span", { class: "foot", text: c.state === "disabled" ? "desligado" : "sem histórico" }),
        h("span", { class: "num", style: "text-align:right", text: c.latencyMs != null ? fmt(c.latencyMs) + " ms" : "—" }),
        h("span", { class: "num", style: "text-align:right;color:var(--muted)", text: hc && hc.p50 != null ? fmt(hc.p50) + " ms" : "—" }),
        h("span", { class: "num", style: "text-align:right;color:" + (c.uptime24h != null && c.uptime24h < 0.999 ? "var(--warn)" : "var(--ok)"), text: c.uptime24h != null ? M.dec(c.uptime24h * 100, 2) + "%" : "—" }),
        h("span", { class: "num", style: "text-align:right;color:var(--muted)", text: c.uptime7d != null ? M.dec(c.uptime7d * 100, 2) + "%" : "—" })
      ]));
    });
    if (!comps.length) sv.appendChild(h("p", { class: "empty", text: "sem leitura do /status.json" }));
    var cap = clear($("sCapacity"));
    var pool = (m.runtime && m.runtime.pool) || {};
    var blocks = function (on, total, cls) { var b = h("div", { class: "blocks " + (cls || "") }); for (var i = 0; i < total; i++) b.appendChild(h("i", { class: i < on ? "on" : null })); return b; };
    var busy = pool.busy != null ? pool.busy : (pool.total || 0) - (pool.idle || 0);
    var poolCls = pool.pressure === "saturated" ? "bad" : pool.pressure === "tight" ? "warn" : "";
    cap.appendChild(h("div", null, [h("div", { style: "display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px" }, [h("span", { text: "pool do postgres" }), h("span", { class: "num", text: fmt(busy) + " de " + fmt(pool.max) + " em uso · pico " + fmt(m.runtime.peakPoolBusy) + " · fila " + fmt(pool.waiting) })]), blocks(busy, pool.max || 0, poolCls), h("div", { class: "foot", style: "margin-top:6px", text: "desde " + stamp(m.runtime.peakTrackedSince) + " · " + (cl.instances > 1 ? "nesta instância; " + fmt(cl.poolBusy) + " de " + fmt(cl.poolMax) + " no total" : "uma instância") })]));
    var sockets = cl.sockets || m.runtime.sockets;
    cap.appendChild(h("div", null, [h("div", { style: "display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px" }, [h("span", { text: "conexões websocket" }), h("span", { class: "num", text: fmt(sockets) + " abertas · pico " + fmt(m.runtime.peakSockets) })]), blocks(Math.round(sockets / Math.max(1, Math.ceil(Math.max(sockets, m.runtime.peakSockets) / 30))), 30, "series"), h("div", { class: "foot", style: "margin-top:6px", text: M.fmtPct(M.pct(cl.compressedSockets || m.runtime.compressedSockets, sockets)) + " com compressão · cada bloco é 1/30 do pico" })]));
    var sfu = m.sfu || {};
    if (sfu.configured) cap.appendChild(h("div", null, [h("div", { style: "display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px" }, [h("span", { text: "servidor de mídia" }), h("span", { class: "num", text: fmt(sfu.rooms) + " salas · " + fmt(sfu.participants) + " pessoas · maior " + fmt(sfu.largestRoom) })]), blocks(Math.min(20, sfu.participants || 0), 20, ""), h("div", { class: "foot", style: "margin-top:6px", text: (sfu.reachable ? "responde em " + fmt(sfu.ms) + " ms" : "sem resposta") + " · " + (sfu.host || "") })]));
    // switches
    var sw = clear($("sSwitches"));
    var fl = S.flags;
    if (!fl) sw.appendChild(h("p", { class: "empty", text: "lendo os interruptores…" }));
    else if (fl._err) sw.appendChild(h("p", { class: "empty", text: "a leitura falhou · " + fl._err }));
    else {
      $("sFlagsAside").textContent = fmt(fl.flags.length) + " interruptores";
      fl.flags.forEach(function (f) {
        var src = f.stored ? "painel" : f.envSet ? "variável" : "padrão";
        var btn = h("button", { type: "button", class: "switch", role: "switch", "aria-checked": f.effective ? "true" : "false", "aria-label": f.key, disabled: S.flagBusy ? true : null, onclick: function () { writeFlag(f, !f.effective); } });
        sw.appendChild(h("div", { class: "rowlink", style: "cursor:default" }, [
          h("span", { class: "t" }, [h("b", { style: "font-size:13.5px", text: f.description }), h("span", { text: f.key + " · segue: " + src + (f.overrides && f.overrides.length ? " · " + f.overrides.length + " servidores com exceção" : "") })]),
          btn
        ]));
      });
    }
    // watch party
    var lh = m.liveHls || {}, wl = m.watchPartyWaitlist;
    clear($("sParty")).appendChild(h("div", { style: "display:flex;flex-direction:column" }, [
      ["ao vivo agora", lh.sessions ? fmt(lh.sessions) + (lh.sessions === 1 ? " transmissão" : " transmissões") : "nenhuma"],
      ["transmissão habilitada", lh.enabled ? (lh.configured ? "sim" : "sem configuração") : "desligada"],
      ["espectadores agora", lh.viewers && lh.viewers.here ? fmt(lh.viewers.here.viewersHere) : "—"],
      ["lista de espera", wl ? fmt(wl.serversWaiting) + " servidores esperando · " + fmt(wl.approvedTotal) + " aprovados" : "—"],
      ["reinícios esgotados", fmt(lh.restartsExhausted)]
    ].map(function (r) { return h("div", { style: "display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--line);font-size:14px" }, [h("span", { text: r[0] }), h("b", { class: "num", text: r[1] })]); })));
    $("sParty").appendChild(h("div", { style: "margin-top:12px" }, [classicLink("controles", "ligar por servidor, lista de espera e canais na visão clássica")]));
    sistemaDetails(m);
  }
  function writeFlag(f, enabled) {
    if (S.flagBusy) return;
    S.flagBusy = true;
    $("sSwitchMsg").textContent = "gravando…";
    fetch("/operator/flags", { method: "PUT", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: f.key, enabled: enabled }) })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (row) {
        S.flagBusy = false;
        $("sSwitchMsg").textContent = f.key + ": " + (row.effective ? "ligado" : "desligado") + " · vale em segundos nas instâncias";
        loadFlags();
      })
      .catch(function (e) { S.flagBusy = false; $("sSwitchMsg").textContent = "não deu pra gravar: " + (e && e.message ? e.message : "erro"); renderSistema(); });
  }
  function sistemaDetails(m) {
    var cl = m.cluster || {}, fl = S.flags, lh = m.liveHls || {}, rc = m.readCache || {};
    var audit = fl && fl.audit ? fl.audit : [];
    details($("sDetails"), "sd", "tudo que estava em “controles” e “infra”", [
      { id: "infra", title: "Infra e deploy", summary: "commit, instâncias e o que cada uma segura", openByDefault: true,
        body: [stats([["commit", m.version ? String(m.version).slice(0, 7) : "—", "gerado " + stamp(m.generatedAt)], ["instâncias", fmt(cl.instances || m.instanceCount), fmt(cl.reporting) + " reportando"], ["sockets no cluster", fmt(cl.sockets), fmt(cl.voiceParticipants) + " em voz"], ["cache de leitura", fmt(rc.hits), fmt(rc.misses) + " faltas · " + fmt(rc.coalesced) + " coalescidas"]])] },
      { id: "auditoria", title: "Quem mexeu nos interruptores", summary: audit.length ? "última mudança " + ago(audit[0].at) : "nenhuma mudança registrada",
        body: [audit.length ? table(["quando", "interruptor", "servidor", "de", "para", "quem"], audit.slice(0, 15).map(function (a) { var on = function (v) { return v == null ? "padrão" : v ? "ligado" : "desligado"; }; return [stamp(a.at), a.key, a.serverName || "global", on(a.previous), on(a.next), a.actorName || a.actorKind]; })) : para("Sem histórico de mudanças.")] },
      { id: "transmissao", title: "Transmissão da watch party", summary: fmt(lh.sessions) + " sessões · " + fmt(lh.startsTotal) + " inícios e " + fmt(lh.stopsTotal) + " fins desde o boot",
        body: [stats([["sessões", fmt(lh.sessions), "máximo " + fmt(lh.maxSessions)], ["sem avançar", fmt(lh.silentSessions), "precisa ser zero"], ["órfãs paradas", fmt(lh.orphansStopped), "precisa ser zero"], ["baixa latência", fmt(lh.llSessions), fmt(lh.llStartFailures) + " falhas ao iniciar"]])] },
      { id: "controles", title: "Watch party por servidor, lista de espera e canais", summary: "as escritas por servidor e canal continuam na visão clássica por enquanto",
        body: [para("Ligar a watch party por servidor, a baixa latência, aprovar ou recusar a lista de espera e fixar o caminho de mídia ou a região de um canal."), classicLink("controles", "abrir os controles na visão clássica")] }
    ]);
  }

  // ---------------------------------------------------------------- boot
  $("refresh").addEventListener("click", function () { S.occupancyAt = 0; refresh(); if (S.screen === "fila") loadFeedback(false); if (S.screen === "sistema") loadFlags(); if (S.screen === "hoje" || S.screen === "crescimento") loadActivity(true); });
  $("toClassic").addEventListener("click", function () { try { localStorage.setItem("pqp-admin-view", "classico"); } catch { /* storage blocked */ } });
  $("fMore").addEventListener("click", function () { if (!S.fb.loading) loadFeedback(true); });
  $("cRange").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-days]"); if (!b) return;
    var d = Number(b.getAttribute("data-days")); if (d === S.activityDays) return;
    S.activityDays = d; S.firstDraw["line:cChart:" + d] = false; loadActivity(true); renderCrescimento();
  });
  var resizeTimer;
  window.addEventListener("resize", function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(function () { renderScreen(S.screen); }, 150); });
  show(location.hash.slice(1) || "hoje");
  refresh();
  setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
})();
