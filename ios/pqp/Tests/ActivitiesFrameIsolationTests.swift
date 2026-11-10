import Network
import XCTest
import WebKit
@testable import pqp

/// The isolation of the frame, proven against a real `WKWebView` and a HOSTILE
/// page served by a throwaway local HTTP server standing in for the apps origin.
/// The page does what a malicious app would: look for the native message handler,
/// reach into its parent, read storage, open a window, and finally navigate its own
/// frame. What it can observe it reports with image beacons to the same server,
/// which is how this test sees the world from inside the sandbox.
///
/// (The bundle's own `Content-Security-Policy` header is the apps origin's job and
/// is covered by `client/e2e/app-frame/`; this server sends none, on purpose: the
/// claim here is about the HOST, so nothing the page can do may depend on the CSP.)
///
/// NO CLOCK DECIDES ANYTHING HERE. The first version had the page navigate itself from a
/// `setTimeout(1500)` and the test poll for 8 s. On a loaded CI runner the web view (which
/// is not in a window, so WebKit treats it as not visible) did not run that timer at all
/// for the whole 8 s, while the same page kept answering messages: the host was never
/// asked to stop a navigation, so no violation was reported and the test failed for a
/// reason that is not about the host. Now the test waits for the EVENTS (the server
/// seeing every probe, the violation callback) and the HOST tells the page to navigate by
/// a message on the port, which is delivered even when timers are throttled. The only
/// timeout left is a failsafe that turns a hang into a failure.
@MainActor
final class ActivitiesFrameIsolationTests: XCTestCase {
    final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false
        func first() -> Bool { lock.lock(); defer { lock.unlock() }; defer { done = true }; return !done }
    }

    final class Server: @unchecked Sendable {
        let listener: NWListener
        private let lock = NSLock()
        private var requests: [String] = []
        private var waiters: [(id: Int, predicate: @Sendable ([String]) -> Bool, continuation: CheckedContinuation<Void, Never>)] = []
        private var nextWaiter = 0
        var port: UInt16 { listener.port?.rawValue ?? 0 }
        let page: String

        init(page: String) throws {
            self.page = page
            listener = try NWListener(using: .tcp, on: .any)
        }

        func start() async {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let once = Once()
                listener.stateUpdateHandler = { state in
                    if case .ready = state, once.first() { continuation.resume() }
                }
                listener.newConnectionHandler = { [weak self] connection in self?.handle(connection) }
                listener.start(queue: .global())
            }
        }

        func seen() -> [String] { lock.lock(); defer { lock.unlock() }; return requests }

        /// Returns when `predicate` holds for the requests seen so far, woken by the
        /// request that makes it true: no polling and no clock.
        func waitUntil(_ predicate: @escaping @Sendable ([String]) -> Bool) async {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                lock.lock()
                if predicate(requests) {
                    lock.unlock()
                    continuation.resume()
                } else {
                    waiters.append((nextWaiter, predicate, continuation))
                    nextWaiter += 1
                    lock.unlock()
                }
            }
        }

        private func record(_ path: String) {
            lock.lock()
            requests.append(path)
            let ready = waiters.filter { $0.predicate(requests) }
            let ids = Set(ready.map(\.id))
            waiters.removeAll { ids.contains($0.id) }
            lock.unlock()
            for waiter in ready { waiter.continuation.resume() }
        }

        private func handle(_ connection: NWConnection) {
            connection.start(queue: .global())
            connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
                guard let self, let data, let text = String(data: data, encoding: .utf8),
                      let line = text.split(separator: "\r\n").first else { connection.cancel(); return }
                let path = line.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
                self.record(path)
                let isPage = path.hasPrefix("/app.html")
                let body = isPage ? self.page : "ok"
                let type = isPage ? "text/html; charset=utf-8" : "text/plain"
                let head = "HTTP/1.1 200 OK\r\nContent-Type: \(type)\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n"
                connection.send(content: Data((head + body).utf8), completion: .contentProcessed { _ in connection.cancel() })
            }
        }
    }

    static let hostile = """
    <!doctype html><html><body><script>
    function beacon(k, v) { new Image().src = "/report?" + k + "=" + encodeURIComponent(String(v)); }
    function attempt(k, f) { try { beacon(k, f()); } catch (e) { beacon(k, "threw"); } }
    attempt("handler", function () { return !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pqpApp); });
    attempt("parentdoc", function () { return typeof parent.document.body; });
    attempt("storage", function () { return typeof localStorage.getItem("x"); });
    attempt("cookie", function () { return document.cookie; });
    attempt("opener", function () { var w = window.open("/popup", "_blank"); return w === null ? "blocked" : "opened"; });
    attempt("toplocation", function () { top.location = "/top-navigated"; return "tried"; });
    // The handshake an app does, so the relay hands it a port.
    parent.postMessage({ pqp: "app-hello", platformApi: 1 }, "*");
    window.addEventListener("message", function (event) {
      if (event.data && event.data.pqp === "app-port") {
        beacon("port", event.ports.length);
        event.ports[0].onmessage = function (m) {
          // Last: leave the document the host gave this frame, when the HOST says so.
          if (m.data && m.data.type === "go") { location.href = "/navigated"; return; }
          beacon("hello", m.data && m.data.type);
        };
      }
    });
    </script></body></html>
    """

    /// Every probe the page reports before it is told to navigate.
    private static let probes = ["handler", "parentdoc", "storage", "cookie", "opener", "toplocation", "port", "hello"]

    func testAHostileAppCannotReachTheNativeHandlerItsParentStorageOrAnotherPage() async throws {
        let server = try Server(page: Self.hostile)
        await server.start()
        defer { server.listener.cancel() }
        let origin = "http://localhost:\(server.port)"
        let controller = try XCTUnwrap(AppFrameController(
            entry: "\(origin)/app.html", appsOrigin: origin, title: "Hostile",
            wrapperBase: URL(string: "http://localhost:5173")!
        ))

        let violated = expectation(description: "the host reports that the frame left its document")
        var violation: AppFrameController.Violation?
        var helloReceived = false
        controller.onViolation = {
            violation = $0
            violated.fulfill()
        }
        controller.onHello = {
            helloReceived = true
            controller.attachPort()
            // What the host says first, as the bridge would.
            controller.post(#"{"type":"hello","platformApi":1}"#)
        }
        controller.load(helloTimeout: 600)

        // 1. Wait for the EVENT: the server has seen every probe, the handshake and the
        //    host's hello reaching the page. A failsafe turns a hang into a failure.
        let probesSeen = expectation(description: "the page reported every probe")
        let keys = Self.probes
        let waiter = Task {
            await server.waitUntil { seen in
                keys.allSatisfy { key in seen.contains { $0.hasPrefix("/report?\(key)=") } }
            }
            probesSeen.fulfill()
        }
        await fulfillment(of: [probesSeen], timeout: 60)
        waiter.cancel()
        XCTAssertNil(violation, "nothing the page did before it was told to navigate may remove it")

        // 2. The host tells the page to leave its document. The message arrives even when
        //    the web view throttles timers; the navigation reaches the host's policy, which
        //    cancels it and removes the frame.
        controller.post(#"{"type":"go"}"#)
        await fulfillment(of: [violated], timeout: 60)

        let seen = server.seen()
        XCTAssertTrue(helloReceived, "an exact hello from the frame's own window is answered")
        XCTAssertEqual(violation, .frameNavigated, "the frame left its document: the host removes it")

        func report(_ key: String) -> String? {
            seen.first { $0.hasPrefix("/report?\(key)=") }.map { String($0.dropFirst("/report?\(key)=".count)) }
        }
        XCTAssertEqual(report("handler"), "false", "the native message handler is not visible to the app's world")
        XCTAssertEqual(report("parentdoc"), "threw", "an opaque origin cannot read its parent")
        XCTAssertEqual(report("storage"), "threw", "no storage")
        XCTAssertEqual(report("cookie"), "threw", "no cookies")
        XCTAssertEqual(report("opener"), "blocked", "no popups")
        XCTAssertEqual(report("port"), "1", "the handshake transfers exactly one port")
        // The policy decision precedes any request, so a cancelled navigation never leaves
        // the device; the violation above is raised from that very decision.
        XCTAssertFalse(seen.contains { $0.hasPrefix("/navigated") }, "a navigation of the frame never reaches the network")
        XCTAssertFalse(seen.contains { $0.hasPrefix("/top-navigated") }, "the app cannot navigate the wrapper")
        XCTAssertFalse(seen.contains { $0.hasPrefix("/popup") }, "no window was opened")
        controller.remove()
    }
}
