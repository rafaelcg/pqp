import Foundation
import ImageIO
import UIKit

/// Who a user id is, for drawing a seat: a name and where the avatar lives. The
/// app itself never sees the id (`AppBridge` builds participants from scratch).
struct ActivityPerson: Equatable, Sendable {
    let userId: String
    let displayName: String
    let avatarUrl: String?
}

/// The avatars an app is handed (`avatar` in a bridge participant): a data URL,
/// never a link the sandboxed frame could load.
///
/// WHICH ADDRESSES. Exactly what the web host fetches (`avatarOrigins` in
/// `bridge-host.ts`): this deployment's own API (`/api/avatars/<user>`, which
/// answers 302 to the uploaded object in our bucket). A user can set their avatar
/// URL to anything, so any other address is NOT fetched from the device (it would
/// tell its owner the viewer's address and timing) and the app draws its own
/// fallback. A redirect is followed only from that route, and only to https.
///
/// HOW. Streamed with a hard byte cap (the transfer is cancelled the moment it is
/// passed, nothing buffers an oversized body), then DOWNSAMPLED from the encoded
/// data to a small JPEG (`CGImageSourceCreateThumbnailAtIndex`, which never
/// decodes the full picture). Results are kept in a small bounded cache.
actor AppAvatarCache {
    static let shared = AppAvatarCache()

    private var cache: [String: String?] = [:]
    private var order: [String] = []
    private var inFlight: [String: Task<String?, Never>] = [:]

    static let maxDownloadBytes = 1_500_000
    static let maxEntries = 200
    static let side = 96

    func dataURL(for raw: String?, backend: Backend = .current) async -> String? {
        guard let raw, !raw.isEmpty,
              let url = await MainActor.run(body: { Avatar.resolve(raw, backend: backend) }),
              Self.isOurAvatarRoute(url, backend: backend) else { return nil }
        let key = url.absoluteString
        if let cached = cache[key] { return cached }
        if let running = inFlight[key] { return await running.value }
        let task = Task<String?, Never> { await Self.fetch(url) }
        inFlight[key] = task
        let value = await task.value
        inFlight[key] = nil
        remember(key, value)
        return value
    }

    /// Only `<api>/api/avatars/…` is fetched.
    static func isOurAvatarRoute(_ url: URL, backend: Backend) -> Bool {
        url.absoluteString.hasPrefix(backend.apiBaseURL.absoluteString + "/api/avatars/")
    }

    private func remember(_ key: String, _ value: String?) {
        if cache[key] == nil { order.append(key) }
        cache[key] = .some(value)
        while order.count > Self.maxEntries {
            cache.removeValue(forKey: order.removeFirst())
        }
    }

    private final class RedirectPolicy: NSObject, URLSessionTaskDelegate {
        func urlSession(
            _ session: URLSession, task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            completionHandler(request.url?.scheme == "https" ? request : nil)
        }
    }

    private static func fetch(_ url: URL) async -> String? {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 6
        configuration.timeoutIntervalForResource = 10
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: RedirectPolicy(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        guard let (bytes, response) = try? await session.bytes(from: url),
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              http.expectedContentLength <= Int64(maxDownloadBytes) else { return nil }
        var data = Data()
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count > maxDownloadBytes { return nil }
            }
        } catch {
            return nil
        }
        return shrunk(data)
    }

    /// A square-ish JPEG data URL of at most `side` pixels, from the ENCODED
    /// image, never decoding it at its full size; nil when it would not fit the
    /// bridge's cap or is not an image.
    static func shrunk(_ data: Data) -> String? {
        let options: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let source = CGImageSourceCreateWithData(data as CFData, options as CFDictionary) else { return nil }
        let thumbnail: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: side,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnail as CFDictionary),
              let jpeg = UIImage(cgImage: image).jpegData(compressionQuality: 0.72) else { return nil }
        let text = "data:image/jpeg;base64," + jpeg.base64EncodedString()
        return text.count <= AppLimits.avatarMaxChars ? text : nil
    }
}
