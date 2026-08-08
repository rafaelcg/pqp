import UIKit
import XCTest
@testable import pqp

/// Avatars: the URL rule and the downscale.
///
/// These are the two parts of the feature that are logic rather than layout,
/// and both fail quietly. A URL rule that is one case too permissive turns a
/// field the account holder types into an `src` on everybody else's screen; a
/// crop with its axes the wrong way round produces a perfectly plausible
/// square of somebody's forehead.
///
/// Deliberately offline, unlike `AttachmentUploadTests` — none of this needs a
/// server, and the upload dance it would exercise is the same one that suite
/// already proves against real storage.
final class AvatarTests: XCTestCase {
    private let backend = Backend(
        apiBaseURL: URL(string: "https://api.example.test")!,
        webSocketURL: URL(string: "wss://api.example.test/ws")!
    )

    // MARK: - resolve

    func testResolvesThisServersOwnPathAgainstTheApiBase() {
        // The server emits it root-relative because it does not know its own
        // public origin. On a device build the base is a Mac on the LAN and on
        // release it is api.pqp.gg; a bare path resolves against neither.
        let url = Avatar.resolve("/api/avatars/abc?v=deadbeef", backend: backend)
        XCTAssertEqual(url?.absoluteURL.absoluteString,
                       "https://api.example.test/api/avatars/abc?v=deadbeef")
    }

    func testPassesAnHttpsUrlThrough() {
        XCTAssertEqual(
            Avatar.resolve("https://cdn.example.com/a.png", backend: backend)?.absoluteString,
            "https://cdn.example.com/a.png"
        )
    }

    func testRefusesPlainHttp() {
        // ATS blocks it on a release build anyway, so accepting it here would
        // only mean a picture that works in the simulator and not on a phone.
        XCTAssertNil(Avatar.resolve("http://cdn.example.com/a.png", backend: backend))
    }

    func testRefusesSchemesThatAreNotPictures() {
        XCTAssertNil(Avatar.resolve("javascript:alert(1)", backend: backend))
        XCTAssertNil(Avatar.resolve("data:image/png;base64,AAAA", backend: backend))
        XCTAssertNil(Avatar.resolve("file:///etc/passwd", backend: backend))
    }

    func testTreatsNilAndEmptyAsNoAvatar() {
        XCTAssertNil(Avatar.resolve(nil, backend: backend))
        XCTAssertNil(Avatar.resolve("", backend: backend))
    }

    // MARK: - downscale

    private func image(width: Int, height: Int) -> UIImage {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(
            size: CGSize(width: width, height: height), format: format
        )
        return renderer.image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    func testProducesASquareOfTheRequestedSize() {
        for (width, height) in [(1600, 900), (900, 1600), (512, 512), (4000, 30)] {
            let data = AvatarUploader.squareJpeg(image(width: width, height: height), size: 512)
            let decoded = data.flatMap(UIImage.init(data:))
            XCTAssertEqual(decoded?.size, CGSize(width: 512, height: 512),
                           "\(width)x\(height) did not come back square")
        }
    }

    func testEncodesAsJpegRegardlessOfTheSource() {
        let data = AvatarUploader.squareJpeg(image(width: 800, height: 600), size: 512)
        // JPEG's SOI marker. A PNG would start 0x89 'P' 'N' 'G'; the upload is
        // signed as image/jpeg and storage compares the stored type on the HEAD.
        XCTAssertEqual(Array(data!.prefix(2)), [0xFF, 0xD8])
    }

    func testATwelveMegapixelPhotoBecomesTensOfKilobytes() {
        // The whole point of doing this client-side. The server's cap is 5 MiB
        // and would accept the original; nobody wants to download it a hundred
        // times to draw a member list.
        let data = AvatarUploader.squareJpeg(image(width: 4032, height: 3024), size: 512)
        XCTAssertNotNil(data)
        XCTAssertLessThan(data!.count, 512 * 1024)
    }

    func testRefusesAnImageWithNoPixels() {
        XCTAssertNil(AvatarUploader.squareJpeg(UIImage(), size: 512))
    }
}
