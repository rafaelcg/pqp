import Foundation

/// When the viewer's bar moves, as a rule with no views in it.
///
/// Two things went wrong with the clock inline in the viewer. A video's bar
/// reads the player's time, and after a story ended the player of the story
/// that just ended was still the viewer's until the next one had loaded: the
/// next tick read 100% again and skipped the story after it (two videos in a
/// row, the second never played), and at the end of a queue it asked to close
/// once per tick until the screen was gone. And the bar ran while the picture
/// was still on its way, so a slow connection ate the time a story is meant
/// to be on screen.
///
/// So: the bar waits for the story's first frame, a video's bar only follows a
/// player that belongs to the story on screen, and nothing moves once the
/// viewer is closing.
enum StoryClockRules {
    /// The bar's value after one tick, or nil when the clock does not run.
    static func nextProgress(
        current: Double, isVideo: Bool, ready: Bool, closing: Bool, playerIsForThisStory: Bool,
        videoSeconds: Double?, videoDuration: Double?, tick: Double, displayMs: Int
    ) -> Double? {
        guard ready, !closing else { return nil }
        let step = tick / (Double(max(1, displayMs)) / 1000)
        if isVideo {
            guard playerIsForThisStory else { return nil }
            // Follows the video itself, so a stall (the player waiting for
            // data) holds the bar too.
            if let duration = videoDuration, duration.isFinite, duration > 0, let seconds = videoSeconds, seconds.isFinite {
                return min(1, max(0, seconds / duration))
            }
            return min(1, current + step)
        }
        return current + step
    }
}
