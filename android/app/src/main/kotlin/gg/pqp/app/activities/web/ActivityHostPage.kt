package gg.pqp.app.activities.web

import java.net.URI

/**
 * The page that frames an activity: the phone's counterpart of the page the web
 * client runs around `<iframe sandbox="allow-scripts">` (`frame-controller.ts`).
 *
 * WHY A WRAPPER AND NOT THE BUNDLE ON ITS OWN. The app SDK's `connect()` posts
 * `app-hello` to `window.parent` and accepts one `app-port` message from it, and
 * refuses at once when `parent === window` ("this page is not inside a pqp
 * frame"). A bundle loaded as the top document therefore cannot connect, and
 * faking `window.parent` from an injected script would hand the untrusted code
 * the page it runs in. So the bundle runs exactly as on the web: in a sandboxed
 * frame (no `allow-same-origin`: an opaque origin with no storage, no cookies,
 * no way to reach this page), under the bundle's own CSP, inside this page.
 *
 * WHAT THIS PAGE IS. The only first-party document in the web view, and a thin
 * one. It does the web host's handshake (the frame's `app-hello` is answered
 * only when `event.source` is the frame's own window, the only identity an
 * opaque origin has) and relays the message port between the frame and the
 * phone's [ActivityHostSession], where every message is validated, every cap
 * enforced and the token never is. Requests whose payloads are binary (the
 * device store, local files, saves, share sound) are answered here, `unavailable`
 * (a phone has none of them) or `not-allowed` (a phone cannot share a pane),
 * and never reach Kotlin.
 *
 * HOW THE PHONE TALKS TO IT. One `WebMessagePort`, handed over with
 * `WebView.postWebMessage` to the MAIN FRAME only: a sandboxed frame is not the
 * main frame and its origin is opaque, so it cannot receive the port, and there
 * is no `addJavascriptInterface` object (that one is injected into every frame,
 * the sandboxed one included). The page accepts the native port only from a
 * message whose source is null (the platform's own delivery); a message the
 * frame posts to its parent has the frame as its source and is ignored.
 *
 * Control messages in both directions are strings starting with `#`; everything
 * else going to the app is a JSON message for the app's port, and everything
 * coming from it is `{"k":"req","m":<request>}`.
 */
object ActivityHostPage {
    /** The origin the page claims, so the bundles' `frame-ancestors` (which list pqp's own origins) admit it. Nothing is fetched from it. */
    const val BASE_ORIGIN = "https://pqp.gg"

    /** Native to page: the frame's `app-hello` was answered with a port. */
    const val CONTROL_PORT = "#port"

    /** Page to native: the frame said hello (first one only). */
    const val CONTROL_HELLO = "#hello"

    /** Page to native: the frame loaded a second document, so it navigated itself. */
    const val CONTROL_NAVIGATED = "#navigated"

    /** Native to page: take the frame out (the session ended, or it misbehaved). */
    const val CONTROL_REMOVE = "#remove"

    /** The message the platform delivers the native port with. */
    const val NATIVE_HELLO = "pqp-native"

    /** `bridgeRequestIdSchema`-bearing request types the page answers itself, with the code to answer. */
    val ANSWERED_HERE: Map<String, String> = linkedMapOf(
        "assets.get" to "unavailable",
        "files.pickLocal" to "unavailable",
        "files.saveLocal" to "unavailable",
        "store.get" to "unavailable",
        "store.put" to "unavailable",
        "store.delete" to "unavailable",
        "store.list" to "unavailable",
        "store.usage" to "unavailable",
        "sync.status" to "unavailable",
        "sync.list" to "unavailable",
        "sync.get" to "unavailable",
        "sync.put" to "unavailable",
        "sync.delete" to "unavailable",
        "sync.restore" to "unavailable",
        "sync.clear" to "unavailable",
        "share.audio" to "not-allowed",
    )

    fun html(entryUrl: String, appsOrigin: String, nonce: String, title: String, background: String, debug: Boolean = false): String {
        val answered = ANSWERED_HERE.entries.joinToString(",") { "\"${it.key}\":\"${it.value}\"" }
        return """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-$nonce'; style-src 'nonce-$nonce'; frame-src ${attr(appsOrigin)}; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="$nonce">html,body{margin:0;height:100%;background:$background;overflow:hidden}iframe{position:fixed;top:0;left:0;display:block;border:0;width:100%;height:100%;background:$background}</style>
</head><body>
<script nonce="$nonce">
(function () {
  "use strict";
  var ANSWERED = {$answered};
  var iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("allow", "");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("title", ${js(title)});
  var nativePort = null;
  var appPort = null;
  var helloSeen = false;
  var loads = 0;
  function toNative(text) { if (nativePort) nativePort.postMessage(text); }
  function reply(id, error) { if (appPort) appPort.postMessage({ id: id, ok: false, error: error }); }

  function isHello(d) {
    if (!d || typeof d !== "object" || Array.isArray(d)) return false;
    var keys = Object.keys(d);
    if (keys.length !== 2 || d.pqp !== "app-hello") return false;
    return typeof d.platformApi === "number" && d.platformApi >= 1 && d.platformApi <= 1000 && Math.floor(d.platformApi) === d.platformApi;
  }

  var DEBUG = ${if (debug) "true" else "false"};
  function log() { if (DEBUG) console.log("host: " + Array.prototype.slice.call(arguments).join(" ")); }
  window.addEventListener("message", function (e) {
    log("message", String(e.source === iframe.contentWindow), String(e.source === null), JSON.stringify(e.data));
    if (e.source === iframe.contentWindow && iframe.contentWindow !== null) {
      // the only identity an opaque origin has is its window
      if (helloSeen || !isHello(e.data)) return;
      helloSeen = true;
      // the frame can be quicker than the phone's port: whichever comes second tells native
      if (nativePort) toNative("#hello");
      return;
    }
    // the platform's own delivery has no source; anything a frame posts to its parent has one
    if (e.source === null && e.data === "${NATIVE_HELLO}" && e.ports && e.ports.length === 1 && !nativePort) {
      nativePort = e.ports[0];
      nativePort.onmessage = onNative;
      if (helloSeen) toNative("#hello");
    }
  });

  function onNative(e) {
    var data = e.data;
    if (typeof data !== "string") return;
    if (data === "${CONTROL_PORT}") {
      if (appPort || !iframe.contentWindow) return;
      var channel = new MessageChannel();
      appPort = channel.port1;
      appPort.onmessage = onApp;
      // an opaque origin cannot be named as a target, so "*" (the receiver checks event.source)
      iframe.contentWindow.postMessage({ pqp: "app-port", platformApi: 1 }, "*", [channel.port2]);
      return;
    }
    if (data === "${CONTROL_REMOVE}") {
      if (appPort) { appPort.onmessage = null; appPort.close(); appPort = null; }
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      return;
    }
    if (data.charAt(0) === "#" || !appPort) return;
    try { appPort.postMessage(JSON.parse(data)); } catch (err) { /* a message the app cannot get is dropped */ }
  }

  function onApp(e) {
    var d = e.data;
    var id = d && typeof d === "object" && typeof d.id === "string" ? d.id : null;
    var type = d && typeof d === "object" && typeof d.type === "string" ? d.type : null;
    if (type !== null && id !== null && Object.prototype.hasOwnProperty.call(ANSWERED, type)) {
      reply(id, ANSWERED[type]);
      return;
    }
    var text;
    try { text = JSON.stringify({ k: "req", m: d }); } catch (err) { if (id) reply(id, "invalid"); return; }
    toNative(text);
  }

  iframe.addEventListener("load", function () {
    loads += 1;
    if (loads >= 2) {
      // it left the document it was given: it navigated itself
      toNative("#navigated");
      if (appPort) { appPort.onmessage = null; appPort.close(); appPort = null; }
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }
  });
  // src before the frame joins the page, so no about:blank load of its own is counted
  iframe.setAttribute("src", ${js(entryUrl)});
  document.body.appendChild(iframe);
})();
</script></body></html>"""
    }

    /**
     * Whether [url] is on [origin] (scheme, host and port): the only place a bundle or any
     * of its parts is fetched from. A prefix test would let `https://apps.example.evil` pass.
     */
    fun isOnOrigin(url: String, origin: String): Boolean = runCatching {
        val a = URI(url)
        val b = URI(origin)
        a.scheme.equals(b.scheme, ignoreCase = true) &&
            a.host.equals(b.host, ignoreCase = true) &&
            effectivePort(a) == effectivePort(b)
    }.getOrDefault(false)

    private fun effectivePort(uri: URI): Int = when {
        uri.port != -1 -> uri.port
        uri.scheme.equals("https", true) -> 443
        uri.scheme.equals("http", true) -> 80
        else -> -1
    }

    private fun attr(value: String): String = value.replace("\"", "").replace(";", "").replace(" ", "")

    /** A JavaScript string literal for [value], with no way out of it. */
    internal fun js(value: String): String {
        val out = StringBuilder("\"")
        for (c in value) {
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '<' -> out.append("\\u003c")
                c == '>' -> out.append("\\u003e")
                c == '&' -> out.append("\\u0026")
                c == ' ' -> out.append("\\u2028")
                c == ' ' -> out.append("\\u2029")
                c < ' ' -> out.append(String.format("\\u%04x", c.code))
                else -> out.append(c)
            }
        }
        return out.append('"').toString()
    }
}
