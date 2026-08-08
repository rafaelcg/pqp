import XCTest
@testable import pqp

/// Link and notification routing, pinned.
///
/// Every input here is a string somebody else wrote — a URL Apple hands over, a
/// `path` the server put in a push payload — and every failure mode is silent:
/// the link opens the app and nothing happens, or the notification tap lands on
/// the hub instead of the conversation. There is no error to see and nothing in
/// a log. So the parsing is tested exhaustively and the two clients' shared
/// vocabulary (`server/src/services/push.ts` builds these paths,
/// `client/src/lib/app-route.ts` parses them) is asserted rather than assumed.
final class DeepLinkTests: XCTestCase {

    // MARK: - Notification paths

    /// The exact strings `buildPushPayload` and `buildCallPushPayload` emit.
    /// If these three ever stop matching, notifications route to nowhere.
    func testParsesTheServersPushPaths() {
        XCTAssertEqual(
            DeepLink.target(path: "/app/dm/1e0b6a4e-1111-2222-3333-444444444444"),
            .conversation(channelId: "1e0b6a4e-1111-2222-3333-444444444444")
        )
        XCTAssertEqual(
            DeepLink.target(path: "/app/server/srv-1/channel/chan-1"),
            .channel(serverId: "srv-1", channelId: "chan-1")
        )
        XCTAssertEqual(
            DeepLink.target(path: "/app/invite/AB12CD34"),
            .invite(code: "AB12CD34")
        )
    }

    /// `/app` is the payload's fallback when a server channel push has no
    /// server id. It means "the hub", which is where the app already is.
    func testTheBareAppPathAsksForNothing() {
        XCTAssertNil(DeepLink.target(path: "/app"))
        XCTAssertNil(DeepLink.target(path: "/"))
        XCTAssertNil(DeepLink.target(path: ""))
    }

    func testUnknownRoutesAreIgnoredRatherThanGuessedAt() {
        XCTAssertNil(DeepLink.target(path: "/app/settings"))
        XCTAssertNil(DeepLink.target(path: "/app/dm"))
        XCTAssertNil(DeepLink.target(path: "/app/server/srv-1/voice/chan-1"))
        XCTAssertNil(DeepLink.target(path: "/app/server/srv-1/channel"))
        XCTAssertNil(DeepLink.target(path: "/privacy"))
    }

    func testTheLeadingAppSegmentIsOptional() {
        // So the same parser reads a custom-scheme URL, which has no /app.
        XCTAssertEqual(DeepLink.target(path: "/dm/x"), .conversation(channelId: "x"))
        XCTAssertEqual(DeepLink.target(path: "/invite/CODE"), .invite(code: "CODE"))
        XCTAssertEqual(DeepLink.target(path: "/server/s"), .server(id: "s"))
    }

    /// Trailing and doubled slashes come from real links; both must not change
    /// the answer.
    func testExtraSlashesDoNotChangeTheRoute() {
        XCTAssertEqual(DeepLink.target(path: "/app/invite/CODE/"), .invite(code: "CODE"))
        XCTAssertEqual(DeepLink.target(path: "//app//invite//CODE"), .invite(code: "CODE"))
    }

    // MARK: - Universal links

    func testAUniversalLinkResolvesToTheInvite() {
        XCTAssertEqual(
            DeepLink.target(url: URL(string: "https://pqp.gg/app/invite/AB12CD34")!),
            .invite(code: "AB12CD34")
        )
    }

    /// Query and fragment ride along on shared links (utm tags, mostly) and are
    /// not part of the route.
    func testAQueryOrFragmentIsNotPartOfTheCode() {
        XCTAssertEqual(
            DeepLink.target(url: URL(string: "https://pqp.gg/app/invite/AB12CD34?utm_source=x")!),
            .invite(code: "AB12CD34")
        )
        XCTAssertEqual(
            DeepLink.target(url: URL(string: "https://pqp.gg/app/invite/AB12CD34#top")!),
            .invite(code: "AB12CD34")
        )
    }

    func testANonInvitePageOnTheSiteIsNotADestination() {
        XCTAssertNil(DeepLink.target(url: URL(string: "https://pqp.gg/")!))
        XCTAssertNil(DeepLink.target(url: URL(string: "https://pqp.gg/terms")!))
    }

    // MARK: - Custom scheme

    /// THE custom-scheme bug: under `pqp://invite/CODE` the first segment is the
    /// URL's *host*, not a path component. Reading `url.path` alone finds only
    /// "/CODE" and the route never matches.
    func testTheCustomSchemeTreatsItsHostAsTheFirstSegment() {
        XCTAssertEqual(
            DeepLink.target(url: URL(string: "pqp://invite/AB12CD34")!),
            .invite(code: "AB12CD34")
        )
    }

    func testTheCustomSchemeIsCaseInsensitive() {
        // iOS lowercases schemes on the way in, but a hand-typed URL may not be.
        XCTAssertEqual(
            DeepLink.target(url: URL(string: "PQP://invite/CODE")!),
            .invite(code: "CODE")
        )
    }

    func testTheCustomSchemeAlsoCarriesConversationsAndChannels() {
        XCTAssertEqual(
            DeepLink.target(url: URL(string: "pqp://dm/chan-9")!),
            .conversation(channelId: "chan-9")
        )
        XCTAssertEqual(
            DeepLink.target(url: URL(string: "pqp://server/s1/channel/c1")!),
            .channel(serverId: "s1", channelId: "c1")
        )
    }

    func testACustomSchemeUrlWithNoCodeIsNotADestination() {
        XCTAssertNil(DeepLink.target(url: URL(string: "pqp://invite")!))
        XCTAssertNil(DeepLink.target(url: URL(string: "pqp://")!))
    }

    // MARK: - Percent encoding

    func testPercentEncodedSegmentsAreDecodedOnce() {
        XCTAssertEqual(
            DeepLink.target(path: "/app/invite/AB%2D12"),
            .invite(code: "AB-12")
        )
    }

    /// A code long enough to be a payload rather than a code is refused before
    /// it becomes a request path.
    func testAnAbsurdlyLongCodeIsRefused() {
        let long = String(repeating: "a", count: DeepLink.maxInviteCodeLength + 1)
        XCTAssertNil(DeepLink.target(path: "/app/invite/\(long)"))
        // The boundary itself is fine.
        let atLimit = String(repeating: "a", count: DeepLink.maxInviteCodeLength)
        XCTAssertEqual(DeepLink.target(path: "/app/invite/\(atLimit)"), .invite(code: atLimit))
    }

    // MARK: - Pasted codes

    /// Behavioural parity with `normalizeInviteCode` in
    /// `client/src/lib/onboarding.ts`, including the cases its own tests pin:
    /// people paste the same links into both clients.
    func testNormalizeAcceptsALinkAWholeUrlOrABareCode() {
        XCTAssertEqual(DeepLink.normalizeInviteCode("AB12CD"), "AB12CD")
        XCTAssertEqual(DeepLink.normalizeInviteCode("pqp://invite/AB12CD"), "AB12CD")
        XCTAssertEqual(
            DeepLink.normalizeInviteCode("https://pqp.gg/app/invite/AB12CD"),
            "AB12CD"
        )
        XCTAssertEqual(DeepLink.normalizeInviteCode("/app/invite/AB12CD"), "AB12CD")
        XCTAssertEqual(DeepLink.normalizeInviteCode("  AB12CD\n"), "AB12CD")
        XCTAssertEqual(
            DeepLink.normalizeInviteCode("https://pqp.gg/app/invite/AB12CD?ref=x"),
            "AB12CD"
        )
    }

    func testNormalizeOfNothingIsNothing() {
        XCTAssertEqual(DeepLink.normalizeInviteCode(""), "")
        XCTAssertEqual(DeepLink.normalizeInviteCode("   "), "")
    }
}
