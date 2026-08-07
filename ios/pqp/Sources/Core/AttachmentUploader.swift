import Foundation
import UIKit

struct AttachmentConfig: Decodable, Sendable {
    let enabled: Bool
    let maxBytes: Int
}

/// A file picked locally and on its way up.
struct PendingAttachment: Identifiable, Sendable {
    let id = UUID()
    let filename: String
    let contentType: String
    let data: Data
    let width: Int?
    let height: Int?
    var progress: Double = 0
    /// Set once the mint succeeds; this is what goes on `message-create`.
    var attachmentId: String?
    var failed: Bool = false

    var byteSize: Int { data.count }
}

/// Uploads follow the server's three-step dance, and the order matters:
///
/// 1. `POST /api/channels/:id/attachments` mints a row and a presigned PUT.
/// 2. The bytes go **straight to storage**, never through the API.
/// 3. The id rides on `message-create`, which is where the claim happens.
///
/// The size is signed into the presigned PUT, so sending a different number of
/// bytes than declared fails at the storage layer rather than being silently
/// accepted — which is why `byteSize` is taken from the data itself and never
/// from anything the caller supplies separately.
actor AttachmentUploader {
    private let api: APIClient
    private let backend: Backend
    private let session: URLSession

    init(api: APIClient, backend: Backend = .current) {
        self.api = api
        self.backend = backend
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        config.timeoutIntervalForResource = 120
        self.session = URLSession(configuration: config)
    }

    struct MintResponse: Decodable, Sendable {
        let attachmentId: String
        let uploadUrl: String
    }

    /// Returns the attachment id to pass to `message-create`.
    func upload(_ pending: PendingAttachment, channelId: String) async throws -> String {
        struct Body: Encodable {
            let filename: String
            let contentType: String
            let byteSize: Int
            let width: Int?
            let height: Int?
        }

        let mint: MintResponse = try await api.post(
            "/api/channels/\(channelId)/attachments",
            body: Body(
                filename: pending.filename,
                contentType: pending.contentType,
                byteSize: pending.byteSize,
                width: pending.width,
                height: pending.height
            )
        )

        guard let url = URL(string: mint.uploadUrl) else {
            throw APIError.transport("Storage returned an unusable upload URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        // Must match the type that was signed, exactly. A mismatch is rejected
        // by storage with a signature error rather than a helpful message.
        request.setValue(pending.contentType, forHTTPHeaderField: "Content-Type")

        let (_, response) = try await session.upload(for: request, from: pending.data)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw APIError.transport("Upload rejected by storage (\(status))")
        }

        return mint.attachmentId
    }
}

extension APIClient {
    func attachmentConfig() async throws -> AttachmentConfig {
        try await get("/api/attachments/config")
    }

    /// A freshly signed URL for an attachment whose presigned link has expired.
    /// The server answers 404 both for "gone" and "not yours to see".
    func attachmentUrl(id: String) async throws -> String {
        struct Response: Decodable { let url: String }
        let response: Response = try await get("/api/attachments/\(id)/url")
        return response.url
    }
}

extension PendingAttachment {
    /// Builds one from a picked image.
    ///
    /// JPEG rather than the original representation: HEIC is what an iPhone
    /// actually stores, and a web client cannot display it. Re-encoding here
    /// means the other end of the conversation can see what was sent.
    static func fromImage(_ image: UIImage, filename: String = "photo.jpg") -> PendingAttachment? {
        guard let data = image.jpegData(compressionQuality: 0.85) else { return nil }
        return PendingAttachment(
            filename: filename,
            contentType: "image/jpeg",
            data: data,
            width: Int(image.size.width * image.scale),
            height: Int(image.size.height * image.scale)
        )
    }
}
