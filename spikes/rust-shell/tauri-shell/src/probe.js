/* eslint-disable -- spike measurement code outside the workspace, see spikes/rust-shell/README.md */
// Injected at document start into the pqp page loaded by the Tauri spike. It
// reports to a collector on loopback (the bench script), because a remote
// origin gets no Tauri IPC and Playwright cannot drive WKWebView.
(function () {
  if (window.top !== window) return;
  var COLLECTOR = "__PQP_COLLECTOR__";
  var MARKER = "__PQP_MARKER__";
  var JOIN = "__PQP_JOIN__" === "1";
  function report(k, v) {
    try {
      fetch(COLLECTOR + "/r", {
        method: "POST",
        mode: "no-cors",
        body: JSON.stringify({ k: k, v: v === undefined ? null : v, t: Date.now() }),
      });
    } catch (e) {}
  }
  report("script", { href: location.href });

  function caps() {
    var md = navigator.mediaDevices;
    return {
      ua: navigator.userAgent,
      RTCPeerConnection: typeof RTCPeerConnection,
      getUserMedia: !!(md && md.getUserMedia),
      getDisplayMedia: !!(md && md.getDisplayMedia),
      MediaSource: typeof MediaSource,
      ManagedMediaSource: typeof window.ManagedMediaSource,
      AudioWorkletNode: typeof AudioWorkletNode,
      WebAssembly: typeof WebAssembly,
      serviceWorker: "serviceWorker" in navigator,
      Notification: typeof Notification,
      domNodes: document.getElementsByTagName("*").length,
      codecs:
        typeof RTCRtpSender !== "undefined" && RTCRtpSender.getCapabilities
          ? (RTCRtpSender.getCapabilities("video") || { codecs: [] }).codecs
              .map(function (c) { return c.mimeType; })
              .filter(function (m, i, a) { return a.indexOf(m) === i; })
          : null,
    };
  }

  // WebRTC with no permission involved: an oscillator sent from one peer
  // connection to another in the same page, and its level read back.
  async function rtcLoopback() {
    var ctx = new AudioContext();
    await ctx.resume();
    var osc = ctx.createOscillator();
    var dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    var a = new RTCPeerConnection();
    var b = new RTCPeerConnection();
    a.onicecandidate = function (e) { if (e.candidate) b.addIceCandidate(e.candidate); };
    b.onicecandidate = function (e) { if (e.candidate) a.addIceCandidate(e.candidate); };
    var dc = a.createDataChannel("x");
    var dcOpen = new Promise(function (r) { dc.onopen = function () { r(true); }; });
    var gotTrack = new Promise(function (r) { b.ontrack = function (e) { r(e.track); }; });
    dest.stream.getTracks().forEach(function (t) { a.addTrack(t, dest.stream); });
    var offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    var answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);
    var track = await Promise.race([gotTrack, new Promise(function (r) { setTimeout(function () { r(null); }, 5000); })]);
    var open = await Promise.race([dcOpen, new Promise(function (r) { setTimeout(function () { r(false); }, 5000); })]);
    await new Promise(function (r) { setTimeout(r, 2000); });
    var bytes = 0;
    var stats = await b.getStats();
    stats.forEach(function (s) { if (s.type === "inbound-rtp" && s.kind === "audio") bytes = s.bytesReceived; });
    a.close(); b.close(); ctx.close();
    return { connection: a.connectionState, remoteTrack: !!track, dataChannelOpen: open, inboundAudioBytes: bytes };
  }

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error("timeout")); }, ms); })]);
  }

  async function probe() {
    report("caps", caps());
    try { report("rtcLoopback", await rtcLoopback()); } catch (e) { report("rtcLoopback", { error: String(e) }); }
    try {
      var s = await withTimeout(navigator.mediaDevices.getUserMedia({ audio: true }), 8000);
      report("getUserMedia", { ok: true, tracks: s.getTracks().map(function (t) { return t.label; }) });
      s.getTracks().forEach(function (t) { t.stop(); });
    } catch (e) {
      report("getUserMedia", { ok: false, error: (e && e.name) + ": " + (e && e.message) });
    }
    try {
      // No user gesture here, so WebKit is expected to refuse; reported for the record.
      await withTimeout(navigator.mediaDevices.getDisplayMedia({ video: true }), 5000);
      report("getDisplayMediaNoGesture", { ok: true });
    } catch (e) {
      report("getDisplayMediaNoGesture", { ok: false, error: (e && e.name) + ": " + (e && e.message) });
    }
    if (JOIN) {
      var t0 = Date.now();
      var btn = Array.prototype.find.call(document.querySelectorAll("button"), function (b) {
        return /lobby/i.test(b.textContent || "");
      });
      if (btn) btn.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      var iv2 = setInterval(function () {
        var leave = document.querySelector('button[aria-label="Disconnect from voice"]');
        if (leave) { clearInterval(iv2); report("joined", { ms: Date.now() - t0 }); }
        if (Date.now() - t0 > 20000) { clearInterval(iv2); report("joined", { error: "timeout", text: document.body.textContent.slice(0, 300) }); }
      }, 16);
    }
  }

  // The same steps electron-bench.mjs drives through Playwright, run from
  // inside the page because nothing can drive WKWebView from outside. The
  // waits leave the collector time to sample memory and CPU between steps.
  var SCENARIO = "__PQP_SCENARIO__";
  var HEAVY_MARKER = "const x = 5000";
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function nextFrame() { return new Promise(function (r) { requestAnimationFrame(function () { r(); }); }); }
  function clickChannel(name) {
    var hit = Array.prototype.find.call(document.querySelectorAll("a, button"), function (e) {
      return (e.textContent || "").trim().indexOf(name) === 0 && !e.closest("main");
    });
    if (hit) hit.click();
    return !!hit;
  }
  async function switchTo(name, marker) {
    var t0 = Date.now();
    clickChannel(name);
    for (;;) {
      await nextFrame();
      var main = document.querySelector("main") || document.body;
      if (main.textContent.indexOf(marker) >= 0) return Date.now() - t0;
      if (Date.now() - t0 > 30000) return -1;
    }
  }
  function scroller() {
    var el = document.querySelector("article");
    el = el && el.parentElement;
    while (el && !(el.scrollHeight > el.clientHeight + 10 && getComputedStyle(el).overflowY !== "visible")) el = el.parentElement;
    return el;
  }
  async function loadHistory(target) {
    var t0 = Date.now();
    var pages = 0;
    for (; pages < 200; pages++) {
      var count = document.querySelectorAll("article").length;
      if (count >= target) break;
      var el = scroller();
      if (el) el.scrollTop = 0;
      var waited = 0;
      while (document.querySelectorAll("article").length <= count && waited < 5000) { await sleep(50); waited += 50; }
      if (waited >= 5000) break;
    }
    return { rows: document.querySelectorAll("article").length, pages: pages, ms: Date.now() - t0 };
  }
  async function sweep() {
    var el = scroller();
    if (!el) return null;
    el.scrollTop = 0;
    await nextFrame(); await nextFrame();
    var frames = [];
    var last = performance.now();
    for (;;) {
      await nextFrame();
      var now = performance.now();
      frames.push(now - last);
      last = now;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) break;
      el.scrollTop += 120;
    }
    frames.shift();
    var sorted = frames.slice().sort(function (a, b) { return a - b; });
    var pct = function (p) { return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10; };
    return { scrollHeight: el.scrollHeight, frames: frames.length, p50: pct(0.5), p95: pct(0.95), max: Math.round(sorted[sorted.length - 1] * 10) / 10, over33ms: frames.filter(function (f) { return f > 33.4; }).length };
  }
  function dom() { return { domNodes: document.getElementsByTagName("*").length, articles: document.querySelectorAll("article").length }; }
  async function full() {
    await sleep(45000); // collector: memory at +10 s, CPU over +10..+40 s
    var toHeavy = [], toLight = [];
    for (var i = 0; i < 5; i++) {
      toHeavy.push(await switchTo("off-topic", HEAVY_MARKER)); await sleep(500);
      toLight.push(await switchTo("general", MARKER)); await sleep(500);
    }
    report("switch", { toHeavy: toHeavy, toLight: toLight });
    await switchTo("off-topic", HEAVY_MARKER);
    await sleep(1000);
    report("sweepAt50", await sweep());
    var h = await loadHistory(2000);
    await sleep(2000);
    report("history", { load: h, dom: dom() }); // collector: memory now
    await sleep(5000);
    report("sweepAtHistory", await sweep());
    report("switchFromHeavyMs", await switchTo("general", MARKER));
    report("switchBackToHeavyMs", await switchTo("off-topic", HEAVY_MARKER));
    await switchTo("general", MARKER);
    await sleep(3000);
    report("leftHeavy", dom()); // collector: memory now, CPU over the next 30 s
    await sleep(35000);
    report("done");
  }

  var iv = setInterval(function () {
    if (document.body && document.body.textContent.indexOf(MARKER) >= 0) {
      clearInterval(iv);
      report("content");
      if (SCENARIO === "full") full();
      else setTimeout(probe, 1500);
    }
  }, 16);
})();
