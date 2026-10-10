import XCTest
@testable import pqp

/// The phone's copy of the web's `channel-refs.test.ts` and the Android
/// `BauChannelRefsTest`: same cases, same answers.
final class BauChannelRefsTests: XCTestCase {
    private let geral = "11111111-2222-4333-8444-555555555555"
    private let voz = "22222222-2222-4333-8444-555555555555"
    private let secret = "33333333-2222-4333-8444-555555555555"
    private let category = "44444444-2222-4333-8444-555555555555"

    private func channel(_ id: String, _ name: String, type: String = "text") throws -> Channel {
        let json = #"{"id":"\#(id)","serverId":null,"kind":"server","name":"\#(name)","type":"\#(type)","position":0,"isPrivate":false,"topic":null,"imageUrl":null,"parentId":null}"#
        return try JSONDecoder().decode(Channel.self, from: Data(json.utf8))
    }

    private func channels() throws -> [Channel] {
        [
            try channel(category, "texto", type: "category"),
            try channel(geral, "geral"),
            try channel(voz, "Sala-de-voz", type: "voice"),
            try channel("55555555-2222-4333-8444-555555555555", "geral-2"),
        ]
    }

    private func duplicated() throws -> [Channel] {
        try channels() + [try channel("66666666-2222-4333-8444-555555555555", "GERAL")]
    }

    func testAStoredReferenceBecomesALinkWithTheCurrentName() throws {
        XCTAssertEqual(
            BauChannelRefs.parse("manda no <#\(geral)> hoje", channels: try channels()),
            [.text("manda no "), .link(id: geral, name: "geral"), .text(" hoje")]
        )
        XCTAssertEqual(
            BauChannelRefs.parse("<#\(geral.uppercased())>", channels: try channels()),
            [.link(id: geral, name: "geral")]
        )
    }

    func testAChannelTheViewerCannotSeeIsUnavailableAndNeverNamed() throws {
        XCTAssertEqual(
            BauChannelRefs.parse("veja <#\(secret)>", channels: try channels()),
            [.text("veja "), .unavailable(id: secret)]
        )
        XCTAssertEqual(
            BauChannelRefs.parse("<#\(category)>", channels: try channels()),
            [.unavailable(id: category)]
        )
    }

    func testOldPlainTextHashResolvesWhenExactlyOneChannelHasTheName() throws {
        XCTAssertEqual(
            BauChannelRefs.parse("Testa aí e manda um áudio no #geral dizendo o que achou", channels: try channels()),
            [
                .text("Testa aí e manda um áudio no "),
                .link(id: geral, name: "geral"),
                .text(" dizendo o que achou"),
            ]
        )
        XCTAssertEqual(
            BauChannelRefs.parse("#sala-de-voz!", channels: try channels()),
            [.link(id: voz, name: "Sala-de-voz"), .text("!")]
        )
    }

    func testUnknownAmbiguousMidWordAndURLHashesStayText() throws {
        let plain = ["#nada", "a#geral", "https://x.com/p#geral", "#geralzao", "&#geral;"]
        for text in plain {
            XCTAssertEqual(BauChannelRefs.parse(text, channels: try channels()), [.text(text)], text)
        }
        XCTAssertEqual(BauChannelRefs.parse("#geral", channels: try duplicated()), [.text("#geral")])
        XCTAssertEqual(BauChannelRefs.parse("", channels: try channels()), [])
        XCTAssertEqual(BauChannelRefs.parse("oi #geral", channels: []), [.text("oi #geral")])
    }

    func testFindQueryFollowsTheEndOfTheText() {
        XCTAssertEqual(BauChannelRefs.findQuery("manda no #ge")?.query, "ge")
        XCTAssertEqual(BauChannelRefs.findQuery("#")?.query, "")
        XCTAssertEqual(BauChannelRefs.findQuery("oi\n#voz")?.query, "voz")
        XCTAssertNil(BauChannelRefs.findQuery("page#anchor"))
        XCTAssertNil(BauChannelRefs.findQuery("<#\(geral)>"))
        XCTAssertNil(BauChannelRefs.findQuery("#geral "))
        XCTAssertNil(BauChannelRefs.findQuery("sem hash"))
    }

    func testFilterListsEverythingButCategoriesPrefixBeforeSubstringCapped() throws {
        let all = try channels()
        XCTAssertEqual(BauChannelRefs.filter(all, query: "").map(\.name), ["geral", "Sala-de-voz", "geral-2"])
        XCTAssertEqual(BauChannelRefs.filter(all, query: "VOZ").map(\.name), ["Sala-de-voz"])
        XCTAssertEqual(BauChannelRefs.filter(all, query: "ger").map(\.name), ["geral", "geral-2"])
        XCTAssertEqual(BauChannelRefs.filter(all, query: "2").map(\.name), ["geral-2"])
        XCTAssertTrue(BauChannelRefs.filter(all, query: "zzz").isEmpty)
        let many = try (1...20).map { try channel("0000000\($0 % 10)-2222-4333-8444-5555555555\(String(format: "%02d", $0))", "c\($0)") }
        XCTAssertEqual(BauChannelRefs.filter(many, query: "").count, BauChannelRefs.maxSuggestions)
    }

    func testApplySwapsTheTokenForTheNameAndOneSpace() throws {
        let all = try channels()
        let text = "manda no #ge"
        let query = try XCTUnwrap(BauChannelRefs.findQuery(text))
        XCTAssertEqual(BauChannelRefs.apply(to: text, query: query, channel: all[1], channels: all), "manda no #geral ")
        let dup = try duplicated()
        let q2 = try XCTUnwrap(BauChannelRefs.findQuery("#ge"))
        XCTAssertEqual(BauChannelRefs.apply(to: "#ge", query: q2, channel: dup[1], channels: dup), "<#\(geral)> ")
    }

    func testDisplayAndStoredFormsRoundTrip() throws {
        let all = try channels()
        let stored = "manda no <#\(geral)> e na <#\(voz)>"
        let display = BauChannelRefs.toDisplay(stored, channels: all)
        XCTAssertEqual(display, "manda no #geral e na #Sala-de-voz")
        XCTAssertEqual(BauChannelRefs.toStored(display, channels: all), stored)
        XCTAssertEqual(BauChannelRefs.toDisplay("veja <#\(secret)>", channels: all), "veja <#\(secret)>")
        XCTAssertEqual(BauChannelRefs.toStored("veja <#\(secret)>", channels: all), "veja <#\(secret)>")
        XCTAssertEqual(BauChannelRefs.toStored("oi #nada e a#geral", channels: all), "oi #nada e a#geral")
    }

    func testTheDraftIsLimitedOnWhatTheServerWillStore() throws {
        let all = try channels()
        let text = String(repeating: "#geral ", count: 570)
        XCTAssertLessThanOrEqual(text.utf16.count, CommunityHomeLimits.bodyMax)
        var draft = ComposeDraft(title: "t", body: text)
        XCTAssertNil(draft.problem)
        draft.channels = all
        XCTAssertEqual(draft.problem, .bodyTooLong)
        XCTAssertNil(draft.request)
        var ok = ComposeDraft(title: "t", body: "oi #geral")
        ok.channels = all
        XCTAssertEqual(ok.request?.body, "oi <#\(geral)>")
    }
}
