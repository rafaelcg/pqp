import XCTest
@testable import pqp

/// Encaminhar on iOS: the wire shapes from `packages/shared/src/forward.ts`
/// (the cases mirror `forward.test.ts`), the card's states, what a tap does,
/// who the picker offers and what a refusal says.
@MainActor
final class ForwardTests: XCTestCase {
    private let serverId = "11111111-1111-4111-8111-111111111111"
    private let otherServerId = "99999999-9999-4999-8999-999999999999"
    private let sourceId = "22222222-2222-4222-8222-222222222222"
    private let channelId = "33333333-3333-4333-8333-333333333333"
    private let hosted = "https://pqp.gg"

    private var postURL: String { "https://pqp.gg/app/server/\(serverId)/bau/\(sourceId)" }
    private var messageURL: String {
        "https://pqp.gg/app/server/\(serverId)/channel/\(channelId)/message/\(sourceId)"
    }

    private func card(
        kind: MessageForward.Kind = .bauPost,
        title: String? = "Sessão 11",
        excerpt: String = "o clip inteiro",
        url: String? = nil,
        channel: String? = nil,
        thumb: String? = nil,
        mediaKind: MessageForward.MediaKind? = nil,
        restricted: Bool = false,
        restrictedTo: String? = nil
    ) -> MessageForward {
        MessageForward(
            kind: kind, sourceServerId: serverId, sourceServerName: "QG",
            sourceServerIconUrl: "/api/servers/\(serverId)/icon?v=ab12cd34",
            sourceChannelName: channel, sourceId: sourceId, authorDisplayName: "Rafa",
            title: title, excerpt: excerpt, mediaThumbUrl: thumb, mediaKind: mediaKind,
            url: url ?? postURL, restricted: restricted, restrictedToServerId: restrictedTo
        )
    }

    private func messageJSON(forward: String?, body: String = "olha isso aqui") -> Data {
        let tail = forward.map { #","forward":\#($0)"# } ?? ""
        return Data("""
        {"id":"\(sourceId)","channelId":"\(channelId)","authorId":"\(serverId)","authorName":"Ana",
         "body":"\(body)","createdAt":"2026-10-15T12:00:00.000Z"\(tail)}
        """.utf8)
    }

    private let cardJSON = """
    {"v":1,"kind":"bau_post","sourceServerId":"11111111-1111-4111-8111-111111111111",
     "sourceServerName":"QG","sourceServerIconUrl":"/api/servers/x/icon?v=ab12cd34",
     "sourceId":"22222222-2222-4222-8222-222222222222","authorDisplayName":"Rafa",
     "title":"Sessão 11","excerpt":"o clip inteiro","mediaThumbUrl":"https://i.ytimg.com/vi/x/hq.jpg",
     "mediaKind":"youtube","url":"https://pqp.gg/app/server/11111111-1111-4111-8111-111111111111/bau/22222222-2222-4222-8222-222222222222",
     "createdAt":"2026-10-15T12:00:00.000Z","restricted":true}
    """

    // MARK: - Decoding

    func testAForwardDecodesOffAMessage() throws {
        let message = try Coding.decoder.decode(Message.self, from: messageJSON(forward: cardJSON))
        let forward = try XCTUnwrap(message.forward)
        XCTAssertEqual(forward.kind, .bauPost)
        XCTAssertEqual(forward.sourceServerName, "QG")
        XCTAssertEqual(forward.title, "Sessão 11")
        XCTAssertEqual(forward.mediaKind, .youtube)
        XCTAssertTrue(forward.restricted)
        XCTAssertEqual(message.body, "olha isso aqui")
    }

    /// `forward` is absent on every ordinary message.
    func testAnOrdinaryMessageHasNoForward() throws {
        let message = try Coding.decoder.decode(Message.self, from: messageJSON(forward: nil))
        XCTAssertNil(message.forward)
        let explicitNull = try Coding.decoder.decode(Message.self, from: messageJSON(forward: "null"))
        XCTAssertNil(explicitNull.forward)
    }

    /// `.catch(null)`: a version this build does not know is an ordinary
    /// message that shows its body, never a failed history page.
    func testAFutureVersionIsAnOrdinaryMessage() throws {
        let future = cardJSON.replacingOccurrences(of: #""v":1"#, with: #""v":2"#)
        let message = try Coding.decoder.decode(Message.self, from: messageJSON(forward: future))
        XCTAssertNil(message.forward)
        XCTAssertEqual(message.body, "olha isso aqui")
    }

    func testASnapshotThatFailsTodaysParseIsAnOrdinaryMessage() throws {
        for broken in [#"{"v":9}"#, #""text""#, #"{"v":1,"kind":"poll"}"#, "42"] {
            let message = try Coding.decoder.decode(Message.self, from: messageJSON(forward: broken))
            XCTAssertNil(message.forward, broken)
            XCTAssertEqual(message.body, "olha isso aqui")
        }
    }

    /// A media kind added later costs the glyph, not the card.
    func testAnUnknownMediaKindKeepsTheCard() throws {
        let json = cardJSON.replacingOccurrences(of: #""mediaKind":"youtube""#, with: #""mediaKind":"hologram""#)
        let forward = try XCTUnwrap(
            try Coding.decoder.decode(Message.self, from: messageJSON(forward: json)).forward
        )
        XCTAssertNil(forward.mediaKind)
        XCTAssertEqual(forward.title, "Sessão 11")
    }

    func testRestrictedAbsentReadsAsFalseAndOptionalsMayBeMissing() throws {
        let minimal = """
        {"v":1,"kind":"message","sourceServerId":"\(serverId)","sourceServerName":"QG",
         "sourceChannelName":"geral","sourceId":"\(sourceId)","excerpt":"oi","url":"\(messageURL)",
         "createdAt":"2026-10-15T12:00:00.000Z"}
        """
        let forward = try XCTUnwrap(
            try Coding.decoder.decode(Message.self, from: messageJSON(forward: minimal)).forward
        )
        XCTAssertFalse(forward.restricted)
        XCTAssertNil(forward.title)
        XCTAssertNil(forward.mediaThumbUrl)
        XCTAssertNil(forward.sourceServerIconUrl)
    }

    /// The disk cache writes messages back out; a forward must survive it.
    func testAForwardSurvivesTheReadCacheRoundTrip() throws {
        let message = try Coding.decoder.decode(Message.self, from: messageJSON(forward: cardJSON))
        let data = try Coding.encoder.encode(message)
        let again = try Coding.decoder.decode(Message.self, from: data)
        XCTAssertEqual(again.forward, message.forward)
    }

    // MARK: - The fallback body (forward.test.ts)

    func testTheFallbackIsEncaminhadoTitleUrl() {
        let forward = card()
        let body = ForwardFallback.body(for: forward)
        XCTAssertEqual(body, "Encaminhado: Sessão 11 \(postURL)")
        XCTAssertTrue(ForwardFallback.isFallback(body, for: forward))
        // A comment that merely starts with the same word is a comment.
        XCTAssertFalse(ForwardFallback.isFallback("Encaminhado: Sessão 11", for: forward))
        XCTAssertFalse(ForwardFallback.isFallback("olha isso", for: forward))
    }

    func testTheFallbackFallsBackToTheExcerptThenTheServerName() {
        XCTAssertTrue(ForwardFallback.body(for: card(title: nil)).contains("o clip inteiro"))
        XCTAssertTrue(ForwardFallback.body(for: card(title: nil, excerpt: "")).contains("QG"))
        XCTAssertTrue(ForwardFallback.body(for: card(title: "   ", excerpt: "  \n ")).contains("QG"))
    }

    func testTheFallbackCollapsesWhitespaceAndCutsAtOneHundredForty() {
        let spaced = ForwardFallback.body(for: card(title: "a   b\n\nc"))
        XCTAssertTrue(spaced.hasPrefix("Encaminhado: a b c "))

        let long = ForwardFallback.body(for: card(title: String(repeating: "a", count: 300)))
        let text = String(long.dropFirst("Encaminhado: ".count).dropLast(postURL.count + 1))
        XCTAssertEqual(text.utf16.count, 140)
        XCTAssertTrue(text.hasSuffix("..."))
        // Exactly 140 is not cut.
        let exact = ForwardFallback.body(for: card(title: String(repeating: "b", count: 140)))
        XCTAssertFalse(exact.contains("..."))
    }

    /// The cut is counted in UTF-16 units like the shared helper's `slice`, so
    /// the body the server wrote and the body this build computes are the same
    /// string for text with an emoji at the boundary: 135 units, then three
    /// emoji (141 units, over the limit), keeps 137 units, which is the first
    /// emoji whole, and then "...".
    func testTheCutCountsUtf16LikeTheSharedHelper() {
        let title = String(repeating: "x", count: 135) + "\u{1F600}\u{1F600}\u{1F600}"
        let body = ForwardFallback.body(for: card(title: title))
        let expected = "Encaminhado: " + String(repeating: "x", count: 135) + "\u{1F600}... "
        XCTAssertTrue(body.hasPrefix(expected), body)
    }

    func testTheCommentIsWhatTheForwarderTypedAndNothingForTheFallback() throws {
        let forward = card()
        var message = try Coding.decoder.decode(Message.self, from: messageJSON(forward: cardJSON))
        message.body = "olha isso aqui"
        XCTAssertEqual(message.forwardComment, "olha isso aqui")
        XCTAssertFalse(message.hasForwardFallbackBody)

        let fallback = ForwardFallback.body(for: try XCTUnwrap(message.forward))
        message.body = fallback
        XCTAssertEqual(message.forwardComment, "")
        XCTAssertTrue(message.hasForwardFallbackBody)
        _ = forward
    }

    func testAnOrdinaryMessageKeepsItsBody() throws {
        let message = try Coding.decoder.decode(Message.self, from: messageJSON(forward: nil, body: "Encaminhado: x"))
        XCTAssertEqual(message.forwardComment, "Encaminhado: x")
        XCTAssertFalse(message.hasForwardFallbackBody)
    }

    // MARK: - What the card says

    func testABauPostCard() {
        let content = ForwardCardContent(card())
        XCTAssertEqual(content.source, .bau(server: "QG"))
        XCTAssertEqual(content.heading, "Sessão 11")
        XCTAssertEqual(content.excerpt, "o clip inteiro")
        XCTAssertNil(content.thumbnail)
        XCTAssertNil(content.glyph)
        XCTAssertFalse(content.restricted)
        XCTAssertEqual(content.iconPath, "/api/servers/\(serverId)/icon?v=ab12cd34")
    }

    func testAChannelMessageCardNamesTheChannelAndHeadsWithTheAuthor() {
        let content = ForwardCardContent(card(kind: .message, title: nil, url: messageURL, channel: "geral"))
        XCTAssertEqual(content.source, .channel(server: "QG", channel: "geral"))
        XCTAssertEqual(content.heading, "Rafa")
    }

    func testAMessageCardWithNoChannelNameNamesJustTheServer() {
        XCTAssertEqual(
            ForwardCardContent(card(kind: .message, title: nil, url: messageURL, channel: "  ")).source,
            .server("QG")
        )
    }

    func testACardWithNoTitleAndNoAuthorHasNoHeading() {
        let bare = MessageForward(
            kind: .message, sourceServerId: serverId, sourceServerName: "QG", sourceId: sourceId,
            excerpt: "oi", url: messageURL
        )
        XCTAssertNil(ForwardCardContent(bare).heading)
        XCTAssertEqual(ForwardCardContent(bare).excerpt, "oi")
    }

    func testAThumbnailIsDrawnWhenItIsAnHttpsUrl() {
        let content = ForwardCardContent(card(thumb: "https://i.ytimg.com/vi/x/hq.jpg", mediaKind: .youtube))
        XCTAssertEqual(content.thumbnail?.absoluteString, "https://i.ytimg.com/vi/x/hq.jpg")
        XCTAssertNil(content.glyph, "a picture needs no glyph")
    }

    /// A signed media URL is never stored, so a kind with no picture draws a
    /// glyph for the kind.
    func testAMediaKindWithNoPictureDrawsAGlyph() {
        XCTAssertEqual(ForwardCardContent(card(excerpt: "", mediaKind: .image)).glyph, "photo")
        XCTAssertEqual(ForwardCardContent(card(excerpt: "", mediaKind: .video)).glyph, "play.rectangle.fill")
        XCTAssertEqual(ForwardCardContent(card(mediaKind: .youtube)).glyph, "play.rectangle.fill")
        XCTAssertEqual(ForwardCardContent(card(mediaKind: .embed)).glyph, "link")
        XCTAssertNil(ForwardCardContent(card()).glyph)
    }

    func testAThumbnailThatIsNotLoadableIsTreatedAsNone() {
        for bad in ["javascript:alert(1)", "ftp://x/y.png", "", "not a url", "file:///etc/passwd"] {
            let content = ForwardCardContent(card(thumb: bad, mediaKind: .image))
            XCTAssertNil(content.thumbnail, bad)
            XCTAssertEqual(content.glyph, "photo", bad)
        }
    }

    func testARestrictedCardSaysSo() {
        XCTAssertTrue(ForwardCardContent(card(restricted: true)).restricted)
    }

    /// Mentions in a snapshot are text, never links: the card keeps the words.
    func testAMentionInTheExcerptIsPlainText() {
        let content = ForwardCardContent(card(excerpt: "@everyone olha @rafa https://evil.example"))
        XCTAssertEqual(content.excerpt, "@everyone olha @rafa https://evil.example")
    }

    // MARK: - What a tap does

    func testABauPostOnOurOriginOpensInTheApp() {
        let open = ForwardOpen.resolve(card(), memberServerIds: [serverId], currentOrigin: nil)
        XCTAssertEqual(open, .inApp(.bauPost(serverId: serverId, postId: sourceId)))
    }

    func testAMessageJumpLinkOpensInTheApp() {
        let forward = card(kind: .message, title: nil, url: messageURL, channel: "geral")
        let open = ForwardOpen.resolve(forward, memberServerIds: [serverId], currentOrigin: nil)
        XCTAssertEqual(open, .inApp(.message(serverId: serverId, channelId: channelId, messageId: sourceId)))
    }

    func testTheLocalDevOriginOpensInTheApp() {
        let forward = card(url: "http://localhost:5173/app/server/\(serverId)/bau/\(sourceId)")
        XCTAssertEqual(
            ForwardOpen.resolve(forward, memberServerIds: [serverId], currentOrigin: "http://localhost:5173"),
            .inApp(.bauPost(serverId: serverId, postId: sourceId))
        )
        // Without that origin configured, a localhost link is somebody else's.
        XCTAssertEqual(
            ForwardOpen.resolve(forward, memberServerIds: [serverId], currentOrigin: nil),
            .external(URL(string: forward.url)!)
        )
    }

    /// Outside the source server the app resolves nothing, so the browser gets
    /// the public link and the web app says what to do.
    func testASourceThisAccountIsNotInOpensInTheBrowser() {
        let open = ForwardOpen.resolve(card(), memberServerIds: [otherServerId], currentOrigin: nil)
        XCTAssertEqual(open, .external(URL(string: postURL)!))
    }

    func testWhenMembershipCouldNotBeReadTheAppTriesIt() {
        XCTAssertEqual(
            ForwardOpen.resolve(card(), memberServerIds: nil, currentOrigin: nil),
            .inApp(.bauPost(serverId: serverId, postId: sourceId))
        )
    }

    func testAPublicPageAndAForeignInstanceOpenInTheBrowser() {
        let publicPage = card(url: "https://pqp.gg/c/qg/p/\(sourceId)")
        XCTAssertEqual(
            ForwardOpen.resolve(publicPage, memberServerIds: [serverId], currentOrigin: nil),
            .external(URL(string: "https://pqp.gg/c/qg/p/\(sourceId)")!)
        )
        let foreign = card(url: "https://other.example/app/server/\(serverId)/bau/\(sourceId)")
        XCTAssertEqual(
            ForwardOpen.resolve(foreign, memberServerIds: [serverId], currentOrigin: nil),
            .external(URL(string: foreign.url)!)
        )
    }

    func testAUrlThatIsNotAWebLinkOpensNothing() {
        for bad in ["", "javascript:alert(1)", "pqp://server/x", "not a url", "/app/server/x"] {
            XCTAssertEqual(ForwardOpen.resolve(card(url: bad), memberServerIds: [serverId], currentOrigin: nil), .none, bad)
        }
    }

    func testAShoutedServerIdStillFindsItsMembership() {
        let shouted = card(url: "https://pqp.gg/app/server/\(serverId.uppercased())/bau/\(sourceId)")
        XCTAssertEqual(
            ForwardOpen.resolve(shouted, memberServerIds: [serverId], currentOrigin: nil),
            .inApp(.bauPost(serverId: serverId, postId: sourceId))
        )
    }

    func testTheMessageJumpLinkParsesAsADeepLink() {
        XCTAssertEqual(
            DeepLink.target(path: "/app/server/s/channel/c/message/m"),
            .message(serverId: "s", channelId: "c", messageId: "m")
        )
        XCTAssertEqual(
            DeepLink.target(path: "/app/server/s/channel/c"),
            .channel(serverId: "s", channelId: "c")
        )
        XCTAssertNil(DeepLink.target(path: "/app/server/s/channel/c/message"))
        XCTAssertEqual(
            DeepLink.target(url: URL(string: "pqp://server/s/channel/c/message/m")!),
            .message(serverId: "s", channelId: "c", messageId: "m")
        )
    }

    // MARK: - Who the picker offers

    private func channelTarget(_ id: String, _ name: String, server: String = "server-a") -> ForwardTarget {
        ForwardTarget(
            channelId: id, title: "#\(name)", serverId: server, serverName: "Servidor \(server)",
            iconUrl: nil, seed: server, isConversation: false
        )
    }

    private func dmTarget(_ id: String, _ name: String) -> ForwardTarget {
        ForwardTarget(
            channelId: id, title: name, serverId: nil, serverName: nil, iconUrl: nil,
            seed: id, isConversation: true
        )
    }

    func testARestrictedSourceStaysInItsServer() {
        let here = channelTarget("c1", "geral", server: "server-a")
        let there = channelTarget("c2", "geral", server: "server-b")
        let dm = dmTarget("d1", "Ana")
        XCTAssertTrue(ForwardTargets.isAllowed(here, stayInServerId: "server-a"))
        XCTAssertFalse(ForwardTargets.isAllowed(there, stayInServerId: "server-a"))
        XCTAssertFalse(ForwardTargets.isAllowed(dm, stayInServerId: "server-a"))
        // An ordinary source goes anywhere.
        for target in [here, there, dm] {
            XCTAssertTrue(ForwardTargets.isAllowed(target, stayInServerId: nil))
        }
    }

    func testRecentsComeFirstInTheOrderUsedAndEveryPlaceAppearsOnce() {
        let all = [channelTarget("a", "um"), channelTarget("b", "dois"), dmTarget("c", "Ana"), channelTarget("d", "quatro")]
        let ranked = ForwardTargets.ranked(all: all, recent: ["d", "gone", "a", "d"])
        XCTAssertEqual(ranked.recent.map(\.id), ["d", "a"])
        XCTAssertEqual(ranked.rest.map(\.id), ["b", "c"])
    }

    func testSearchFoldsCaseAndAccentsAndMatchesTheServerName() {
        let target = ForwardTarget(
            channelId: "x", title: "#São-Paulo", serverId: "s", serverName: "Comunidade Gaúcha",
            iconUrl: nil, seed: "s", isConversation: false
        )
        XCTAssertTrue(ForwardTargets.matches(target, query: "sao"))
        XCTAssertTrue(ForwardTargets.matches(target, query: "PAULO"))
        XCTAssertTrue(ForwardTargets.matches(target, query: "gaucha"))
        XCTAssertTrue(ForwardTargets.matches(target, query: "   "))
        XCTAssertFalse(ForwardTargets.matches(target, query: "rio"))
    }

    func testSelectionIsCappedAtFiveAndTogglesOff() {
        var selected: [ForwardTarget] = []
        for index in 0..<5 {
            let result = ForwardTargets.toggled(selected, channelTarget("c\(index)", "x\(index)"))
            XCTAssertFalse(result.refusedFull)
            selected = result.selected
        }
        XCTAssertEqual(selected.count, 5)
        let sixth = ForwardTargets.toggled(selected, channelTarget("c9", "x9"))
        XCTAssertTrue(sixth.refusedFull)
        XCTAssertEqual(sixth.selected.count, 5)
        // A place already picked comes off even when full.
        let off = ForwardTargets.toggled(selected, channelTarget("c2", "x2"))
        XCTAssertFalse(off.refusedFull)
        XCTAssertEqual(off.selected.map(\.id), ["c0", "c1", "c3", "c4"])
    }

    /// "Try again" resends only what is worth resending: not to a place that
    /// already has it, and not into a refusal that will be the same.
    func testPendingIsWhatHasNoAnswerOrWasRefusedForAReasonThatPasses() {
        let a = channelTarget("a", "um"), b = channelTarget("b", "dois")
        let c = channelTarget("c", "tres"), d = channelTarget("d", "quatro")
        func outcome(_ id: String, _ refusal: ForwardRefusal?) -> ForwardOutcome {
            ForwardOutcome(channelId: id, serverId: nil, refusal: refusal, retryAfterMs: nil)
        }
        let outcomes = [
            "a": outcome("a", nil),                // has it
            "b": outcome("b", .staysInServer),     // refused for good
            "c": outcome("c", .slowMode),          // worth another try
        ]
        XCTAssertEqual(ForwardTargets.pending([a, b, c, d], outcomes: outcomes).map(\.id), ["c", "d"])
        XCTAssertEqual(ForwardTargets.pending([a, b, c, d], outcomes: [:]).map(\.id), ["a", "b", "c", "d"])
        XCTAssertEqual(ForwardTargets.pending([a], outcomes: outcomes).map(\.id), [])
    }

    func testThePickerListsRecentsFirstThenChatsThenChannelsAndSearchFlattens() {
        let model = ForwardPickerModel(
            source: ForwardSource(kind: .message, id: sourceId, serverId: nil, summary: "oi", stayInServerId: nil),
            recentIds: ["ch2"],
            conversations: [dmTarget("dm1", "Ana"), dmTarget("dm2", "Beto")],
            channels: [channelTarget("ch1", "geral"), channelTarget("ch2", "clips")]
        )
        XCTAssertEqual(model.recentRows.map(\.id), ["ch2"])
        XCTAssertEqual(model.conversationRows.map(\.id), ["dm1", "dm2"])
        XCTAssertEqual(model.channelRows.map(\.id), ["ch1"], "a recent is not listed twice")

        model.query = "ana"
        XCTAssertEqual(model.recentRows.map(\.id), [])
        XCTAssertEqual(model.conversationRows.map(\.id), ["dm1"])
        XCTAssertEqual(model.channelRows.map(\.id), [])

        model.query = "zzz"
        XCTAssertTrue(model.hasNoMatches)
    }

    func testARestrictedSourceOffersOnlyItsOwnServersChannels() {
        let model = ForwardPickerModel(
            source: ForwardSource(kind: .bauPost, id: sourceId, serverId: "server-a", summary: "VIP", stayInServerId: "server-a"),
            recentIds: ["dm1", "ch9"],
            conversations: [dmTarget("dm1", "Ana")],
            channels: [channelTarget("ch1", "geral", server: "server-a"), channelTarget("ch9", "outro", server: "server-b")]
        )
        XCTAssertEqual(model.recentRows.map(\.id), [])
        XCTAssertEqual(model.conversationRows.map(\.id), [])
        XCTAssertEqual(model.channelRows.map(\.id), ["ch1"])
    }

    func testAFullSelectionDimsTheOthersButNotThePickedOnes() {
        let channels = (0..<6).map { channelTarget("c\($0)", "x\($0)") }
        let model = ForwardPickerModel(
            source: ForwardSource(kind: .message, id: sourceId, serverId: nil, summary: "", stayInServerId: nil),
            recentIds: [], conversations: [], channels: channels
        )
        for target in channels.prefix(5) { model.toggle(target) }
        XCTAssertEqual(model.selected.count, 5)
        XCTAssertTrue(model.isDisabled(channels[5]))
        XCTAssertFalse(model.isDisabled(channels[0]))
        model.toggle(channels[5])
        XCTAssertTrue(model.showsFullNotice)
        XCTAssertEqual(model.selected.count, 5)
    }

    // MARK: - Sources

    func testAMessageSourceSummarisesTheCommentOrTheForwardedTitle() throws {
        let plain = try Coding.decoder.decode(Message.self, from: messageJSON(forward: nil, body: "bora jogar"))
        XCTAssertEqual(ForwardSource.message(plain).summary, "bora jogar")
        XCTAssertEqual(ForwardSource.message(plain).kind, .message)
        XCTAssertNil(ForwardSource.message(plain).serverId)

        var forwarded = try Coding.decoder.decode(Message.self, from: messageJSON(forward: cardJSON))
        forwarded.body = ForwardFallback.body(for: try XCTUnwrap(forwarded.forward))
        XCTAssertEqual(ForwardSource.message(forwarded).summary, "Sessão 11")
        // The card in this message is restricted (the JSON says so): it can
        // only be forwarded again inside the server it came from.
        XCTAssertEqual(ForwardSource.message(forwarded).stayInServerId, serverId)
    }

    /// A restricted card may only go to `restrictedToServerId`, which is not
    /// always the server it came from (a free card stamped inside a private
    /// channel of another server); an older restricted card reads as its source.
    func testARestrictedCardStaysInRestrictedToServerIdElseItsSource() throws {
        XCTAssertNil(card().stayInServerId)
        XCTAssertNil(card(restricted: false, restrictedTo: otherServerId).stayInServerId)
        XCTAssertEqual(card(restricted: true).stayInServerId, serverId)
        XCTAssertEqual(card(restricted: true, restrictedTo: otherServerId).stayInServerId, otherServerId)

        let json = cardJSON.replacingOccurrences(
            of: #""restricted":true"#,
            with: #""restricted":true,"restrictedToServerId":"\#(otherServerId)""#
        )
        var message = try Coding.decoder.decode(Message.self, from: messageJSON(forward: json))
        XCTAssertEqual(message.forward?.restrictedToServerId, otherServerId)
        message.body = ForwardFallback.body(for: try XCTUnwrap(message.forward))
        XCTAssertEqual(ForwardSource.message(message).stayInServerId, otherServerId)
        // The picker then offers only that server's channels.
        let model = ForwardPickerModel(
            source: ForwardSource.message(message), recentIds: [],
            conversations: [dmTarget("d", "Ana")],
            channels: [channelTarget("c1", "a", server: serverId), channelTarget("c2", "b", server: otherServerId)]
        )
        XCTAssertEqual(model.conversationRows.map(\.id), [])
        XCTAssertEqual(model.channelRows.map(\.id), ["c2"])
    }

    // MARK: - The request and its answer

    func testTheRequestBodyIsTheContract() throws {
        let source = ForwardSource(kind: .bauPost, id: sourceId, serverId: serverId, summary: "x", stayInServerId: nil)
        let request = ForwardRequest(
            source: source, targets: [channelTarget("c1", "a"), dmTarget("d1", "Ana")],
            comment: "  olha isso  ", nonce: "n-1"
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Coding.encoder.encode(request)) as? [String: Any]
        )
        let src = try XCTUnwrap(object["source"] as? [String: Any])
        XCTAssertEqual(src["kind"] as? String, "bau_post")
        XCTAssertEqual(src["id"] as? String, sourceId)
        XCTAssertEqual(src["serverId"] as? String, serverId)
        let targets = try XCTUnwrap(object["targets"] as? [[String: String]])
        XCTAssertEqual(targets, [["channelId": "c1"], ["channelId": "d1"]])
        XCTAssertEqual(object["comment"] as? String, "olha isso")
        XCTAssertEqual(object["nonce"] as? String, "n-1")
    }

    func testAMessageRequestOmitsServerIdAndABlankCommentIsOmitted() throws {
        let source = ForwardSource(kind: .message, id: sourceId, serverId: nil, summary: "x", stayInServerId: nil)
        let request = ForwardRequest(source: source, targets: [channelTarget("c1", "a")], comment: "  \n", nonce: "n")
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Coding.encoder.encode(request)) as? [String: Any]
        )
        XCTAssertNil((object["source"] as? [String: Any])?["serverId"])
        XCTAssertNil(object["comment"])
    }

    func testTheAnswerDecodesPerTargetInOrder() throws {
        let json = """
        {"results":[
          {"ok":true,"target":{"channelId":"c1"},"channelId":"c1","serverId":"\(serverId)","message":{"id":"m"}},
          {"ok":false,"target":{"channelId":"c2"},"reason":"slow_mode","retryAfterMs":1200},
          {"ok":false,"target":{"userId":"u"},"reason":"stays_in_server"},
          {"ok":false,"target":{"channelId":"c4"},"reason":"something_new"}
        ]}
        """
        let outcomes = try Coding.decoder.decode(ForwardResponse.self, from: Data(json.utf8)).outcomes
        XCTAssertEqual(outcomes.count, 4)
        XCTAssertTrue(outcomes[0].ok)
        XCTAssertEqual(outcomes[0].serverId, serverId)
        XCTAssertEqual(outcomes[1].refusal, .slowMode)
        XCTAssertEqual(outcomes[1].retryAfterMs, 1200)
        XCTAssertEqual(outcomes[1].channelId, "c2")
        XCTAssertEqual(outcomes[2].refusal, .staysInServer)
        XCTAssertEqual(outcomes[3].refusal, .unavailable, "a reason added later is the catch-all")
    }

    /// The other targets really did go out: one row this build cannot read
    /// must not cost the whole answer.
    func testARowThatCannotBeReadDoesNotCostTheAnswer() throws {
        let json = """
        {"results":[{"nonsense":true},
          {"ok":true,"target":{"channelId":"c1"},"channelId":"c1","serverId":null,"message":{}}]}
        """
        let outcomes = try Coding.decoder.decode(ForwardResponse.self, from: Data(json.utf8)).outcomes
        XCTAssertEqual(outcomes.map(\.channelId), ["c1"])
        XCTAssertTrue(outcomes[0].ok)
        XCTAssertNil(outcomes[0].serverId, "a conversation has no server")
    }

    func testEveryRefusalHasItsOwnSentence() {
        let reasons: [ForwardRefusal] = [
            .noAccess, .cannotSend, .badTarget, .staysInServer, .unreachable,
            .slowMode, .rateLimited, .automod, .unavailable,
        ]
        let copies = reasons.map { $0.copy(retryAfterMs: nil) }
        XCTAssertEqual(Set(copies).count, reasons.count)
        for copy in copies {
            XCTAssertFalse(copy.contains("\u{2014}"), "no em dash")
            XCTAssertFalse(copy.isEmpty)
        }
        XCTAssertTrue(ForwardRefusal.slowMode.copy(retryAfterMs: 1200).contains("2"), "rounds up to whole seconds")
        XCTAssertTrue(ForwardRefusal.slowMode.isTransient)
        XCTAssertFalse(ForwardRefusal.noAccess.isTransient)
    }

    func testRequestLevelFailuresMapToTheirOwnSentences() {
        XCTAssertEqual(ForwardFailure.from(APIError.notFound("Not found")), .unavailable)
        XCTAssertEqual(ForwardFailure.from(APIError.server(status: 422, message: "source_empty")), .notForwardable)
        XCTAssertEqual(ForwardFailure.from(APIError.rateLimited(retryAfter: 5)), .rateLimited(retryAfter: 5))
        XCTAssertEqual(ForwardFailure.from(APIError.transport("offline")), .other("offline"))
    }

    func testTheConfigIsOffUnlessExplicitlyTrue() throws {
        XCTAssertTrue(try Coding.decoder.decode(ForwardConfig.self, from: Data(#"{"enabled":true}"#.utf8)).enabled)
        XCTAssertFalse(try Coding.decoder.decode(ForwardConfig.self, from: Data(#"{"enabled":false}"#.utf8)).enabled)
        XCTAssertFalse(try Coding.decoder.decode(ForwardConfig.self, from: Data("{}".utf8)).enabled)
        XCTAssertFalse(try Coding.decoder.decode(ForwardConfig.self, from: Data(#"{"enabled":"yes"}"#.utf8)).enabled)
    }

    func testRecentsKeepTheLatestFirstAndAreBounded() {
        let suite = "pqp.forward.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let recents = ForwardRecents()
        XCTAssertEqual(recents.load(defaults: defaults), [])
        recents.remember(["a", "b"], defaults: defaults)
        recents.remember(["c", "a"], defaults: defaults)
        XCTAssertEqual(recents.load(defaults: defaults), ["c", "a", "b"])
        recents.remember((0..<30).map { "x\($0)" }, defaults: defaults)
        XCTAssertEqual(recents.load(defaults: defaults).count, 12)
        XCTAssertEqual(recents.load(defaults: defaults).first, "x0")
    }
}
