import Foundation

/// Everything the app re-reads every time you open a screen, kept on disk so
/// the screen can be drawn *before* the network is asked.
///
/// The complaint this exists for: opening a channel showed a spinner and then
/// content, every single time, even when nothing had changed since the last
/// visit. Two halves fix that. Here, the last page per channel (plus the
/// server, channel and DM lists) is persisted and painted immediately. On the
/// server, those same reads carry an `ETag`, so the refetch that follows the
/// paint usually comes back `304 Not Modified` — no body, nothing to decode,
/// nothing to re-render.
///
/// What is deliberately *not* here:
///
/// - **No expiry.** A cached page is never shown as final; it is shown while
///   the real answer is in flight, and replaced when it arrives. A TTL would
///   only choose *which* stale page to show, which is not a question worth
///   asking.
/// - **No attachment bytes.** A cached message carries a presigned URL that
///   expires (`ATTACHMENT_URL_TTL_SECONDS`), and the views already handle a
///   dead one by asking `GET /api/attachments/:id/url` for a fresh signature —
///   keyed on the attachment *id*, which never expires. Caching the message
///   row therefore degrades exactly the way a scrolled-back message already
///   did.
/// - **No cross-account leakage.** `SessionStore.signOut` empties the whole
///   directory; a second account must not find the first one's messages.

// MARK: - Storage

/// Where cached bytes live. A protocol so the cache's logic — LRU,
/// write-through, round-trip — is testable without touching a real disk.
protocol CacheStorage: Sendable {
    func read(_ name: String) -> Data?
    func write(_ data: Data, to name: String)
    func remove(_ name: String)
    func removeAll()
}

/// Application Support, which is where data the app can rebuild but would
/// rather not belongs — Caches can be evicted under storage pressure mid-use,
/// and Documents is for things the user made.
struct FileCacheStorage: CacheStorage {
    let directory: URL

    init(directory: URL) {
        self.directory = directory
        try? FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true
        )
    }

    static func applicationSupport() -> FileCacheStorage {
        let base = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        ).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return FileCacheStorage(directory: base.appendingPathComponent("pqp/read-cache"))
    }

    func read(_ name: String) -> Data? {
        try? Data(contentsOf: directory.appendingPathComponent(name))
    }

    func write(_ data: Data, to name: String) {
        // `.atomic` so a crash mid-write leaves the previous page rather than a
        // truncated file that fails to decode forever.
        try? data.write(to: directory.appendingPathComponent(name), options: .atomic)
    }

    func remove(_ name: String) {
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
    }

    func removeAll() {
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true
        )
    }
}

/// The same contract, in memory. Used by the tests, and as the fallback when a
/// real directory cannot be made.
final class MemoryCacheStorage: CacheStorage, @unchecked Sendable {
    private var files: [String: Data] = [:]
    private let lock = NSLock()

    init() {}

    var fileCount: Int {
        lock.lock(); defer { lock.unlock() }
        return files.count
    }

    func read(_ name: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        return files[name]
    }

    func write(_ data: Data, to name: String) {
        lock.lock(); defer { lock.unlock() }
        files[name] = data
    }

    func remove(_ name: String) {
        lock.lock(); defer { lock.unlock() }
        files[name] = nil
    }

    func removeAll() {
        lock.lock(); defer { lock.unlock() }
        files.removeAll()
    }
}

// MARK: - Entries

/// A channel's newest page, as last seen.
struct CachedPage: Codable, Sendable, Equatable {
    var messages: [Message]
    var hasMore: Bool
    /// The server's validator for exactly these bytes, or nil when the page has
    /// been edited locally since it was fetched — in which case the next read
    /// must be unconditional, or a `304` would confirm a page we no longer hold.
    var etag: String?
    var storedAt: Date = Date()
}

/// A cached list response (servers, a server's channels, conversations).
struct CachedList<Item: Codable & Sendable>: Codable, Sendable {
    var items: [Item]
    var etag: String?
    var storedAt: Date = Date()
}

/// What can be cached. The channel pages are the only entries under LRU
/// pressure: there is one server list and one DM list, and channel lists are
/// bounded by how many servers you are in.
enum CacheKey: Hashable, Sendable {
    case messages(channelId: String)
    case servers
    case conversations
    case channels(serverId: String)

    var filename: String {
        switch self {
        case .messages(let channelId): "messages-\(channelId).json"
        case .servers: "servers.json"
        case .conversations: "conversations.json"
        case .channels(let serverId): "channels-\(serverId).json"
        }
    }
}

/// Recency for the channel pages, persisted alongside them.
///
/// Split out as a plain value type on purpose: eviction is the one piece of
/// this file with an interesting rule in it, and a pure struct is testable
/// without a disk, a clock or an actor hop.
struct CacheIndex: Codable, Sendable, Equatable {
    /// Channel id → when its page was last read or written.
    var lastUsed: [String: Date] = [:]

    mutating func touch(_ channelId: String, at now: Date = Date()) {
        lastUsed[channelId] = now
    }

    mutating func forget(_ channelId: String) {
        lastUsed[channelId] = nil
    }

    /// The channel ids to drop so at most `limit` remain — least recently used
    /// first. Ties break on the id so the answer is deterministic rather than
    /// dictionary-ordered.
    func overflow(limit: Int) -> [String] {
        guard lastUsed.count > limit else { return [] }
        let ordered = lastUsed.sorted { left, right in
            left.value == right.value ? left.key < right.key : left.value < right.value
        }
        return ordered.prefix(lastUsed.count - limit).map(\.key)
    }
}

// MARK: - The cache

actor ReadCache {
    /// The app's cache. `APIClient` writes through it; `SessionStore` clears it.
    static let shared = ReadCache()

    /// Roughly a year of active servers' worth of channels. Past this the
    /// least recently opened pages go — each is at most a page of messages, but
    /// unbounded growth on a phone is its own bug.
    static let maxChannels = 50

    /// The server's own default page size. A write-through append past this
    /// trims the oldest row and admits there is more above.
    static let pageCap = 50

    private let storage: any CacheStorage
    private var index: CacheIndex

    private static let indexFile = "index.json"

    init(storage: any CacheStorage = FileCacheStorage.applicationSupport()) {
        self.storage = storage
        self.index =
            storage.read(Self.indexFile).flatMap {
                try? Self.decoder.decode(CacheIndex.self, from: $0)
            } ?? CacheIndex()
    }

    // MARK: Message pages

    func page(for channelId: String) -> CachedPage? {
        guard let data = storage.read(CacheKey.messages(channelId: channelId).filename),
              let page = try? Self.decoder.decode(CachedPage.self, from: data)
        else { return nil }
        index.touch(channelId)
        persistIndex()
        return page
    }

    func store(_ page: CachedPage, for channelId: String) {
        // Optimistic rows have client-side ids that no server will ever
        // confirm; persisting one would resurrect a message that was never
        // sent every time the channel is reopened.
        var page = page
        page.messages.removeAll(where: \.isPending)
        guard let data = try? Self.encoder.encode(page) else { return }
        storage.write(data, to: CacheKey.messages(channelId: channelId).filename)
        index.touch(channelId)
        evictOverflow()
        persistIndex()
    }

    func forgetPage(for channelId: String) {
        storage.remove(CacheKey.messages(channelId: channelId).filename)
        index.forget(channelId)
        persistIndex()
    }

    // MARK: Lists

    func list<Item: Codable & Sendable>(
        _ type: Item.Type, for key: CacheKey
    ) -> CachedList<Item>? {
        guard let data = storage.read(key.filename) else { return nil }
        return try? Self.decoder.decode(CachedList<Item>.self, from: data)
    }

    func setList<Item: Codable & Sendable>(_ list: CachedList<Item>, for key: CacheKey) {
        guard let data = try? Self.encoder.encode(list) else { return }
        storage.write(data, to: key.filename)
    }

    func clear() {
        storage.removeAll()
        index = CacheIndex()
    }

    // MARK: Write-through

    /// Keeps a cached page honest while its channel is *not* on screen.
    ///
    /// The open channel's model applies the same frames to what it is drawing;
    /// this applies them to what is on disk, so reopening a channel that
    /// received messages in the background shows them immediately instead of
    /// showing a page that is visibly behind.
    ///
    /// Any mutation drops the stored validator: the bytes on disk no longer
    /// match what the server last sent, so the next read has to be
    /// unconditional or a `304` would silently bless a page of our own making.
    func apply(_ event: RealtimeEvent) {
        switch event {
        case .messageCreated(let message, _):
            mutate(message.channelId) { page in
                guard !page.messages.contains(where: { $0.id == message.id }) else {
                    return false
                }
                page.messages.append(message)
                if page.messages.count > ReadCache.pageCap {
                    page.messages.removeFirst(page.messages.count - ReadCache.pageCap)
                    page.hasMore = true
                }
                return true
            }

        case .messageUpdated(let message):
            mutate(message.channelId) { page in
                guard let index = page.messages.firstIndex(where: { $0.id == message.id })
                else { return false }
                page.messages[index] = message
                return true
            }

        case .messageDeleted(let channelId, let messageId):
            mutate(channelId) { page in
                let before = page.messages.count
                page.messages.removeAll { $0.id == messageId }
                return page.messages.count != before
            }

        // Reactions, typing, presence and every voice frame change nothing a
        // reopened channel would draw from disk — the page is refetched anyway,
        // and a reaction delta is not worth a file write per emoji.
        default:
            break
        }
    }

    /// Applies `change` to a cached page if there is one, and rewrites it only
    /// when something actually changed.
    private func mutate(_ channelId: String, _ change: (inout CachedPage) -> Bool) {
        let name = CacheKey.messages(channelId: channelId).filename
        guard let data = storage.read(name),
              var page = try? Self.decoder.decode(CachedPage.self, from: data)
        else { return }
        guard change(&page) else { return }
        page.etag = nil
        page.storedAt = Date()
        guard let encoded = try? Self.encoder.encode(page) else { return }
        storage.write(encoded, to: name)
    }

    // MARK: Housekeeping

    private func evictOverflow() {
        for channelId in index.overflow(limit: Self.maxChannels) {
            storage.remove(CacheKey.messages(channelId: channelId).filename)
            index.forget(channelId)
        }
    }

    private func persistIndex() {
        guard let data = try? Self.encoder.encode(index) else { return }
        storage.write(data, to: Self.indexFile)
    }

    /// Test seam: the LRU bookkeeping is otherwise only observable through
    /// which files survive, which is a slower and vaguer assertion.
    func trackedChannelCount() -> Int { index.lastUsed.count }

    // MARK: Coding

    /// ISO-8601 *with* fractional seconds, matching the wire exactly, so a
    /// message decoded from cache is byte-for-byte the message decoded from the
    /// API — including `createdAt`, which drives message grouping.
    /// `Coding.decoder` already accepts both forms, so only the encoder is new.
    private static let encoder: JSONEncoder = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(formatter.string(from: date))
        }
        return encoder
    }()

    private static var decoder: JSONDecoder { Coding.decoder }
}
