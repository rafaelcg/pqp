import CryptoKit
import Foundation
import ImageIO
import SwiftUI
import UIKit

// A SONG'S COVER, KEPT.
//
// The server hands every song summary a freshly SIGNED address for the cover
// (`coverUrl`, "A SONG'S COVER" in `packages/shared/src/jam.ts`), so the same
// picture arrives under a different query string on every list read and every
// song frame, and each one stops working at its own expiry (twelve hours by
// default). A cache keyed by that string would download the picture again on
// every refresh and lose it the moment the signature lapsed.
//
// What identifies a picture is the SONG and the PATH of the address (everything
// before `?`): the key inside it never changes for one picture, and a replaced
// cover is a new key, so the path is the cover's version. The payload carries no
// other version field. So the cache is keyed on `songId|path`, keeps the bytes
// on disk (a picture is a few hundred kilobytes) and a decoded, down-sampled
// bitmap in memory, and the signature is used once, to fetch.

enum JamCoverKey {
    /// Everything before `?`: the picture's identity inside a presigned address.
    static func path(of url: String) -> String {
        if let cut = url.firstIndex(of: "?") { return String(url[..<cut]) }
        return url
    }

    /// The cache key. Two reads of one picture under different signatures are
    /// one key; a replaced picture is another.
    static func key(songId: String, url: String) -> String {
        "\(songId)|\(path(of: url))"
    }

    /// The file a key is stored under: a digest, so the name is safe on disk
    /// whatever the address held.
    static func fileName(for key: String) -> String {
        SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// What a fetch can answer, so the cache can be tested without a network.
protocol JamCoverFetching: Sendable {
    func data(from url: URL) async throws -> Data
}

struct JamCoverNetwork: JamCoverFetching {
    let session: URLSession

    func data(from url: URL) async throws -> Data {
        let (data, response) = try await session.data(from: url)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw JamCoverStore.CoverError.badResponse(http.statusCode)
        }
        return data
    }
}

@MainActor
final class JamCoverStore {
    static let shared = JamCoverStore()

    enum CoverError: Error, Equatable { case noURL, badResponse(Int), undecodable }

    /// The longest side a decoded cover keeps, in pixels. The server's picture
    /// is 1024 square; a tile is about 600 px on the densest phone and the
    /// song header 1000, so one size serves both.
    nonisolated static let maxPixel: CGFloat = 1024
    /// Decoded bitmaps in memory, by cost (about 4 bytes a pixel).
    nonisolated static let memoryBudgetBytes = 32 * 1024 * 1024
    /// Bytes kept on disk.
    nonisolated static let diskBudgetBytes = 48 * 1024 * 1024
    /// How long a failed key is left alone before it is tried again.
    nonisolated static let retryAfter: TimeInterval = 60

    private let memory: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = JamCoverStore.memoryBudgetBytes
        return cache
    }()
    private let directory: URL
    private let fetcher: any JamCoverFetching
    private let now: () -> Date
    private var inFlight: [String: Task<UIImage?, Never>] = [:]
    private var failedAt: [String: Date] = [:]
    /// Network fetches made, for the tests: a cache that works makes none for
    /// a picture it holds.
    private(set) var fetchCount = 0

    init(
        directory: URL? = nil,
        fetcher: any JamCoverFetching = JamCoverNetwork(session: .shared),
        now: @escaping () -> Date = Date.init
    ) {
        let base = directory
            ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("jam-covers", isDirectory: true)
        self.directory = base
        self.fetcher = fetcher
        self.now = now
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    }

    /// What is already decoded, for a first frame with no flash.
    func cached(songId: String, url: String) -> UIImage? {
        memory.object(forKey: JamCoverKey.key(songId: songId, url: url) as NSString)
    }

    /// The cover for a song: memory, then disk, then the network with the
    /// address as it is NOW. Nil when there is none to be had (offline, an
    /// expired address, a file that is not a picture): the caller keeps its
    /// fallback art, and the key is left alone for a minute before another try.
    func image(songId: String, url: String) async -> UIImage? {
        let key = JamCoverKey.key(songId: songId, url: url)
        if let hit = memory.object(forKey: key as NSString) { return hit }
        if let running = inFlight[key] { return await running.value }
        if let failed = failedAt[key], now().timeIntervalSince(failed) < Self.retryAfter { return nil }

        let file = directory.appendingPathComponent(JamCoverKey.fileName(for: key))
        let fetcher = self.fetcher
        let task = Task<UIImage?, Never> { [weak self] in
            if let bytes = try? Data(contentsOf: file), let image = Self.decode(bytes) {
                self?.touch(file)
                return image
            }
            guard let remote = JamMediaURL.allowed(url) else { return nil }
            guard let bytes = try? await fetcher.data(from: remote), let image = Self.decode(bytes) else {
                return nil
            }
            self?.noteFetch()
            try? bytes.write(to: file, options: .atomic)
            self?.trimToBudget(keeping: file)
            return image
        }
        inFlight[key] = task
        let image = await task.value
        inFlight[key] = nil
        if let image {
            failedAt[key] = nil
            let cost = Int(image.size.width * image.scale * image.size.height * image.scale * 4)
            memory.setObject(image, forKey: key as NSString, cost: cost)
        } else {
            failedAt[key] = now()
        }
        return image
    }

    private func noteFetch() { fetchCount += 1 }

    /// Drop what is held for a song (it was deleted).
    func forget(songId: String) {
        // The memory cache cannot be enumerated by prefix; a deleted song's
        // bitmap ages out under the cost limit. Its file goes with the budget.
        failedAt = failedAt.filter { !$0.key.hasPrefix("\(songId)|") }
    }

    func removeAll() {
        memory.removeAllObjects()
        failedAt = [:]
        if let urls = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            for url in urls { try? FileManager.default.removeItem(at: url) }
        }
    }

    // MARK: Decoding and the disk

    /// Down-sampled on decode (ImageIO), so a 4 MiB picture a client sent as it
    /// was does not sit in memory at full size.
    nonisolated static func decode(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    private nonisolated func touch(_ file: URL) {
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
    }

    private nonisolated func trimToBudget(keeping keep: URL) {
        let manager = FileManager.default
        let directory = keep.deletingLastPathComponent()
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

// MARK: - The view

/// A song's cover, drawn once it is here and nothing before it: the caller
/// keeps its own art underneath, so a slow or failed download is the art it
/// always had and never a gap or a broken image. `onChange` tells the caller
/// whether a cover is on screen, for the one thing that depends on it (a title
/// that reads on ink over a colour reads on paper over a picture).
struct JamCoverImage: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let songId: String
    let cover: JamCoverRef?
    var onChange: ((UIImage?) -> Void)?

    @State private var image: UIImage?

    init(songId: String, cover: JamCoverRef?, onChange: ((UIImage?) -> Void)? = nil) {
        self.songId = songId
        self.cover = cover
        self.onChange = onChange
        // A cover already decoded is on the first frame, so scrolling a wall
        // back to a tile does not flash its art.
        _image = State(initialValue: cover.flatMap { JamCoverStore.shared.cached(songId: songId, url: $0.url) })
    }

    var body: some View {
        ZStack {
            if let image {
                Color.clear.overlay {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                }
                .clipped()
                .transition(.opacity)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .task(id: cover.map { JamCoverKey.key(songId: songId, url: $0.url) }) {
            guard let cover else {
                set(nil)
                return
            }
            if let hit = JamCoverStore.shared.cached(songId: songId, url: cover.url) {
                set(hit)
                return
            }
            // A new picture over an old one: the old stays until the new lands.
            let loaded = await JamCoverStore.shared.image(songId: songId, url: cover.url)
            if Task.isCancelled { return }
            set(loaded)
        }
    }

    private func set(_ next: UIImage?) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.35)) { image = next }
        onChange?(next)
    }
}
