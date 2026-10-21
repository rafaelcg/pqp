// A stand-in for the pqp page, just enough of the host side of the bridge (docs/APPS.md) to run Locadora's
// sandboxed frame: the app-hello / app-port handshake, files.pickLocal from a file input, assets.get with a
// hash check, ui.fullscreen, the device store (store.*, kept in a Map of THIS page, so it survives a reload of
// the frame the way the real host's IndexedDB does) and files.saveLocal. Every success carries the `type` of
// the request it answers, as the real host does (the SDK refuses a reply that does not echo it). It is test
// code: the real host is client/src/lib/apps/bridge-host.ts.
(function () {
  var q = new URLSearchParams(location.search);
  var FRAME_SRC = q.get("src");
  var locale = q.get("locale") || "pt-BR";
  var reduced = q.get("motion") === "reduce";
  var W = +q.get("w") || 640;
  var H = +q.get("h") || 560;
  // ?fs=real: ui.fullscreen really full-screens the iframe element, the way the pqp host does
  // (client/src/lib/apps/frame-controller.ts); anything else only records the request and says yes
  var realFullscreen = q.get("fs") === "real";

  // ?share=on: the platform says this server may share (D14's `shareAllowed`); anything else: it may not
  // ?share=nocall: it may, but the person is not in the call, so a request to start fails the way the real host's does
  var shareAllowed = q.get("share") === "on" || q.get("share") === "nocall";
  var shareNoCall = q.get("share") === "nocall";
  // ?role=spectator: the frame is a watcher's
  var role = q.get("role") === "spectator" ? "spectator" : "player";
  // ?store=off: a host that predates the device store (answers `invalid`); ?store=denied: one that refuses this app
  var storeMode = q.get("store") || "on";
  // ?welcome=1: forwarded to the frame's own address, where the app reads it (a replay on load, nothing stored)
  var welcome = q.get("welcome") === "1";
  function frameSrc(fallback) {
    var src = FRAME_SRC || fallback;
    return welcome ? src + (src.indexOf("?") < 0 ? "?" : "&") + "welcome=1" : src;
  }
  // ?seen=1: the first-visit walkthrough was already shown on this device
  var seen = q.get("seen") === "1";
  // ?cap=N: a device store that holds N bytes at most (the manifest's cap, lowered, to see a full disk)
  var capOverride = q.get("cap") ? +q.get("cap") : 0;
  // ?sync=computer|phone: Saves na conta is on, and this page is that kind of device (with an id of its own)
  var syncDevice = q.get("sync") === "computer" || q.get("sync") === "phone" ? q.get("sync") : null;
  var syncDeviceId = syncDevice ? "dev-" + syncDevice + "-0000000000000" : null;

  var H_ = (window.__h = {
    /** every request the frame sent over the port, as text, so a test can search it for a file name */
    requests: [],
    responsesBytes: 0,
    frameLoads: 0,
    wrongSource: 0,
    fullscreen: [],
    /** every share.request the frame made, and what the stand-in answered */
    shares: [],
    assetsServed: [],
    /** the device store: key -> { bytes: ArrayBuffer, meta: JSON | null, updatedAt } */
    store: new Map(),
    /** every store.* request type the frame made, in order */
    storeCalls: [],
    /** every files.saveLocal: { ext, size, bytes } */
    saved: [],
    /** every sync.* request type the frame made, in order */
    syncCalls: [],
  });
  if (seen && storeMode === "on") H_.store.set("seen:onboarding", { bytes: new Uint8Array([1]).buffer, meta: { at: 1 }, updatedAt: 1 });
  var STORE_KEY = /^[a-z0-9:._-]{1,128}$/;
  var storeUsed = function () {
    var total = 0;
    H_.store.forEach(function (row) { total += row.bytes.byteLength; });
    return total;
  };

  var spec = null;
  var port = null;
  var pending = null;

  var iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("allow", "");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.id = "app";
  iframe.width = W;
  iframe.height = H;
  iframe.addEventListener("load", function () { H_.frameLoads += 1; });

  var fileInput = document.getElementById("pick");
  fileInput.addEventListener("change", function () {
    var file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (pending && file) { var p = pending; pending = null; p(file); }
  });

  function hex(buffer) {
    return Array.from(new Uint8Array(buffer)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  async function fetchAsset(name) {
    var asset = spec.assets.find(function (a) { return a.name === name; });
    if (!asset) throw new Error("no such asset");
    var res = await fetch(spec.base + "/" + asset.path);
    if (!res.ok) throw new Error("asset fetch failed");
    var bytes = await res.arrayBuffer();
    var digest = hex(await crypto.subtle.digest("SHA-256", bytes));
    if (digest !== asset.sha256 || bytes.byteLength !== asset.bytes) throw new Error("hash mismatch");
    H_.assetsServed.push(name);
    return bytes;
  }

  // `m` is the request being answered: a success echoes its `type`. It is answered on the port it came in on, so a
  // reply that is still in flight when the frame is reloaded (`reloadFrame`) goes nowhere instead of throwing.
  function send(on, m, ok, payload, transfer) {
    if (!on) return;
    on.postMessage(ok ? { id: m.id, ok: true, type: m.type, result: payload } : { id: m.id, ok: false, error: payload }, transfer || []);
  }

  async function onRequest(m, mine) {
    function reply(request, ok, payload, transfer) { send(mine, request, ok, payload, transfer); }
    H_.requests.push(JSON.stringify(m, function (k, v) { return v instanceof ArrayBuffer ? "[bytes]" : v; }));
    try {
      switch (m.type) {
        case "participants.get":
          return reply(m, true, { participants: [
            { seatId: "seat-ana-aaaaaaaaaaaaaaaaa", displayName: "Ana", avatar: null, role: "player", isHost: true, connection: "present" },
            { seatId: "seat-bia-aaaaaaaaaaaaaaaaa", displayName: "Bia", avatar: null, role: "player", isHost: false, connection: "present" },
            { seatId: spec.self.seatId, displayName: "Eu", avatar: null, role: role, isHost: role === "player", connection: "present" },
          ] });
        case "state.get":
          return reply(m, true, { rev: 0, value: {} });
        case "files.pickLocal": {
          var file = await new Promise(function (resolve) { pending = resolve; window.__pickWaiting = true; });
          window.__pickWaiting = false;
          var dot = file.name.lastIndexOf(".");
          var ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
          if (spec.accept.indexOf(ext) < 0) return reply(m, false, "not-allowed");
          if (file.size > spec.maxBytes) return reply(m, false, "too-large");
          var bytes = await file.arrayBuffer();
          // what is sent back is exactly this: the bytes and the extension from the closed list, never the name
          H_.sentToFrame = { keys: ["bytes", "ext"], ext: ext, size: bytes.byteLength };
          return reply(m, true, { bytes: bytes, ext: ext }, [bytes]);
        }
        case "assets.get": {
          var data = await fetchAsset(m.name);
          return reply(m, true, { bytes: data }, [data]);
        }
        case "store.get":
        case "store.put":
        case "store.delete":
        case "store.list":
        case "store.usage": {
          H_.storeCalls.push(m.type);
          if (storeMode === "off") return reply(m, false, "invalid");
          if (storeMode === "denied") return reply(m, false, "not-allowed");
          var cap = capOverride || spec.storeCap || 0;
          var usage = function () { return { used: storeUsed(), cap: cap, persisted: true }; };
          if (m.type === "store.usage") return reply(m, true, usage());
          if (m.type === "store.list") {
            var rows = [];
            H_.store.forEach(function (row, key) {
              if (key.indexOf(m.prefix || "") === 0) rows.push({ key: key, size: row.bytes.byteLength, meta: row.meta, updatedAt: row.updatedAt });
            });
            rows.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
            return reply(m, true, rows.slice(0, 500));
          }
          if (!STORE_KEY.test(m.key || "")) return reply(m, false, "invalid");
          if (m.type === "store.get") {
            var found = H_.store.get(m.key);
            if (!found) return reply(m, true, null);
            var copy = found.bytes.slice(0);
            return reply(m, true, { bytes: copy, meta: found.meta }, [copy]);
          }
          if (m.type === "store.delete") {
            H_.store.delete(m.key);
            return reply(m, true, null);
          }
          var before = H_.store.get(m.key);
          var next = storeUsed() - (before ? before.bytes.byteLength : 0) + m.bytes.byteLength;
          if (next > cap) return reply(m, false, "too-large");
          H_.store.set(m.key, { bytes: m.bytes, meta: m.meta === undefined ? null : m.meta, updatedAt: Date.now() });
          return reply(m, true, { usage: usage() });
        }
        case "files.saveLocal": {
          if (spec.accept.indexOf(m.ext) < 0) return reply(m, false, "not-allowed");
          // the bytes are kept so a test can carry the file to another host page, as the person would
          H_.saved.push({ ext: m.ext, size: m.bytes.byteLength, bytes: m.bytes });
          return reply(m, true, null);
        }
        case "sync.status":
        case "sync.list":
        case "sync.get":
        case "sync.put":
        case "sync.delete":
        case "sync.restore":
        case "sync.clear": {
          // ?sync=computer|phone: Saves na conta, against the rig's stand-in account (shared by every page of the rig);
          // without it this host is one that predates sync and answers `invalid`, like any unknown request
          H_.syncCalls.push(m.type);
          if (!syncDevice) return reply(m, false, "invalid");
          var b64 = function (buffer) {
            var bytes = new Uint8Array(buffer);
            var text = "";
            for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
            return btoa(text);
          };
          var unb64 = function (text) {
            var raw = atob(text);
            var out = new Uint8Array(raw.length);
            for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
            return out.buffer;
          };
          var call = function (body) {
            return fetch("/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(function (r) { return r.json(); });
          };
          var answer;
          if (m.type === "sync.status") {
            answer = await call({ op: "status" });
            if (answer.ok) answer.result.device = syncDevice;
          } else if (m.type === "sync.list") {
            answer = await call({ op: "list", game: m.game, deviceId: syncDeviceId });
            if (answer.ok) answer.result = { entries: answer.result };
          } else if (m.type === "sync.get") {
            answer = await call({ op: "get", save: m.save });
            if (answer.ok) {
              var bytes = unb64(answer.result.bytes);
              var thumb = answer.result.thumb ? unb64(answer.result.thumb) : null;
              return reply(m, true, { rev: answer.result.rev, bytes: bytes, thumb: thumb }, thumb ? [bytes, thumb] : [bytes]);
            }
          } else if (m.type === "sync.put") {
            answer = await call({
              op: "put", game: m.game, kind: m.kind, slot: m.slot, baseRev: m.baseRev, bytes: b64(m.bytes),
              thumb: m.thumb ? b64(m.thumb) : null, platform: m.platform, core: m.core, coreVersion: m.coreVersion,
              deviceKind: syncDevice, deviceId: syncDeviceId,
            });
          } else if (m.type === "sync.delete") {
            answer = await call({ op: "delete", save: m.save });
          } else if (m.type === "sync.clear") {
            answer = await call({ op: "clear", game: m.game });
          } else {
            return reply(m, false, "not-allowed");
          }
          return answer.ok ? reply(m, true, answer.result) : reply(m, false, answer.error);
        }
        case "share.request":
          H_.shares.push({ on: m.on, allowed: shareAllowed });
          if (!shareAllowed) return reply(m, false, "not-allowed");
          if (shareNoCall && m.on) return reply(m, false, "unavailable");
          return reply(m, true, { on: m.on });
        case "ui.fullscreen":
          H_.fullscreen.push(m.on);
          if (realFullscreen) {
            if (m.on && document.fullscreenElement !== iframe) await iframe.requestFullscreen();
            if (!m.on && document.fullscreenElement === iframe) await document.exitFullscreen();
            return reply(m, true, { on: document.fullscreenElement === iframe });
          }
          return reply(m, true, { on: m.on });
        case "ui.resize":
          return reply(m, true, { height: m.height });
        case "session.end":
          return reply(m, true, null);
        default:
          return reply(m, false, "invalid");
      }
    } catch (error) {
      reply(m, false, "unavailable");
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== iframe.contentWindow) { H_.wrongSource += 1; return; }
    var d = event.data;
    if (d && d.pqp === "app-hello" && !port) {
      var channel = new MessageChannel();
      port = channel.port1;
      var mine = port;
      port.onmessage = function (e) { onRequest(e.data, mine); };
      event.source.postMessage({ pqp: "app-port", platformApi: 1 }, "*", [channel.port2]);
      port.postMessage({
        type: "hello",
        platformApi: 1,
        app: { id: "pqp-locadora", version: spec.version },
        locale: locale,
        theme: { "--color-accent": "#c8f55a", "--color-surface-0": "#14161c" },
        reducedMotion: reduced,
        self: { seatId: spec.self.seatId, role: role, isHost: role === "player" },
        connection: "online",
      });
    }
  });

  window.__h.end = function (reason) { port.postMessage({ type: "session.ended", reason: reason || "host" }); };
  // reloads the FRAME only: the device store (and everything else of this page) stays, as a reload of the app does
  window.__h.reloadFrame = function () {
    port = null;
    var next = iframe.cloneNode(false);
    next.addEventListener("load", function () { H_.frameLoads += 1; });
    iframe.replaceWith(next);
    iframe = next;
    iframe.src = frameSrc(spec.frame);
  };
  window.__h.setConnection =function (status) { port.postMessage({ type: "connection", status: status }); };

  fetch("/spec.json").then(function (r) { return r.json(); }).then(function (s) {
    spec = s;
    iframe.src = frameSrc(s.frame);
    document.getElementById("frame-holder").appendChild(iframe);
  });
})();
