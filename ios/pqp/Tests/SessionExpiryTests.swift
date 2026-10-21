import XCTest
import ClerkKit
@testable import pqp

/// "Your session expired. Sign in again." used to appear all over the app while
/// Profile still offered "Sign out": every screen found out about a dead session
/// for itself, and nothing ever changed `phase`. These pin the single door that
/// replaced that: the HTTP layer's mapping, the idempotent handler, and a
/// sign-out that does not need the session it is ending.
final class SessionExpiryTests: XCTestCase {

    override func setUp() {
        super.setUp()
        StubAPI.reset()
    }

    // MARK: - Pure rules

    func testOnlyA401IsADeadSessionInTheProbe() {
        XCTAssertEqual(APIClient.classifyProbe(status: 401), .dead)
        XCTAssertEqual(APIClient.classifyProbe(status: 200), .alive)
        XCTAssertEqual(APIClient.classifyProbe(status: 204), .alive)
        // Not being able to tell is never a reason to sign somebody out.
        XCTAssertEqual(APIClient.classifyProbe(status: 500), .unknown)
        XCTAssertEqual(APIClient.classifyProbe(status: 503), .unknown)
        XCTAssertEqual(APIClient.classifyProbe(status: 429), .unknown)
        XCTAssertEqual(APIClient.classifyProbe(status: 403), .unknown)
    }

    func testEveryEndedClerkStatusIsTheSessionBeingOver() {
        XCTAssertTrue(ClerkSessionEnd.isOver(nil))
        // `replaced` is what single session mode does to the phone when the
        // same account signs in on the web.
        for ended: Session.SessionStatus in [.ended, .expired, .removed, .replaced, .revoked, .abandoned] {
            XCTAssertTrue(ClerkSessionEnd.isOver(ended), "\(ended)")
        }
        XCTAssertFalse(ClerkSessionEnd.isOver(.active))
        XCTAssertFalse(ClerkSessionEnd.isOver(.pending), "a sign-in waiting on a step is unfinished, not over")
        XCTAssertFalse(ClerkSessionEnd.isOver(.unknown("future_status")))
    }

    func testOnlySignedInPhasesHaveAnAccountToLose() {
        XCTAssertTrue(SessionPhase.ready.hasAccount)
        XCTAssertTrue(SessionPhase.ageGate.hasAccount)
        XCTAssertTrue(SessionPhase.blocked.hasAccount)
        XCTAssertFalse(SessionPhase.loading.hasAccount)
        XCTAssertFalse(SessionPhase.onboarding.hasAccount)
    }

    // MARK: - The HTTP layer

    func testA401ReachesTheHandlerAndStillThrowsUnauthorized() async {
        StubAPI.statusFor = { _, _ in 401 }
        let api = APIClient(tokenProvider: StubToken(), protocolClasses: [StubAPI.self])
        let told = Counter()
        await api.setUnauthorizedHandler { await told.bump() }

        do {
            let _: EmptyResponse = try await api.get("/api/anything")
            XCTFail("a 401 must throw")
        } catch {
            guard case APIError.unauthorized = error else {
                return XCTFail("expected .unauthorized, got \(error)")
            }
        }
        let count = await told.value
        XCTAssertEqual(count, 1)
    }

    func testOtherRefusalsDoNotTouchTheHandler() async {
        let api = APIClient(tokenProvider: StubToken(), protocolClasses: [StubAPI.self])
        let told = Counter()
        await api.setUnauthorizedHandler { await told.bump() }

        for status in [403, 404, 429, 500, 503] {
            StubAPI.statusFor = { _, _ in status }
            let _: EmptyResponse? = try? await api.get("/api/anything")
        }
        let count = await told.value
        XCTAssertEqual(count, 0)
    }

    func testTheProbeIsDeadOn401AliveOn200AndUnknownOn500() async {
        let api = APIClient(tokenProvider: StubToken(), protocolClasses: [StubAPI.self])
        StubAPI.statusFor = { _, _ in 401 }
        let dead = await api.probeSession()
        XCTAssertEqual(dead, .dead)
        StubAPI.statusFor = { _, _ in 200 }
        let alive = await api.probeSession()
        XCTAssertEqual(alive, .alive)
        StubAPI.statusFor = { _, _ in 500 }
        let unknown = await api.probeSession()
        XCTAssertEqual(unknown, .unknown)
    }

    func testNoSessionAtAllIsDeadWithoutAskingTheServer() async {
        let api = APIClient(tokenProvider: StubToken(refresh: .noSession), protocolClasses: [StubAPI.self])
        let verdict = await api.probeSession()
        XCTAssertEqual(verdict, .dead)
        XCTAssertEqual(StubAPI.count(path: "/api/me"), 0)
    }

    func testATokenThatCannotBeRefreshedOfflineIsUnknownNotDead() async {
        let api = APIClient(tokenProvider: StubToken(refresh: .unavailable), protocolClasses: [StubAPI.self])
        let verdict = await api.probeSession()
        XCTAssertEqual(verdict, .unknown)
    }

    func testAFailedCancelledRequestNeverReportsASessionDeath() async {
        // A 401 that arrives for a request begun before the session ended
        // belongs to the session that ended.
        StubAPI.statusFor = { _, _ in 401 }
        StubAPI.delay = 0.3
        let api = APIClient(tokenProvider: StubToken(), protocolClasses: [StubAPI.self])
        let told = Counter()
        await api.setUnauthorizedHandler { await told.bump() }

        async let request: EmptyResponse? = try? await api.get("/api/slow")
        try? await Task.sleep(for: .milliseconds(100))
        await api.cancelInFlight()
        _ = await request
        let count = await told.value
        XCTAssertEqual(count, 0)
    }

    func testARequestStillReadingItsTokenWhenTheSessionEndsNeverGoesOut() async {
        // Farol: the epoch must be read before the first suspension, or a
        // request that began under the old session resumes under the new one.
        StubAPI.statusFor = { _, _ in 401 }
        let api = APIClient(
            tokenProvider: StubToken(tokenDelay: .milliseconds(300)),
            protocolClasses: [StubAPI.self]
        )
        let told = Counter()
        await api.setUnauthorizedHandler { await told.bump() }

        async let request: Result<EmptyResponse, any Error> = {
            do { return .success(try await api.get("/api/late")) } catch { return .failure(error) }
        }()
        try? await Task.sleep(for: .milliseconds(100))
        await api.cancelInFlight()
        let outcome = await request

        guard case .failure(let error) = outcome else { return XCTFail("the old request must not complete") }
        XCTAssertTrue(error.isCancellation, "\(error)")
        XCTAssertEqual(StubAPI.count(path: "/api/late"), 0, "it never reached the network")
        let count = await told.value
        XCTAssertEqual(count, 0)
    }

    // MARK: - The handler

    @MainActor
    private func makeStore() async -> SessionStore {
        let provider = StubToken()
        let store = SessionStore(
            authMode: .devBypass,
            tokenProvider: provider,
            api: APIClient(tokenProvider: provider, protocolClasses: [StubAPI.self])
        )
        await store.installUnauthorizedHandler()
        store.seedPhaseForTesting(.ready)
        return store
    }

    @MainActor
    func testManyConcurrent401sMakeOneTransitionAndOneMessage() async {
        // Every route refuses, including the probe: the session is dead.
        StubAPI.statusFor = { _, _ in 401 }
        let store = await makeStore()
        let epochBefore = store.unreadEpoch

        await withTaskGroup(of: Void.self) { group in
            for i in 0..<30 {
                group.addTask {
                    let _: EmptyResponse? = try? await store.api.get("/api/things/\(i)")
                }
            }
        }
        // Let the handler tasks that were fired off finish.
        try? await Task.sleep(for: .milliseconds(300))

        XCTAssertEqual(store.phase, .onboarding, "the app goes to the sign-in screen")
        XCTAssertEqual(store.sessionNotice, SessionStore.sessionExpiredMessage)
        XCTAssertNil(store.lastError, "no second, alarming message beside the calm one")
        XCTAssertNil(store.currentUser)
        XCTAssertEqual(store.unreadEpoch, epochBefore + 1, "one teardown, not thirty")
        XCTAssertEqual(StubAPI.count(path: "/api/me"), 1, "one confirmation, however many 401s")
    }

    @MainActor
    func testAHandlerCalledTwiceInARowIsOneTransition() async {
        StubAPI.statusFor = { _, _ in 401 }
        let store = await makeStore()
        let epochBefore = store.unreadEpoch
        async let a: Void = store.handleSessionExpired()
        async let b: Void = store.handleSessionExpired()
        _ = await (a, b)
        await store.handleSessionExpired()
        XCTAssertEqual(store.unreadEpoch, epochBefore + 1)
        XCTAssertEqual(store.phase, .onboarding)
    }

    @MainActor
    func testAStaleTokenIsNotASignOut() async {
        // The route refused, but a freshly refreshed token works: one stale
        // token, not a dead session.
        StubAPI.statusFor = { path, _ in path == "/api/me" ? 200 : 401 }
        let store = await makeStore()
        let _: EmptyResponse? = try? await store.api.get("/api/things")
        try? await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(store.phase, .ready)
        XCTAssertNil(store.sessionNotice)
    }

    @MainActor
    func testOfflineIsNotASignOut() async {
        StubAPI.statusFor = { path, _ in path == "/api/me" ? 503 : 401 }
        let store = await makeStore()
        await store.handleSessionExpired()
        XCTAssertEqual(store.phase, .ready)
        XCTAssertNil(store.sessionNotice)
        // And the claim was released: a later, real death still gets through.
        StubAPI.statusFor = { _, _ in 401 }
        await store.handleSessionExpired()
        XCTAssertEqual(store.phase, .onboarding)
    }

    @MainActor
    func testTheHandlerDoesNothingWhenNobodyIsSignedIn() async {
        StubAPI.statusFor = { _, _ in 401 }
        let store = await makeStore()
        store.seedPhaseForTesting(.onboarding)
        await store.handleSessionExpired()
        XCTAssertNil(store.sessionNotice, "the sign-in screen does not scold somebody who was never in")
        XCTAssertEqual(StubAPI.count(path: "/api/me"), 0)
    }

    // MARK: - Sign out with a dead session

    @MainActor
    func testSignOutWorksWhenEveryRequestIsRefused() async {
        StubAPI.statusFor = { _, _ in 401 }
        let store = await makeStore()
        // A device token on file, so sign-out has a network step to attempt.
        await store.registerPushToken("abc123")

        let started = Date()
        await store.signOut()

        XCTAssertEqual(store.phase, .onboarding)
        XCTAssertNil(store.currentUser)
        XCTAssertNil(store.sessionNotice, "the person chose this; no 'expired' message")
        XCTAssertLessThan(Date().timeIntervalSince(started), 3, "a dead session must not make Sign out wait")
    }

    @MainActor
    func testSignOutStillWorksOffline() async {
        StubAPI.statusFor = { _, _ in 0 }
        StubAPI.fail = true
        let store = await makeStore()
        await store.signOut()
        XCTAssertEqual(store.phase, .onboarding)
    }
}

// MARK: - Doubles

private struct StubToken: TokenProviding {
    var refresh: TokenRefresh = .token("stub-token")
    var tokenDelay: Duration = .zero
    func currentToken() async -> String? {
        if tokenDelay > .zero { try? await Task.sleep(for: tokenDelay) }
        return "stub-token"
    }
    func refreshedToken() async -> TokenRefresh { refresh }
}

private actor Counter {
    private(set) var value = 0
    func bump() { value += 1 }
}

/// Stands in for the API. Static because `URLProtocol` is instantiated by the
/// loading system; every test resets it first.
final class StubAPI: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var statusFor: @Sendable (String, String) -> Int = { _, _ in 200 }
    nonisolated(unsafe) static var delay: TimeInterval = 0
    nonisolated(unsafe) static var fail = false
    nonisolated(unsafe) static var body = Data("{}".utf8)
    nonisolated(unsafe) private static var paths: [String: Int] = [:]
    private static let lock = NSLock()

    static func reset() {
        statusFor = { _, _ in 200 }
        delay = 0
        fail = false
        body = Data("{}".utf8)
        lock.lock(); paths = [:]; lock.unlock()
    }

    static func count(path: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return paths[path] ?? 0
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        let method = request.httpMethod ?? "GET"
        Self.lock.lock(); Self.paths[path, default: 0] += 1; Self.lock.unlock()
        let work = { [self] in
            if Self.fail {
                client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
                return
            }
            let status = Self.statusFor(path, method)
            let payload = status == 401 ? Data(#"{"error":"Unauthorized"}"#.utf8) : Self.body
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: payload)
            client?.urlProtocolDidFinishLoading(self)
        }
        if Self.delay > 0 {
            DispatchQueue.global().asyncAfter(deadline: .now() + Self.delay, execute: work)
        } else {
            work()
        }
    }

    override func stopLoading() {}
}
