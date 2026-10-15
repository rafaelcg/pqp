import XCTest
@testable import pqp

/// Compartilhar on a public Baú post: `publicUrl` on the wire (present, null,
/// absent from an older API) and the link the share sheet is handed.
///
/// The URL cases mirror `bauShareUrl` in
/// `packages/shared/src/community-home-public.ts`, plus the one rule the phone
/// adds: any `utm_*` already on the address is replaced, never duplicated.
final class BauPublicShareTests: XCTestCase {
    private let page = "https://pqp.gg/c/mesa-da-tues/p/1d4cec33-e2e8-4200-8c11-9cf15789a4cb"

    // MARK: - The URL

    func testAppendsTheNativeCampaign() throws {
        let url = try XCTUnwrap(BauPublicShare.shareURL(publicUrl: page))
        XCTAssertEqual(
            url.absoluteString,
            "\(page)?utm_source=native&utm_medium=share&utm_campaign=bau"
        )
    }

    func testReplacesExistingCampaignParamsAndKeepsEverythingElse() throws {
        let url = try XCTUnwrap(BauPublicShare.shareURL(
            publicUrl: "\(page)?utm_source=x&ref=qg&UTM_MEDIUM=old&utm_content=a#comentarios"
        ))
        let items = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(items.map(\.name), ["ref", "utm_source", "utm_medium", "utm_campaign"])
        XCTAssertEqual(items.first { $0.name == "utm_source" }?.value, "native")
        XCTAssertEqual(items.filter { $0.name.lowercased().hasPrefix("utm_") }.count, 3)
        XCTAssertEqual(url.fragment, "comentarios")
    }

    func testIsStableWhenAppliedTwice() throws {
        let once = try XCTUnwrap(BauPublicShare.shareURL(publicUrl: page))
        let twice = try XCTUnwrap(BauPublicShare.shareURL(publicUrl: once.absoluteString))
        XCTAssertEqual(once, twice)
    }

    func testTakesAnotherSource() throws {
        let url = try XCTUnwrap(BauPublicShare.shareURL(publicUrl: page, source: "copy"))
        XCTAssertTrue(url.absoluteString.contains("utm_source=copy&"))
    }

    func testNothingToShareWithoutAUsableAddress() {
        XCTAssertNil(BauPublicShare.shareURL(publicUrl: nil))
        XCTAssertNil(BauPublicShare.shareURL(publicUrl: ""))
        XCTAssertNil(BauPublicShare.shareURL(publicUrl: "   "))
        XCTAssertNil(BauPublicShare.shareURL(publicUrl: "/c/mesa-da-tues/p/1"))
        XCTAssertNil(BauPublicShare.shareURL(publicUrl: "javascript:alert(1)"))
        XCTAssertNil(BauPublicShare.shareURL(publicUrl: "pqp://c/mesa"))
    }

    // MARK: - The post on the wire

    private let author = """
    {"id":"33333333-3333-3333-3333-333333333333","displayName":"Rafa",
     "username":"rafa","tag":"rafa#0001","avatarUrl":null}
    """

    private func post(locked: Bool = false, title: String = #""Regras da mesa""#, _ extra: String) throws -> CommunityHomePost {
        try Coding.decoder.decode(CommunityHomePost.self, from: Data("""
        {
          "id": "1d4cec33-e2e8-4200-8c11-9cf15789a4cb",
          "serverId": "7f6362dd-c16e-4f35-8256-dd3a858f82c4",
          "author": \(author),
          "title": \(title),
          "body": "Leiam antes da sessão.",
          "teaser": "Leiam antes",
          "visibility": "free",
          "locked": \(locked),
          "likeCount": 0,
          "commentCount": 0,
          "publishedAt": "2026-10-15T12:00:00.000Z",
          "createdAt": "2026-10-15T11:00:00.000Z"\(extra)
        }
        """.utf8))
    }

    func testDecodesAPublicUrl() throws {
        let decoded = try post(#", "publicUrl": "\#(page)""#)
        XCTAssertEqual(decoded.publicUrl, page)
        XCTAssertNotNil(BauPublicShare.shareURL(for: decoded))
        XCTAssertEqual(BauPublicShare.shareTitle(for: decoded), "Regras da mesa")
    }

    func testNullMeansNoPublicPage() throws {
        let decoded = try post(#", "publicUrl": null"#)
        XCTAssertNil(decoded.publicUrl)
        XCTAssertNil(BauPublicShare.shareURL(for: decoded))
    }

    func testAnOlderApiWithoutTheFieldStillDecodes() throws {
        let decoded = try post("")
        XCTAssertNil(decoded.publicUrl)
        XCTAssertNil(BauPublicShare.shareURL(for: decoded))
    }

    func testAWrongTypedValueCostsTheButtonNotThePost() throws {
        let decoded = try post(#", "publicUrl": 42"#)
        XCTAssertNil(decoded.publicUrl)
        XCTAssertEqual(decoded.title, "Regras da mesa")
    }

    func testALockedPostNeverOffersCompartilhar() throws {
        let decoded = try post(locked: true, #", "publicUrl": "\#(page)""#)
        XCTAssertNil(BauPublicShare.shareURL(for: decoded))
    }

    func testTitleFallsBackToTheTeaser() throws {
        let decoded = try post(title: "null", "")
        XCTAssertEqual(BauPublicShare.shareTitle(for: decoded), "Leiam antes")
    }

    // MARK: - The chat card on the wire

    private func card(_ extra: String) throws -> CommunityHomePostCard {
        try Coding.decoder.decode(CommunityHomePostCardResponse.self, from: Data("""
        {"card":{"postId":"1d4cec33-e2e8-4200-8c11-9cf15789a4cb",
         "serverId":"7f6362dd-c16e-4f35-8256-dd3a858f82c4","serverName":"Mesa",
         "title":"Regras da mesa","visibility":"free","locked":false\(extra)}}
        """.utf8)).card
    }

    func testCardCarriesPublicUrlWhenPresentNullOrAbsent() throws {
        XCTAssertEqual(try card(#","publicUrl":"\#(page)""#).publicUrl, page)
        XCTAssertNil(try card(#","publicUrl":null"#).publicUrl)
        XCTAssertNil(try card("").publicUrl)
    }
}
