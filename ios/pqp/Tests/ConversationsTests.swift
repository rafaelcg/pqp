import XCTest
@testable import pqp

/// Conversas: the switches, the list rules, the preview line, typing in the
/// list and the landing tab. Ports of the web's `conversation-list.ts`,
/// `conversation-typing.ts`, `phone-tabs.ts` and `formatMessagePreview`, so
/// the cases below mirror the web tests where one exists.
final class ConversationsTests: XCTestCase {
    private let me = "00000000-0000-4000-8000-000000000001"
    private let rafa = PublicUser(id: "00000000-0000-4000-8000-000000000002", displayName: "Rafa Souza",
                                  username: "rafa", tag: "rafa#0001", avatarUrl: nil)
    private let joao = PublicUser(id: "00000000-0000-4000-8000-000000000003", displayName: "João",
                                  username: "joao", tag: "joao#0002", avatarUrl: nil)

    private func dm(_ id: String, _ people: [PublicUser], kind: String = "dm", at: TimeInterval = 0,
                    unread: Int = 0, last: DmLastMessage? = nil) -> DmSummary {
        DmSummary(channelId: id, kind: kind, participants: people,
                  lastMessageAt: Date(timeIntervalSince1970: at),
                  unread: DmUnread(count: unread, mentions: 0), lastMessage: last)
    }

    // MARK: - Config

    func testDmsConfigDecodesBothSwitches() throws {
        let on = try Coding.decoder.decode(DmsConfig.self, from: Data(#"{"home":true,"phoneTabs":true}"#.utf8))
        XCTAssertEqual(on, DmsConfig(home: true, phoneTabs: true))
        XCTAssertTrue(on.phoneTabs)
    }

    /// The server answers phoneTabs false while home is off; the client says
    /// so again, so an API that forgot cannot turn on half a layout.
    func testPhoneTabsNeverOutlivesHome() throws {
        let half = try Coding.decoder.decode(DmsConfig.self, from: Data(#"{"home":false,"phoneTabs":true}"#.utf8))
        XCTAssertFalse(half.phoneTabs)
        XCTAssertFalse(half.home)
    }

    /// Anything but an explicit true is off: an empty or odd answer is today's hub.
    func testMissingOrNonBooleanSwitchesAreOff() throws {
        let empty = try Coding.decoder.decode(DmsConfig.self, from: Data("{}".utf8))
        XCTAssertEqual(empty, .off)
        let odd = try Coding.decoder.decode(DmsConfig.self, from: Data(#"{"home":"yes","phoneTabs":1}"#.utf8))
        XCTAssertEqual(odd, .off)
    }

    func testDmsConfigRoundTripsThroughDefaults() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "conversas-config-test"))
        defaults.removePersistentDomain(forName: "conversas-config-test")
        XCTAssertEqual(DmsConfig.load(from: defaults), .off)
        DmsConfig(home: true, phoneTabs: true).save(to: defaults)
        XCTAssertEqual(DmsConfig.load(from: defaults), DmsConfig(home: true, phoneTabs: true))
        DmsConfig(home: true, phoneTabs: false).save(to: defaults)
        XCTAssertEqual(DmsConfig.load(from: defaults), DmsConfig(home: true, phoneTabs: false))
        DmsConfig.off.save(to: defaults)
        XCTAssertEqual(DmsConfig.load(from: defaults), .off)
    }

    // MARK: - Landing tab

    func testLandingIsServidoresWithNothingStored() {
        XCTAssertEqual(PhoneTab.landing(stored: nil, arrivedForPerson: false), .servidores)
    }

    func testLandingIsTheLastTabUsed() {
        XCTAssertEqual(PhoneTab.landing(stored: .tu, arrivedForPerson: false), .tu)
        XCTAssertEqual(PhoneTab.landing(stored: .conversas, arrivedForPerson: false), .conversas)
    }

    func testArrivingForAPersonLandsOnConversas() {
        XCTAssertEqual(PhoneTab.landing(stored: .servidores, arrivedForPerson: true), .conversas)
        XCTAssertEqual(PhoneTab.landing(stored: nil, arrivedForPerson: true), .conversas)
    }

    // MARK: - Decoding the list

    /// The preview the API has sent for months, which this app used to drop.
    func testDmSummaryDecodesThePreview() throws {
        let json = """
        {"channelId":"c1","kind":"dm","participants":[],"lastMessageAt":"2026-10-11T20:41:00.000Z",
         "unread":{"count":2,"mentions":0},
         "lastMessage":{"authorId":"a","authorName":"Rafa","preview":"fechou, chama a galera",
                        "isAttachment":false,"isGif":false,"isVoice":false,"voiceDurationMs":null}}
        """
        let summary = try Coding.decoder.decode(DmSummary.self, from: Data(json.utf8))
        XCTAssertEqual(summary.lastMessage?.preview, "fechou, chama a galera")
        XCTAssertEqual(summary.lastMessage?.authorName, "Rafa")
        XCTAssertEqual(summary.unread.count, 2)
    }

    /// An older server omits the key; previews off sends null.
    func testDmSummaryWithoutAPreviewStillDecodes() throws {
        let absent = #"{"channelId":"c1","kind":"dm","participants":[],"lastMessageAt":null,"unread":{"count":0,"mentions":0}}"#
        XCTAssertNil(try Coding.decoder.decode(DmSummary.self, from: Data(absent.utf8)).lastMessage)
        let null = #"{"channelId":"c1","kind":"dm","participants":[],"lastMessageAt":null,"unread":{"count":0,"mentions":0},"lastMessage":null}"#
        XCTAssertNil(try Coding.decoder.decode(DmSummary.self, from: Data(null.utf8)).lastMessage)
    }

    /// A preview this build cannot read costs the preview, never the list.
    func testAMalformedPreviewDoesNotLoseTheConversation() throws {
        let json = #"{"channelId":"c1","kind":"dm","participants":[],"lastMessageAt":null,"unread":{"count":0,"mentions":0},"lastMessage":{"preview":42}}"#
        let summary = try Coding.decoder.decode(DmSummary.self, from: Data(json.utf8))
        XCTAssertEqual(summary.channelId, "c1")
        XCTAssertNil(summary.lastMessage)
    }

    // MARK: - The preview line

    func testOwnMessageIsPrefixedWithTu() {
        let row = dm("c1", [rafa], last: DmLastMessage(authorId: me, authorName: "Eu", preview: "bora", isAttachment: false, isGif: false))
        XCTAssertEqual(MessagePreviewText.line(for: row, viewerId: me), String(localized: "you: \("bora")"))
    }

    func testGroupPrefixesTheAuthorsFirstName() {
        let row = dm("c1", [rafa, joao], kind: "group",
                     last: DmLastMessage(authorId: rafa.id, authorName: "Rafa Souza", preview: "quem leva o violão?", isAttachment: false, isGif: false))
        XCTAssertEqual(MessagePreviewText.line(for: row, viewerId: me), "Rafa: quem leva o violão?")
    }

    func testOneToOneShowsThePreviewAlone() {
        let row = dm("c1", [rafa], last: DmLastMessage(authorId: rafa.id, authorName: "Rafa", preview: "oi", isAttachment: false, isGif: false))
        XCTAssertEqual(MessagePreviewText.line(for: row, viewerId: me), "oi")
    }

    func testAttachmentGifAndVoiceAreLabels() {
        let file = dm("c1", [rafa], last: DmLastMessage(authorId: rafa.id, authorName: "Rafa", preview: "", isAttachment: true, isGif: false))
        XCTAssertEqual(MessagePreviewText.line(for: file, viewerId: me), String(localized: "Sent a file"))
        let gif = dm("c1", [rafa], last: DmLastMessage(authorId: rafa.id, authorName: "Rafa", preview: "", isAttachment: true, isGif: true))
        XCTAssertEqual(MessagePreviewText.line(for: gif, viewerId: me), String(localized: "Sent a GIF"))
        let voice = dm("c1", [rafa], last: DmLastMessage(authorId: rafa.id, authorName: "Rafa", preview: "", isAttachment: true, isGif: false, isVoice: true, voiceDurationMs: 12_400))
        XCTAssertEqual(MessagePreviewText.line(for: voice, viewerId: me), String(localized: "Voice message · \("0:12")"))
    }

    func testNoPreviewIsNoLine() {
        XCTAssertNil(MessagePreviewText.line(for: dm("c1", [rafa]), viewerId: me))
    }

    /// The same redaction as `buildMessagePreview` in packages/shared.
    func testMarkdownIsStrippedLikeTheServer() {
        XCTAssertEqual(MessagePreviewText.stripMarkdown("**olha** [isso](https://x.y)\n> `code` ~~não~~"), "olha isso code não")
        let long = String(repeating: "a", count: 200)
        let cut = MessagePreviewText.truncate(long)
        XCTAssertEqual(cut.count, 140)
        XCTAssertTrue(cut.hasSuffix("…"))
    }

    // MARK: - Filters, search, Fixadas, badge

    func testSearchFoldsAccentsAndMatchesUsernameAndTag() {
        let row = dm("c1", [joao])
        XCTAssertTrue(ConversationList.matches(row, query: "joao"))
        XCTAssertTrue(ConversationList.matches(row, query: "JOÃO"))
        XCTAssertTrue(ConversationList.matches(row, query: "#0002"))
        XCTAssertFalse(ConversationList.matches(row, query: "rafa"))
        XCTAssertTrue(ConversationList.matches(row, query: "   "))
    }

    func testChipsFilterUnreadAndGroups() {
        let list = [
            dm("a", [rafa], unread: 3),
            dm("b", [joao]),
            dm("c", [rafa, joao], kind: "group", unread: 1),
        ]
        XCTAssertEqual(ConversationList.filter(list, query: "", filter: .all).map(\.channelId), ["a", "b", "c"])
        XCTAssertEqual(ConversationList.filter(list, query: "", filter: .unread).map(\.channelId), ["a", "c"])
        XCTAssertEqual(ConversationList.filter(list, query: "", filter: .groups).map(\.channelId), ["c"])
        XCTAssertEqual(ConversationList.filter(list, query: "jo", filter: .unread).map(\.channelId), ["c"])
    }

    func testPinnedKeepPinOrderAndLeaveTheRestInRecencyOrder() {
        let list = [dm("a", [rafa]), dm("b", [joao]), dm("c", [rafa, joao], kind: "group")]
        let split = ConversationList.splitPinned(list, pinnedIds: ["c", "missing", "a", "c"])
        XCTAssertEqual(split.pinned.map(\.channelId), ["c", "a"])
        XCTAssertEqual(split.recent.map(\.channelId), ["b"])
    }

    /// Three people writing forty lines is 3.
    func testTheBadgeCountsConversationsNotMessages() {
        let list = [dm("a", [rafa], unread: 40), dm("b", [joao], unread: 1), dm("c", [rafa]), dm("d", [joao], unread: 100)]
        XCTAssertEqual(ConversationList.waitingCount(list), 3)
    }

    // MARK: - Live updates

    func testActivityBumpsUnreadMovesTheRowAndTakesThePreview() throws {
        let list = [dm("a", [rafa], at: 200), dm("b", [joao], at: 100, unread: 1)]
        let next = try XCTUnwrap(ConversationList.applyingActivity(
            list, channelId: "b", mention: true,
            preview: ConversationActivityPreview(authorId: joao.id, authorName: "João", preview: "e aí"),
            now: Date(timeIntervalSince1970: 300)
        ))
        XCTAssertEqual(next.map(\.channelId), ["b", "a"])
        XCTAssertEqual(next[0].unread, DmUnread(count: 2, mentions: 1))
        XCTAssertEqual(next[0].lastMessage?.preview, "e aí")
    }

    /// The server stops counting at 100; a live bump must too.
    func testActivityNeverCountsPastTheServersCap() throws {
        let list = [dm("a", [rafa], unread: 100)]
        let next = try XCTUnwrap(ConversationList.applyingActivity(list, channelId: "a", mention: false, preview: nil))
        XCTAssertEqual(next[0].unread.count, 100)
    }

    /// Previews off: the frame names the author but carries no text, and the
    /// old line must not stay up claiming to be the newest message.
    func testActivityWithPreviewsOffDropsTheOldLine() throws {
        let list = [dm("a", [rafa], last: DmLastMessage(authorId: rafa.id, authorName: "Rafa", preview: "velha", isAttachment: false, isGif: false))]
        let next = try XCTUnwrap(ConversationList.applyingActivity(
            list, channelId: "a", mention: false,
            preview: ConversationActivityPreview(authorId: rafa.id, authorName: "Rafa", preview: nil)
        ))
        XCTAssertNil(next[0].lastMessage)
    }

    func testActivityForAnUnknownConversationAsksForARefetch() {
        XCTAssertNil(ConversationList.applyingActivity([dm("a", [rafa])], channelId: "zzz", mention: false, preview: nil))
    }

    // MARK: - Typing in the list

    func testTypingShowsThenExpiresAfterFiveSeconds() {
        var typing = ConversationTyping()
        let t0 = Date(timeIntervalSince1970: 1_000)
        XCTAssertTrue(typing.note(channelId: "a", userId: rafa.id, name: "Rafa", viewerId: me, now: t0))
        XCTAssertEqual(typing.names(in: "a", now: t0.addingTimeInterval(4.9)), ["Rafa"])
        XCTAssertEqual(typing.names(in: "a", now: t0.addingTimeInterval(5.1)), [])
        XCTAssertTrue(typing.prune(now: t0.addingTimeInterval(5.1)))
        XCTAssertTrue(typing.isEmpty)
    }

    func testOwnTypingIsDropped() {
        var typing = ConversationTyping()
        XCTAssertFalse(typing.note(channelId: "a", userId: me, name: "Eu", viewerId: me))
        XCTAssertTrue(typing.isEmpty)
    }

    /// Somebody still typing sends a frame every couple of seconds: that only
    /// moves their expiry, which the list does not draw.
    func testARepeatFrameIsNotARedraw() {
        var typing = ConversationTyping()
        let t0 = Date(timeIntervalSince1970: 1_000)
        XCTAssertTrue(typing.note(channelId: "a", userId: rafa.id, name: "Rafa", viewerId: me, now: t0))
        XCTAssertFalse(typing.note(channelId: "a", userId: rafa.id, name: "Rafa", viewerId: me, now: t0.addingTimeInterval(2)))
        XCTAssertEqual(typing.names(in: "a", now: t0.addingTimeInterval(6)), ["Rafa"])
    }

    func testTheirMessageEndsTheTypingAtOnce() {
        var typing = ConversationTyping()
        typing.note(channelId: "a", userId: rafa.id, name: "Rafa", viewerId: me)
        typing.note(channelId: "a", userId: joao.id, name: "João", viewerId: me)
        XCTAssertTrue(typing.clear(channelId: "a", userId: rafa.id))
        XCTAssertEqual(typing.names(in: "a"), ["João"])
        XCTAssertFalse(typing.clear(channelId: "a", userId: rafa.id))
    }

    // MARK: - Time

    func testRowTimeIsClockTodayAndYesterdayAfter() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Sao_Paulo")!
        let locale = Locale(identifier: "pt_BR")
        let now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 12, hour: 21))!
        let today = calendar.date(from: DateComponents(year: 2026, month: 10, day: 12, hour: 20, minute: 41))!
        let yesterday = calendar.date(from: DateComponents(year: 2026, month: 10, day: 11, hour: 9))!
        let old = calendar.date(from: DateComponents(year: 2026, month: 9, day: 3, hour: 9))!
        XCTAssertEqual(ConversationTime.label(for: today, now: now, calendar: calendar, locale: locale), "20:41")
        XCTAssertEqual(ConversationTime.label(for: yesterday, now: now, calendar: calendar, locale: locale), String(localized: "yesterday"))
        XCTAssertEqual(ConversationTime.label(for: old, now: now, calendar: calendar, locale: locale), "03/09")
    }
}
