// A stand-in for the pqp page, just enough of the host side of the bridge (docs/APPS.md) to run Locadora's
// sandboxed frame: the app-hello / app-port handshake, files.pickLocal from a file input, assets.get with a
// hash check, ui.fullscreen. It is test code: the real host is client/src/lib/apps/bridge-host.ts.
(function () {
  var q = new URLSearchParams(location.search);
  var FRAME_SRC = q.get("src");
  var locale = q.get("locale") || "pt-BR";
  var reduced = q.get("motion") === "reduce";
  var W = +q.get("w") || 640;
  var H = +q.get("h") || 560;

  var H_ = (window.__h = {
    /** every request the frame sent over the port, as text, so a test can search it for a file name */
    requests: [],
    responsesBytes: 0,
    frameLoads: 0,
    wrongSource: 0,
    fullscreen: [],
    assetsServed: [],
  });

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

  function reply(id, ok, payload, transfer) {
    port.postMessage(ok ? { id: id, ok: true, result: payload } : { id: id, ok: false, error: payload }, transfer || []);
  }

  async function onRequest(m) {
    H_.requests.push(JSON.stringify(m, function (k, v) { return v instanceof ArrayBuffer ? "[bytes]" : v; }));
    try {
      switch (m.type) {
        case "participants.get":
          return reply(m.id, true, { participants: [{ seatId: spec.self.seatId, displayName: "Ana", avatar: null, role: "player", isHost: true, connection: "present" }] });
        case "state.get":
          return reply(m.id, true, { rev: 0, value: {} });
        case "files.pickLocal": {
          var file = await new Promise(function (resolve) { pending = resolve; window.__pickWaiting = true; });
          window.__pickWaiting = false;
          var dot = file.name.lastIndexOf(".");
          var ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
          if (spec.accept.indexOf(ext) < 0) return reply(m.id, false, "not-allowed");
          if (file.size > spec.maxBytes) return reply(m.id, false, "too-large");
          var bytes = await file.arrayBuffer();
          // what is sent back is exactly this: the bytes and the extension from the closed list, never the name
          H_.sentToFrame = { keys: ["bytes", "ext"], ext: ext, size: bytes.byteLength };
          return reply(m.id, true, { bytes: bytes, ext: ext }, [bytes]);
        }
        case "assets.get": {
          var data = await fetchAsset(m.name);
          return reply(m.id, true, { bytes: data }, [data]);
        }
        case "ui.fullscreen":
          H_.fullscreen.push(m.on);
          return reply(m.id, true, { on: m.on });
        case "ui.resize":
          return reply(m.id, true, { height: m.height });
        case "session.end":
          return reply(m.id, true, null);
        default:
          return reply(m.id, false, "invalid");
      }
    } catch (error) {
      reply(m.id, false, "unavailable");
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== iframe.contentWindow) { H_.wrongSource += 1; return; }
    var d = event.data;
    if (d && d.pqp === "app-hello" && !port) {
      var channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = function (e) { onRequest(e.data); };
      event.source.postMessage({ pqp: "app-port", platformApi: 1 }, "*", [channel.port2]);
      port.postMessage({
        type: "hello",
        platformApi: 1,
        app: { id: "pqp-locadora", version: spec.version },
        locale: locale,
        theme: { "--color-accent": "#c8f55a", "--color-surface-0": "#14161c" },
        reducedMotion: reduced,
        self: spec.self,
        connection: "online",
      });
    }
  });

  window.__h.end = function (reason) { port.postMessage({ type: "session.ended", reason: reason || "host" }); };
  window.__h.setConnection = function (status) { port.postMessage({ type: "connection", status: status }); };

  fetch("/spec.json").then(function (r) { return r.json(); }).then(function (s) {
    spec = s;
    iframe.src = FRAME_SRC || s.frame;
    document.getElementById("frame-holder").appendChild(iframe);
  });
})();
