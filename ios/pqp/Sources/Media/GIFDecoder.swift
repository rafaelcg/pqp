import CoreGraphics
import Foundation
import ImageIO

/// One decoded GIF frame: a bitmap plus how long it stays on screen before
/// the next one — already run through `GIFTiming.normalizedDelay`.
///
/// `CGImage` is immutable once created and safe to hand across isolation
/// boundaries, but the SDK does not mark it `Sendable` on every platform this
/// still has to build for, hence `@unchecked` here rather than on every call
/// site that moves a frame off the actor that decoded it.
struct GIFFrame: @unchecked Sendable {
    let image: CGImage
    let duration: TimeInterval
}

/// Pulls a GIF apart into `GIFFrame`s with ImageIO.
///
/// SwiftUI's `Image`/`AsyncImage` rasterize a GIF's *first* frame only —
/// there is no SwiftUI-native animated GIF support — so anything that needs
/// the whole thing has to go around them and decode frame-by-frame itself.
enum GIFDecoder {
    /// Frames are capped to roughly this many pixels each. A chat attachment
    /// or a Tenor preview is already well under this most of the time; the
    /// cap only bites the rare huge upload, where decoding every frame at
    /// full resolution would be the actual cost, not the network fetch.
    static let defaultMaxPixelCount = 2_000_000

    static func decode(data: Data, maxPixelCount: Int = defaultMaxPixelCount) -> [GIFFrame] {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return [] }
        let count = CGImageSourceGetCount(source)
        guard count > 0 else { return [] }

        let maxPixelSize = thumbnailMaxPixelSize(for: source, cap: maxPixelCount)
        var frames: [GIFFrame] = []
        frames.reserveCapacity(count)

        for index in 0..<count {
            // A thumbnail request rather than `CGImageSourceCreateImageAtIndex`:
            // ImageIO downsamples *during* decode this way, so a frame never
            // exists in memory at full resolution even momentarily.
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
            ]
            guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, index, options as CFDictionary) else {
                continue
            }
            let duration = GIFTiming.normalizedDelay(rawFrameDelay(source: source, index: index))
            frames.append(GIFFrame(image: cgImage, duration: duration))
        }
        return frames
    }

    /// GIF carries the per-frame delay two ways: a legacy value clamped to a
    /// minimum some old viewers imposed, and an "unclamped" one modern
    /// encoders prefer. The unclamped value wins when both are present.
    private static func rawFrameDelay(source: CGImageSource, index: Int) -> TimeInterval {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any],
              let gif = properties[kCGImagePropertyGIFDictionary] as? [CFString: Any]
        else { return 0 }

        if let unclamped = gif[kCGImagePropertyGIFUnclampedDelayTime] as? Double, unclamped > 0 {
            return unclamped
        }
        if let clamped = gif[kCGImagePropertyGIFDelayTime] as? Double {
            return clamped
        }
        return 0
    }

    private static func thumbnailMaxPixelSize(for source: CGImageSource, cap: Int) -> Int {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Double,
              let height = properties[kCGImagePropertyPixelHeight] as? Double,
              width > 0, height > 0
        else {
            return Int(Double(cap).squareRoot())
        }

        let area = width * height
        guard area > Double(cap) else { return Int(max(width, height)) }
        let scale = (Double(cap) / area).squareRoot()
        return Int((max(width, height) * scale).rounded(.up))
    }
}
