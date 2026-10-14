import XCTest
@testable import pqp

/// Posting a story in the background: the composer hands it over and is gone,
/// the queue keeps it on disk, reports progress, and on a failure keeps the
/// draft until it is retried or discarded.
@MainActor
final class StoryPostQueueTests: XCTestCase {
    private let storyId = "44444444-4444-4444-8444-444444444444"
    private let server = "33333333-3333-4333-8333-333333333333"
    private let me = "55555555-5555-4555-8555-555555555555"

    private var root: URL!
    private var store: StoryPostStore!

    override func setUp() {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("story-post-tests-\(UUID().uuidString)")
        store = StoryPostStore(root: root)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: A scripted network

    /// A backend whose uploads wait until the test lets them go.
    final class FakeBackend: StoryPostBackend, @unchecked Sendable {
        private let lock = NSLock()
        private(set) var requests: [CreateStoryRequest] = []
        private(set) var published: [String] = []
        private(set) var deleted: [String] = []
        private(set) var putCount = 0
        private(set) var minted: [(kind: String, contentType: String, byteLength: Int)] = []
        private(set) var deletedUploads: [String] = []
        var failPuts = false
        var holdPuts = false
        var holdCreates = false
        var withUploads = true
        /// A create that names an upload is refused with this status.
        var refuseClaims: Int?
        private var refusals = 0
        let storyId: String

        init(storyId: String) { self.storyId = storyId }

        private func locked<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }

        func create(_ request: CreateStoryRequest) async throws -> CreateStoryResponse {
            locked { requests.append(request) }
            // Answers late, as a slow link does, and not even for a caller
            // that was cancelled meanwhile.
            while locked({ holdCreates }) {
                try? await Task.sleep(for: .milliseconds(10))
            }
            let claims = request.media?.uploadId != nil
                || (request.layers ?? []).contains { $0["upload"]?["uploadId"] != nil }
            if claims, let status = locked({ () -> Int? in
                guard let status = refuseClaims, refusals > 0 else { return nil }
                refusals -= 1
                return status
            }) {
                throw APIError.server(status: status, message: "claimed")
            }
            if claims {
                // Every file was uploaded ahead: nothing to hand back, and with
                // `publish` the story is answered live.
                let own = request.publish == true ? "live" : "pending"
                let json = """
                {"story":{"id":"\(storyId)","author":{"id":"u","displayName":"Bia","avatarUrl":null},"kind":"image","caption":null,"text":null,"background":null,
                 "media":null,"sticker":null,"call":null,"publishedAt":null,"expiresAt":null,"audiences":[],
                 "viewer":{"seen":false,"reaction":null,"canReply":false,"replyBlockedReason":null,"canModerate":[]},
                 "own":{"status":"\(own)","viewCount":0,"reactionCount":0,"replyCount":0,"repliesEnabled":true}},
                 "upload":null,"layerUploads":[]}
                """
                return try Coding.decoder.decode(CreateStoryResponse.self, from: Data(json.utf8))
            }
            let upload = withUploads
                ? #","upload":{"url":"https://store.test/base","method":"PUT","headers":{"Content-Type":"image/jpeg"}}"#
                : ""
            let layerUploads = withUploads && request.layers?.isEmpty == false
                ? #"[{"layerId":"L1","url":"https://store.test/layer","method":"PUT","headers":{}}]"#
                : "[]"
            let json = """
            {"story":{"id":"\(storyId)","author":{"id":"u","displayName":"Bia","avatarUrl":null},"kind":"image","caption":null,"text":null,"background":null,
             "media":null,"sticker":null,"call":null,"publishedAt":null,"expiresAt":null,"audiences":[],
             "viewer":{"seen":false,"reaction":null,"canReply":false,"replyBlockedReason":null,"canModerate":[]},"own":null}\(upload),
             "layerUploads":\(layerUploads)}
            """
            return try Coding.decoder.decode(CreateStoryResponse.self, from: Data(json.utf8))
        }

        func mintUpload(kind: String, contentType: String, byteLength: Int) async throws -> StoryUploadTicket {
            let n = locked { () -> Int in
                minted.append((kind, contentType, byteLength))
                return minted.count
            }
            return StoryUploadTicket(
                uploadId: "up-\(n)", url: "https://store.test/up-\(n)", method: "PUT",
                headers: ["Content-Type": contentType], expiresAt: nil
            )
        }

        func deleteUpload(id: String) async { locked { deletedUploads.append(id) } }

        func publish(storyId: String) async throws { locked { published.append(storyId) } }
        func delete(storyId: String) async { locked { deleted.append(storyId) } }

        func put(file: URL, to upload: StoryUpload, progress: @escaping @Sendable (Int64) -> Void) async throws {
            locked { putCount += 1 }
            let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
            progress(Int64(size / 2))
            while locked({ holdPuts }) {
                try await Task.sleep(for: .milliseconds(10))
            }
            if locked({ failPuts }) { throw APIError.transport("offline") }
            progress(Int64(size))
        }

        func set(fail: Bool? = nil, hold: Bool? = nil, holdCreate: Bool? = nil) {
            locked {
                if let fail { failPuts = fail }
                if let hold { holdPuts = hold }
                if let holdCreate { holdCreates = holdCreate }
            }
        }
        func snapshot() -> (requests: [CreateStoryRequest], published: [String], deleted: [String], puts: Int) {
            locked { (requests, published, deleted, putCount) }
        }
        func setRefuseClaims(_ status: Int?, times: Int = .max) { locked { refuseClaims = status; refusals = times } }
        func uploads() -> (minted: [(kind: String, contentType: String, byteLength: Int)], deleted: [String]) {
            locked { (minted: minted, deleted: deletedUploads) }
        }
    }

    private func queue(_ backend: FakeBackend) -> StoryPostQueue {
        StoryPostQueue(backend: backend, store: store, usesBackgroundTime: false)
    }

    private func photoRequest(layers: Bool = false) throws -> CreateStoryRequest {
        CreateStoryRequest(
            requestId: "req-1", kind: "image",
            audiences: StoryAudienceTargets(serverIds: [server], friends: false),
            media: StoryMediaInput(contentType: "image/jpeg", byteSize: 1000, width: 720, height: 1280),
            layers: layers ? [try JSONValue(encoding: ["id": "L1"])] : nil
        )
    }

    private func waitUntil(_ what: String, timeout: Double = 5, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { return XCTFail("Timed out waiting for \(what)") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    private let photo = StoryPostBytes(contentType: "image/jpeg", data: Data(repeating: 7, count: 1000))

    // MARK: - Tests

    /// The composer's whole part: enqueue returns with the job in the air and
    /// nothing awaited. The post is on disk before anything touches the network.
    func testEnqueueReturnsAtOnceAndKeepsThePostOnDisk() throws {
        let backend = FakeBackend(storyId: storyId)
        backend.set(hold: true)
        let posts = queue(backend)
        let id = try posts.enqueue(request: try photoRequest(), base: photo, layers: [:], userId: me)
        let job = try XCTUnwrap(posts.job(id: id))
        XCTAssertEqual(job.phase, .posting)
        XCTAssertEqual(store.loadAll().map(\.id), [id], "Kept on disk for a relaunch")
        XCTAssertEqual(store.loadAll().first?.base?.byteSize, 1000)
        XCTAssertTrue(posts.isPosting)
        posts.discard(id)
    }

    func testAPostGoesThroughCreatePutPublishAndLeavesNothingBehind() async throws {
        let backend = FakeBackend(storyId: storyId)
        let posts = queue(backend)
        try posts.enqueue(request: try photoRequest(), base: photo, layers: [:], userId: me)
        try await waitUntil("the post to go live") { posts.publishedCount == 1 }
        let seen = backend.snapshot()
        XCTAssertEqual(seen.published, [storyId], "Published only after the bytes are up")
        XCTAssertEqual(seen.puts, 1)
        XCTAssertTrue(posts.jobs.isEmpty)
        XCTAssertTrue(store.loadAll().isEmpty, "The draft is gone once it posted")
    }

    func testEveryFileOfAPostIsUploadedBeforeItIsPublished() async throws {
        let backend = FakeBackend(storyId: storyId)
        let posts = queue(backend)
        let layer = StoryPostBytes(contentType: "image/png", data: Data(repeating: 9, count: 500))
        try posts.enqueue(request: try photoRequest(layers: true), base: photo, layers: ["L1": layer], userId: me)
        try await waitUntil("the post to go live") { posts.publishedCount == 1 }
        XCTAssertEqual(backend.snapshot().puts, 2, "The base photo and the placed photo")
    }

    func testATextStoryHasNothingToPublish() async throws {
        let backend = FakeBackend(storyId: storyId)
        backend.withUploads = false
        let posts = queue(backend)
        let request = CreateStoryRequest(
            kind: "text", text: "bora", background: "night",
            audiences: StoryAudienceTargets(serverIds: [server], friends: false)
        )
        try posts.enqueue(request: request, base: nil, layers: [:], userId: me)
        try await waitUntil("the post to go live") { posts.publishedCount == 1 }
        let seen = backend.snapshot()
        XCTAssertEqual(seen.published, [])
        XCTAssertEqual(seen.puts, 0)
    }

    func testProgressIsBytesSentOverBytesTotal() async throws {
        let backend = FakeBackend(storyId: storyId)
        backend.set(hold: true)
        let posts = queue(backend)
        let id = try posts.enqueue(request: try photoRequest(), base: photo, layers: [:], userId: me)
        // The fake reports half before it waits.
        try await waitUntil("half the bytes") { (posts.job(id: id)?.progress ?? 0) >= 0.49 }
        XCTAssertEqual(try XCTUnwrap(posts.job(id: id)).progress, 0.5, accuracy: 0.02)
        backend.set(hold: false)
        try await waitUntil("the post to go live") { posts.publishedCount == 1 }
    }

    /// Two files, one ring: the fraction is over both, and a file whose bytes
    /// are all handed over still counts for 90% until the server has answered.
    func testProgressCountsEveryFileAndHoldsBackUntilTheServerAnswers() {
        let progress = StoryPostProgress(fileSizes: [600, 400])
        XCTAssertEqual(try XCTUnwrap(progress.record(file: 0, sent: 300)), 0.3, accuracy: 0.0001)
        XCTAssertEqual(try XCTUnwrap(progress.record(file: 1, sent: 200)), 0.5, accuracy: 0.0001)
        XCTAssertNil(progress.record(file: 1, sent: 201), "Under a percent is not worth redrawing")
        XCTAssertEqual(try XCTUnwrap(progress.record(file: 0, sent: 600)), 0.741, accuracy: 0.0001)
        // Everything handed over, nothing confirmed: not full.
        XCTAssertEqual(try XCTUnwrap(progress.record(file: 1, sent: 400)), 0.9, accuracy: 0.0001)
        XCTAssertNil(progress.record(file: 1, sent: 400), "Already at its hold-back")
        XCTAssertEqual(try XCTUnwrap(progress.complete(file: 0)), 0.6 + 0.36, accuracy: 0.0001)
        XCTAssertEqual(try XCTUnwrap(progress.complete(file: 1)), 1, accuracy: 0.0001)
    }

    func testAFailedPostKeepsItsDraftAndRetryIsTheSameStory() async throws {
        let backend = FakeBackend(storyId: storyId)
        backend.set(fail: true)
        let posts = queue(backend)
        let id = try posts.enqueue(request: try photoRequest(), base: photo, layers: [:], userId: me)
        try await waitUntil("the failure") { posts.job(id: id)?.failed == true }
        XCTAssertEqual(posts.job(id: id)?.failureMessage, String(localized: "Couldn't reach pqp. Check your connection."))
        XCTAssertEqual(store.loadAll().count, 1, "Kept until it posts or is discarded")
        XCTAssertEqual(posts.publishedCount, 0)

        backend.set(fail: false)
        posts.retry(id)
        XCTAssertEqual(posts.job(id: id)?.phase, .posting)
        try await waitUntil("the retry to go live") { posts.publishedCount == 1 }
        let seen = backend.snapshot()
        XCTAssertEqual(seen.requests.map(\.requestId), ["req-1", "req-1"], "The same request id: the server answers the same story")
        XCTAssertTrue(store.loadAll().isEmpty)
    }

    func testDiscardingMidUploadStopsItAndDeletesWhatWasMinted() async throws {
        let backend = FakeBackend(storyId: storyId)
        backend.set(hold: true)
        let posts = queue(backend)
        let id = try posts.enqueue(request: try photoRequest(), base: photo, layers: [:], userId: me)
        try await waitUntil("the first bytes") { (posts.job(id: id)?.progress ?? 0) > 0 }
        posts.discard(id)
        XCTAssertNil(posts.job(id: id))
        XCTAssertTrue(store.loadAll().isEmpty)
        try await waitUntil("the minted story to be deleted") { backend.snapshot().deleted == [self.storyId] }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(backend.snapshot().published, [], "A discarded post is never published")
        XCTAssertEqual(posts.publishedCount, 0)
    }

    func testAPostLeftOnDiskComesBackFailedForItsOwnerOnly() throws {
        let backend = FakeBackend(storyId: storyId)
        _ = try store.create(id: "mine", userId: me, request: try photoRequest(), base: photo, layers: [:])
        _ = try store.create(id: "theirs", userId: "someone-else", request: try photoRequest(), base: photo, layers: [:])
        let posts = queue(backend)
        posts.restore(userId: me)
        XCTAssertEqual(posts.jobs.map(\.id), ["mine"])
        XCTAssertTrue(posts.jobs[0].failed, "Nothing is re-sent behind the person's back")
        // And a second restore does not duplicate it.
        posts.restore(userId: me)
        XCTAssertEqual(posts.jobs.count, 1)
    }

    func testSigningOutClearsTheDrafts() throws {
        let backend = FakeBackend(storyId: storyId)
        backend.set(hold: true)
        let posts = queue(backend)
        try posts.enqueue(request: try photoRequest(), base: photo, layers: [:], userId: me)
        posts.clear()
        XCTAssertTrue(posts.jobs.isEmpty)
        XCTAssertTrue(store.loadAll().isEmpty)
    }

    func testAVideoFileIsCopiedNotReadWhole() throws {
        let source = FileManager.default.temporaryDirectory.appendingPathComponent("clip-\(UUID().uuidString).mp4")
        try Data(repeating: 1, count: 4096).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        let record = try store.create(
            id: "clip", userId: me, request: try photoRequest(),
            base: StoryPostBytes(contentType: "video/mp4", fileURL: source), layers: [:]
        )
        // The composer deletes its own temp file right after enqueue.
        try FileManager.default.removeItem(at: source)
        let kept = store.fileURL(record, try XCTUnwrap(record.base))
        XCTAssertEqual(try Data(contentsOf: kept).count, 4096)
        XCTAssertEqual(record.base?.byteSize, 4096)
    }

    /// A phone's uplink is shared: three posts do not all start at once.
    func testOnlyTwoPostsRunAtOnceAndTheNextStartsWhenOneEnds() async throws {
        let backend = FakeBackend(storyId: storyId)
        backend.set(holdCreate: true)
        let posts = queue(backend)
        for _ in 0..<3 {
            try posts.enqueue(request: try photoRequest(), base: photo, layers: [:], userId: me)
        }
        try await waitUntil("two creates") { backend.snapshot().requests.count == 2 }
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertEqual(backend.snapshot().requests.count, 2, "The third waits for a slot")
        backend.set(holdCreate: false)
        try await waitUntil("all three to go live") { posts.publishedCount == 3 }
        XCTAssertEqual(backend.snapshot().requests.count, 3)
    }

    /// Discarded while the create was still in the air: the story it made
    /// has nobody holding its id, so it is deleted when the answer lands, and
    /// nothing is published or counted.
    func testADiscardDuringTheCreateDeletesWhatTheCreateMade() async throws {
        let backend = FakeBackend(storyId: storyId)
        backend.set(holdCreate: true)
        let posts = queue(backend)
        let id = try posts.enqueue(request: try photoRequest(), base: photo, layers: [:], userId: me)
        try await waitUntil("the create to be sent") { backend.snapshot().requests.count == 1 }
        posts.discard(id)
        backend.set(holdCreate: false)
        try await waitUntil("the minted story to be deleted") { backend.snapshot().deleted == [self.storyId] }
        XCTAssertEqual(backend.snapshot().published, [])
        XCTAssertEqual(posts.publishedCount, 0)
        XCTAssertEqual(backend.snapshot().puts, 0)
    }

    func testAPostIsShownOnTheStripsItIsGoingTo() throws {
        let backend = FakeBackend(storyId: storyId)
        backend.set(hold: true)
        let posts = queue(backend)
        let id = try posts.enqueue(request: try photoRequest(), base: photo, layers: [:], userId: me)
        XCTAssertNotNil(posts.job(for: .server(id: server, name: "QG")))
        XCTAssertNil(posts.job(for: .friends), "Not aimed at Amigos")
        XCTAssertNil(posts.job(for: .server(id: "other", name: "Outro")))
        posts.discard(id)
    }

    func testTheWireJSONOfALayerSurvivesTheDisk() throws {
        let layer = StoryLayer(content: .text(StoryTextData(text: "oi", font: .bold, color: .lime)))
        let value = try JSONValue(encoding: StoryLayerInput(layer: layer, upload: nil))
        let request = CreateStoryRequest(
            kind: "text", audiences: StoryAudienceTargets(serverIds: [], friends: true), layers: [value]
        )
        let again = try Coding.decoder.decode(CreateStoryRequest.self, from: Coding.encoder.encode(request))
        XCTAssertEqual(again.layers, [value])
        XCTAssertEqual(again.layers?.first?["type"]?.stringValue, "text")
    }
}
