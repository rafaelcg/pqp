import AVFoundation
import Foundation
import UIKit

/// Stems on disk. The engine streams from files (a ten minute stem must not sit
/// in memory), so a stem is downloaded once to the caches folder, named by its
/// track id, and kept until the system wants the space back. A track's bytes
/// never change (an edit moves numbers, not the file), so the id is the cache
/// key and a re-read of the song with fresh presigned URLs reuses it.
actor JamMediaCache {
    static let shared = JamMediaCache()

    enum MediaError: Error { case badResponse(Int), noURL }

    private let directory: URL
    private let session: URLSession
    private var inFlight: [String: Task<URL, Error>] = [:]

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
        guard let url = URL(string: remote) else { throw MediaError.noURL }
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
        return try await task.value
    }
}

/// A poster frame for a video stem, for a tile. Only MP4 (AVFoundation does not
/// open WebM), only on demand, and kept in memory: a wall of twenty tiles is
/// twenty small images, and a re-read of the same song reuses the one it has.
@MainActor
final class JamPosterCache {
    static let shared = JamPosterCache()
    private let cache = NSCache<NSString, UIImage>()
    private var inFlight: [String: Task<UIImage?, Never>] = [:]

    func cached(trackId: String) -> UIImage? { cache.object(forKey: trackId as NSString) }

    /// Whether this build can draw a poster for the stored type.
    nonisolated static func canPoster(contentType: String?) -> Bool {
        guard let type = contentType?.lowercased() else { return false }
        return type.hasPrefix("video/mp4") || type.hasPrefix("video/quicktime")
    }

    func poster(trackId: String, url: String, contentType: String?, atSeconds: Double = 1) async -> UIImage? {
        if let hit = cached(trackId: trackId) { return hit }
        guard Self.canPoster(contentType: contentType), let remote = URL(string: url) else { return nil }
        if let running = inFlight[trackId] { return await running.value }
        let task = Task<UIImage?, Never> {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: remote))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 720, height: 720)
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
        if let image { cache.setObject(image, forKey: trackId as NSString) }
        return image
    }
}
