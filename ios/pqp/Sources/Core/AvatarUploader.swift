import Foundation
import UIKit

struct AvatarConfig: Decodable, Sendable {
    let enabled: Bool
    let maxBytes: Int
    /// The square both clients crop to. Sent by the server so the two cannot
    /// drift; `AVATAR_IMAGE_SIZE` in packages/shared is where it is decided.
    let size: Int
}

/// Uploading a profile picture.
///
/// The same three-step dance `AttachmentUploader` performs, and deliberately
/// not folded into it — the shapes only look alike. An attachment is minted
/// against a *channel*, becomes a row that a message later claims, and is swept
/// if no message ever does. An avatar is minted against the account, replaces
/// whatever was there, and is claimed by its own endpoint.
///
/// 1. `POST /api/me/avatar` mints a key and a presigned PUT.
/// 2. The bytes go **straight to storage**, never through the API.
/// 3. `POST /api/me/avatar/claim` HEADs the object and swaps the columns.
///
/// The length is signed into the PUT, so the size sent to the mint is taken
/// from the encoded data itself and never from anything the caller passes
/// alongside it — the same rule, for the same reason, as attachments.
actor AvatarUploader {
    private let api: APIClient
    private let session: URLSession

    init(api: APIClient) {
        self.api = api
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        config.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: config)
    }

    private struct MintResponse: Decodable, Sendable {
        let key: String
        let uploadUrl: String
    }

    private struct ClaimResponse: Decodable, Sendable {
        let user: CurrentUser
    }

    /// Returns the account as the server now holds it.
    func upload(_ image: UIImage, size: Int = 512) async throws -> CurrentUser {
        guard let data = Self.squareJpeg(image, size: CGFloat(size)) else {
            throw APIError.transport("That image could not be prepared")
        }

        struct Body: Encodable {
            let contentType: String
            let byteSize: Int
        }
        let mint: MintResponse = try await api.post(
            "/api/me/avatar",
            body: Body(contentType: "image/jpeg", byteSize: data.count)
        )

        guard let url = URL(string: mint.uploadUrl) else {
            throw APIError.transport("Storage returned an unusable upload URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        // Must match the type that was signed, exactly.
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        let (_, response) = try await session.upload(for: request, from: data)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw APIError.transport("Upload rejected by storage (\(status))")
        }

        struct Claim: Encodable { let key: String }
        let claimed: ClaimResponse = try await api.post(
            "/api/me/avatar/claim",
            body: Claim(key: mint.key)
        )
        return claimed.user
    }

    /// Centre-crop to a square, scale to `size`, encode as JPEG.
    ///
    /// Done here rather than server-side because the API never decodes an
    /// uploaded image — decoding attacker-controlled bytes in the process that
    /// holds the database pool is what the presigned-upload design exists to
    /// avoid. A phone photo is twelve megabytes and this is what makes it forty
    /// kilobytes; the server's byte cap is what handles a client that skips it.
    ///
    /// `UIGraphicsImageRenderer` rather than `CGContext`: it resolves the
    /// image's `imageOrientation` while drawing, and without that every photo
    /// taken in portrait uploads rotated ninety degrees. `opaque` because the
    /// output is a JPEG, which has no alpha to preserve anyway, and an opaque
    /// context is the cheaper one.
    static func squareJpeg(_ image: UIImage, size: CGFloat, quality: CGFloat = 0.85) -> Data? {
        let source = image.size
        guard source.width > 0, source.height > 0 else { return nil }

        let side = min(source.width, source.height)
        let format = UIGraphicsImageRendererFormat.default()
        // 1.0, not the screen's scale: `size` is already the pixel count we
        // want, and a @3x device would otherwise render 1536×1536.
        format.scale = 1
        format.opaque = true

        let renderer = UIGraphicsImageRenderer(
            size: CGSize(width: size, height: size),
            format: format
        )
        let square = renderer.image { _ in
            // Draw the whole image scaled so its short side fills the square,
            // offset so the long side is cropped evenly at both ends.
            let scale = size / side
            let drawn = CGSize(width: source.width * scale, height: source.height * scale)
            image.draw(in: CGRect(
                x: (size - drawn.width) / 2,
                y: (size - drawn.height) / 2,
                width: drawn.width,
                height: drawn.height
            ))
        }
        return square.jpegData(compressionQuality: quality)
    }
}

extension APIClient {
    /// Memoised for the life of the process, exactly like `attachmentConfig()`:
    /// storage is either configured on this deployment or it is not.
    func avatarConfig() async throws -> AvatarConfig {
        if let avatarConfigCache { return avatarConfigCache }
        let config: AvatarConfig = try await get("/api/avatars/config")
        avatarConfigCache = config
        return config
    }

    /// Back to the monogram. The object is dropped from the bucket server-side.
    func deleteAvatar() async throws -> CurrentUser {
        struct Response: Decodable { let user: CurrentUser }
        let response: Response = try await delete("/api/me/avatar")
        return response.user
    }
}
