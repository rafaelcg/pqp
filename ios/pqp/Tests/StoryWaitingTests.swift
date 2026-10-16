import XCTest
@testable import pqp

/// No connection is not a refusal: the ring waits and the post goes by itself
/// when the network is back (or the app is on screen again). Red is for the
/// server saying no, or for an automatic retry made with a network failing too.
@MainActor
final class StoryWaitingTests: XCTestCase {
    private typealias Backend = StoryPostQueueTests.FakeBackend
    private let storyId = "44444444-4444-4444-8444-444444444444"
    private let server = "33333333-3333-4333-8333-333333333333"

    private var root: URL!
    private var store: StoryPostStore!

    override func setUp() {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("story-wait-tests-\(UUID().uuidString)")
        store = StoryPostStore(root: root)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
    }

    final class FakeConnectivity: StoryConnectivity {
        var isSatisfied: Bool
        private var handler: (@MainActor () -> Void)?
        init(satisfied: Bool) { isSatisfied = satisfied }
        func onRestored(_ handler: @escaping @MainActor () -> Void) { self.handler = handler }
        /// The network comes back.
        func restore() {
            isSatisfied = true
            handler?()
        }
    }

    private func queue(_ backend: Backend, _ network: FakeConnectivity, waitRetry: Duration = .seconds(3600)) -> StoryPostQueue {
        StoryPostQueue(
            backend: backend, store: store, usesBackgroundTime: false,
            connectivity: network, waitRetry: waitRetry
        )
    }

    private func enqueue(_ posts: StoryPostQueue) throws -> String {
        try posts.enqueue(
            request: CreateStoryRequest(
                requestId: "req-1", kind: "image",
                audiences: StoryAudienceTargets(serverIds: [server], friends: false),
                media: StoryMediaInput(contentType: "image/jpeg", byteSize: 1000, width: 720, height: 1280)
            ),
            base: StoryPostBytes(contentType: "image/jpeg", data: Data(repeating: 7, count: 1000)),
            layers: [:], userId: "me"
        )
    }

    private func waitUntil(_ what: String, timeout: Double = 5, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { return XCTFail("Timed out waiting for \(what)") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    func testNoConnectionWaitsAndPostsByItselfWhenTheNetworkIsBack() async throws {
        let backend = Backend(storyId: storyId)
        backend.failNextCreates(1)
        let network = FakeConnectivity(satisfied: false)
        let posts = queue(backend, network)
        let id = try enqueue(posts)
        try await waitUntil("the job to wait") { posts.job(id: id)?.waiting == true }
        XCTAssertFalse(posts.job(id: id)?.failed ?? true, "Nothing is wrong with the story")
        XCTAssertNotNil(posts.job(for: .friends), "A waiting post shows on every strip, like a failed one")
        XCTAssertEqual(store.loadAll().count, 1, "Kept on disk meanwhile")

        // Back online, with nobody touching anything.
        network.restore()
        try await waitUntil("the post to go live") { posts.publishedCount == 1 }
        XCTAssertEqual(backend.snapshot().requests.map(\.requestId), ["req-1", "req-1"], "The same story, not a second one")
    }

    func testStillOfflineAnAppReturnDoesNotSpendTheRetry() async throws {
        let backend = Backend(storyId: storyId)
        backend.failNextCreates(1)
        let network = FakeConnectivity(satisfied: false)
        let posts = queue(backend, network)
        let id = try enqueue(posts)
        try await waitUntil("the job to wait") { posts.job(id: id)?.waiting == true }
        posts.retryWaiting()
        try await Task.sleep(for: .milliseconds(60))
        XCTAssertTrue(posts.job(id: id)?.waiting == true)
        XCTAssertEqual(backend.snapshot().requests.count, 1, "No request is made with no network")
    }

    /// The automatic retry had a network and still did not get through: now it
    /// is a failure to be shown, with Tentar de novo.
    func testAnAutomaticRetryThatFailsWithANetworkTurnsRed() async throws {
        let backend = Backend(storyId: storyId)
        backend.failNextCreates(2)
        let network = FakeConnectivity(satisfied: false)
        let posts = queue(backend, network)
        let id = try enqueue(posts)
        try await waitUntil("the job to wait") { posts.job(id: id)?.waiting == true }
        network.restore()
        try await waitUntil("the retry to fail") { posts.job(id: id)?.failed == true }
        XCTAssertEqual(posts.publishedCount, 0)
    }

    func testAServerRefusalIsRedAtOnce() async throws {
        let backend = Backend(storyId: storyId)
        backend.serverErrors(true)
        backend.failNextCreates(1)
        let posts = queue(backend, FakeConnectivity(satisfied: true))
        let id = try enqueue(posts)
        try await waitUntil("the job to fail") { posts.job(id: id)?.failed == true }
    }

    /// A miss with a network (the server is down for a minute) does not wait for
    /// a path change that never comes: a timer retries.
    func testAMissWithANetworkRetriesOnATimer() async throws {
        let backend = Backend(storyId: storyId)
        backend.failNextCreates(1)
        let posts = queue(backend, FakeConnectivity(satisfied: true), waitRetry: .milliseconds(40))
        let id = try enqueue(posts)
        try await waitUntil("the job to wait") { posts.job(id: id)?.waiting == true }
        try await waitUntil("the post to go live") { posts.publishedCount == 1 }
    }

    func testTentarDeNovoWorksFromWaiting() async throws {
        let backend = Backend(storyId: storyId)
        backend.failNextCreates(1)
        let posts = queue(backend, FakeConnectivity(satisfied: false))
        let id = try enqueue(posts)
        try await waitUntil("the job to wait") { posts.job(id: id)?.waiting == true }
        posts.retry(id)
        try await waitUntil("the post to go live") { posts.publishedCount == 1 }
    }

    func testWhatIsAConnectionProblemAndWhatIsNot() {
        XCTAssertTrue(StoryPostQueue.isConnectivity(APIError.transport("x")))
        XCTAssertTrue(StoryPostQueue.isConnectivity(URLError(.notConnectedToInternet)))
        XCTAssertFalse(StoryPostQueue.isConnectivity(APIError.server(status: 500, message: "x")))
        XCTAssertFalse(StoryPostQueue.isConnectivity(APIError.rateLimited(retryAfter: 5)))
        XCTAssertFalse(StoryPostQueue.isConnectivity(APIError.unauthorized))
    }
}
