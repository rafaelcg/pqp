import SwiftUI
import WebKit

/// Runs one app bundle in a `WKWebView` under the same isolation the web client
/// gives it (docs/APPS.md "The frame host (web client)"):
///
/// - The app is an `<iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer">`
///   inside a tiny wrapper document: no `allow-same-origin` (an opaque origin: no
///   cookies, no storage, no way to reach the wrapper), no popups, no forms, no
///   top navigation. The bundle's own `Content-Security-Policy` header (no network,
///   `connect-src 'none'`, `frame-ancestors` listing pqp's origins) applies as it
///   does on the web, because the bundle is loaded from the apps origin with its
///   headers, not from disk and not rewritten.
/// - The wrapper document is loaded with the pqp web origin as its base URL, which
///   is what the bundle's `frame-ancestors` names. It has no cookies, no storage
///   (a non-persistent data store) and no script of its own: the only code in it
///   is the relay below, which runs in an ISOLATED content world, so the app's
///   own scripts cannot see it, call the native message handler or reach the
///   bridge port. The handler also refuses every message that is not from the
///   main frame.
/// - The relay does exactly what `frame-controller.ts` does: it answers the app's
///   `app-hello` only when it came from THIS frame's window (`event.source`, the
///   only identity an opaque origin has), hands over one end of a
///   `MessageChannel` and carries the port's messages to Swift as JSON text and
///   back. Swift (`AppBridge`) is the host: it validates, enforces the manifest
///   and talks to the session. The app never sees the auth token, a user id or
///   the socket: none of them exist in the webview.
/// - Navigation is decided natively. The wrapper loads once; the iframe loads its
///   entry URL once; a second load of the frame (it navigated itself: `location`,
///   `<meta refresh>`, an anchor click) is cancelled and the frame is removed
///   (`frame-navigated`, the web's rule). Popups are refused.
/// - No `hello` within 20 s: the frame is removed (`timeout`).
@MainActor
final class AppFrameController: NSObject {
    enum Violation: Equatable { case frameNavigated, timeout, loadFailed, processGone, badEntry }

    /// The wrapper's iframe id and the message handler name: nothing else in the
    /// document is addressable.
    private static let frameElementId = "pqp-app-frame"
    private static let handlerName = "pqpApp"

    let webView: WKWebView
    private let world = WKContentWorld.world(name: "pqpAppBridge")
    private let entryURL: URL
    private let wrapperBase: URL
    private let title: String

    /// The frame said hello: take it a seat's worth of state and call `attachPort()`.
    var onHello: (() -> Void)?
    /// One message from the app's port, as JSON text.
    var onMessage: ((String) -> Void)?
    var onViolation: ((Violation) -> Void)?

    private var mainLoaded = false
    private var frameLoads = 0
    private var helloTimer: Task<Void, Never>?
    private var removed = false
    private var helloReceived = false

    /// `entry` must be on `appsOrigin`; anything else is refused without a request.
    init?(entry: String, appsOrigin: String, title: String, wrapperBase: URL = AppFrameController.defaultWrapperBase) {
        guard let entryURL = URL(string: entry), let origin = URL(string: appsOrigin),
              AppFrameController.isOnOrigin(entryURL, origin: origin) else { return nil }
        self.entryURL = entryURL
        self.wrapperBase = wrapperBase
        self.title = title

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.suppressesIncrementalRendering = false
        let userContent = WKUserContentController()
        configuration.userContentController = userContent
        let webView = WKWebView(frame: .zero, configuration: configuration)
        self.webView = webView
        super.init()

        let script = WKUserScript(
            source: Self.relayScript, injectionTime: .atDocumentStart,
            forMainFrameOnly: true, in: world
        )
        userContent.addUserScript(script)
        // Registered in the relay's own world only: the app's scripts run in the
        // page world of ANOTHER document and cannot reach it either way.
        userContent.add(HandlerProxy(owner: self), contentWorld: world, name: Self.handlerName)

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = UIColor(Palette.ink)
        webView.scrollView.backgroundColor = UIColor(Palette.ink)
        #if DEBUG
        webView.isInspectable = true
        #endif
    }

    /// The pqp web origin the bundle's `frame-ancestors` names: the production
    /// site for a release build, the Vite dev server for a debug one.
    static var defaultWrapperBase: URL {
        #if DEBUG
        URL(string: "http://localhost:5173")!
        #else
        URL(string: "https://pqp.gg")!
        #endif
    }

    static func isOnOrigin(_ url: URL, origin: URL) -> Bool {
        guard let scheme = url.scheme, scheme == origin.scheme, let host = url.host, host == origin.host
        else { return false }
        let defaultPort = scheme == "https" ? 443 : 80
        return (url.port ?? defaultPort) == (origin.port ?? defaultPort)
    }

    func load(helloTimeout: TimeInterval = 20) {
        guard !removed else { return }
        webView.loadHTMLString(wrapperHTML, baseURL: wrapperBase)
        helloTimer?.cancel()
        helloTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(helloTimeout))
            guard !Task.isCancelled else { return }
            self?.remove(.timeout)
        }
    }

    /// Hands the frame one end of a fresh `MessageChannel`. Call after the seat
    /// exists: the `hello` that follows carries it.
    func attachPort() {
        guard !removed, !portAttached else { return }
        portAttached = true
        helloTimer?.cancel()
        run("window.__pqpBridge.attach()")
    }

    private var portAttached = false

    /// Posts one JSON text on the port.
    func post(_ json: String) {
        guard !removed, portAttached else { return }
        webView.callAsyncJavaScript(
            "window.__pqpBridge.post(text)", arguments: ["text": json], in: nil, in: world
        ) { _ in }
    }

    /// Takes the frame out and stops talking to it. Safe to call twice.
    func remove(_ violation: Violation? = nil) {
        guard !removed else { return }
        removed = true
        helloTimer?.cancel()
        helloTimer = nil
        if portAttached { run("window.__pqpBridge.close()") }
        // The iframe element goes (what the web does with `iframe.remove()`);
        // the wrapper is not navigated, because it may not be.
        run("var f = document.getElementById('\(Self.frameElementId)'); if (f) { f.remove(); }")
        webView.stopLoading()
        webView.configuration.userContentController.removeAllUserScripts()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: Self.handlerName, contentWorld: world)
        if let violation { onViolation?(violation) }
    }

    private func run(_ source: String) {
        webView.callAsyncJavaScript(source, arguments: [:], in: nil, in: world) { _ in }
    }

    // MARK: - The wrapper

    /// The whole document: one iframe and nothing else. Its own CSP allows no
    /// script of the page's world and frames only the apps origin.
    var wrapperHTML: String {
        let origin = entryURL.scheme.map { "\($0)://\(entryURL.host ?? "")\(entryURL.port.map { ":\($0)" } ?? "")" } ?? ""
        return """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src \(origin); style-src 'unsafe-inline'">
        <style>html,body{margin:0;height:100%;background:#091218;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style>
        </head><body>
        <iframe id="\(Self.frameElementId)" sandbox="allow-scripts" allow="" referrerpolicy="no-referrer" title="\(Self.escape(title))" src="\(Self.escape(entryURL.absoluteString))"></iframe>
        </body></html>
        """
    }

    private static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    /// The relay. Runs ONLY in the isolated world, in the main frame. No `hello`
    /// is answered unless it came from the iframe's own window and carries exactly
    /// `{ pqp: "app-hello", platformApi: <number> }` (`bridgeAppHelloSchema`).
    static let relayScript = """
    (function () {
      "use strict";
      var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(handlerName);
      if (!handler) return;
      var port = null;
      var answered = false;
      function tell(kind, payload) {
        handler.postMessage({ kind: kind, payload: payload === undefined ? null : payload });
      }
      function frameEl() { return document.getElementById("\(frameElementId)"); }
      window.addEventListener("message", function (event) {
        var el = frameEl();
        if (!el || !el.contentWindow || event.source !== el.contentWindow) return;
        if (answered) return;
        var data = event.data;
        if (!data || typeof data !== "object") return;
        var keys = Object.keys(data);
        if (keys.length !== 2 || data.pqp !== "app-hello") return;
        if (typeof data.platformApi !== "number" || data.platformApi < 1 || data.platformApi > 1000) return;
        answered = true;
        tell("hello");
      });
      function replacer(key, value) {
        if (value instanceof ArrayBuffer) return { "$bytes": value.byteLength };
        if (ArrayBuffer.isView(value)) return { "$bytes": value.byteLength };
        return value;
      }
      window.__pqpBridge = {
        attach: function () {
          var el = frameEl();
          if (!el || !el.contentWindow || port) return;
          var channel = new MessageChannel();
          port = channel.port1;
          port.onmessage = function (event) {
            var text;
            try { text = JSON.stringify(event.data, replacer); } catch (e) { return; }
            if (typeof text === "string") tell("message", text);
          };
          el.contentWindow.postMessage({ pqp: "app-port", platformApi: 1 }, "*", [channel.port2]);
        },
        post: function (text) {
          if (port) port.postMessage(JSON.parse(text));
        },
        close: function () {
          if (port) { port.onmessage = null; port.close(); port = null; }
        }
      };
    })();
    """

    // MARK: - Messages from the relay

    fileprivate func receive(kind: String, payload: Any?, isMainFrame: Bool) {
        guard isMainFrame, !removed else { return }
        switch kind {
        case "hello":
            guard !helloReceived else { return }
            helloReceived = true
            onHello?()
        case "message":
            if let text = payload as? String { onMessage?(text) }
        default:
            break
        }
    }
}

/// `WKUserContentController` retains its handler strongly; this keeps the
/// controller from being kept alive by the webview it owns.
private final class HandlerProxy: NSObject, WKScriptMessageHandler {
    weak var owner: AppFrameController?
    init(owner: AppFrameController) { self.owner = owner }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let body = message.body as? [String: Any]
        let kind = body?["kind"] as? String ?? ""
        let payload = body?["payload"]
        let isMain = message.frameInfo.isMainFrame
        Task { @MainActor [weak owner] in
            owner?.receive(kind: kind, payload: payload, isMainFrame: isMain)
        }
    }
}

extension AppFrameController: WKNavigationDelegate, WKUIDelegate {
    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        guard !removed else { return .cancel }
        let isMain = navigationAction.targetFrame?.isMainFrame ?? false
        if isMain {
            // The wrapper loads once. Nothing may take the main frame anywhere else.
            if !mainLoaded { mainLoaded = true; return .allow }
            return .cancel
        }
        // A new window (a popup, `target=_blank`) has no target frame.
        guard navigationAction.targetFrame != nil, let url = navigationAction.request.url else { return .cancel }
        frameLoads += 1
        if frameLoads == 1, url == entryURL { return .allow }
        // The frame left the document it was given: remove it, as the web does.
        Task { @MainActor [weak self] in self?.remove(.frameNavigated) }
        return .cancel
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        remove(.loadFailed)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        remove(.loadFailed)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        remove(.processGone)
    }

    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        nil
    }
}

/// The controller's webview, for SwiftUI.
struct AppFrameRepresentable: UIViewRepresentable {
    let controller: AppFrameController
    func makeUIView(context: Context) -> WKWebView { controller.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
