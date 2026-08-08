import XCTest
@testable import pqp

/// The device half of "opening a channel should not show a spinner".
///
/// Everything here runs against `MemoryCacheStorage` except the one test that
/// proves the real directory works — the point of the storage protocol is that
/// the interesting rules (round-trip, LRU, write-through) are testable without
/// a disk, a clock or a server.
final class ReadCacheTests: XCTestCase {

    // MARK: Fixtures

    private func message(
        id: String,
        channelId: String = "chan-1",
        body: String = "hello",
        createdAt: Date = Date(timeIntervalSince1970: 1_700_000_000)
    ) throws -> Message {
        let json = """
        {"id":"\(id)","channelId":"\(channelId)","authorId":"author-1",
         "authorName":"Someone","authorTag":"someone#0001","authorAvatarUrl":null,
         "body":"\(body)","createdAt":"\(iso8601WithMilliseconds(createdAt))",
         "editedAt":null,"reactions":[],"replyTo":null,
         "attachments":[{"id":"att-1","filename":"photo.jpg","contentType":"image/jpeg",
                         "byteSize":1234,"width":100,"height":100,
                         "url":"https://storage.example/photo.jpg?X-Amz-Expires=900"}],
         "embeds":[],"blocked":false,"pinnedAt":null,"isWebhook":false,"webhookEmbeds":[]}
        """
        return try Coding.decoder.decode(Message.self, from: Data(json.utf8))
    }

    private func page(_ messages: [Message], hasMore: Bool = false, etag: String? = "\"v1\"")
        -> CachedPage
    {
        CachedPage(messages: messages, hasMore: hasMore, etag: etag)
    }

    // MARK: Round trip

    func testStoresAndReadsBackAPageIntact() async throws {
        let cache = ReadCache(storage: MemoryCacheStorage())
        let original = try message(id: "m1", body: "first")
        await cache.store(page([original], hasMore: true, etag: "\"abc\""), for: "chan-1")

        let restored = await cache.page(for: "chan-1")
        XCTAssertEqual(restored?.messages, [original])
        XCTAssertEqual(restored?.hasMore, true)
        XCTAssertEqual(restored?.etag, "\"abc\"")
    }

    /// `createdAt` drives message grouping, so a round trip that quietly
    /// rounded it would regroup the whole page on reopen.
    func testPreservesFractionalTimestamps() async throws {
        let cache = ReadCache(storage: MemoryCacheStorage())
        let precise = Date(timeIntervalSince1970: 1_700_000_000.123)
        let original = try message(id: "m1", createdAt: precise)
        await cache.store(page([original]), for: "chan-1")

        let restored = await cache.page(for: "chan-1")
        XCTAssertEqual(
            restored?.messages.first?.createdAt.timeIntervalSince1970 ?? 0,
            precise.timeIntervalSince1970,
            accuracy: 0.002
        )
    }

    /// A presigned attachment URL is cached as-is. It expires, and that is
    /// fine: the views refetch by attachment *id*, which does not.
    func testKeepsAttachmentIdSoAnExpiredUrlCanBeRefreshed() async throws {
        let cache = ReadCache(storage: MemoryCacheStorage())
        await cache.store(page([try message(id: "m1")]), for: "chan-1")

        let attachment = await cache.page(for: "chan-1")?.messages.first?.attachments.first
        XCTAssertEqual(attachment?.id, "att-1")
        XCTAssertTrue(attachment?.url.contains("X-Amz-Expires") == true)
    }

    func testMissingChannelReadsAsNil() async {
        let cache = ReadCache(storage: MemoryCacheStorage())
        let restored = await cache.page(for: "never-opened")
        XCTAssertNil(restored)
    }

    /// Optimistic rows have client-side ids the server will never confirm.
    /// Persisting one would resurrect an unsent message on every reopen.
    func testNeverPersistsPendingRows() async throws {
        let cache = ReadCache(storage: MemoryCacheStorage())
        let user = CurrentUser(
            id: "me", clerkId: "clerk_me", displayName: "Me", username: nil,
            discriminator: nil, tag: nil, avatarUrl: nil, dmPrivacy: nil, ageGate: nil
        )
        let pending = Message(pendingBody: "never sent", channelId: "chan-1", author: user)
        await cache.store(page([try message(id: "m1"), pending]), for: "chan-1")

        let restored = await cache.page(for: "chan-1")
        XCTAssertEqual(restored?.messages.map(\.id), ["m1"])
    }

    func testForgettingAPageRemovesIt() async throws {
        let cache = ReadCache(storage: MemoryCacheStorage())
        await cache.store(page([try message(id: "m1")]), for: "chan-1")
        await cache.forgetPage(for: "chan-1")
        let restored = await cache.page(for: "chan-1")
        XCTAssertNil(restored)
    }

    func testClearEmptiesEverything() async throws {
        let storage = MemoryCacheStorage()
        let cache = ReadCache(storage: storage)
        await cache.store(page([try message(id: "m1")]), for: "chan-1")
        await cache.setList(CachedList(items: [DmSummaryFixture.make()], etag: nil),
                            for: .conversations)

        await cache.clear()

        let page = await cache.page(for: "chan-1")
        let list = await cache.list(DmSummary.self, for: .conversations)
        XCTAssertNil(page)
        XCTAssertNil(list)
        XCTAssertEqual(storage.fileCount, 0)
    }

    // MARK: Lists

    func testRoundTripsAListWithItsValidator() async {
        let cache = ReadCache(storage: MemoryCacheStorage())
        let conversation = DmSummaryFixture.make()
        await cache.setList(
            CachedList(items: [conversation], etag: "\"dms-1\""), for: .conversations
        )

        let restored = await cache.list(DmSummary.self, for: .conversations)
        XCTAssertEqual(restored?.items, [conversation])
        XCTAssertEqual(restored?.etag, "\"dms-1\"")
    }

    func testListsAreKeyedSeparatelyPerServer() async {
        let cache = ReadCache(storage: MemoryCacheStorage())
        await cache.setList(CachedList(items: [ChannelFixture.make(id: "a")], etag: nil),
                            for: .channels(serverId: "server-1"))
        await cache.setList(CachedList(items: [ChannelFixture.make(id: "b")], etag: nil),
                            for: .channels(serverId: "server-2"))

        let first = await cache.list(Channel.self, for: .channels(serverId: "server-1"))
        let second = await cache.list(Channel.self, for: .channels(serverId: "server-2"))
        XCTAssertEqual(first?.items.map(\.id), ["a"])
        XCTAssertEqual(second?.items.map(\.id), ["b"])
    }

    // MARK: LRU

    func testEvictionDropsTheLeastRecentlyUsedPages() {
        var index = CacheIndex()
        let epoch = Date(timeIntervalSince1970: 0)
        for step in 0..<5 {
            index.touch("chan-\(step)", at: epoch.addingTimeInterval(Double(step)))
        }
        // Reaching back for the oldest one makes it the newest.
        index.touch("chan-0", at: epoch.addingTimeInterval(100))

        XCTAssertEqual(index.overflow(limit: 3), ["chan-1", "chan-2"])
        XCTAssertEqual(index.overflow(limit: 5), [])
        XCTAssertEqual(index.overflow(limit: 10), [])
    }

    func testEvictionIsDeterministicWhenTimestampsTie() {
        var index = CacheIndex()
        let same = Date(timeIntervalSince1970: 1)
        index.touch("b", at: same)
        index.touch("a", at: same)
        index.touch("c", at: same)
        XCTAssertEqual(index.overflow(limit: 1), ["a", "b"])
    }

    func testKeepsAtMostFiftyChannelsOnDisk() async throws {
        let cache = ReadCache(storage: MemoryCacheStorage())
        for step in 0...ReadCache.maxChannels {
            await cache.store(
                page([try message(id: "m\(step)", channelId: "chan-\(step)")]),
                for: "chan-\(step)"
            )
        }

        let tracked = await cache.trackedChannelCount()
        XCTAssertEqual(tracked, ReadCache.maxChannels)
        // The very first channel written is the one that went.
        let evicted = await cache.page(for: "chan-0")
        let survivor = await cache.page(for: "chan-\(ReadCache.maxChannels)")
        XCTAssertNil(evicted)
        XCTAssertNotNil(survivor)
    }

    // MARK: Write-through

    func testAppliesAMessageCreatedFrameToACachedPage() async throws {
        let cache = ReadCache(storage: MemoryCacheStorage())
        await cache.store(page([try message(id: "m1")]), for: "chan-1")

        await cache.apply(.messageCreated(try message(id: "m2", body: "later"), nonce: nil))

        let restored = await cache.page(for: "chan-1")
        XCTAssertEqual(restored?.messages.map(\.id), ["m1", "m2"])
    }

    /// The cached bytes no longer match what the server last sent, so the
    /// validator has to go — otherwise the next open would send it, get a 304,
    /// and treat a page of our own making as confirmed.
    func testWriteThroughDropsTheValidator() async throws {
        let cache = ReadCache(storage: MemoryCacheStorage())
        await cache.store(page([try message(id: "m1")], etag: "\"v1\""), for: "chan-1")

        await cache.apply(.messageCreated(try message(id: "m2"), nonce: nil))

        let restored = await cache.page(for: "chan-1")
        XCTAssertNil(restored?.etag)
    }

    func testIgnoresADuplicateCreateFrame() async throws {
        let cache = ReadCache(storage: MemoryCacheStorage())
        await cache.store(page([try message(id: "m1")]), for: "chan-1")

        await cache.apply(.messageCreated(try message(id: "m1"), nonce: nil))

        let restored = await cache.page(for: "chan-1")
        XCTAssertEqual(restored?.messages.count, 1)
        // Nothing changed, so the validator is still good.
        XCTAssertEqual(restored?.etag, "\"v1\"")
    }

    func testAppliesAnEditFrame() async throws {
        let cache = ReadCache(storage: MemoryCacheStorage())
        await cache.store(page([try message(id: "m1", body: "before")]), for: "chan-1")

        await cache.apply(.messageUpdated(try message(id: "m1", body: "after")))

        let restored = await cache.page(for: "chan-1")
        XCTAssertEqual(restored?.messages.first?.body, "after")
    }

    func testAppliesADeleteFrame() async throws {
        let cache = ReadCache(storage: MemoryCacheStorage())
        await cache.store(
            page([try message(id: "m1"), try message(id: "m2")]), for: "chan-1"
        )

        await cache.apply(.messageDeleted(channelId: "chan-1", messageId: "m1"))

        let restored = await cache.page(for: "chan-1")
        XCTAssertEqual(restored?.messages.map(\.id), ["m2"])
    }

    func testDoesNotCreateAPageForAChannelItHasNeverSeen() async throws {
        let cache = ReadCache(storage: MemoryCacheStorage())
        await cache.apply(.messageCreated(try message(id: "m1", channelId: "unknown"),
                                          nonce: nil))
        let restored = await cache.page(for: "unknown")
        XCTAssertNil(restored)
    }

    /// A busy channel nobody is looking at must not grow without bound.
    func testTrimsTheOldestRowsPastAPage() async throws {
        let cache = ReadCache(storage: MemoryCacheStorage())
        let seeded = try (0..<ReadCache.pageCap).map { try message(id: "m\($0)") }
        await cache.store(page(seeded, hasMore: false), for: "chan-1")

        await cache.apply(.messageCreated(try message(id: "new"), nonce: nil))

        let restored = await cache.page(for: "chan-1")
        XCTAssertEqual(restored?.messages.count, ReadCache.pageCap)
        XCTAssertEqual(restored?.messages.first?.id, "m1")
        XCTAssertEqual(restored?.messages.last?.id, "new")
        // Something was dropped off the top, so there is now more above.
        XCTAssertEqual(restored?.hasMore, true)
    }

    func testIgnoresFramesThatChangeNothingOnDisk() async throws {
        let cache = ReadCache(storage: MemoryCacheStorage())
        await cache.store(page([try message(id: "m1")], etag: "\"v1\""), for: "chan-1")

        await cache.apply(
            .reaction(channelId: "chan-1", messageId: "m1", emoji: "🔥",
                      userId: "u1", added: true)
        )
        await cache.apply(.typing(channelId: "chan-1", userId: "u1", displayName: "Someone"))

        let restored = await cache.page(for: "chan-1")
        XCTAssertEqual(restored?.etag, "\"v1\"")
    }

    // MARK: The real disk

    func testSurvivesAFreshCacheInstanceOnDisk() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("pqp-read-cache-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }

        let storage = FileCacheStorage(directory: directory)
        let writer = ReadCache(storage: storage)
        await writer.store(page([try message(id: "m1", body: "persisted")]), for: "chan-1")

        // A second instance over the same directory is what a relaunch is.
        let reader = ReadCache(storage: FileCacheStorage(directory: directory))
        let restored = await reader.page(for: "chan-1")
        XCTAssertEqual(restored?.messages.first?.body, "persisted")
        let tracked = await reader.trackedChannelCount()
        XCTAssertEqual(tracked, 1)
    }
}

// MARK: - Fixtures

private enum DmSummaryFixture {
    static func make(channelId: String = "dm-1") -> DmSummary {
        let json = """
        {"channelId":"\(channelId)","kind":"dm",
         "participants":[{"id":"u1","displayName":"Friend","username":"friend",
                          "tag":"friend#0001","avatarUrl":null}],
         "lastMessageAt":null,"unread":{"count":0,"mentions":0}}
        """
        // Force-tried: a fixture that cannot decode is a broken test, not a
        // condition worth threading through every call site.
        return try! Coding.decoder.decode(DmSummary.self, from: Data(json.utf8))
    }
}

private enum ChannelFixture {
    static func make(id: String) -> Channel {
        let json = """
        {"id":"\(id)","serverId":"server-1","kind":"server","name":"general",
         "type":"text","position":0,"isPrivate":false,"topic":null,
         "imageUrl":null,"parentId":null}
        """
        return try! Coding.decoder.decode(Channel.self, from: Data(json.utf8))
    }
}

/// Fractional seconds, the way the server writes them. Built per call rather
/// than cached in a static: `ISO8601DateFormatter` is not `Sendable`, and a
/// shared one is a data race the compiler is right to refuse.
private func iso8601WithMilliseconds(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}
