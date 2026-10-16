import Foundation
import ImageIO
import UIKit

/// Bringing a file into a story without freezing the composer or holding a
/// whole photo in memory: the copy and the decode run off the main actor, and
/// a picture is downsampled from the file to the size the story keeps rather
/// than decoded at full resolution first.
enum StoryImport {
    /// A picked movie, copied somewhere this app owns. The picked URL is
    /// security scoped and only valid while it is open, so the copy happens
    /// inside that scope. Off the main actor: a movie can be gigabytes.
    static func copyMovie(_ url: URL) async throws -> URL {
        try await Task.detached(priority: .userInitiated) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let copy = FileManager.default.temporaryDirectory
                .appendingPathComponent("story-\(UUID().uuidString).\(url.pathExtension)")
            try FileManager.default.copyItem(at: url, to: copy)
            return copy
        }.value
    }

    /// A picture file, decoded straight to `maxEdge` on its long side, with its
    /// orientation applied. Nothing larger is ever in memory.
    static func downsampledImage(at url: URL, maxEdge: CGFloat) async -> UIImage? {
        await Task.detached(priority: .userInitiated) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
            return thumbnail(from: source, maxEdge: maxEdge)
        }.value
    }

    /// The same for bytes already in memory (the photo picker hands over
    /// `Data`): the full-size bitmap is never made.
    static func downsampledImage(data: Data, maxEdge: CGFloat) async -> UIImage? {
        await Task.detached(priority: .userInitiated) {
            guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
            return thumbnail(from: source, maxEdge: maxEdge)
        }.value
    }

    private static func thumbnail(from source: CGImageSource, maxEdge: CGFloat) -> UIImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxEdge,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
    }

    /// A temp file this app made and is done with.
    static func remove(_ url: URL?) {
        guard let url else { return }
        try? FileManager.default.removeItem(at: url)
    }
}
