import XCTest
@testable import pqp

/// Friends and threads, pinned against the shapes in `packages/shared/src`.
///
/// Same reasoning as WireDecodingTests: the Zod schemas are the contract, and
/// a decode rule that drifts fails as a silently dropped frame or an empty
/// list, not as an error anybody notices.
final class SocialWireTests: XCTestCase {
    private func firstEvent(from json: String) async -> RealtimeEvent? {
        let client = RealtimeClient(backend: .local, tokenProvider: DevTokenProvider())
        let stream = await client.events()
        await client.ingest(Data(json.utf8))
        var iterator = stream.makeAsyncIterator()
        let waiter = Task { await iterator.next() }
        let timeout = Task {
            try? await Task.sleep(for: .seconds(2))
            waiter.cancel()
        }
        let event = await waiter.value
        timeout.cancel()
        return event
    }

    // MARK: - Threads

    /// `thread-update` carries the PARENT channel id, not the thread's — a
    /// client that matched it against the thread would never update a chip.
    func testThreadUpdateCarriesTheParentChannel() async throws {
        let json = """
        {"type":"thread-update",
         "channelId":"22222222-2222-2222-2222-222222222222",
         "messageId":"55555555-5555-5555-5555-555555555555",
         "thread":{"channelId":"66666666-6666-6666-6666-666666666666",
                   "parentChannelId":"22222222-2222-2222-2222-222222222222",
                   "rootMessageId":"55555555-5555-5555-5555-555555555555",
                   "name":"about the deploy","replyCount":3,
                   "lastActivityAt":"2026-08-07T11:00:00.000Z","archived":false}}
        """
        let event = await firstEvent(from: json)
        guard case .threadUpdate(let channelId, let messageId, let thread) = event else {
            return XCTFail("Expected threadUpdate, got \(String(describing: event))")
        }
        XCTAssertEqual(channelId, "22222222-2222-2222-2222-222222222222")
        XCTAssertEqual(messageId, "55555555-5555-5555-5555-555555555555")
        XCTAssertEqual(thread.channelId, "66666666-6666-6666-6666-666666666666")
        XCTAssertNotEqual(thread.channelId, channelId)
        XCTAssertEqual(thread.replyCount, 3)
        XCTAssertFalse(thread.archived)
    }

    /// Deleting the origin message keeps the thread, so `rootMessageId` really
    /// does arrive null — a non-optional would drop the whole frame.
    func testThreadSummaryToleratesADeletedOrigin() throws {
        let json = """
        {"channelId":"66666666-6666-6666-6666-666666666666",
         "parentChannelId":"22222222-2222-2222-2222-222222222222",
         "rootMessageId":null,"name":"orphan","replyCount":0,
         "lastActivityAt":"2026-08-07T11:00:00.000Z","archived":true}
        """
        let thread = try Coding.decoder.decode(ThreadSummary.self, from: Data(json.utf8))
        XCTAssertNil(thread.rootMessageId)
        XCTAssertTrue(thread.archived)
    }

    /// A message's `thread` key is `.nullable().default(null)` server-side:
    /// null, and absent on an older server, must both read as "no thread".
    func testMessageThreadIsOptionalInBothDirections() throws {
        let base = """
        "id":"55555555-5555-5555-5555-555555555555",
        "channelId":"22222222-2222-2222-2222-222222222222",
        "authorId":"44444444-4444-4444-4444-444444444444",
        "authorName":"Ana","body":"oi","createdAt":"2026-08-07T11:00:00.000Z"
        """
        let absent = try Coding.decoder.decode(Message.self, from: Data("{\(base)}".utf8))
        XCTAssertNil(absent.thread)

        let explicitNull = try Coding.decoder.decode(
            Message.self, from: Data("{\(base),\"thread\":null}".utf8)
        )
        XCTAssertNil(explicitNull.thread)

        let present = try Coding.decoder.decode(Message.self, from: Data("""
        {\(base),"thread":{"channelId":"66666666-6666-6666-6666-666666666666",
         "parentChannelId":"22222222-2222-2222-2222-222222222222",
         "rootMessageId":"55555555-5555-5555-5555-555555555555",
         "name":"n","replyCount":1,"lastActivityAt":"2026-08-07T11:00:00.000Z",
         "archived":false}}
        """.utf8))
        XCTAssertEqual(present.thread?.replyCount, 1)

        // A thread payload this client cannot read costs the chip, never the
        // message — the body is the payload, the chip is an accessory.
        let malformed = try Coding.decoder.decode(
            Message.self, from: Data("{\(base),\"thread\":{\"id\":\"x\",\"messageCount\":3}}".utf8)
        )
        XCTAssertNil(malformed.thread)
        XCTAssertEqual(malformed.body, "oi")
    }

    /// The channel's thread list is derived from a history page, so the
    /// derivation has to dedupe and order without any help from the server.
    func testThreadDigestOrdersFreshestFirst() throws {
        let older = try message(id: "1", threadId: "a", at: "2026-08-01T10:00:00.000Z")
        let newer = try message(id: "2", threadId: "b", at: "2026-08-06T10:00:00.000Z")
        let duplicate = try message(id: "3", threadId: "b", at: "2026-08-06T10:00:00.000Z")

        let threads = ThreadDigest.threads(in: [older, newer, duplicate])
        XCTAssertEqual(threads.map(\.channelId), ["b", "a"])
        XCTAssertEqual(ThreadDigest.origins(in: [older, newer]).count, 2)
    }

    func testArchiveThresholdMatchesTheSharedRule() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let sixDays = now.addingTimeInterval(-6 * 24 * 3600)
        let eightDays = now.addingTimeInterval(-8 * 24 * 3600)
        XCTAssertFalse(ThreadRules.isArchived(sixDays, now: now))
        XCTAssertTrue(ThreadRules.isArchived(eightDays, now: now))
    }

    func testDerivedThreadNameFlattensAndTruncates() {
        XCTAssertEqual(ThreadRules.deriveName(from: "  hello\n  world "), "hello world")
        XCTAssertEqual(ThreadRules.deriveName(from: "   "), "thread")
        let long = String(repeating: "a", count: 200)
        let derived = ThreadRules.deriveName(from: long)
        XCTAssertEqual(derived.count, ThreadRules.nameMaxLength)
        XCTAssertTrue(derived.hasSuffix("…"))
    }

    // MARK: - Friends

    /// `GET /api/friends` in one read. `friendsSince` and `requestedAt` are ISO
    /// strings with milliseconds, which is the format that breaks the stock
    /// `.iso8601` strategy — so this also guards the shared decoder.
    func testFriendsResponseDecodes() throws {
        let json = """
        {"friends":[{"id":"44444444-4444-4444-4444-444444444444","displayName":"Ana",
          "username":"ana","tag":"ana#0001","avatarUrl":null,"status":"idle",
          "friendsSince":"2026-07-01T09:30:00.000Z"}],
         "incoming":[{"id":"77777777-7777-7777-7777-777777777777","displayName":"Bea",
          "username":"bea","tag":"bea#0002","avatarUrl":null,
          "requestedAt":"2026-08-05T09:30:00.000Z"}],
         "outgoing":[]}
        """
        let response = try Coding.decoder.decode(FriendsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.friends.first?.status, "idle")
        XCTAssertEqual(response.incoming.first?.tag, "bea#0002")
        XCTAssertTrue(response.outgoing.isEmpty)
        XCTAssertEqual(FriendsDigest.pendingActionCount(response), 1)
    }

    /// Idle and do-not-disturb are "around": the Online tab answers "who could
    /// I talk to", not "who is at their desk".
    func testOnlineCountsIdleAndDnd() {
        let friends = [
            friend(id: "1", status: "online"),
            friend(id: "2", status: "idle"),
            friend(id: "3", status: "dnd"),
            friend(id: "4", status: "offline"),
        ]
        XCTAssertEqual(FriendsDigest.online(friends).map(\.id), ["1", "2", "3"])
        XCTAssertEqual(FriendsDigest.onlineFirst(friends).map(\.id), ["1", "2", "3", "4"])
    }

    /// The badge counts requests waiting on YOU. Outgoing ones are a call to
    /// nothing.
    func testBadgeIgnoresOutgoing() {
        var response = FriendsResponse()
        response.outgoing = [request(id: "9")]
        XCTAssertEqual(FriendsDigest.pendingActionCount(response), 0)
        response.incoming = [request(id: "8")]
        XCTAssertEqual(FriendsDigest.pendingActionCount(response), 1)
    }

    /// Nobody already befriended, already asked, or already asking should be
    /// offered an "Add" button — and neither should you.
    func testAlreadyKnownCoversEveryRelationship() {
        var response = FriendsResponse()
        response.friends = [friend(id: "1", status: "online")]
        response.incoming = [request(id: "2")]
        response.outgoing = [request(id: "3")]
        let known = FriendsDigest.alreadyKnown(response, selfId: "me")
        XCTAssertEqual(known, ["1", "2", "3", "me"])
    }

    /// The two states `POST /api/friends` can answer with; anything else must
    /// not read as "you are friends now".
    func testFriendRequestResultStates() throws {
        let pending = try Coding.decoder.decode(
            FriendRequestResult.self, from: Data(#"{"state":"pending"}"#.utf8)
        )
        XCTAssertFalse(pending.isAccepted)
        let accepted = try Coding.decoder.decode(
            FriendRequestResult.self, from: Data(#"{"state":"accepted"}"#.utf8)
        )
        XCTAssertTrue(accepted.isAccepted)
    }

    // MARK: - Fixtures

    private func friend(id: String, status: String) -> Friend {
        Friend(id: id, displayName: "P\(id)", username: nil, tag: nil,
               avatarUrl: nil, status: status, friendsSince: Date())
    }

    private func request(id: String) -> FriendRequestEntry {
        FriendRequestEntry(id: id, displayName: "P\(id)", username: nil, tag: nil,
                           avatarUrl: nil, requestedAt: Date())
    }

    private func message(id: String, threadId: String, at: String) throws -> Message {
        let json = """
        {"id":"\(id)","channelId":"c","authorId":"a","authorName":"Ana","body":"b",
         "createdAt":"2026-08-01T10:00:00.000Z",
         "thread":{"channelId":"\(threadId)","parentChannelId":"c","rootMessageId":"\(id)",
          "name":"t","replyCount":1,"lastActivityAt":"\(at)","archived":false}}
        """
        return try Coding.decoder.decode(Message.self, from: Data(json.utf8))
    }
}

/// Opening a thread is the one moment the app fetches an empty history and the
/// person is *already typing into it* — a thread exists to be said something in.
/// That made `ChatModel.open` the place where a page landing after a send wiped
/// the send: the server had the message, the transcript did not, and no amount
/// of scrolling brought it back. Reported from TestFlight build 7 as "started a
/// thread and sent a message but that failed".
@MainActor
final class ChatHistoryMergeTests: XCTestCase {
    private func stored(id: String, body: String) throws -> Message {
        let json = """
        {"id":"\(id)","channelId":"c","authorId":"a","authorName":"Ana","body":"\(body)",
         "createdAt":"2026-08-01T10:00:00.000Z"}
        """
        return try Coding.decoder.decode(Message.self, from: Data(json.utf8))
    }

    private func pendingRow(_ body: String) throws -> Message {
        let author = try Coding.decoder.decode(
            CurrentUser.self,
            from: Data(#"{"id":"a","clerkId":"ck","displayName":"Ana"}"#.utf8)
        )
        return Message(pendingBody: body, channelId: "c", author: author)
    }

    /// The bug: a history page requested when the thread opened, answered after
    /// the first message was sent into it.
    func testAPageThatPredatesASendDoesNotSwallowIt() throws {
        let inFlight = try pendingRow("first thing said in the thread")
        let merged = ChatModel.merge(page: [], with: [inFlight])
        XCTAssertEqual(merged.map(\.id), [inFlight.id],
                       "An empty page must not erase a message already on its way to the server")
    }

    /// Same window, one beat later: the broadcast already retired the optimistic
    /// row, so what the page would erase is a *confirmed* message.
    func testAPageDoesNotSwallowAMessageTheBroadcastAlreadyConfirmed() throws {
        let history = try stored(id: "00000000-0000-4000-8000-000000000001", body: "older")
        let live = try stored(id: "00000000-0000-4000-8000-00000000000f", body: "arrived mid-fetch")
        let merged = ChatModel.merge(page: [history], with: [live])
        XCTAssertEqual(merged.map(\.id), [history.id, live.id],
                       "A message that arrived while the page was in flight belongs after it")
    }

    /// And the other direction: a page that already contains what is on screen
    /// must not double it, or `ForEach(id: \.id)` gets two rows with one identity.
    func testAPageThatAlreadyContainsALocalMessageDoesNotDuplicateIt() throws {
        let message = try stored(id: "00000000-0000-4000-8000-000000000002", body: "once")
        let merged = ChatModel.merge(page: [message], with: [message])
        XCTAssertEqual(merged.count, 1, "The same message must not appear twice")
    }
}
