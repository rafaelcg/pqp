import SwiftUI
import UIKit
import XCTest
@testable import pqp

/// THE INSTRUMENT COLOURS ARE THE WEB'S. `--color-inst-*` in
/// `client/src/index.css` are oklch tokens; the phone carries sRGB conversions of
/// them (`JamInstrument.rgb`). This reads the web's file, converts the phone's
/// colours back to oklch and compares, so a token that moves there fails here
/// instead of drifting.
final class JamInstrumentColorTests: XCTestCase {
    private func srgbToOklch(_ r: Double, _ g: Double, _ b: Double) -> (l: Double, c: Double, h: Double) {
        func lin(_ x: Double) -> Double { x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4) }
        let (lr, lg, lb) = (lin(r), lin(g), lin(b))
        let l = cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
        let m = cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
        let s = cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
        let L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
        let a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
        let bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
        var hue = atan2(bb, a) * 180 / .pi
        if hue < 0 { hue += 360 }
        return (L, hypot(a, bb), hue)
    }

    private func webTokens() throws -> [String: (l: Double, c: Double, h: Double)] {
        let css = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("client/src/index.css")
        let text = try String(contentsOf: css, encoding: .utf8)
        var out: [String: (Double, Double, Double)] = [:]
        let pattern = try NSRegularExpression(pattern: #"--color-inst-(\w+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)"#)
        for match in pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            func part(_ i: Int) -> String { String(text[Range(match.range(at: i), in: text)!]) }
            out[part(1)] = (Double(part(2))!, Double(part(3))!, Double(part(4))!)
        }
        return out
    }

    func testEveryInstrumentColourIsTheWebsToken() throws {
        let tokens = try webTokens()
        XCTAssertEqual(Set(tokens.keys), Set(JamInstrument.allCases.map(\.rawValue)), "the web has a token for each instrument")
        for instrument in JamInstrument.allCases {
            let web = try XCTUnwrap(tokens[instrument.rawValue])
            let c = instrument.rgb
            let ios = srgbToOklch(c.red, c.green, c.blue)
            // The guitar's yellow is outside sRGB and is clipped, so it gets a little more room.
            let slack = instrument == .guitar ? 2.0 : 1.0
            XCTAssertEqual(ios.l, web.l, accuracy: 0.02 * slack, "\(instrument) lightness")
            XCTAssertEqual(ios.c, web.c, accuracy: 0.03 * slack, "\(instrument) chroma")
            // Hue is meaningless for a grey; `other` is nearly one, so only its lightness is held.
            if instrument != .other {
                XCTAssertEqual(ios.h, web.h, accuracy: 4 * slack, "\(instrument) hue")
            }
        }
    }

    func testGuitarIsYellowAndNotTheAppsLime() {
        let c = JamInstrument.guitar.rgb
        let hue = srgbToOklch(c.red, c.green, c.blue).h
        XCTAssertTrue((85...100).contains(hue), "guitar hue \(hue)")
        let lime = srgbToOklch(0.733, 0.925, 0.298).h
        XCTAssertGreaterThan(lime - hue, 25, "lime is the accent, a guitar lane must not read as one more button")
        // Told apart by lightness too, from the darkest blue to the lightest yellow.
        let lightness = JamInstrument.allCases.map { (i: JamInstrument) -> (JamInstrument, Double) in
            let c = i.rgb
            return (i, srgbToOklch(c.red, c.green, c.blue).l)
        }.sorted { $0.1 < $1.1 }.map(\.0)
        XCTAssertEqual(lightness, [.bass, .other, .drums, .vocals, .keys, .guitar])
    }
}

// MARK: - Covers

final class JamCoverKeyTests: XCTestCase {
    func testTheKeyIsTheSongAndThePathNotTheSignature() {
        let a = JamCoverKey.key(songId: "s1", url: "https://r2.example/jam/s1/cover-9f3.jpg?X-Amz-Signature=aaa&X-Amz-Expires=43200")
        let b = JamCoverKey.key(songId: "s1", url: "https://r2.example/jam/s1/cover-9f3.jpg?X-Amz-Signature=bbb&X-Amz-Expires=43200")
        XCTAssertEqual(a, b, "the same picture under a fresh signature is the same key")
        XCTAssertNotEqual(a, JamCoverKey.key(songId: "s1", url: "https://r2.example/jam/s1/cover-11c.jpg?X-Amz-Signature=aaa"), "a replaced cover is a new key")
        XCTAssertNotEqual(a, JamCoverKey.key(songId: "s2", url: "https://r2.example/jam/s1/cover-9f3.jpg?X-Amz-Signature=aaa"))
        XCTAssertEqual(JamCoverKey.path(of: "https://x/y.jpg"), "https://x/y.jpg", "no query is fine")
        XCTAssertEqual(JamCoverKey.fileName(for: a), JamCoverKey.fileName(for: b))
        XCTAssertEqual(JamCoverKey.fileName(for: a).count, 64)
        XCTAssertFalse(JamCoverKey.fileName(for: a).contains("/"))
    }

    private func decode(_ json: String) throws -> JamSongSummary {
        try Coding.decoder.decode(JamSongSummary.self, from: Data(json.utf8))
    }

    private func summary(cover: String?) -> String {
        """
        {"id":"s1","channelId":"c","serverId":"v","title":"T","artist":null,"joinMode":"open","wantedInstruments":[],
         "authorId":null,"authorName":null,"authorAvatarUrl":null,"createdAt":"2026-11-10T10:00:00.000Z",
         "updatedAt":"2026-11-10T10:00:00.000Z","trackCount":1,"instruments":["guitar"],"contributorCount":1,"mixDurationMs":1000
         \(cover.map { #","coverUrl":"\#($0)""# } ?? "")}
        """
    }

    func testTheSummaryCarriesTheCoverAndOlderServersCarryNone() throws {
        XCTAssertEqual(try decode(summary(cover: "https://r2.example/a.jpg?sig=1")).coverUrl, "https://r2.example/a.jpg?sig=1")
        XCTAssertNil(try decode(summary(cover: nil)).coverUrl, "absent from an older server's answer")
        XCTAssertNil(try decode(#"{"id":"s1","channelId":"c","title":"T","createdAt":"2026-11-10T10:00:00.000Z","updatedAt":"2026-11-10T10:00:00.000Z","coverUrl":null}"#).cover)
    }

    func testAFreshSignatureIsNotAChange() throws {
        let a = try decode(summary(cover: "https://r2.example/a.jpg?sig=1"))
        let b = try decode(summary(cover: "https://r2.example/a.jpg?sig=2"))
        XCTAssertEqual(a, b, "a song frame that changed nothing else redraws nothing")
        XCTAssertEqual(a.hashValue, b.hashValue)
        XCTAssertNotEqual(a, try decode(summary(cover: "https://r2.example/b.jpg?sig=1")), "a replaced cover is a change")
        XCTAssertNotEqual(a, try decode(summary(cover: nil)), "a removed cover is a change")
        XCTAssertEqual(b.coverUrl, "https://r2.example/a.jpg?sig=2", "the newest address is the one held, for the fetch")
    }
}

@MainActor
final class JamCoverStoreTests: XCTestCase {
    final class Fetcher: JamCoverFetching, @unchecked Sendable {
        private let lock = NSLock()
        private var _count = 0
        private var _fail = false
        var data: Data
        var count: Int { lock.withLock { _count } }
        var fail: Bool {
            get { lock.withLock { _fail } }
            set { lock.withLock { _fail = newValue } }
        }
        init(data: Data) { self.data = data }
        func data(from url: URL) async throws -> Data {
            let failing = lock.withLock { () -> Bool in
                _count += 1
                return _fail
            }
            if failing { throw JamCoverStore.CoverError.badResponse(403) }
            return data
        }
    }

    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("jam-cover-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func png(width: Int, height: Int) -> Data {
        let size = CGSize(width: width, height: height)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).pngData { context in
            UIColor.systemYellow.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
    }

    func testAPictureIsFetchedOnceWhateverTheSignature() async throws {
        let fetcher = Fetcher(data: png(width: 64, height: 64))
        let store = JamCoverStore(directory: directory, fetcher: fetcher)
        let first = await store.image(songId: "s1", url: "https://r2.example/jam/s1/cover-9f3.jpg?sig=aaa")
        XCTAssertNotNil(first)
        let second = await store.image(songId: "s1", url: "https://r2.example/jam/s1/cover-9f3.jpg?sig=bbb")
        XCTAssertNotNil(second)
        XCTAssertEqual(fetcher.count, 1, "a re-read of the list gives a new signature and not a new download")
        XCTAssertNotNil(store.cached(songId: "s1", url: "https://r2.example/jam/s1/cover-9f3.jpg?sig=ccc"))
    }

    func testAReplacedCoverIsFetchedAgain() async throws {
        let fetcher = Fetcher(data: png(width: 64, height: 64))
        let store = JamCoverStore(directory: directory, fetcher: fetcher)
        _ = await store.image(songId: "s1", url: "https://r2.example/jam/s1/cover-9f3.jpg?sig=aaa")
        _ = await store.image(songId: "s1", url: "https://r2.example/jam/s1/cover-11c.jpg?sig=aaa")
        XCTAssertEqual(fetcher.count, 2)
    }

    func testItSurvivesARestartAndAnExpiredSignature() async throws {
        let fetcher = Fetcher(data: png(width: 64, height: 64))
        let url = "https://r2.example/jam/s1/cover-9f3.jpg?sig=aaa"
        _ = await JamCoverStore(directory: directory, fetcher: fetcher).image(songId: "s1", url: url)
        XCTAssertEqual(fetcher.count, 1)
        // A new process: nothing in memory, the signature has lapsed (the fetcher would refuse it).
        fetcher.fail = true
        let reborn = JamCoverStore(directory: directory, fetcher: fetcher)
        XCTAssertNil(reborn.cached(songId: "s1", url: url))
        let image = await reborn.image(songId: "s1", url: "https://r2.example/jam/s1/cover-9f3.jpg?sig=EXPIRED")
        XCTAssertNotNil(image, "the bytes are on disk under the picture's identity")
        XCTAssertEqual(fetcher.count, 1, "and the network was not asked")
    }

    func testAFailureIsLeftAloneForAMinuteAndThenTriedAgain() async throws {
        let fetcher = Fetcher(data: png(width: 64, height: 64))
        fetcher.fail = true
        var clock = Date(timeIntervalSince1970: 1_000_000)
        let store = JamCoverStore(directory: directory, fetcher: fetcher, now: { clock })
        let url = "https://r2.example/jam/s1/cover-9f3.jpg?sig=aaa"
        let missed = await store.image(songId: "s1", url: url)
        XCTAssertNil(missed, "the caller keeps its own art")
        _ = await store.image(songId: "s1", url: url)
        XCTAssertEqual(fetcher.count, 1, "not hammered")
        clock = clock.addingTimeInterval(JamCoverStore.retryAfter + 1)
        fetcher.fail = false
        let later = await store.image(songId: "s1", url: url)
        XCTAssertNotNil(later)
        XCTAssertEqual(fetcher.count, 2)
    }

    func testSomethingThatIsNotAPictureIsNotACover() async throws {
        let store = JamCoverStore(directory: directory, fetcher: Fetcher(data: Data("<html>403</html>".utf8)))
        let image = await store.image(songId: "s1", url: "https://r2.example/jam/s1/cover.jpg?sig=a")
        XCTAssertNil(image)
    }

    func testAnAddressThatIsNotTheBucketsIsNeverFetched() async throws {
        let fetcher = Fetcher(data: png(width: 8, height: 8))
        let store = JamCoverStore(directory: directory, fetcher: fetcher)
        let image = await store.image(songId: "s1", url: "https://192.168.1.4/cover.jpg?sig=a")
        XCTAssertNil(image, "a phone has no business fetching a picture from its own network")
        XCTAssertEqual(fetcher.count, 0)
    }

    func testABigPictureIsDecodedDownToTheBudget() throws {
        let image = try XCTUnwrap(JamCoverStore.decode(png(width: 3000, height: 2000)))
        XCTAssertLessThanOrEqual(max(image.size.width, image.size.height) * image.scale, JamCoverStore.maxPixel)
        XCTAssertGreaterThan(image.size.width, image.size.height, "the aspect is kept")
    }

    func testTheDiskIsKeptUnderItsBudget() async throws {
        let fetcher = Fetcher(data: png(width: 64, height: 64))
        let store = JamCoverStore(directory: directory, fetcher: fetcher)
        for n in 0..<5 { _ = await store.image(songId: "s\(n)", url: "https://r2.example/jam/s\(n)/c.jpg?sig=a") }
        let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(files.count, 5)
        let total = files.reduce(0) { $0 + ((try? FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent($1).path)[.size] as? Int) ?? 0) }
        XCTAssertLessThan(total, JamCoverStore.diskBudgetBytes)
    }
}
