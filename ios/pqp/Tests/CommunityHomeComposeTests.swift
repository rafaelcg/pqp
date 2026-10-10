import XCTest
@testable import pqp

/// Who is offered the composer, what a draft needs, what goes on the wire, and
/// what the server's refusals turn into. The storage leg of an upload runs
/// against a stubbed session, so the PUT's headers and length are pinned
/// without a server.
final class CommunityHomeComposeTests: XCTestCase {
    private let on = CommunityHomeConfig(enabled: true, vipEnabled: false, mediaEnabled: true)

    private func snapshot(_ bits: UInt64) throws -> PermissionsSnapshot {
        let json = #"{"version":1,"server":"\#(bits)","channels":{}}"#
        return try JSONDecoder().decode(PermissionsSnapshot.self, from: Data(json.utf8))
    }

    // MARK: - Gating

    func testManageServerIsTheBitTheServerPublishesOn() {
        // `1n << 5n` in packages/shared/src/permissions.ts.
        XCTAssertEqual(PermissionBit.manageServer, 32)
    }

    func testManageServerIsOfferedTheComposer() throws {
        XCTAssertTrue(CommunityHomeComposeGate.canPost(config: on, permissions: try snapshot(PermissionBit.manageServer)))
    }

    func testAnOwnerOrAdministratorArrivesWithEveryBitAndIsOfferedItToo() throws {
        XCTAssertTrue(CommunityHomeComposeGate.canPost(config: on, permissions: try snapshot(UInt64.max)))
    }

    func testAMemberWithoutManageServerIsNotWhateverElseTheyHold() throws {
        XCTAssertFalse(CommunityHomeComposeGate.canPost(config: on, permissions: try snapshot(PermissionBit.startWatchParty)))
        XCTAssertFalse(CommunityHomeComposeGate.canPost(config: on, permissions: try snapshot(0)))
        // The neighbouring bits are different permissions, not near misses.
        XCTAssertFalse(CommunityHomeComposeGate.canPost(config: on, permissions: try snapshot((1 << 4) | (1 << 6))))
    }

    func testASnapshotThatNeverArrivedFailsClosed() {
        XCTAssertFalse(CommunityHomeComposeGate.canPost(config: on, permissions: nil))
    }

    func testAnUnreadableBitfieldFailsClosed() throws {
        let json = #"{"version":1,"server":"nope","channels":{}}"#
        let bad = try JSONDecoder().decode(PermissionsSnapshot.self, from: Data(json.utf8))
        XCTAssertFalse(CommunityHomeComposeGate.canPost(config: on, permissions: bad))
    }

    func testNothingIsOfferedWhileTheBauIsOffEvenToStaff() throws {
        XCTAssertFalse(CommunityHomeComposeGate.canPost(config: .off, permissions: try snapshot(PermissionBit.manageServer)))
    }

    func testFilesNeedStorageAndLinksDoNot() {
        XCTAssertTrue(CommunityHomeComposeGate.canAttachFiles(config: on))
        XCTAssertFalse(CommunityHomeComposeGate.canAttachFiles(
            config: CommunityHomeConfig(enabled: true, vipEnabled: false, mediaEnabled: false)
        ))
    }

    // MARK: - The draft

    private let file = ComposeMedia(
        filename: "clip.mp4", contentType: "video/mp4", byteSize: 1000, isVideo: true, uploadId: "up-1"
    )

    func testAPostNeedsATitle() {
        XCTAssertEqual(ComposeDraft(body: "hi").problem, .needsTitle)
        XCTAssertEqual(ComposeDraft(title: "   ", body: "hi").problem, .needsTitle)
    }

    func testATitleAloneIsNotAPost() {
        XCTAssertEqual(ComposeDraft(title: "Hello").problem, .needsContent)
    }

    func testTextAFileOrALinkEachMakeAPost() {
        XCTAssertNil(ComposeDraft(title: "t", body: "words").problem)
        XCTAssertNil(ComposeDraft(title: "t", media: file).problem)
        XCTAssertNil(ComposeDraft(title: "t", link: "https://youtu.be/dQw4w9WgXcQ").problem)
    }

    func testTheLimitsAreTheServers() {
        XCTAssertNil(ComposeDraft(title: String(repeating: "a", count: 200), body: "x").problem)
        XCTAssertEqual(ComposeDraft(title: String(repeating: "a", count: 201), body: "x").problem, .titleTooLong)
        XCTAssertEqual(ComposeDraft(title: "t", body: String(repeating: "a", count: 4001)).problem, .bodyTooLong)
    }

    func testLengthsAreCountedInUTF16LikeTheServer() {
        // 101 emoji is 101 characters to Swift and 202 to the server's `max(200)`.
        XCTAssertEqual(
            ComposeDraft(title: String(repeating: "\u{1F600}", count: 101), body: "x").problem,
            .titleTooLong
        )
        XCTAssertNil(ComposeDraft(title: String(repeating: "\u{1F600}", count: 100), body: "x").problem)
    }

    func testAFileAndALinkTogetherAreRefusedBeforeTheServerHasTo() {
        let draft = ComposeDraft(title: "t", link: "https://youtu.be/dQw4w9WgXcQ", media: file)
        XCTAssertEqual(draft.problem, .oneMediaSource)
        XCTAssertNil(draft.request)
    }

    func testALinkThatIsPlainlyNotOneOfTheFourProvidersIsRefused() {
        XCTAssertEqual(ComposeDraft(title: "t", link: "hello there").problem, .badLink)
        XCTAssertEqual(ComposeDraft(title: "t", link: "https://example.com/x").problem, .badLink)
        XCTAssertEqual(ComposeDraft(title: "t", link: "javascript:alert(1)").problem, .badLink)
    }

    func testAPostNeverGoesOutAheadOfItsFile() {
        var uploading = file
        uploading.uploadId = nil
        uploading.uploading = true
        XCTAssertEqual(ComposeDraft(title: "t", media: uploading).problem, .fileStillUploading)
        var failed = file
        failed.uploadId = nil
        failed.failed = true
        XCTAssertEqual(ComposeDraft(title: "t", media: failed).problem, .fileFailed)
    }

    // MARK: - Wire

    private func json(_ request: some Encodable) throws -> [String: Any] {
        let data = try Coding.encoder.encode(request)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testTheRequestIsPublishedFreeTrimmedAndCarriesOneMediaSource() throws {
        let withFile = try XCTUnwrap(ComposeDraft(title: "  Hello ", body: " words ", media: file).request)
        let sent = try json(withFile)
        // `draft` is the server's default; a request that omitted this would
        // save a post that never appears in the feed.
        XCTAssertEqual(sent["status"] as? String, "published")
        XCTAssertEqual(sent["visibility"] as? String, "free")
        XCTAssertEqual(sent["commentsEnabled"] as? Bool, true)
        XCTAssertEqual(sent["title"] as? String, "Hello")
        XCTAssertEqual(sent["body"] as? String, "words")
        XCTAssertEqual(sent["mediaUploadId"] as? String, "up-1")
        XCTAssertNil(sent["youtubeUrl"])
    }

    func testALinkRidesAsYoutubeUrlTheOneFieldAllFourProvidersShare() throws {
        let request = try XCTUnwrap(ComposeDraft(title: "t", link: " https://youtu.be/dQw4w9WgXcQ ").request)
        let sent = try json(request)
        XCTAssertEqual(sent["youtubeUrl"] as? String, "https://youtu.be/dQw4w9WgXcQ")
        XCTAssertNil(sent["mediaUploadId"])
        XCTAssertNil(sent["body"])
    }

    func testTheMintCarriesTheSignedTypeAndLength() throws {
        let sent = try json(CommunityHomeMediaMintRequest(contentType: "video/mp4", byteSize: 5000, filename: "clip.mp4"))
        XCTAssertEqual(sent["contentType"] as? String, "video/mp4")
        XCTAssertEqual(sent["byteSize"] as? Int, 5000)
        XCTAssertEqual(sent["filename"] as? String, "clip.mp4")
    }

    // MARK: - Links

    func testProvidersAreNamedByHostNotByGuessworkAboutPaths() {
        XCTAssertEqual(CommunityHomeLinks.provider("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), .youtube)
        XCTAssertEqual(CommunityHomeLinks.provider("https://youtu.be/dQw4w9WgXcQ"), .youtube)
        XCTAssertEqual(CommunityHomeLinks.provider("https://www.twitch.tv/somebody"), .twitch)
        XCTAssertEqual(CommunityHomeLinks.provider("https://www.tiktok.com/@a/video/123"), .tiktok)
        XCTAssertEqual(CommunityHomeLinks.provider("https://www.instagram.com/p/abc/"), .instagram)
        XCTAssertNil(CommunityHomeLinks.provider("https://notyoutube.com/watch?v=x"))
        XCTAssertNil(CommunityHomeLinks.provider("https://evil.com/youtube.com"))
        XCTAssertNil(CommunityHomeLinks.provider("youtube.com/watch?v=dQw4w9WgXcQ"))
        XCTAssertNil(CommunityHomeLinks.provider(""))
    }

    func testOnlyAYoutubeLinkHasAThumbnail() {
        XCTAssertEqual(
            CommunityHomeLinks.youtubeThumbnail("https://youtu.be/dQw4w9WgXcQ")?.absoluteString,
            "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
        )
        XCTAssertEqual(
            CommunityHomeLinks.youtubeThumbnail("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3")?.absoluteString,
            "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
        )
        XCTAssertNil(CommunityHomeLinks.youtubeThumbnail("https://www.twitch.tv/somebody"))
        XCTAssertNil(CommunityHomeLinks.youtubeThumbnail("https://www.youtube.com/watch?v=short"))
    }

    // MARK: - Refusals

    func testTheStatusTheBauRoutesUseDecidesTheSentence() {
        XCTAssertEqual(CommunityHomeRefusal.from(APIError.server(status: 403, message: "Staff only")), .notStaff)
        XCTAssertEqual(CommunityHomeRefusal.from(APIError.notFound("Not found")), .unavailable)
        XCTAssertEqual(CommunityHomeRefusal.from(APIError.server(status: 413, message: "File too large")), .tooLarge)
        XCTAssertEqual(CommunityHomeRefusal.from(APIError.rateLimited(retryAfter: 5)), .slowDown)
        XCTAssertEqual(CommunityHomeRefusal.from(APIError.server(status: 503, message: "Media uploads are not configured")), .noStorage)
    }

    func testA400KeepsTheServersOwnWords() {
        XCTAssertEqual(
            CommunityHomeRefusal.from(APIError.server(status: 400, message: "Title is required to publish")),
            .invalid("Title is required to publish")
        )
        // The client's own filler is not worth showing.
        XCTAssertEqual(
            CommunityHomeRefusal.from(APIError.server(status: 400, message: "Request failed (400)")),
            .invalid(nil)
        )
    }

    func testADeadConnectionIsANetworkRefusal() {
        XCTAssertEqual(CommunityHomeRefusal.from(APIError.transport("timeout")), .network)
        XCTAssertEqual(CommunityHomeRefusal.from(URLError(.notConnectedToInternet)), .network)
    }

    // MARK: - The storage leg

    private struct FakeAPI: CommunityHomeMediaAPI {
        let uploadUrl: String
        func mintCommunityHomeMedia(serverId: String, request: CommunityHomeMediaMintRequest) async throws -> CommunityHomeMediaMint {
            StubStorage.mintedLength = request.byteSize
            return CommunityHomeMediaMint(uploadId: "up-9", uploadUrl: uploadUrl)
        }
        func claimCommunityHomeMedia(serverId: String, uploadId: String) async throws -> String {
            StubStorage.claimed = true
            return uploadId
        }
    }

    private func stubbedSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubStorage.self]
        return URLSession(configuration: config)
    }

    private func tempFile(bytes: Int) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("bau-test-\(UUID().uuidString).mp4")
        try Data((0..<bytes).map { UInt8($0 % 251) }).write(to: url)
        return url
    }

    func testAFileIsPutStraightToStorageWithTheSignedTypeAndNoToken() async throws {
        StubStorage.reset(status: 200)
        let url = try tempFile(bytes: 5000)
        defer { try? FileManager.default.removeItem(at: url) }

        let uploader = CommunityHomeMediaUploader(
            api: FakeAPI(uploadUrl: "https://storage.example/put?sig=1"),
            session: stubbedSession()
        )
        let id = try await uploader.upload(serverId: "s1", fileURL: url, contentType: "video/mp4", filename: "clip.mp4")

        XCTAssertEqual(id, "up-9")
        XCTAssertEqual(StubStorage.method, "PUT")
        XCTAssertEqual(StubStorage.contentType, "video/mp4")
        XCTAssertNil(StubStorage.authorization, "storage refuses a request that is also authenticated another way")
        // The length that is signed is the length that is sent.
        XCTAssertEqual(StubStorage.mintedLength, 5000)
        XCTAssertEqual(StubStorage.bodyLength, 5000)
        XCTAssertTrue(StubStorage.claimed)
    }

    func testStorageRefusingThePutStopsTheUploadBeforeTheClaim() async throws {
        StubStorage.reset(status: 403)
        let url = try tempFile(bytes: 10)
        defer { try? FileManager.default.removeItem(at: url) }
        let uploader = CommunityHomeMediaUploader(
            api: FakeAPI(uploadUrl: "https://storage.example/put"),
            session: stubbedSession()
        )
        do {
            _ = try await uploader.upload(serverId: "s1", fileURL: url, contentType: "video/mp4", filename: "a.mp4")
            XCTFail("expected the PUT to fail")
        } catch {
            XCTAssertEqual(CommunityHomeRefusal.from(error), .network)
        }
        XCTAssertFalse(StubStorage.claimed)
    }

    func testAnEmptyFileNeverReachesTheMint() async throws {
        StubStorage.reset(status: 200)
        let url = try tempFile(bytes: 0)
        defer { try? FileManager.default.removeItem(at: url) }
        let uploader = CommunityHomeMediaUploader(
            api: FakeAPI(uploadUrl: "https://storage.example/put"),
            session: stubbedSession()
        )
        do {
            _ = try await uploader.upload(serverId: "s1", fileURL: url, contentType: "video/mp4", filename: "a.mp4")
            XCTFail("expected a refusal")
        } catch {
            XCTAssertNil(StubStorage.mintedLength)
        }
    }
}

/// Stands in for object storage. Static because `URLProtocol` is instantiated
/// by the loading system, not by the test; every test resets it first.
final class StubStorage: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var method: String?
    nonisolated(unsafe) static var contentType: String?
    nonisolated(unsafe) static var authorization: String?
    nonisolated(unsafe) static var bodyLength = 0
    nonisolated(unsafe) static var mintedLength: Int64?
    nonisolated(unsafe) static var claimed = false

    static func reset(status: Int) {
        self.status = status
        method = nil
        contentType = nil
        authorization = nil
        bodyLength = 0
        mintedLength = nil
        claimed = false
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.method = request.httpMethod
        Self.contentType = request.value(forHTTPHeaderField: "Content-Type")
        Self.authorization = request.value(forHTTPHeaderField: "Authorization")
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            var total = 0
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                total += read
            }
            stream.close()
            Self.bodyLength = total
        } else if let body = request.httpBody {
            Self.bodyLength = body.count
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
