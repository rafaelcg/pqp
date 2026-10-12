import XCTest
@testable import pqp

/// The rules behind the inline YouTube player in the Baú: what the page asks
/// YouTube for, what the web view may load, and how the player's messages are
/// read. The player itself needs a screen and the network, so only the rules
/// are pinned.
final class BauYoutubeEmbedTests: XCTestCase {
    private let id = "dQw4w9WgXcQ"

    // MARK: The page

    func testThePageAsksTheNoCookieHostToPlayInline() {
        let page = BauYoutubeEmbed.playerPage(videoId: id)
        XCTAssertTrue(page.contains("host:'https://www.youtube-nocookie.com'"))
        XCTAssertTrue(page.contains("videoId:'\(id)'"))
        XCTAssertTrue(page.contains("playsinline:1"))
        XCTAssertTrue(page.contains("autoplay:1"))
        XCTAssertTrue(page.contains("rel:0"))
    }

    func testThePageNamesTheOriginItIsLoadedUnder() {
        let page = BauYoutubeEmbed.playerPage(
            videoId: id, origin: URL(string: "https://pqp.gg/")!
        )
        XCTAssertTrue(page.contains("origin:'https://pqp.gg'"), "no trailing slash")
    }

    func testThePageReportsToTheHandlerTheAppListensOn() {
        let page = BauYoutubeEmbed.playerPage(videoId: id)
        XCTAssertTrue(page.contains("messageHandlers.\(BauYoutubeEmbed.messageHandler).postMessage"))
        XCTAssertTrue(page.contains("function bauPause()"))
    }

    // MARK: Navigation

    private func decide(_ raw: String, main: Bool, newWindow: Bool = false) -> BauYoutubeEmbed.NavigationDecision {
        BauYoutubeEmbed.decide(url: URL(string: raw), isMainFrame: main, opensNewWindow: newWindow)
    }

    func testThePageItselfLoads() {
        XCTAssertEqual(decide("https://pqp.gg/", main: true), .allow)
        XCTAssertEqual(decide("https://pqp.gg", main: true), .allow)
        XCTAssertEqual(decide("about:blank", main: true), .allow)
    }

    func testTheMainFrameNeverFollowsALinkOut() {
        XCTAssertEqual(decide("https://www.youtube.com/watch?v=\(id)", main: true), .cancel)
        XCTAssertEqual(decide("https://youtu.be/\(id)", main: true), .cancel)
        XCTAssertEqual(decide("https://pqp.gg/app", main: true), .cancel)
        XCTAssertEqual(decide("https://evil.example/", main: true), .cancel)
    }

    func testThePlayerFrameMayLoadOverTheWeb() {
        XCTAssertEqual(decide("https://www.youtube-nocookie.com/embed/\(id)?playsinline=1", main: false), .allow)
        XCTAssertEqual(decide("https://www.youtube.com/embed/\(id)", main: false), .allow)
        XCTAssertEqual(decide("about:srcdoc", main: false), .allow)
    }

    func testAnAppSchemeIsRefusedEverywhere() {
        XCTAssertEqual(decide("youtube://watch?v=\(id)", main: false), .cancel)
        XCTAssertEqual(decide("intent://watch#Intent;end", main: false), .cancel)
        XCTAssertEqual(decide("youtube://watch?v=\(id)", main: true), .cancel)
    }

    func testANewWindowIsRefused() {
        XCTAssertEqual(decide("https://www.youtube.com/watch?v=\(id)", main: false, newWindow: true), .cancel)
    }

    func testNoURLIsRefused() {
        XCTAssertEqual(BauYoutubeEmbed.decide(url: nil, isMainFrame: false, opensNewWindow: false), .cancel)
    }

    // MARK: Messages

    func testPlayerStatesAreRead() {
        XCTAssertEqual(BauYoutubeEmbed.event(from: ["state": NSNumber(value: 1)]), .playing)
        XCTAssertEqual(BauYoutubeEmbed.event(from: ["state": NSNumber(value: 3)]), .buffering)
        for stopped in [0, 2, 5, -1] {
            XCTAssertEqual(BauYoutubeEmbed.event(from: ["state": NSNumber(value: stopped)]), .stopped, "\(stopped)")
        }
    }

    func testAnErrorIsAFailureWithItsCode() {
        // 150: the owner does not allow embedding. The card then offers
        // "Open on YouTube" instead of a player that will never start.
        XCTAssertEqual(BauYoutubeEmbed.event(from: ["error": NSNumber(value: 150)]), .failed(150))
        XCTAssertEqual(BauYoutubeEmbed.event(from: ["error": NSNumber(value: -1)]), .failed(-1))
    }

    func testAnythingElseIsIgnored() {
        XCTAssertNil(BauYoutubeEmbed.event(from: "playing"))
        XCTAssertNil(BauYoutubeEmbed.event(from: ["state": NSNumber(value: 42)]))
        XCTAssertNil(BauYoutubeEmbed.event(from: [String: Any]()))
    }
}
