import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import pqp

/// The pure math behind GIF playback — normalizing a frame delay and
/// resolving "which frame is on screen `elapsed` seconds into the loop" —
/// pinned down without needing a simulator, a real GIF file, or a display
/// link. `GIFDecoderTests` below covers the ImageIO half separately.
final class GIFTimingTests: XCTestCase {
    func testZeroDelayBecomesTheHundredMillisecondConvention() {
        XCTAssertEqual(GIFTiming.normalizedDelay(0), 0.1)
    }

    /// Some encoders write a couple of milliseconds rather than a clean
    /// zero; the convention still applies below the ~11ms threshold.
    func testNearZeroDelayAlsoNormalizes() {
        XCTAssertEqual(GIFTiming.normalizedDelay(0.01), 0.1)
    }

    func testRealDelayPassesThroughUnchanged() {
        XCTAssertEqual(GIFTiming.normalizedDelay(0.3), 0.3)
        XCTAssertEqual(GIFTiming.normalizedDelay(0.02), 0.02)
    }

    func testFrameIndexPicksTheFrameCoveringElapsedTime() {
        let durations: [TimeInterval] = [0.1, 0.2, 0.3] // cumulative: 0.1, 0.3, 0.6
        XCTAssertEqual(GIFTiming.frameIndex(at: 0, durations: durations), 0)
        XCTAssertEqual(GIFTiming.frameIndex(at: 0.05, durations: durations), 0)
        XCTAssertEqual(GIFTiming.frameIndex(at: 0.15, durations: durations), 1)
        XCTAssertEqual(GIFTiming.frameIndex(at: 0.35, durations: durations), 2)
        XCTAssertEqual(GIFTiming.frameIndex(at: 0.59, durations: durations), 2)
    }

    func testFrameIndexWrapsAtTheLoopBoundary() {
        // Exact binary fractions (eighths and quarters), so the boundaries
        // below land exactly rather than one ULP off from float summation —
        // 0.1 + 0.2 + 0.3 is not exactly 0.6 in binary floating point, which
        // would make an assertion pinned to that literal boundary flaky.
        let durations: [TimeInterval] = [0.125, 0.125, 0.25] // cumulative: 0.125, 0.25, total 0.5
        XCTAssertEqual(GIFTiming.frameIndex(at: 0.5, durations: durations), 0, "exactly one full loop wraps to the start")
        XCTAssertEqual(GIFTiming.frameIndex(at: 0.6, durations: durations), 0)
        XCTAssertEqual(GIFTiming.frameIndex(at: 0.75, durations: durations), 2)
        XCTAssertEqual(GIFTiming.frameIndex(at: 1.3, durations: durations), 2, "past multiple full loops")
    }

    func testFrameIndexHandlesUnevenPerFrameDelays() {
        // A single long "hold" frame at the end, the way a looping sticker
        // often pauses before restarting — the whole reason variable-delay
        // playback (rather than `UIImageView.animationDuration`) matters.
        let durations: [TimeInterval] = [0.05, 0.05, 1.0]
        XCTAssertEqual(GIFTiming.frameIndex(at: 0.2, durations: durations), 2)
        XCTAssertEqual(GIFTiming.frameIndex(at: 1.05, durations: durations), 2)
        XCTAssertEqual(GIFTiming.frameIndex(at: 1.1, durations: durations), 0)
    }

    func testFrameIndexDegeneratesGracefully() {
        XCTAssertEqual(GIFTiming.frameIndex(at: 5, durations: []), 0)
        XCTAssertEqual(GIFTiming.frameIndex(at: 5, durations: [0, 0, 0]), 0)
        XCTAssertEqual(GIFTiming.frameIndex(at: .nan, durations: [0.1, 0.1]), 0)
        XCTAssertEqual(GIFTiming.frameIndex(at: -1, durations: [0.1, 0.1]), 0)
    }
}

/// Exercises `GIFDecoder` against real, tiny GIFs built in-memory with
/// ImageIO rather than a bundled fixture — the two things worth pinning down
/// are frame count/timing round-tripping correctly, and that the ~2MP
/// downsample cap actually shrinks a frame that exceeds it.
final class GIFDecoderTests: XCTestCase {
    /// Builds a minimal animated GIF: `frames.count` solid-color squares of
    /// `size`, each held for `delay` seconds.
    private func makeGIFData(size: Int, frameCount: Int, delay: Double) -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data, UTType.gif.identifier as CFString, frameCount, nil
        ) else {
            XCTFail("Could not create GIF destination")
            return Data()
        }

        let gifProperties = [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]]
        CGImageDestinationSetProperties(destination, gifProperties as CFDictionary)

        let frameProperties = [
            kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFUnclampedDelayTime: delay]
        ]

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        for frame in 0..<frameCount {
            let context = CGContext(
                data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )!
            context.setFillColor(
                red: CGFloat(frame) / CGFloat(max(frameCount - 1, 1)), green: 0, blue: 0, alpha: 1
            )
            context.fill(CGRect(x: 0, y: 0, width: size, height: size))
            guard let cgImage = context.makeImage() else {
                XCTFail("Could not render frame \(frame)")
                continue
            }
            CGImageDestinationAddImage(destination, cgImage, frameProperties as CFDictionary)
        }

        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    func testDecodesEveryFrameWithItsDelay() {
        let data = makeGIFData(size: 40, frameCount: 3, delay: 0.2)
        let frames = GIFDecoder.decode(data: data)
        XCTAssertEqual(frames.count, 3)
        for frame in frames {
            XCTAssertEqual(frame.duration, 0.2, accuracy: 0.001)
        }
    }

    func testZeroDelayFramesNormalizeThroughTheDecoder() {
        let data = makeGIFData(size: 20, frameCount: 2, delay: 0)
        let frames = GIFDecoder.decode(data: data)
        XCTAssertEqual(frames.count, 2)
        for frame in frames {
            XCTAssertEqual(frame.duration, 0.1, accuracy: 0.001)
        }
    }

    /// A frame above the ~2MP cap should come back downsampled, not at its
    /// original resolution — the whole point of decoding via
    /// `CGImageSourceCreateThumbnailAtIndex` instead of a plain image read.
    func testLargeFramesAreDownsampledUnderTheCap() {
        // 2000x2000 = 4,000,000px, twice the default cap.
        let data = makeGIFData(size: 2000, frameCount: 1, delay: 0.1)
        let frames = GIFDecoder.decode(data: data, maxPixelCount: 1_000_000)
        guard let frame = frames.first else {
            return XCTFail("Expected at least one frame")
        }
        let decodedArea = frame.image.width * frame.image.height
        XCTAssertLessThan(decodedArea, 2000 * 2000)
        XCTAssertLessThanOrEqual(decodedArea, 1_100_000, "Should land close to the requested cap")
    }

    func testEmptyDataDecodesToNoFrames() {
        XCTAssertTrue(GIFDecoder.decode(data: Data()).isEmpty)
    }
}
