import Foundation

/// The pure arithmetic behind GIF playback: normalizing a frame's on-disk
/// delay and picking which frame is showing at a given moment.
///
/// Kept free of ImageIO/UIKit deliberately so it can be unit-tested without a
/// simulator or a real GIF file — the thing worth pinning down with tests is
/// this math, not whether `CGImageSource` can be constructed in a test host.
enum GIFTiming {
    /// Below this, a delay reads as "encoder wrote zero (or near-zero)"
    /// rather than "author really wants sub-frame timing."
    private static let zeroDelayThreshold: TimeInterval = 0.011

    /// The GIF 0-delay convention: several encoders write a delay of 0 —
    /// occasionally a couple of milliseconds — meaning "as fast as the
    /// viewer allows." Every major browser has long since standardized that
    /// on 100ms rather than "instant," and clients that don't follow suit
    /// play the GIF far faster than its author intended.
    static func normalizedDelay(_ raw: TimeInterval) -> TimeInterval {
        raw < zeroDelayThreshold ? 0.1 : raw
    }

    /// The index into `durations` that should be on screen `elapsed`
    /// seconds into a loop, wrapping once the total is exceeded.
    ///
    /// Frame-count based (not `UIImageView.animationDuration`, which only
    /// supports one uniform duration for every frame) so a GIF authored with
    /// per-frame delays plays back at the speed it was authored at.
    static func frameIndex(at elapsed: TimeInterval, durations: [TimeInterval]) -> Int {
        guard !durations.isEmpty else { return 0 }
        let total = durations.reduce(0, +)
        guard total > 0, elapsed.isFinite, elapsed >= 0 else { return 0 }

        var remaining = elapsed.truncatingRemainder(dividingBy: total)
        for (index, duration) in durations.enumerated() {
            if remaining < duration { return index }
            remaining -= duration
        }
        // Floating-point remainder can land exactly on the boundary; the last
        // frame is the correct answer rather than falling through to 0.
        return durations.count - 1
    }
}
