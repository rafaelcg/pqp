import XCTest
@testable import pqp

/// The rules behind the live channel list (A1) and the Baú preview (M2):
/// what a row says about unread, mute and private; what a folded section
/// says; who is drawn under a voice room; and which shape the Baú takes.
final class ChannelListLiveTests: XCTestCase {

    // MARK: - Fixtures

    private let serverId = "99999999-2222-4333-8444-555555555555"

    private func channel(_ id: String, type: String = "text") throws -> Channel {
        let json = #"{"id":"\#(id)","serverId":"\#(serverId)","kind":"server","name":"c-\#(id.prefix(4))","type":"\#(type)","position":0,"isPrivate":false,"topic":null,"imageUrl":null,"parentId":null}"#
        return try JSONDecoder().decode(Channel.self, from: Data(json.utf8))
    }

    private func peer(_ id: String) throws -> VoiceParticipant {
        let json = #"{"peerId":"\#(id)","userId":"user-\#(id)","displayName":"\#(id)","avatarUrl":null}"#
        return try JSONDecoder().decode(VoiceParticipant.self, from: Data(json.utf8))
    }

    private func preferences(channels: [String: String]? = nil, servers: [String: String]? = nil) -> UserPreferences {
        var prefs = UserPreferences()
        prefs.notifications = NotificationPreferences(desktop: nil, default: nil, servers: servers, channels: channels)
        return prefs
    }

    // MARK: - Unread and mute

    func testUnreadIsBoldWithNoNumberAndAMentionIsCounted() {
        let plain = ChannelUnreadMark.resolve(unread: UnreadEntry(channelId: "a", count: 4, mentions: 0), isMuted: false)
        XCTAssertEqual(plain, ChannelUnreadMark(isUnread: true, mentions: 0))

        let mentioned = ChannelUnreadMark.resolve(unread: UnreadEntry(channelId: "a", count: 4, mentions: 3), isMuted: false)
        XCTAssertEqual(mentioned, ChannelUnreadMark(isUnread: true, mentions: 3))

        XCTAssertEqual(ChannelUnreadMark.resolve(unread: nil, isMuted: false), .none)
        XCTAssertEqual(ChannelUnreadMark.resolve(unread: UnreadEntry(channelId: "a", count: 0, mentions: 0), isMuted: false), .none)
    }

    func testAMutedChannelIsNeverBoldNorTickedEvenWithAMention() {
        let mark = ChannelUnreadMark.resolve(unread: UnreadEntry(channelId: "a", count: 9, mentions: 2), isMuted: true)
        XCTAssertEqual(mark, .none)
    }

    func testTheChannelsOwnLevelWinsOverTheServers() {
        let channelId = "c1"
        XCTAssertTrue(ChannelMute.isMuted(channelId: channelId, serverId: serverId,
                                          preferences: preferences(channels: [channelId: "none"])))
        XCTAssertTrue(ChannelMute.isMuted(channelId: channelId, serverId: serverId,
                                          preferences: preferences(servers: [serverId: "none"])))
        // Turned back on for one channel inside a muted server.
        XCTAssertFalse(ChannelMute.isMuted(channelId: channelId, serverId: serverId,
                                           preferences: preferences(channels: [channelId: "all"], servers: [serverId: "none"])))
        XCTAssertFalse(ChannelMute.isMuted(channelId: channelId, serverId: serverId,
                                           preferences: preferences(channels: [channelId: "mentions"])))
        XCTAssertFalse(ChannelMute.isMuted(channelId: channelId, serverId: serverId, preferences: UserPreferences()))
    }

    // MARK: - Sections

    func testAFoldedSectionCountsItsChannelsAndIgnoresMutedUnread() throws {
        let loud = try channel("11111111-2222-4333-8444-555555555555")
        let muted = try channel("22222222-2222-4333-8444-555555555555")
        let unread = [
            muted.id: UnreadEntry(channelId: muted.id, count: 5, mentions: 1),
        ]
        let quiet = ChannelSectionSummary.make(channels: [loud, muted], unread: unread) { $0.id == muted.id }
        XCTAssertEqual(quiet, ChannelSectionSummary(channelCount: 2, hasUnread: false))

        var withLoud = unread
        withLoud[loud.id] = UnreadEntry(channelId: loud.id, count: 1, mentions: 0)
        let dotted = ChannelSectionSummary.make(channels: [loud, muted], unread: withLoud) { $0.id == muted.id }
        XCTAssertTrue(dotted.hasUnread)
    }

    func testFoldingIsRememberedPerServerAndUnfoldingLeavesNothingBehind() throws {
        let suite = "pqp.tests.collapsed.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = CollapsedSections(defaults: defaults)

        XCTAssertEqual(store.load(serverId: "s1"), [])
        XCTAssertEqual(store.toggle("cat-1", serverId: "s1"), ["cat-1"])
        XCTAssertEqual(store.toggle(CollapsedSections.voiceKey, serverId: "s1"), ["cat-1", "voice"])
        XCTAssertEqual(store.load(serverId: "s1"), ["cat-1", "voice"])
        XCTAssertEqual(store.load(serverId: "s2"), [], "another server keeps its own sections")

        store.toggle("cat-1", serverId: "s1")
        store.toggle(CollapsedSections.voiceKey, serverId: "s1")
        XCTAssertEqual(store.load(serverId: "s1"), [])
        XCTAssertNil(defaults.object(forKey: "pqp.channelList.collapsed.s1"))
    }

    // MARK: - Who is in a room

    func testUpToThreePeopleAreListedByNameAndPastThatTwoPlusTheRest() throws {
        let three = try ["a", "b", "c"].map(peer)
        let summary = VoiceOccupantSummary(three)
        XCTAssertEqual(summary.listed.map(\.peerId), ["a", "b", "c"])
        XCTAssertEqual(summary.overflowCount, 0)
        XCTAssertTrue(summary.overflowFaces.isEmpty)

        let five = try ["a", "b", "c", "d", "e"].map(peer)
        let folded = VoiceOccupantSummary(five)
        XCTAssertEqual(folded.listed.map(\.peerId), ["a", "b"])
        XCTAssertEqual(folded.overflowCount, 3)
        XCTAssertEqual(folded.overflowFaces.map(\.peerId), ["c", "d", "e"])

        let crowd = try (0..<200).map { try peer("p\($0)") }
        let big = VoiceOccupantSummary(crowd)
        XCTAssertEqual(big.overflowCount, 198)
        XCTAssertEqual(big.overflowFaces.count, 3, "only the faces drawn are copied")

        XCTAssertTrue(VoiceOccupantSummary([]).listed.isEmpty)
    }

    @MainActor
    func testOccupancyFollowsRostersAndForgetsEverythingOnANewSocket() throws {
        let store = VoiceOccupancyStore()
        store.apply(.voiceRoster(voiceChannelId: "lobby", participants: try ["a", "b"].map(peer)))
        store.apply(.voiceRoster(voiceChannelId: "ranked", participants: try ["c"].map(peer)))
        XCTAssertEqual(store.participants(in: "lobby").map(\.peerId), ["a", "b"])
        XCTAssertEqual(store.headcount(in: ["lobby", "ranked", "empty"]), 3)

        // A room that empties is dropped, not kept as an empty list.
        store.apply(.voiceRoster(voiceChannelId: "ranked", participants: []))
        XCTAssertTrue(store.participants(in: "ranked").isEmpty)
        XCTAssertNil(store.rooms["ranked"])

        // A new socket gets fresh rosters; anything held is a ghost.
        store.apply(.ready)
        XCTAssertTrue(store.rooms.isEmpty)
    }

    // MARK: - Baú

    private func latestJSON(unread: Int, posts: String) -> Data {
        Data(#"{"unread":\#(unread),"lastSeenAt":"2026-10-10T12:00:00.000Z","posts":[\#(posts)]}"#.utf8)
    }

    private func postJSON(_ id: String, isNew: Bool, mediaKind: String? = nil, mediaUrl: String? = nil,
                          posterUrl: String? = nil, locked: Bool = false) -> String {
        let kind = mediaKind.map { "\"\($0)\"" } ?? "null"
        let media = mediaUrl.map { "\"\($0)\"" } ?? "null"
        let poster = posterUrl.map { ",\"posterUrl\":\"\($0)\"" } ?? ""
        return #"{"postId":"\#(id)","serverId":"\#(serverId)","serverName":"QG","title":"Post \#(id)","teaser":null,"author":{"id":"u1","displayName":"Bia","avatarUrl":null},"mediaKind":\#(kind),"mediaUrl":\#(media),"visibility":"free","locked":\#(locked),"pinned":false,"likeCount":23,"commentCount":8,"publishedAt":"2026-10-11T18:46:00.000Z","isNew":\#(isNew)\#(poster)}"#
    }

    private func decode(_ data: Data) throws -> CommunityHomeLatest {
        try Coding.decoder.decode(CommunityHomeLatest.self, from: data)
    }

    func testTheLatestResponseDecodesTheChatCardPlusIsNew() throws {
        let latest = try decode(latestJSON(unread: 2, posts: [
            postJSON("p1", isNew: true, mediaKind: "youtube", mediaUrl: "https://i.ytimg.com/vi/x/hqdefault.jpg"),
            postJSON("p2", isNew: true),
            postJSON("p3", isNew: false),
        ].joined(separator: ",")))
        XCTAssertEqual(latest.unread, 2)
        XCTAssertEqual(latest.posts.map(\.id), ["p1", "p2", "p3"])
        XCTAssertEqual(latest.posts[0].card.title, "Post p1")
        XCTAssertEqual(latest.posts[0].card.likeCount, 23)
        XCTAssertTrue(latest.posts[0].isNew)
        XCTAssertFalse(latest.posts[2].isNew)
        XCTAssertNotNil(latest.posts[0].publishedDate)
    }

    func testSomethingNewIsACardThatSaysWhatIsBehindIt() throws {
        let latest = try decode(latestJSON(unread: 5, posts: [
            postJSON("p1", isNew: true), postJSON("p2", isNew: true), postJSON("p3", isNew: false),
        ].joined(separator: ",")))
        let mode = BauPreviewMode.resolve(answer: .ok(latest), legacyUnread: 0, canPost: false)
        guard case .fresh(let lead, let moreNew, let next) = mode else { return XCTFail("expected the card, got \(mode)") }
        XCTAssertEqual(lead.id, "p1")
        XCTAssertEqual(moreNew, 4, "the unread count outranks the three posts the response carries")
        XCTAssertEqual(next?.id, "p2")
    }

    func testSeenShrinksToTheRowWithTheNewestPost() throws {
        let latest = try decode(latestJSON(unread: 0, posts: [
            postJSON("p1", isNew: false), postJSON("p2", isNew: false),
        ].joined(separator: ",")))
        XCTAssertEqual(
            BauPreviewMode.resolve(answer: .ok(latest), legacyUnread: 0, canPost: true),
            .seen(latest.posts[0], unread: 0)
        )
    }

    func testTheViewersOwnNewestPostDoesNotHideSomebodyElsesNewOne() throws {
        // p1 is the viewer's own (never new); p2 underneath is new.
        let latest = try decode(latestJSON(unread: 1, posts: [
            postJSON("p1", isNew: false), postJSON("p2", isNew: true), postJSON("p3", isNew: false),
        ].joined(separator: ",")))
        let mode = BauPreviewMode.resolve(answer: .ok(latest), legacyUnread: 0, canPost: true)
        guard case .fresh(let lead, let moreNew, let next) = mode else { return XCTFail("expected the card, got \(mode)") }
        XCTAssertEqual(lead.id, "p2")
        XCTAssertEqual(moreNew, 0)
        XCTAssertNil(next)
    }

    func testNewPostsBeyondTheLimitStillBadgeTheRow() throws {
        let latest = try decode(latestJSON(unread: 2, posts: [
            postJSON("own1", isNew: false), postJSON("own2", isNew: false), postJSON("own3", isNew: false),
        ].joined(separator: ",")))
        XCTAssertEqual(
            BauPreviewMode.resolve(answer: .ok(latest), legacyUnread: 0, canPost: true),
            .seen(latest.posts[0], unread: 2)
        )
    }

    func testAnEmptyBauInvitesStaffAndStaysQuietForMembers() throws {
        let latest = try decode(latestJSON(unread: 0, posts: ""))
        XCTAssertEqual(BauPreviewMode.resolve(answer: .ok(latest), legacyUnread: 0, canPost: true), .empty(canPost: true))
        XCTAssertEqual(BauPreviewMode.resolve(answer: .ok(latest), legacyUnread: 0, canPost: false), .empty(canPost: false))
    }

    func testAnOlderApiKeepsTodaysRowAndCount() {
        XCTAssertEqual(BauPreviewMode.resolve(answer: .unsupported, legacyUnread: 3, canPost: true), .legacy(unread: 3))
        XCTAssertEqual(BauPreviewMode.resolve(answer: nil, legacyUnread: 3, canPost: true), .loading)
    }

    func testTheThumbnailNeverPullsAFrameOutOfAVideo() throws {
        let latest = try decode(latestJSON(unread: 0, posts: [
            postJSON("upload", isNew: false, mediaKind: "video", mediaUrl: "https://r2.example/v.mp4"),
            postJSON("cover", isNew: false, mediaKind: "video", mediaUrl: "https://r2.example/v.mp4",
                     posterUrl: "https://r2.example/cover.jpg"),
            postJSON("locked", isNew: false, mediaKind: "video", posterUrl: "https://r2.example/cover.jpg", locked: true),
            postJSON("photo", isNew: false, mediaKind: "image", mediaUrl: "https://r2.example/p.jpg"),
            postJSON("text", isNew: false),
        ].joined(separator: ",")))
        XCTAssertEqual(latest.posts[0].thumbnail, .plate)
        XCTAssertEqual(latest.posts[1].thumbnail, .image(URL(string: "https://r2.example/cover.jpg")!))
        XCTAssertEqual(latest.posts[2].thumbnail, .plate, "a locked post's cover is not drawn")
        XCTAssertEqual(latest.posts[3].thumbnail, .image(URL(string: "https://r2.example/p.jpg")!))
        XCTAssertEqual(latest.posts[4].thumbnail, .none)
    }
}
