import Foundation
import UIKit

/// Who a user id is, for drawing a seat: a name and where the avatar lives. The
/// app itself never sees the id (`AppBridge` builds participants from scratch).
struct ActivityPerson: Equatable, Sendable {
    let userId: String
    let displayName: String
    let avatarUrl: String?
}

/// The avatars an app is handed (`avatar` in a bridge participant): a data URL,
/// never a link the sandboxed frame could load. Fetched natively, from
/// addresses `Avatar.resolve` accepts (this deployment's own `/api/avatars/…`
/// or an https URL), shrunk to a small JPEG, and kept for the life of the
/// process. A name a user typed into an avatar URL is untrusted, so a redirect
/// is followed ONLY from this deployment's own avatar route (which answers 302
/// to the uploaded object in our bucket) and refused everywhere else.
actor AppAvatarCache {
    static let shared = AppAvatarCache()

    /// A data URL of at most `AppLimits.avatarMaxChars`; the shrunk image is a
    /// few KB, so this is a ceiling a sane avatar never meets.
    private var cache: [String: String?] = [:]
    private var inFlight: [String: Task<String?, Never>] = [:]

    private static let maxDownloadBytes = 1_500_000
    private static let side: CGFloat = 96

    func dataURL(for raw: String?, backend: Backend = .current) async -> String? {
        guard let raw, !raw.isEmpty, let url = await MainActor.run(body: { Avatar.resolve(raw, backend: backend) }) else { return nil }
        let key = url.absoluteString
        if let cached = cache[key] { return cached }
        if let running = inFlight[key] { return await running.value }
        let followsRedirects = url.absoluteString.hasPrefix(backend.apiBaseURL.absoluteString + "/api/avatars/")
        let task = Task<String?, Never> { await Self.fetch(url, followsRedirects: followsRedirects) }
        inFlight[key] = task
        let value = await task.value
        inFlight[key] = nil
        cache[key] = .some(value)
        return value
    }

    private final class RedirectPolicy: NSObject, URLSessionTaskDelegate {
        let follows: Bool
        init(follows: Bool) { self.follows = follows }
        func urlSession(
            _ session: URLSession, task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            // https only, even when redirects are followed: ATS says the same, this says why.
            completionHandler(follows && request.url?.scheme == "https" ? request : nil)
        }
    }

    private static func fetch(_ url: URL, followsRedirects: Bool) async -> String? {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 6
        configuration.timeoutIntervalForResource = 10
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: RedirectPolicy(follows: followsRedirects), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        guard let (data, response) = try? await session.data(from: url),
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              data.count <= maxDownloadBytes,
              let image = UIImage(data: data) else { return nil }
        return shrunk(image)
    }

    /// A square JPEG of `side` points at scale 1, as a data URL; nil when it
    /// would not fit the bridge's cap.
    static func shrunk(_ image: UIImage) -> String? {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format)
        let source = image.size
        let scale = max(side / max(source.width, 1), side / max(source.height, 1))
        let drawn = CGSize(width: source.width * scale, height: source.height * scale)
        let jpeg = renderer.jpegData(withCompressionQuality: 0.72) { context in
            UIColor.black.setFill()
            context.fill(CGRect(x: 0, y: 0, width: side, height: side))
            image.draw(in: CGRect(
                x: (side - drawn.width) / 2, y: (side - drawn.height) / 2,
                width: drawn.width, height: drawn.height
            ))
        }
        let text = "data:image/jpeg;base64," + jpeg.base64EncodedString()
        return text.count <= AppLimits.avatarMaxChars ? text : nil
    }
}
