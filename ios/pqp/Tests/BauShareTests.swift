import XCTest
@testable import pqp

/// A Baú post pasted into chat: the permalink grammar, which link gets a card,
/// the card's JSON, and the cache around its fetch.
///
/// The grammar cases mirror `packages/shared/src/community-home-share.test.ts`
/// one for one, and the selection cases mirror
/// `client/src/lib/community-home/share-card.test.ts`. A drift between the
/// clients shows up here as a red test rather than a card that never appears.
final class BauShareTests: XCTestCase {
    private let server = "0f5b7a3e-1c2d-4e8f-9a0b-1234567890ab"
    private let post = "aa11bb22-cc33-4dd4-8ee5-ff6677889900"
    private var path: String { "/app/server/\(server)/bau/\(post)" }

    // MARK: - Grammar

    func testPathRoundTrips() {
        XCTAssertEqual(BauShare.postPath(serverId: server, postId: post), path)
        let ref = BauPostRef(serverId: server, postId: post)
        XCTAssertEqual(BauShare.parsePostPath(path), ref)
        XCTAssertEqual(BauShare.parsePostPath(path + "/"), ref)
    }

    func testIdsAreLowercasedSoAShoutedLinkStillMatches() {
        XCTAssertEqual(
            BauShare.parsePostPath("/app/server/\(server.uppercased())/bau/\(post.uppercased())"),
            BauPostRef(serverId: server, postId: post)
        )
    }

    func testRefusesAnythingThatIsNotAPostAddress() {
        XCTAssertNil(BauShare.parsePostPath("/app/server/\(server)/bau"))
        XCTAssertNil(BauShare.parsePostPath("/app/server/\(server)"))
        XCTAssertNil(BauShare.parsePostPath("/app/server/\(server)/channel/\(post)"))
        XCTAssertNil(BauShare.parsePostPath("/app/server/not-a-uuid/bau/\(post)"))
        XCTAssertNil(BauShare.parsePostPath("/other/app/server/\(server)/bau/\(post)"))
        XCTAssertNil(BauShare.parsePostPath("\(path)/extra"))
        XCTAssertNil(BauShare.parsePostPath("\(path)//"))
        XCTAssertNil(BauShare.parsePostPath(""))
    }

    func testFindsALinkInProseIgnoringATrailingMarkAndAQuery() throws {
        let text = "Olha o novo post https://pqp.gg\(path)?ref=x. Corre!"
        let link = try XCTUnwrap(BauShare.findLinks(in: text).first)
        XCTAssertEqual(link.serverId, server)
        XCTAssertEqual(link.postId, post)
        XCTAssertEqual(link.origin, "https://pqp.gg")
        XCTAssertEqual(link.url, "https://pqp.gg\(path)?ref=x")
        XCTAssertEqual(String(text[link.range]), link.url)
    }

    func testFindsSeveralInOrderAndSkipsUnrelatedLinks() {
        let other = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
        let text = "https://example.com/a http://localhost:5173\(path) https://pqp.gg\(BauShare.postPath(serverId: server, postId: other))"
        let links = BauShare.findLinks(in: text)
        XCTAssertEqual(links.map(\.postId), [post, other])
        XCTAssertEqual(links[0].origin, "http://localhost:5173")
    }

    func testReturnsNothingForTextWithNoPostLink() {
        XCTAssertTrue(BauShare.findLinks(in: "").isEmpty)
        XCTAssertTrue(BauShare.findLinks(in: "https://pqp.gg/app/server/\(server)/channel/\(post)").isEmpty)
        XCTAssertTrue(BauShare.findLinks(in: "pqp.gg\(path)").isEmpty)
    }

    func testDefaultPortsAreNotPartOfTheOrigin() throws {
        let link = try XCTUnwrap(BauShare.findLinks(in: "https://pqp.gg:443\(path)").first)
        XCTAssertEqual(link.origin, "https://pqp.gg")
    }

    func testBodyIsOnlyTheLinkOnlyWhenNothingElseIsSaid() throws {
        let bare = "https://pqp.gg\(path)"
        for text in [bare, " \(bare)\n", "\(bare)."] {
            let link = try XCTUnwrap(BauShare.findLinks(in: text).first)
            XCTAssertTrue(BauShare.bodyIsOnly(link, in: text), text)
        }
        let noted = "Novo! \(bare)"
        let link = try XCTUnwrap(BauShare.findLinks(in: noted).first)
        XCTAssertFalse(BauShare.bodyIsOnly(link, in: noted))
    }

    // MARK: - Origin policy

    func testOnlyThisInstanceAndTheHostedAppAreOurs() {
        XCTAssertTrue(BauShare.isOwnInstanceOrigin("https://pqp.gg", currentOrigin: nil))
        XCTAssertTrue(BauShare.isOwnInstanceOrigin("https://www.pqp.gg", currentOrigin: nil))
        XCTAssertTrue(BauShare.isOwnInstanceOrigin("http://localhost:5173", currentOrigin: "http://localhost:5173"))
        XCTAssertFalse(BauShare.isOwnInstanceOrigin("http://localhost:5173", currentOrigin: nil))
        XCTAssertFalse(BauShare.isOwnInstanceOrigin("http://pqp.gg", currentOrigin: nil), "http is not the hosted app")
        XCTAssertFalse(BauShare.isOwnInstanceOrigin("https://evil.example", currentOrigin: nil))
        XCTAssertFalse(BauShare.isOwnInstanceOrigin("https://pqp.gg.evil.example", currentOrigin: nil))
        XCTAssertFalse(BauShare.isOwnInstanceOrigin("https://other-pqp.example", currentOrigin: "http://localhost:5173"))
        XCTAssertFalse(BauShare.isOwnInstanceOrigin("not a url", currentOrigin: nil))
    }

    // MARK: - Which link gets a card

    func testSelectsTheFirstSameInstanceLinkAndSkipsForeignOnes() throws {
        let foreign = "https://example.com\(path)"
        let ours = "https://pqp.gg\(path)"
        let selection = try XCTUnwrap(BauShare.selectCardLink(in: "\(foreign) \(ours)", currentOrigin: nil))
        XCTAssertEqual(selection.link.url, ours)
        XCTAssertFalse(selection.linkOnly)
        XCTAssertNil(BauShare.selectCardLink(in: foreign, currentOrigin: nil))
        XCTAssertNil(BauShare.selectCardLink(in: nil, currentOrigin: nil))
        XCTAssertNil(BauShare.selectCardLink(in: "", currentOrigin: nil))
        XCTAssertNil(BauShare.selectCardLink(in: "oi pessoal", currentOrigin: nil))
    }

    func testALinkOnlyMessageLetsTheCardStandAlone() throws {
        let selection = try XCTUnwrap(BauShare.selectCardLink(in: "https://pqp.gg\(path)", currentOrigin: nil))
        XCTAssertTrue(selection.linkOnly)
    }

    func testStrippingKeepsTheWordsAndDropsOnlyTheUrl() throws {
        let body = "Saiu post novo!\n\nhttps://pqp.gg\(path)\n\n\n\nVai lá ver"
        let link = try XCTUnwrap(BauShare.findLinks(in: body).first)
        XCTAssertEqual(BauShare.strippingLink(link, from: body), "Saiu post novo!\n\nVai lá ver")

        let inline = "Olha https://pqp.gg\(path) agora"
        let inlineLink = try XCTUnwrap(BauShare.findLinks(in: inline).first)
        XCTAssertEqual(BauShare.strippingLink(inlineLink, from: inline), "Olha  agora")

        let only = "https://pqp.gg\(path)"
        let onlyLink = try XCTUnwrap(BauShare.findLinks(in: only).first)
        XCTAssertEqual(BauShare.strippingLink(onlyLink, from: only), "")
    }

    // MARK: - Tapping a permalink

    func testASameInstancePermalinkOpensInTheApp() throws {
        let url = try XCTUnwrap(URL(string: "https://pqp.gg\(path)?utm=1"))
        XCTAssertEqual(
            BauShare.inAppTarget(for: url, currentOrigin: nil),
            .bauPost(serverId: server, postId: post)
        )
        XCTAssertNil(BauShare.inAppTarget(for: try XCTUnwrap(URL(string: "https://example.com\(path)")), currentOrigin: nil))
        XCTAssertNil(BauShare.inAppTarget(for: try XCTUnwrap(URL(string: "https://pqp.gg/app/server/\(server)")), currentOrigin: nil))
        XCTAssertNil(BauShare.inAppTarget(for: try XCTUnwrap(URL(string: "https://pqp.gg/@rafa")), currentOrigin: nil))
    }

    func testTheDeepLinkVocabularyKnowsTheBau() {
        XCTAssertEqual(
            DeepLink.target(path: path),
            .bauPost(serverId: server, postId: post)
        )
        XCTAssertEqual(
            DeepLink.target(path: "/app/server/\(server)/bau"),
            .bau(serverId: server)
        )
        XCTAssertEqual(
            DeepLink.target(url: URL(string: "pqp://server/\(server)/bau/\(post)")!),
            .bauPost(serverId: server, postId: post)
        )
    }

    func testCardLanguageFollowsTheAppLocalisation() {
        XCTAssertEqual(BauShare.cardLanguage(preferred: ["pt-BR"]), "pt-BR")
        XCTAssertEqual(BauShare.cardLanguage(preferred: ["pt-PT"]), "pt-BR")
        XCTAssertEqual(BauShare.cardLanguage(preferred: ["es-MX"]), "es")
        XCTAssertEqual(BauShare.cardLanguage(preferred: ["en"]), "en")
        XCTAssertEqual(BauShare.cardLanguage(preferred: ["fr"]), "en")
        XCTAssertEqual(BauShare.cardLanguage(preferred: []), "en")
    }

    // MARK: - The card on the wire

    private func decode(_ json: String) throws -> CommunityHomePostCard {
        try Coding.decoder.decode(CommunityHomePostCardResponse.self, from: Data(json.utf8)).card
    }

    private func cardJSON(
        author: String = #"{"id":"33333333-3333-3333-3333-333333333333","displayName":"Rafa","avatarUrl":null}"#,
        _ rest: String
    ) -> String {
        """
        {"card":{"postId":"\(post)","serverId":"\(server)","serverName":"QG",
         "author":\(author),\(rest)}}
        """
    }

    func testDecodesAFullVideoCard() throws {
        let card = try decode(cardJSON("""
        "title":"Clipe","teaser":"Veja só","mediaKind":"video","mediaUrl":"https://r2.example/v.mp4?sig=1",
        "visibility":"free","locked":false,"pinned":true,"likeCount":3,"commentCount":2,
        "publishedAt":"2026-10-01T12:00:00.000Z"
        """))
        XCTAssertEqual(card.title, "Clipe")
        XCTAssertEqual(card.author?.displayName, "Rafa")
        XCTAssertEqual(card.mediaKind, .video)
        XCTAssertTrue(card.isPlayable)
        XCTAssertTrue(card.pinned)
        XCTAssertEqual(card.likeCount, 3)
        XCTAssertEqual(card.commentCount, 2)
        XCTAssertEqual(card.poster, .videoFrame(URL(string: "https://r2.example/v.mp4?sig=1")!))
    }

    func testDecodesATextOnlyCardWithNullMedia() throws {
        let card = try decode(cardJSON("""
        "title":null,"teaser":"Só texto","mediaKind":null,"mediaUrl":null,
        "visibility":"free","locked":false,"pinned":false,"likeCount":0,"commentCount":0,"publishedAt":null
        """))
        XCTAssertNil(card.title)
        XCTAssertNil(card.mediaKind)
        XCTAssertNil(card.publishedAt)
        XCTAssertFalse(card.isPlayable)
        XCTAssertEqual(card.poster, .none)
    }

    func testDecodesALockedCardWithNoAuthorAndNoMedia() throws {
        let card = try decode(cardJSON(author: "null", """
        "title":"Só VIP","teaser":"Um gostinho","mediaKind":"video","mediaUrl":null,
        "visibility":"members","locked":true,"pinned":false,"likeCount":9,"commentCount":4,"publishedAt":null
        """))
        XCTAssertTrue(card.locked)
        XCTAssertNil(card.author, "a locked card withholds who wrote it")
        XCTAssertEqual(card.serverName, "QG")
        // The play badge is suppressed for a locked card; the poster is the plate.
        XCTAssertEqual(card.poster, .plate)
    }

    func testPosterFollowsTheWebRules() throws {
        func poster(_ kind: String?, _ url: String?) throws -> CommunityHomePostCard.Poster {
            let kindJSON = kind.map { "\"\($0)\"" } ?? "null"
            let urlJSON = url.map { "\"\($0)\"" } ?? "null"
            return try decode(cardJSON(
                "\"mediaKind\":\(kindJSON),\"mediaUrl\":\(urlJSON),\"visibility\":\"free\",\"locked\":false,\"pinned\":false,\"likeCount\":0,\"commentCount\":0"
            )).poster
        }
        let img = URL(string: "https://x.example/a.jpg")!
        XCTAssertEqual(try poster("image", img.absoluteString), .image(img))
        XCTAssertEqual(try poster("youtube", img.absoluteString), .image(img))
        XCTAssertEqual(try poster("youtube", nil), .plate)
        XCTAssertEqual(try poster("image", nil), .none)
        XCTAssertEqual(try poster("video", nil), .plate)
        for kind in ["twitch", "tiktok", "instagram"] {
            XCTAssertEqual(try poster(kind, nil), .plate, kind)
        }
        XCTAssertEqual(try poster("file", nil), .none)
        // A kind this build has never heard of is a card without a picture.
        XCTAssertEqual(try poster("hologram", img.absoluteString), .none)
        // A non-http URL is not a picture.
        XCTAssertEqual(try poster("image", "javascript:alert(1)"), .none)
    }

    // MARK: - The cache

    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var value: TimeInterval = 1_000
        var now: TimeInterval { lock.withLock { value } }
        func advance(_ seconds: TimeInterval) { lock.withLock { value += seconds } }
    }

    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var value: Int { lock.withLock { count } }
        func hit() { lock.withLock { count += 1 } }
    }

    private func sampleCard() -> CommunityHomePostCard {
        CommunityHomePostCard(
            postId: post, serverId: server,
            author: .init(id: "a", displayName: "Rafa", avatarUrl: nil)
        )
    }

    private struct NotFound: Error {}

    func testCachesAnAnswerForAboutAMinute() async {
        let clock = Clock()
        let calls = Counter()
        let store = BauCardStore(now: { clock.now })
        let card = sampleCard()
        let fetch: BauCardStore.Fetch = { _, _, _ in calls.hit(); return card }

        _ = await store.card(serverId: server, postId: post, lang: "pt-BR", fetch: fetch)
        clock.advance(59)
        let again = await store.card(serverId: server, postId: post, lang: "pt-BR", fetch: fetch)
        XCTAssertEqual(again, card)
        XCTAssertEqual(calls.value, 1)

        clock.advance(2)
        _ = await store.card(serverId: server, postId: post, lang: "pt-BR", fetch: fetch)
        XCTAssertEqual(calls.value, 2)

        // Another language is another card (the teaser is translated).
        _ = await store.card(serverId: server, postId: post, lang: "en", fetch: fetch)
        XCTAssertEqual(calls.value, 3)
    }

    func testCachesARefusalForHalfAsLong() async {
        let clock = Clock()
        let calls = Counter()
        let store = BauCardStore(now: { clock.now })
        let fetch: BauCardStore.Fetch = { _, _, _ in calls.hit(); throw NotFound() }

        let first = await store.card(serverId: server, postId: post, lang: "en", fetch: fetch)
        XCTAssertNil(first)
        clock.advance(29)
        _ = await store.card(serverId: server, postId: post, lang: "en", fetch: fetch)
        XCTAssertEqual(calls.value, 1)
        clock.advance(2)
        _ = await store.card(serverId: server, postId: post, lang: "en", fetch: fetch)
        XCTAssertEqual(calls.value, 2)
    }

    func testRowsAskingTogetherShareOneRequest() async {
        let calls = Counter()
        let store = BauCardStore()
        let card = sampleCard()
        let fetch: BauCardStore.Fetch = { _, _, _ in
            calls.hit()
            try await Task.sleep(for: .milliseconds(100))
            return card
        }
        let (serverId, postId) = (server, post)
        let results = await withTaskGroup(of: CommunityHomePostCard?.self) { group in
            for _ in 0..<3 {
                group.addTask { await store.card(serverId: serverId, postId: postId, lang: "en", fetch: fetch) }
            }
            var all: [CommunityHomePostCard?] = []
            for await result in group { all.append(result) }
            return all
        }
        XCTAssertEqual(results.compactMap { $0 }.count, 3)
        XCTAssertEqual(calls.value, 1)
    }

    func testClearForgetsEverythingForTheNextAccount() async {
        let calls = Counter()
        let store = BauCardStore()
        let card = sampleCard()
        let fetch: BauCardStore.Fetch = { _, _, _ in calls.hit(); return card }
        _ = await store.card(serverId: server, postId: post, lang: "en", fetch: fetch)
        await store.clear()
        _ = await store.card(serverId: server, postId: post, lang: "en", fetch: fetch)
        XCTAssertEqual(calls.value, 2)
    }
}
