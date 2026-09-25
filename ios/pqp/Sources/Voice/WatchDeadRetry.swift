import Foundation

/**
 "THE PICTURE STOPPED" TRIES AGAIN BY ITSELF.

 Mirrors the web's `DEAD_RETRY_*` (`hls-watch-player.tsx`, PR #824). Once
 `WatchFailureRecovery` has spent its budget and `WatchModel.phase` is
 `.failed`, the only way back used to be a button nobody watching a film is
 looking for. `WatchStageView`'s retry loop presses it for the viewer instead,
 on a jittered, growing backoff, so a decoder that keeps failing does not turn
 into a player tearing itself down every few seconds for the rest of the
 party.

 Pure and `Date`-free so the schedule itself is testable without a running
 loop: `delay(attempt:jitter:)` answers "how long before automatic retry
 number N", and the caller supplies its own randomness.
 */
enum WatchDeadRetry {
    /// Mirrors `DEAD_RETRY_MIN_MS` / `DEAD_RETRY_MAX_MS`.
    static let minSeconds: TimeInterval = 8
    static let maxSeconds: TimeInterval = 15
    /// Mirrors `DEAD_RETRY_MAX_DOUBLINGS`: 8-15s, then 16-30s, then 32-60s,
    /// then held there.
    static let maxDoublings = 2

    /// The wait before automatic retry number `attempt` (0-based).
    /// `jitter` returns a value in `0...1`; production passes
    /// `Double.random(in: 0...1)`, a test passes a fixed one.
    static func delay(attempt: Int, jitter: () -> Double) -> TimeInterval {
        let doublings = min(max(attempt, 0), maxDoublings)
        let base = minSeconds + jitter() * (maxSeconds - minSeconds)
        return base * pow(2, Double(doublings))
    }
}
