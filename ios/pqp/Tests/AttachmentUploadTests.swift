import XCTest
@testable import pqp

/// The attachment upload path, end to end against a **running local server**
/// with storage configured (`docker compose --profile storage up`).
///
/// The picker is system UI and not worth automating, but the picker is not the
/// risky part. The three-step dance is: the server mints a presigned PUT with
/// the size and content type *signed into it*, and storage rejects anything
/// that does not match — which is exactly the kind of mismatch that ships
/// unnoticed because it only fails against real storage.
final class AttachmentUploadTests: XCTestCase {
    private var api: APIClient!
    private var uploader: AttachmentUploader!

    override func setUp() {
        super.setUp()
        api = APIClient(backend: .local, tokenProvider: DevTokenProvider())
        uploader = AttachmentUploader(api: api, backend: .local)
    }

    /// A tiny valid PNG, built rather than bundled so the test carries no
    /// fixture files.
    private func makeImageData() -> Data {
        let size = CGSize(width: 24, height: 24)
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { context in
            UIColor.systemGreen.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
        return image.jpegData(compressionQuality: 0.9)!
    }

    private func firstTextChannelId() async throws -> String {
        let servers = try await api.servers()
        let server = try XCTUnwrap(servers.first, "Seed a server before running this")
        let channels = try await api.channels(serverId: server.id)
        return try XCTUnwrap(channels.first(where: { $0.isText })?.id)
    }

    func testStorageIsConfigured() async throws {
        let config = try await api.attachmentConfig()
        XCTAssertTrue(
            config.enabled,
            "Attachments are off. Start MinIO and set S3_* — this suite tests real storage."
        )
        XCTAssertGreaterThan(config.maxBytes, 0)
    }

    /// The whole path: mint, PUT the bytes, then **claim** by sending a message
    /// that references the id.
    ///
    /// The claim is the part worth testing. An uploaded-but-unclaimed
    /// attachment is deliberately invisible — `/url` 404s for it — so a test
    /// that stopped after the PUT would pass while the feature was broken for
    /// anyone actually trying to send a photo.
    func testUploadingAndSendingMakesTheAttachmentReadable() async throws {
        let channelId = try await firstTextChannelId()
        let pending = PendingAttachment(
            filename: "test.jpg",
            contentType: "image/jpeg",
            data: makeImageData(),
            width: 24,
            height: 24
        )

        let attachmentId = try await uploader.upload(pending, channelId: channelId)
        XCTAssertFalse(attachmentId.isEmpty)

        // Claiming is a WebSocket frame — there is no HTTP route that does it.
        let realtime = RealtimeClient(backend: .local, tokenProvider: DevTokenProvider())
        let stream = await realtime.events()
        await realtime.connect()

        // Written as a value-returning task rather than one that mutates a
        // captured local: XCTestCase is not Sendable, so a closure writing back
        // into `self`'s scope is a data race under Swift 6.
        let waiter = Task { () -> Message? in
            for await event in stream {
                if case .ready = event {
                    await realtime.join(channelId: channelId)
                    _ = await realtime.sendMessage(
                        channelId: channelId,
                        body: "photo test",
                        attachmentIds: [attachmentId]
                    )
                }
                if case .messageCreated(let message, _) = event, !message.attachments.isEmpty {
                    return message
                }
            }
            return nil
        }
        let timeout = Task {
            try? await Task.sleep(for: .seconds(15))
            waiter.cancel()
        }
        let claimed = await waiter.value
        timeout.cancel()
        await realtime.stop()

        let message = try XCTUnwrap(claimed, "No broadcast carrying an attachment arrived")
        let attachment = try XCTUnwrap(message.attachments.first)
        XCTAssertEqual(attachment.filename, "test.jpg")
        XCTAssertEqual(attachment.byteSize, pending.byteSize)

        // Fetch the presigned URL the server handed back — proof the bytes are
        // really in the bucket and readable, not just that a row exists.
        let url = try XCTUnwrap(URL(string: attachment.url))
        let (data, response) = try await URLSession.shared.data(from: url)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(data.count, pending.byteSize, "Downloaded bytes should match what was sent")
    }

    /// The size is signed into the presigned PUT, so a body of a different
    /// length must be refused by storage rather than quietly accepted. This is
    /// the check that cannot be done against a mock.
    func testStorageRejectsABodyThatDoesNotMatchTheSignedSize() async throws {
        let channelId = try await firstTextChannelId()
        let honest = makeImageData()

        // Declare the real size, then send more bytes than that.
        let lying = PendingAttachment(
            filename: "liar.jpg",
            contentType: "image/jpeg",
            data: honest + Data(repeating: 0, count: 512),
            width: 24,
            height: 24
        )
        // Mint against the honest size by uploading a doctored pending whose
        // declared byteSize is smaller than the data it carries.
        struct Body: Encodable {
            let filename: String
            let contentType: String
            let byteSize: Int
            let width: Int?
            let height: Int?
        }
        let mint: AttachmentUploader.MintResponse = try await api.post(
            "/api/channels/\(channelId)/attachments",
            body: Body(filename: "liar.jpg", contentType: "image/jpeg",
                       byteSize: honest.count, width: 24, height: 24)
        )

        var request = URLRequest(url: URL(string: mint.uploadUrl)!)
        request.httpMethod = "PUT"
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        let (_, response) = try await URLSession.shared.upload(for: request, from: lying.data)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        XCTAssertFalse(
            (200..<300).contains(status),
            "Storage accepted \(lying.data.count) bytes against a URL signed for \(honest.count)"
        )
    }
}
