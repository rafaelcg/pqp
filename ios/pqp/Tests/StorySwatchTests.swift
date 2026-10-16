import XCTest
@testable import pqp

/// QA S3: every dot in the background menu was the same lime.
@MainActor
final class StorySwatchTests: XCTestCase {
    private func centerPixel(_ image: UIImage) -> [UInt8] {
        let cg = image.cgImage!
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = CGContext(
            data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        // Draw so that the pixel at the centre of the swatch lands on the one pixel.
        context.draw(cg, in: CGRect(x: -CGFloat(cg.width) / 2, y: -CGFloat(cg.height) / 2, width: CGFloat(cg.width), height: CGFloat(cg.height)))
        return pixel
    }

    func testEveryKeyOfTheTwelveNewOnesDrawsItsOwnColour() {
        let keys = StoryRules.solidBackgrounds + StoryRules.gradientBackgrounds
        XCTAssertEqual(keys.count, 12)
        // The ticked state draws over the middle, so compare the plain swatches.
        let pixels = keys.map { centerPixel(StorySwatch.image(key: $0, selected: false)) }
        XCTAssertEqual(Set(pixels.map { $0.map(String.init).joined(separator: ",") }).count, keys.count)
    }

    func testAnUnknownKeyDrawsTheDefaultCardNotLime() {
        XCTAssertNotEqual(
            centerPixel(StorySwatch.image(key: "no-such-key", selected: false)),
            centerPixel(StorySwatch.image(key: "lime", selected: false))
        )
    }

    func testTheImageKeepsItsOwnColoursInAMenu() {
        XCTAssertEqual(StorySwatch.image(key: "sunset", selected: true).renderingMode, .alwaysOriginal)
    }
}
