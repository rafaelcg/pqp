import XCTest
@testable import pqp

/// Reporting a Baú post or comment from the phone (App Store guideline 1.2):
/// the two kinds the server's `createReportSchema` accepts as `bau_post` and
/// `bau_comment`, id only. The shape is pinned here because a body the schema
/// rejects fails as a 400 behind a "could not send" the reader can do nothing
/// about, and the feature would look shipped.
final class BauReportTests: XCTestCase {
    private struct Token: TokenProviding {
        func currentToken() async -> String? { "t" }
        func refreshedToken() async -> TokenRefresh { .token("t") }
    }

    override func setUp() { BauReportStub.reset() }

    private func api() -> APIClient {
        APIClient(tokenProvider: Token(), protocolClasses: [BauReportStub.self])
    }

    func testAPostIsReportedAsBauPostWithItsIdOnly() async throws {
        try await api().reportBauPost(postId: "11111111-1111-4111-8111-111111111111", reason: "spam", details: nil)

        let sent = try XCTUnwrap(BauReportStub.lastRequest)
        XCTAssertEqual(sent.path, "/api/reports")
        XCTAssertEqual(sent.method, "POST")
        XCTAssertEqual(sent.json["subjectType"] as? String, "bau_post")
        XCTAssertEqual(sent.json["postId"] as? String, "11111111-1111-4111-8111-111111111111")
        XCTAssertEqual(sent.json["reason"] as? String, "spam")
        // The server reads the community and the author from the post, and
        // refuses to be told: nothing else rides along.
        XCTAssertNil(sent.json["serverId"])
        XCTAssertNil(sent.json["commentId"])
    }

    func testACommentIsReportedAsBauCommentWithItsIdOnly() async throws {
        try await api().reportBauComment(
            commentId: "22222222-2222-4222-8222-222222222222", reason: "harassment", details: "again"
        )

        let sent = try XCTUnwrap(BauReportStub.lastRequest)
        XCTAssertEqual(sent.json["subjectType"] as? String, "bau_comment")
        XCTAssertEqual(sent.json["commentId"] as? String, "22222222-2222-4222-8222-222222222222")
        XCTAssertEqual(sent.json["reason"] as? String, "harassment")
        XCTAssertEqual(sent.json["details"] as? String, "again")
        XCTAssertNil(sent.json["postId"])
    }

    /// Two reports on one screen must not share a sheet identity, or the second
    /// tap would reuse the first one's already-sent state.
    func testAPostAndItsCommentAreDifferentTargets() {
        let post = ReportTarget.bauPost(id: "a", authorName: "Ana")
        let comment = ReportTarget.bauComment(id: "a", authorName: "Ana")
        XCTAssertNotEqual(post.id, comment.id)
        XCTAssertNotEqual(post.id, ReportTarget.message(id: "a", authorName: "Ana").id)
    }

    func testTheBlockConfirmationCarriesTheBauSurfaceToken() {
        // The operators' log line says where the block was made; the schema
        // allows `[a-z0-9_.-]{1,32}` and nothing else.
        let target = BlockPersonTarget(userId: "u", name: "Ana", surface: "bau")
        XCTAssertNotNil(target.surface.range(of: "^[a-z0-9_.-]{1,32}$", options: .regularExpression))
    }
}

/// Records the last request instead of sending it, and answers 201.
final class BauReportStub: URLProtocol, @unchecked Sendable {
    struct Sent { let path: String; let method: String; let json: [String: Any] }
    nonisolated(unsafe) static var lastRequest: Sent?
    private static let lock = NSLock()

    static func reset() { lock.lock(); lastRequest = nil; lock.unlock() }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            stream.close()
        }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        Self.lock.lock()
        Self.lastRequest = Sent(path: request.url?.path ?? "", method: request.httpMethod ?? "", json: json)
        Self.lock.unlock()
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 201, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
