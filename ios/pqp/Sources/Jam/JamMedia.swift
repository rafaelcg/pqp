import AVFoundation
import Foundation
import UIKit

/// Stems on disk. The engine streams from files (a ten minute stem must not sit
/// in memory), so a stem is downloaded once to the caches folder, named by its
/// track id, and kept until the system wants the space back. A track's bytes
/// never change (an edit moves numbers, not the file), so the id is the cache
/// key and a re-read of the song with fresh presigned URLs reuses it.
/// Where media may be fetched from. The server mints every stem and video URL
/// from its own bucket (a client cannot name one), so the check is about the
/// transport and not a host list that would differ per deployment: https only,
/// and plain http only in a Debug build pointed at a local MinIO.
enum JamMediaURL {
    static func allowed(_ string: String) -> URL? {
        guard let url = URL(string: string), let scheme = url.scheme?.lowercased(), url.host != nil else { return nil }
        if scheme == "https" { return url }
        #if DEBUG
        if scheme == "http" { return url }
        #endif
        return nil
    }
}

actor JamMediaCache {
    static let shared = JamMediaCache()

    enum MediaError: Error { case badResponse(Int), noURL }

    private let directory: URL
    private let session: URLSession
    private var inFlight: [String: Task<URL, Error>] = [:]
    /// The most stems kept on disk. Past it the least recently written go.
    static let diskBudgetBytes = 300 * 1024 * 1024

    init(session: URLSession = .shared) {
        self.session = session
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        directory = base.appendingPathComponent("jam", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    /// The file extension CoreAudio sniffs by, from the stored type.
    static func fileExtension(forContentType type: String) -> String {
        switch type.split(separator: ";").first.map(String.init)?.lowercased() ?? "" {
        case "audio/mp4", "audio/x-m4a", "audio/aac": "m4a"
        case "audio/mpeg", "audio/mp3": "mp3"
        case "audio/ogg": "ogg"
        case "audio/webm": "webm"
        case "audio/flac", "audio/x-flac": "flac"
        case "audio/wav", "audio/x-wav": "wav"
        case "video/mp4": "mp4"
        case "video/webm": "webm"
        default: "bin"
        }
    }

    func localURL(id: String, remote: String, contentType: String, expectedBytes: Int) async throws -> URL {
        let ext = Self.fileExtension(forContentType: contentType)
        let target = directory.appendingPathComponent("\(id).\(ext)")
        if let size = (try? FileManager.default.attributesOfItem(atPath: target.path)[.size]) as? Int,
           size > 0, expectedBytes == 0 || size == expectedBytes {
            return target
        }
        if let running = inFlight[id] { return try await running.value }
        guard let url = JamMediaURL.allowed(remote) else { throw MediaError.noURL }
        let session = self.session
        let task = Task<URL, Error> {
            let (temp, response) = try await session.download(from: url)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                throw MediaError.badResponse(http.statusCode)
            }
            try? FileManager.default.removeItem(at: target)
            try FileManager.default.moveItem(at: temp, to: target)
            return target
        }
        inFlight[id] = task
        defer { inFlight[id] = nil }
        let result = try await task.value
        trimToBudget(keeping: result)
        return result
    }

    /// Oldest first, until the folder fits. The file just written is never the
    /// one dropped, so a single stem larger than the budget still plays.
    private func trimToBudget(keeping keep: URL) {
        let manager = FileManager.default
        guard let urls = try? manager.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey]
        ) else { return }
        var entries: [(url: URL, date: Date, size: Int)] = urls.compactMap { url in
            let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
            return (url, values?.contentModificationDate ?? .distantPast, values?.fileSize ?? 0)
        }
        var total = entries.reduce(0) { $0 + $1.size }
        guard total > Self.diskBudgetBytes else { return }
        entries.sort { $0.date < $1.date }
        for entry in entries where total > Self.diskBudgetBytes && entry.url != keep {
            try? manager.removeItem(at: entry.url)
            total -= entry.size
        }
    }
}

/// A poster frame for a video stem, for a tile. Only MP4 (AVFoundation does not
/// open WebM), only on demand, and kept in memory: a wall of twenty tiles is
/// twenty small images, and a re-read of the same song reuses the one it has.
@MainActor
final class JamPosterCache {
    static let shared = JamPosterCache()
    private let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        // A poster is a decoded bitmap: about 4 bytes a pixel. Budgeted, not
        // left to memory pressure alone.
        cache.totalCostLimit = 24 * 1024 * 1024
        return cache
    }()
    private var inFlight: [String: Task<UIImage?, Never>] = [:]

    func cached(trackId: String) -> UIImage? { cache.object(forKey: trackId as NSString) }

    /// Whether this build can draw a poster for the stored type.
    nonisolated static func canPoster(contentType: String?) -> Bool {
        guard let type = contentType?.lowercased() else { return false }
        return type.hasPrefix("video/mp4") || type.hasPrefix("video/quicktime")
    }

    func poster(trackId: String, url: String, contentType: String?, atSeconds: Double = 1) async -> UIImage? {
        if let hit = cached(trackId: trackId) { return hit }
        guard Self.canPoster(contentType: contentType), let remote = JamMediaURL.allowed(url) else { return nil }
        if let running = inFlight[trackId] { return await running.value }
        let task = Task<UIImage?, Never> {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: remote))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 480, height: 480)
            generator.requestedTimeToleranceBefore = .positiveInfinity
            generator.requestedTimeToleranceAfter = .positiveInfinity
            do {
                let result = try await generator.image(at: CMTime(seconds: atSeconds, preferredTimescale: 600))
                return UIImage(cgImage: result.image)
            } catch {
                // A video shorter than the poster time, or no network: the
                // tile stays the coloured one.
                return nil
            }
        }
        inFlight[trackId] = task
        let image = await task.value
        inFlight[trackId] = nil
        if let image {
            let cost = Int(image.size.width * image.scale * image.size.height * image.scale * 4)
            cache.setObject(image, forKey: trackId as NSString, cost: cost)
        }
        return image
    }
}
