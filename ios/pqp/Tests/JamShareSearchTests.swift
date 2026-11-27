import XCTest
@testable import pqp

// What the second slice of phone parity adds around the take notices: the card
// that waits while a song is open, the share message and link of a song, and the
// wall's search. Shares `makePublicSession` and `songId` with `JamPublicTests`.

// MARK: - The card waits while a song is open

@MainActor
final class JamNoticeHoldTests: XCTestCase {
    func testACardIsHeldWhileAnySongIsOpenAndComesBackWhenTheLastClosed() {
        let store = JamPublicStore()
        XCTAssertFalse(store.cardsAreHeld)
        store.songOpened("a")
        store.songOpened("b")
        store.songOpened("a")
        XCTAssertTrue(store.cardsAreHeld, "never over a transport")
        store.songClosed("a")
        XCTAssertTrue(store.cardsAreHeld, "one song is still open")
        store.songClosed("b")
        XCTAssertFalse(store.cardsAreHeld)
    }
}

// MARK: - Sharing a song

final class JamShareTests: XCTestCase {
    private func song(
        _ mode: JamJoinMode, wanted: [JamInstrument] = [], present: [JamInstrument] = []
    ) -> JamSongSummary {
        JamSongSummary(
            id: songId, channelId: "c", serverId: "s", title: "Lua cheia", joinMode: mode,
            wantedInstruments: wanted, instruments: present
        )
    }

    private func track(_ instrument: JamInstrument, author: String, inMix: Bool) -> JamTrack {
        JamTrack(id: UUID().uuidString, songId: songId, authorId: author, instrument: instrument, inMix: inMix)
    }

    func testASongAsksOnlyForWhatIsStillMissing() {
        XCTAssertEqual(JamShare.stillNeeds(song(.wanted, wanted: [.bass, .drums], present: [.guitar])), [.bass, .drums])
        XCTAssertEqual(JamShare.stillNeeds(song(.wanted, wanted: [.bass, .drums], present: [.bass])), [.drums])
        XCTAssertEqual(
            JamShare.stillNeeds(song(.wanted, wanted: [.bass, .drums]), pending: [.drums]), [.bass],
            "the sharer cannot ask their friends for the part they just sent"
        )
        XCTAssertEqual(JamShare.stillNeeds(song(.open, wanted: [.bass])), [])
        XCTAssertEqual(JamShare.stillNeeds(song(.closed, wanted: [.bass])), [])
    }

    func testThePartsThatWaitAreTheViewersOwnOutOfTheMixOnASongTheyDidNotStart() {
        let tracks = [
            track(.drums, author: "me", inMix: false), track(.drums, author: "me", inMix: false),
            track(.bass, author: "me", inMix: true), track(.keys, author: "you", inMix: false),
        ]
        XCTAssertEqual(JamShare.pending(tracks: tracks, viewerId: "me", isStarter: false), [.drums])
        XCTAssertEqual(JamShare.pending(tracks: tracks, viewerId: "me", isStarter: true), [], "the starter's own parts are in")
        XCTAssertEqual(JamShare.pending(tracks: tracks, viewerId: nil, isStarter: false), [])
    }

    func testTheKindFollowsTheJoinModeAndWhatIsMissing() {
        XCTAssertEqual(JamShare.kind(joinMode: .wanted, needs: [.bass]), .needs)
        XCTAssertEqual(JamShare.kind(joinMode: .wanted, needs: []), .listen)
        XCTAssertEqual(JamShare.kind(joinMode: .open, needs: []), .open)
        XCTAssertEqual(JamShare.kind(joinMode: .closed, needs: [.bass]), .listen)
    }

    func testTheMessageAsksForTheMissingPart() {
        XCTAssertEqual(
            JamShare.text(song: song(.wanted, wanted: [.bass], present: [.guitar]), pending: []),
            "Lua cheia: it needs bass. Record your part:"
        )
        XCTAssertEqual(
            JamShare.text(song: song(.wanted, wanted: [.bass, .drums]), pending: []),
            "Lua cheia: it needs bass and drums. Record your part:"
        )
        XCTAssertEqual(JamShare.text(song: song(.open), pending: []), "Lua cheia: a jam open to anyone. Come record a part:")
        XCTAssertEqual(JamShare.text(song: song(.closed), pending: []), "Lua cheia: give this jam a listen:")
    }

    func testTheSendersOwnWaitingPartIsSaidAndNotAskedAgain() {
        XCTAssertEqual(
            JamShare.text(song: song(.wanted, wanted: [.bass, .drums]), pending: [.drums]),
            "Lua cheia: I sent my drums part, it joins once whoever started the jam accepts it. It still needs bass. Record yours:"
        )
    }

    func testNoMessageEverCarriesAMadeWithLineOrADash() {
        for mode in [JamJoinMode.open, .wanted, .closed] {
            let text = JamShare.text(song: song(mode, wanted: [.bass]), pending: [.drums])
            XCTAssertFalse(text.contains("\u{2014}"))
            XCTAssertFalse(text.lowercased().contains("made with"))
        }
    }

    func testATitleIsCleanedOfBidiControlsInTheMessage() {
        var hostile = song(.open)
        hostile.title = "\u{202E}Lua"
        XCTAssertFalse(JamShare.text(song: hostile, pending: []).unicodeScalars.contains { (0x202A...0x202E).contains($0.value) })
    }

    func testOnlyALiveSongGetsThePublicLinkAndItIsTheSitesPageTaggedAsAShare() {
        XCTAssertTrue(JamShare.isShareable(publicationStatus: "live"))
        for status in ["review", "hidden", "removed", "unpublished", nil] {
            XCTAssertFalse(JamShare.isShareable(publicationStatus: status), "\(String(describing: status)) has no public page")
        }
        let link = JamShare.publicLink(songId: songId)
        XCTAssertEqual(link?.absoluteString, "https://jam.pqp.gg/m/\(songId)?ref=share")
        XCTAssertFalse(link?.absoluteString.contains("/app/") ?? true, "a stranger cannot open an app address")
    }

    func testTheShareSheetGetsTheMessageThenTheLinkAsOneString() throws {
        let link = try XCTUnwrap(JamShare.publicLink(songId: songId))
        XCTAssertEqual(
            JamShare.shareItem(text: "Lua cheia: give this jam a listen:", link: link),
            "Lua cheia: give this jam a listen: https://jam.pqp.gg/m/\(songId)?ref=share"
        )
    }

    func testAPrivateSongKeepsTheChannelLink() {
        XCTAssertEqual(
            JamLinks.song(serverId: "s", channelId: "c", songId: songId)?.absoluteString,
            "https://pqp.gg/app/server/s/channel/c/song/\(songId)"
        )
    }
}

// MARK: - Search

@MainActor
final class JamSongSearchTests: XCTestCase {
    private var keep: SessionStore?

    func testTwoLettersMeanSomethingAndOneDoesNot() {
        XCTAssertNil(JamSongSearch.words(""))
        XCTAssertNil(JamSongSearch.words("l"))
        XCTAssertNil(JamSongSearch.words("  l  "))
        XCTAssertEqual(JamSongSearch.words("  lu "), "lu")
        XCTAssertEqual(JamSongSearch.words(String(repeating: "a", count: 300))?.count, JamSongSearch.maxLength)
    }

    private func wall(
        handler: @escaping @Sendable (URLRequest) -> (TimeInterval, Int, Data)
    ) -> JamWallModel {
        JamStubURLProtocol.handler = handler
        let session = makePublicSession()
        keep = session
        let channel = try! Coding.decoder.decode(Channel.self, from: Data(
            #"{"id":"chan-1","serverId":"srv-1","kind":"server","name":"jam","type":"jam","position":0,"isPrivate":false}"#.utf8
        ))
        let model = JamWallModel(
            channel: channel, server: Server(id: "srv-1", name: "S", ownerId: "u1", role: "owner", createdAt: Date())
        )
        model.attach(session: session)
        return model
    }

    private func page(_ titles: [String]) -> Data {
        let songs = titles.enumerated().map { index, title in
            #"{"id":"s\#(index)","channelId":"chan-1","serverId":"srv-1","title":"\#(title)","artist":null,"joinMode":"open","wantedInstruments":[],"authorId":"u1","authorName":"rafa","authorAvatarUrl":null,"createdAt":"2026-11-27T10:00:00.000Z","updatedAt":"2026-11-27T10:00:00.000Z","trackCount":1,"instruments":["guitar"],"contributorCount":1,"mixDurationMs":1000}"#
        }
        return Data(#"{"songs":[\#(songs.joined(separator: ","))],"nextCursor":null}"#.utf8)
    }

    func testTheServerIsAskedForTheWordsAfterTheySettleAndNotBefore() async {
        let asked = LockedBox<[String]>([])
        let body = page(["Lua cheia"])
        let model = wall { request in
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            asked.value.append("\(query?.first { $0.name == "q" }?.value ?? "-")|\(query?.first { $0.name == "limit" }?.value ?? "-")")
            return (0, 200, body)
        }
        model.searchText = "l"
        await model.runSearch()
        XCTAssertEqual(model.search, .idle)
        XCTAssertTrue(asked.value.isEmpty, "one letter asks nothing")
        model.searchText = " lu "
        await model.runSearch()
        XCTAssertEqual(asked.value, ["lu|25"], "trimmed, one page")
        guard case .results(let words, let songs) = model.search else { return XCTFail("results") }
        XCTAssertEqual(words, "lu")
        XCTAssertEqual(songs.map(\.title), ["Lua cheia"])
    }

    func testTypingOnCancelsTheLastSearchBeforeItAsksAnything() async throws {
        let asked = LockedBox<[String]>([])
        let body = page(["x"])
        let model = wall { request in
            asked.value.append(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "q" }?.value ?? "-")
            return (0, 200, body)
        }
        model.searchText = "lu"
        let first = Task { await model.runSearch() }
        try await Task.sleep(for: .milliseconds(40))
        model.searchText = "lua"
        first.cancel()
        await model.runSearch()
        await first.value
        XCTAssertEqual(asked.value, ["lua"], "the words that were typed over were never asked")
    }

    func testAnAnswerForWordsThatAreNoLongerTheWordsIsDropped() async throws {
        let body = page(["old"])
        let model = wall { _ in (0.4, 200, body) }
        model.searchText = "lu"
        let slow = Task { await model.runSearch() }
        try await Task.sleep(for: .milliseconds(300))
        model.searchText = "x"
        await slow.value
        if case .results = model.search { XCTFail("a stale answer landed") }
    }

    func testAFailedSearchIsAnEmptyListNotAnError() async {
        let model = wall { _ in (0, 500, Data(#"{"error":"boom"}"#.utf8)) }
        model.searchText = "lu"
        await model.runSearch()
        XCTAssertEqual(model.search, .results(words: "lu", songs: []))
    }

    func testClearingTheFieldIsTheWallAgain() async {
        let body = page(["a"])
        let model = wall { _ in (0, 200, body) }
        model.searchText = "lu"
        await model.runSearch()
        model.searchText = ""
        await model.runSearch()
        XCTAssertEqual(model.search, .idle)
    }
}
