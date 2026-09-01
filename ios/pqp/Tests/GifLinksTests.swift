import XCTest
@testable import pqp

/// The allowlist that decides whether a message body is drawn as a picture.
///
/// Every case here has a counterpart in `client/src/lib/gif-media.test.ts`,
/// `packages/shared/src/api.test.ts` and Android's `GifLinksTest`, deliberately:
/// the three clients have to agree about which bodies are media, and the ones
/// that read as hostile are the reason the predicate exists at all.
final class GifLinksTests: XCTestCase {
    private let klipy = "https://static.klipy.com/ii/abc/14/af/um0L4dFH.gif"
    private let giphy = "https://media3.giphy.com/media/abc123/giphy.gif"
    private let tenor = "https://media.tenor.com/xyz/happy-dance.gif"

    func testAnAllowlistedHostServingAnImageIsMedia() {
        XCTAssertTrue(GifLinks.isMediaURL(klipy))
        XCTAssertTrue(GifLinks.isMediaURL(giphy))
        XCTAssertTrue(GifLinks.isMediaURL(tenor))
        XCTAssertTrue(GifLinks.isMediaURL("https://i.giphy.com/abc123.gif"))
        XCTAssertTrue(GifLinks.isMediaURL("https://c.tenor.com/abc/x.gif"))
        XCTAssertTrue(GifLinks.isMediaURL("https://media.giphy.com/media/abc/giphy.webp"))
    }

    func testAQueryStringDoesNotStopItBeingMedia() {
        XCTAssertTrue(GifLinks.isMediaURL("https://media0.giphy.com/media/abc/giphy.gif?cid=1&ct=g"))
    }

    func testAnyOtherHostIsNotMediaHoweverTheURLIsDressedUp() {
        XCTAssertFalse(GifLinks.isMediaURL("https://evil.example/tracker.gif"))
        XCTAssertFalse(GifLinks.isMediaURL("https://giphy.com.evil.example/giphy.gif"))
        XCTAssertFalse(GifLinks.isMediaURL("https://notgiphy.com/media/abc/giphy.gif"))
        XCTAssertFalse(GifLinks.isMediaURL("https://static.klipy.com.evil.example/a.gif"))
        XCTAssertFalse(GifLinks.isMediaURL("https://media.giphy.com@evil.example/a.gif"))
        XCTAssertFalse(GifLinks.isMediaURL("https://user:pw@media.giphy.com/media/abc/giphy.gif"))
    }

    func testTheBareProviderDomainIsNotAMediaHost() {
        XCTAssertFalse(GifLinks.isMediaURL("https://giphy.com/media/abc/giphy.gif"))
        XCTAssertFalse(GifLinks.isMediaURL("https://klipy.com/abc.gif"))
        XCTAssertFalse(GifLinks.isMediaURL("https://tenor.com/view/abc.gif"))
    }

    func testHttpIsRefusedEvenOnAnAllowlistedHost() {
        XCTAssertFalse(GifLinks.isMediaURL("http://static.klipy.com/ii/a/b.gif"))
    }

    func testAPathThatIsNotAnImageIsNotMedia() {
        XCTAssertFalse(GifLinks.isMediaURL("https://media.giphy.com/media/abc/giphy.mp4"))
        XCTAssertFalse(GifLinks.isMediaURL("https://media.giphy.com/media/abc/"))
        // Only the path decides. `?x=.gif` on an HTML page would otherwise be
        // enough to get that page drawn as a picture.
        XCTAssertFalse(GifLinks.isMediaURL("https://media.giphy.com/media/abc/page?x=.gif"))
    }

    func testABodyThatIsOnlyTheURLIsMedia() {
        XCTAssertEqual(GifLinks.mediaBody(klipy)?.absoluteString, klipy)
        // A share sheet appends a newline often enough that ignoring this
        // would look random.
        XCTAssertEqual(GifLinks.mediaBody("  \(klipy)\n")?.absoluteString, klipy)
    }

    func testABodyWithWordsAroundTheURLStaysText() {
        XCTAssertNil(GifLinks.mediaBody("look at this \(klipy)"))
        XCTAssertNil(GifLinks.mediaBody("\(klipy) lol"))
        XCTAssertNil(GifLinks.mediaBody("\(klipy) \(tenor)"))
        XCTAssertNil(GifLinks.mediaBody(""))
        XCTAssertNil(GifLinks.mediaBody("hello"))
    }

    func testSomethingThatIsNotAURLAtAllDoesNotThrow() {
        XCTAssertFalse(GifLinks.isMediaURL("::::"))
        XCTAssertFalse(GifLinks.isMediaURL("https://"))
        XCTAssertFalse(GifLinks.isMediaURL("https://[bad"))
        XCTAssertFalse(GifLinks.isMediaURL("mailto:someone@example.com"))
    }

    // MARK: - The contract with shared

    /// `ios/pqp`, derived from this file rather than from a bundle, the way
    /// `NoEmDashTests` finds the sources: a test bundle contains compiled code,
    /// not the repo being asserted about.
    private static var repoRoot: URL {
        URL(fileURLWithPath: #filePath)      // …/ios/pqp/Tests/GifLinksTests.swift
            .deletingLastPathComponent()     // …/ios/pqp/Tests
            .deletingLastPathComponent()     // …/ios/pqp
            .deletingLastPathComponent()     // …/ios
            .deletingLastPathComponent()     // repo root
    }

    /// The host allowlist in `packages/shared/src/gifs.ts`, exercised through
    /// this client's copy with a URL built for each pattern. A regex-to-regex
    /// comparison would only prove the two strings match; this proves the two
    /// *decisions* match, which is what stops a host added on the web (or
    /// removed from it) drawing differently on the phone.
    func testTheHostAllowlistIsTheOneSharedPublishes() throws {
        let shared = Self.repoRoot.appending(path: "packages/shared/src/gifs.ts")
        let source = try String(contentsOf: shared, encoding: .utf8)
        let hosts = source.matches(of: #/\/\^([^\/]+)\$\//#).map { String($0.output.1) }
        XCTAssertEqual(hosts.count, 5, "Parsed the wrong number of host patterns out of gifs.ts")

        let samples: [String: String] = [
            #"static\.klipy\.com"#: "https://static.klipy.com/ii/a/b/c/d.gif",
            #"media\d*\.giphy\.com"#: "https://media3.giphy.com/media/a/giphy.gif",
            #"i\.giphy\.com"#: "https://i.giphy.com/a.gif",
            #"media\d*\.tenor\.com"#: "https://media.tenor.com/a/b.gif",
            #"c\.tenor\.com"#: "https://c.tenor.com/a/b.gif",
        ]
        XCTAssertEqual(
            Set(samples.keys), Set(hosts),
            "The host allowlist in gifs.ts changed. Update GifLinks.mediaHosts and the samples together."
        )
        for url in samples.values {
            XCTAssertTrue(GifLinks.isMediaURL(url), "\(url) should be media")
        }
    }

    func testTheExtensionAllowlistIsTheOneSharedPublishes() throws {
        let shared = Self.repoRoot.appending(path: "packages/shared/src/gifs.ts")
        let source = try String(contentsOf: shared, encoding: .utf8)
        let block = try XCTUnwrap(
            source.firstMatch(of: #/GIF_MEDIA_EXTENSIONS\s*=\s*\[([^\]]*)\]/#)?.output.1,
            "No GIF_MEDIA_EXTENSIONS in gifs.ts"
        )
        let extensions = String(block).matches(of: #/"([^"]+)"/#).map { String($0.output.1) }
        XCTAssertFalse(extensions.isEmpty)
        XCTAssertEqual(Set(extensions), Set(GifLinks.mediaExtensions))
    }
}
