import XCTest
@testable import pqp

/// Uploading ahead of Post: a file goes up the moment it is final, Post claims
/// it by id in one request, and throwing a draft away deletes what went up.
@MainActor
final class StoryEagerUploadsTests: XCTestCase {
    private typealias Backend = StoryPostQueueTests.FakeBackend
    private let storyId = "44444444-4444-4444-8444-444444444444"
    private let server = "33333333-3333-4333-8333-333333333333"

    private var root: URL!
    private var store: StoryPostStore!

    override func setUp() {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("story-eager-tests-\(UUID().uuidString)")
        store = StoryPostStore(root: root)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
    }

    private func photoWant(_ byte: UInt8 = 7) -> StoryEagerWant {
        let data = Data(repeating: byte, count: 1000)
        return StoryEagerWant(
            key: StoryEagerWant.baseKey(), kind: "base", contentType: "image/jpeg", byteSize: 1000,
            fingerprint: StoryEagerWant.fingerprint(of: data), data: data
        )
    }

    private func layerWant(_ id: String = "L1", _ byte: UInt8 = 9) -> StoryEagerWant {
        let data = Data(repeating: byte, count: 500)
        return StoryEagerWant(
            key: StoryEagerWant.layerKey(id), kind: "layer", contentType: "image/png", byteSize: 500,
            fingerprint: StoryEagerWant.fingerprint(of: data), data: data
        )
    }

    private func request(layers: Bool = false) throws -> CreateStoryRequest {
        let layer = StoryLayer(id: "L1", content: .image(StoryLayerPicture(url: nil, width: 10, height: 10)))
        let input = StoryLayerInput(layer: layer, upload: StoryLayerUploadDeclaration(contentType: "image/png", byteSize: 500, width: 10, height: 10))
        return CreateStoryRequest(
            requestId: "req-1", kind: "image",
            audiences: StoryAudienceTargets(serverIds: [server], friends: false),
            media: StoryMediaInput(contentType: "image/jpeg", byteSize: 1000, width: 720, height: 1280),
            layers: layers ? [try JSONValue(encoding: input)] : nil
        )
    }

    private func waitUntil(_ what: String, timeout: Double = 5, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { return XCTFail("Timed out waiting for \(what)") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    private func settle(_ uploads: StoryEagerUploads) async {
        for file in uploads.files.values { _ = try? await file.task?.value }
    }

    // MARK: - Starting and abandoning

    func testAFileStartsUploadingTheMomentItIsFinal() async throws {
        let backend = Backend(storyId: storyId)
        let uploads = StoryEagerUploads(backend: backend, enabled: true)
        uploads.sync([photoWant(), layerWant()])
        await settle(uploads)
        let seen = backend.uploads()
        XCTAssertEqual(seen.minted.map(\.kind).sorted(), ["base", "layer"])
        XCTAssertEqual(backend.snapshot().puts, 2)
        XCTAssertNotNil(uploads.files[StoryEagerWant.baseKey()]?.uploadId)
    }

    func testSyncingTheSameFilesAgainStartsNothingNew() async throws {
        let backend = Backend(storyId: storyId)
        let uploads = StoryEagerUploads(backend: backend, enabled: true)
        uploads.sync([photoWant()])
        uploads.sync([photoWant()])
        await settle(uploads)
        XCTAssertEqual(backend.uploads().minted.count, 1)
    }

    func testARemovedPhotoIsAbortedAndDeleted() async throws {
        let backend = Backend(storyId: storyId)
        let uploads = StoryEagerUploads(backend: backend, enabled: true)
        uploads.sync([photoWant(), layerWant()])
        await settle(uploads)
        uploads.sync([photoWant()])
        try await waitUntil("the removed layer to be deleted") { backend.uploads().deleted == ["up-2"] }
        XCTAssertEqual(uploads.files.keys.sorted(), [StoryEagerWant.baseKey()])
    }

    func testAChangedFileIsReplaced() async throws {
        let backend = Backend(storyId: storyId)
        let uploads = StoryEagerUploads(backend: backend, enabled: true)
        uploads.sync([layerWant("L1", 1)])
        await settle(uploads)
        // The drawing was drawn on again: the old bytes go, the new ones go up.
        uploads.sync([layerWant("L1", 2)])
        await settle(uploads)
        try await waitUntil("the first to be deleted") { backend.uploads().deleted == ["up-1"] }
        XCTAssertEqual(backend.uploads().minted.count, 2)
    }

    func testDiscardingTheDraftDeletesEverythingThatWentUp() async throws {
        let backend = Backend(storyId: storyId)
        let uploads = StoryEagerUploads(backend: backend, enabled: true)
        uploads.sync([photoWant(), layerWant()])
        await settle(uploads)
        uploads.discardAll()
        try await waitUntil("both to be deleted") { Set(backend.uploads().deleted) == ["up-1", "up-2"] }
        XCTAssertTrue(uploads.files.isEmpty)
    }

    func testAnUploadStillInFlightWhenTheDraftIsThrownAwayIsStopped() async throws {
        let backend = Backend(storyId: storyId)
        backend.set(hold: true)
        let uploads = StoryEagerUploads(backend: backend, enabled: true)
        uploads.sync([photoWant()])
        try await waitUntil("the PUT to start") { backend.snapshot().puts == 1 }
        uploads.discardAll()
        try await waitUntil("it to be deleted") { backend.uploads().deleted == ["up-1"] }
        backend.set(hold: false)
    }

    func testNothingStartsWithoutServerSupport() async throws {
        let backend = Backend(storyId: storyId)
        let uploads = StoryEagerUploads(backend: backend, enabled: false)
        uploads.sync([photoWant(), layerWant()])
        XCTAssertTrue(uploads.files.isEmpty)
        XCTAssertEqual(backend.uploads().minted.count, 0)
    }

    // MARK: - Post claims them

    func testPostIsOneRequestThatClaimsTheUploadsAndPublishes() async throws {
        let backend = Backend(storyId: storyId)
        let uploads = StoryEagerUploads(backend: backend, enabled: true)
        uploads.sync([photoWant(), layerWant()])
        await settle(uploads)
        let putsBeforePost = backend.snapshot().puts
        let posts = StoryPostQueue(backend: backend, store: store, usesBackgroundTime: false)
        try posts.enqueue(
            request: try request(layers: true),
            base: StoryPostBytes(contentType: "image/jpeg", data: Data(repeating: 7, count: 1000)),
            layers: ["L1": StoryPostBytes(contentType: "image/png", data: Data(repeating: 9, count: 500))],
            userId: "me", eager: uploads
        )
        try await waitUntil("the post to go live") { posts.publishedCount == 1 }
        let seen = backend.snapshot()
        XCTAssertEqual(seen.puts, putsBeforePost, "Nothing is sent after Post: it was all up already")
        XCTAssertEqual(seen.requests.count, 1)
        let create = try XCTUnwrap(seen.requests.first)
        XCTAssertEqual(create.media?.uploadId, "up-1")
        XCTAssertEqual(create.layers?.first?["upload"]?["uploadId"]?.stringValue, "up-2")
        XCTAssertEqual(create.publish, true)
        XCTAssertEqual(seen.published, [], "Published by the create itself, not a second call")
        XCTAssertTrue(store.loadAll().isEmpty)
    }

    /// Post tapped while a file is still going up: the post waits for THAT
    /// upload instead of sending the file again.
    func testPostTakesOverAnUploadStillInFlight() async throws {
        let backend = Backend(storyId: storyId)
        backend.set(hold: true)
        let uploads = StoryEagerUploads(backend: backend, enabled: true)
        uploads.sync([photoWant()])
        try await waitUntil("the PUT to start") { backend.snapshot().puts == 1 }
        let posts = StoryPostQueue(backend: backend, store: store, usesBackgroundTime: false)
        let id = try posts.enqueue(
            request: try request(),
            base: StoryPostBytes(contentType: "image/jpeg", data: Data(repeating: 7, count: 1000)),
            layers: [:], userId: "me", eager: uploads
        )
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertEqual(posts.job(id: id)?.phase, .posting)
        XCTAssertEqual(backend.snapshot().requests.count, 0, "Nothing is created before the bytes are up")
        backend.set(hold: false)
        try await waitUntil("the post to go live") { posts.publishedCount == 1 }
        XCTAssertEqual(backend.snapshot().puts, 1, "The same upload, not a second one")
        XCTAssertEqual(backend.uploads().minted.count, 1)
    }

    func testAFileThatFellOverIsSentAgainWithThePost() async throws {
        let backend = Backend(storyId: storyId)
        backend.set(fail: true)
        let uploads = StoryEagerUploads(backend: backend, enabled: true)
        uploads.sync([photoWant()])
        await settle(uploads)
        try await waitUntil("the failed upload to be deleted") { backend.uploads().deleted == ["up-1"] }
        backend.set(fail: false)
        let posts = StoryPostQueue(backend: backend, store: store, usesBackgroundTime: false)
        try posts.enqueue(
            request: try request(),
            base: StoryPostBytes(contentType: "image/jpeg", data: Data(repeating: 7, count: 1000)),
            layers: [:], userId: "me", eager: uploads
        )
        try await waitUntil("the post to go live") { posts.publishedCount == 1 }
        XCTAssertEqual(backend.uploads().minted.count, 2, "A fresh upload at Post")
        XCTAssertEqual(backend.snapshot().requests.first?.media?.uploadId, "up-2")
    }

    func testWithoutServerSupportPostIsTheOldCreatePutPublish() async throws {
        let backend = Backend(storyId: storyId)
        let uploads = StoryEagerUploads(backend: backend, enabled: false)
        let posts = StoryPostQueue(backend: backend, store: store, usesBackgroundTime: false)
        try posts.enqueue(
            request: try request(),
            base: StoryPostBytes(contentType: "image/jpeg", data: Data(repeating: 7, count: 1000)),
            layers: [:], userId: "me", eager: uploads
        )
        try await waitUntil("the post to go live") { posts.publishedCount == 1 }
        let seen = backend.snapshot()
        XCTAssertNil(seen.requests.first?.publish)
        XCTAssertNil(seen.requests.first?.media?.uploadId)
        XCTAssertEqual(seen.published, [storyId])
        XCTAssertEqual(backend.uploads().minted.count, 0)
    }

    /// The server turned the claim down (an upload that expired, a mismatch):
    /// the post does not fail, it goes the old way.
    func testARefusedClaimFallsBackToTheOldWay() async throws {
        let backend = Backend(storyId: storyId)
        backend.setRefuseClaims(400)
        let uploads = StoryEagerUploads(backend: backend, enabled: true)
        uploads.sync([photoWant()])
        await settle(uploads)
        let posts = StoryPostQueue(backend: backend, store: store, usesBackgroundTime: false)
        try posts.enqueue(
            request: try request(),
            base: StoryPostBytes(contentType: "image/jpeg", data: Data(repeating: 7, count: 1000)),
            layers: [:], userId: "me", eager: uploads
        )
        try await waitUntil("the post to go live") { posts.publishedCount == 1 }
        let seen = backend.snapshot()
        XCTAssertEqual(seen.requests.count, 2)
        XCTAssertNil(seen.requests[1].media?.uploadId, "The second create names no upload")
        XCTAssertEqual(seen.published, [storyId])
        XCTAssertEqual(seen.puts, 2, "The eager one, then the file again on the URL the create returned")
        try await waitUntil("the unclaimed upload to be deleted") { backend.uploads().deleted.contains("up-1") }
    }

    /// 409: the object is not all there yet. The same create is sent again (same
    /// request id) and the post goes through on the one upload, no fallback.
    func testAClaimThatIsTooEarlyIsRetriedWithTheSameRequestId() async throws {
        let backend = Backend(storyId: storyId)
        backend.setRefuseClaims(409, times: 1)
        let uploads = StoryEagerUploads(backend: backend, enabled: true)
        uploads.sync([photoWant()])
        await settle(uploads)
        let posts = StoryPostQueue(backend: backend, store: store, usesBackgroundTime: false)
        try posts.enqueue(
            request: try request(),
            base: StoryPostBytes(contentType: "image/jpeg", data: Data(repeating: 7, count: 1000)),
            layers: [:], userId: "me", eager: uploads
        )
        try await waitUntil("the post to go live", timeout: 8) { posts.publishedCount == 1 }
        let seen = backend.snapshot()
        XCTAssertEqual(seen.requests.map(\.requestId), ["req-1", "req-1"])
        XCTAssertEqual(seen.requests.map { $0.media?.uploadId }, ["up-1", "up-1"])
        XCTAssertEqual(backend.uploads().minted.count, 1, "Not uploaded again")
        XCTAssertEqual(seen.puts, 1)
    }

    /// The create fails after the uploads are up: the job remembers them, so
    /// "Tentar de novo" claims the same uploads instead of sending the bytes
    /// again, and a discard would delete them.
    func testARetryAfterAFailedCreateReusesTheUploads() async throws {
        let backend = Backend(storyId: storyId)
        backend.failNextCreates(1)
        let uploads = StoryEagerUploads(backend: backend, enabled: true)
        uploads.sync([photoWant()])
        await settle(uploads)
        let posts = StoryPostQueue(backend: backend, store: store, usesBackgroundTime: false)
        let id = try posts.enqueue(
            request: try request(),
            base: StoryPostBytes(contentType: "image/jpeg", data: Data(repeating: 7, count: 1000)),
            layers: [:], userId: "me", eager: uploads
        )
        try await waitUntil("the failure") { posts.job(id: id)?.failed == true }
        XCTAssertEqual(posts.job(id: id)?.record.uploadIds, [StoryEagerWant.baseKey(): "up-1"])
        posts.retry(id)
        try await waitUntil("the retry to go live") { posts.publishedCount == 1 }
        XCTAssertEqual(backend.uploads().minted.count, 1, "Nothing was uploaded again")
        XCTAssertEqual(backend.snapshot().puts, 1)
        XCTAssertEqual(backend.snapshot().requests.last?.media?.uploadId, "up-1")
    }

    func testDiscardingAPostDeletesItsUploads() async throws {
        let backend = Backend(storyId: storyId)
        backend.set(hold: true)
        let uploads = StoryEagerUploads(backend: backend, enabled: true)
        uploads.sync([photoWant()])
        try await waitUntil("the PUT to start") { backend.snapshot().puts == 1 }
        let posts = StoryPostQueue(backend: backend, store: store, usesBackgroundTime: false)
        let id = try posts.enqueue(
            request: try request(),
            base: StoryPostBytes(contentType: "image/jpeg", data: Data(repeating: 7, count: 1000)),
            layers: [:], userId: "me", eager: uploads
        )
        posts.discard(id)
        try await waitUntil("the upload to be deleted") { backend.uploads().deleted == ["up-1"] }
        XCTAssertEqual(backend.snapshot().requests.count, 0)
        XCTAssertTrue(store.loadAll().isEmpty)
    }

    // MARK: - The wire

    func testClaimingNamesEveryFileAndPublishes() throws {
        let claimed = try request(layers: true).claiming([
            StoryEagerWant.baseKey(): "base-id", StoryEagerWant.layerKey("L1"): "layer-id",
        ])
        XCTAssertEqual(claimed.media?.uploadId, "base-id")
        XCTAssertEqual(claimed.layers?.first?["upload"]?["uploadId"]?.stringValue, "layer-id")
        XCTAssertEqual(claimed.publish, true)
        // And the declared type and size are untouched: the server checks the
        // stored object against exactly these.
        XCTAssertEqual(claimed.media?.byteSize, 1000)
        let json = try XCTUnwrap(String(data: try Coding.encoder.encode(claimed), encoding: .utf8))
        XCTAssertTrue(json.contains("\"publish\":true"))
        XCTAssertTrue(json.contains("\"uploadId\":\"base-id\""))
    }

    func testTheConfigKnowsWhetherTheServerOffersEagerUploads() throws {
        func config(_ tail: String) throws -> StoriesConfig {
            try Coding.decoder.decode(StoriesConfig.self, from: Data(
                (#"{"enabled":true,"friendsEnabled":false,"mediaEnabled":true,"videoEnabled":true,"maxVideoMs":30000,"maxBytes":100"# + tail + "}").utf8
            ))
        }
        XCTAssertFalse(try config("").eagerUploadsEnabled, "A server that predates it")
        XCTAssertTrue(try config(#","eagerUploads":true"#).eagerUploadsEnabled)
        XCTAssertFalse(try config(#","eagerUploads":false"#).eagerUploadsEnabled)
    }
}
