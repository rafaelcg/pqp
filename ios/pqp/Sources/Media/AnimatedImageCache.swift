import Foundation

/// Decoded GIF frames, cached by source URL string.
///
/// An actor with a hand-rolled LRU rather than `NSCache`: `NSCache` needs
/// `AnyObject` values, and `GIFFrame` wraps a `CGImage` that isn't a
/// Foundation-bridgeable class, so every entry would need boxing in a
/// wrapper class anyway. An actor gets the same "safe to touch from any
/// task" property from Swift concurrency directly, plus request coalescing:
/// two chat rows that scroll into view showing the same GIF at once decode
/// it exactly once between them instead of racing ImageIO twice.
actor AnimatedImageCache {
    static let shared = AnimatedImageCache()

    /// Chat scrollback realistically shows a handful of distinct GIFs at
    /// once; this is generous headroom without letting a long scroll session
    /// hold every animated attachment ever seen in memory.
    private let capacity = 24

    private var store: [String: [GIFFrame]] = [:]
    private var recency: [String] = []
    private var inFlight: [String: Task<[GIFFrame], Never>] = [:]

    private init() {}

    func cached(for key: String) -> [GIFFrame]? {
        store[key]
    }

    /// Decodes `data` for `key` unless already cached or already being
    /// decoded elsewhere, in which case this awaits that instead of
    /// redoing the work.
    func decodeAndStore(data: Data, key: String) async -> [GIFFrame] {
        if let existing = store[key] {
            touch(key)
            return existing
        }
        if let running = inFlight[key] {
            return await running.value
        }

        let task = Task.detached(priority: .userInitiated) {
            GIFDecoder.decode(data: data)
        }
        inFlight[key] = task
        let frames = await task.value
        inFlight[key] = nil

        if !frames.isEmpty {
            insert(frames, for: key)
        }
        return frames
    }

    private func touch(_ key: String) {
        recency.removeAll { $0 == key }
        recency.append(key)
    }

    private func insert(_ frames: [GIFFrame], for key: String) {
        store[key] = frames
        touch(key)
        while recency.count > capacity {
            let oldest = recency.removeFirst()
            store[oldest] = nil
        }
    }
}
