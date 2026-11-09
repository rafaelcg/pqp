import AVFoundation
import Foundation

/// The video stems, muted, locked to the audio clock.
///
/// THE AUDIO IS THE CLOCK. A video here never plays its own sound (it is the
/// player's face; the sound is the same take's stem, already in the engine) and
/// is never the thing the others follow. It is started at the SAME host time as
/// the engine, offset by the output latency so the picture meets what is HEARD,
/// not what was scheduled, and it is checked against the engine's position while
/// it plays: past `driftToleranceMs` it is put back with a seek and a restart,
/// which is rare and visible as one dropped frame rather than a lip-sync that
/// slowly walks away.
///
/// The file time shown at song time `s` is `s - offsetMs + trimStartMs` (the
/// same slice arithmetic as the audio: a take recorded with a camera is cut so
/// its sample 0 is the video's first frame, one `offsetMs` places both).
///
/// AVFoundation opens MP4 and not WebM. A WebM video is simply not given a
/// player (`canPlay`), and the screen draws the track's colour instead.
@MainActor
final class JamVideoSync {
    static let driftToleranceMs = 90.0

    struct Item {
        let trackId: String
        let player: AVPlayer
        let offsetMs: Double
        let trimStartMs: Double
        let trimEndMs: Double
        let durationMs: Double
    }

    private(set) var items: [String: Item] = [:]
    private var order: [String] = []

    static func canPlay(contentType: String?) -> Bool {
        JamPosterCache.canPoster(contentType: contentType)
    }

    func player(for trackId: String) -> AVPlayer? { items[trackId]?.player }

    /// Make these the videos on screen. Existing players are kept.
    func load(_ tracks: [JamTrack]) {
        let wanted = tracks.filter { $0.hasVideo && Self.canPlay(contentType: $0.videoContentType) }
        let ids = Set(wanted.map(\.id))
        for id in items.keys where !ids.contains(id) {
            items[id]?.player.pause()
            items.removeValue(forKey: id)
        }
        for track in wanted {
            guard let urlString = track.videoUrl, let url = URL(string: urlString) else { continue }
            if let existing = items[track.id] {
                // Same file, maybe a moved offset: keep the player, take the
                // new numbers.
                items[track.id] = Item(
                    trackId: track.id, player: existing.player, offsetMs: track.offsetMs,
                    trimStartMs: track.trimStartMs, trimEndMs: track.trimEndMs, durationMs: track.durationMs
                )
                continue
            }
            let player = AVPlayer(url: url)
            player.isMuted = true
            player.actionAtItemEnd = .pause
            player.automaticallyWaitsToMinimizeStalling = false
            items[track.id] = Item(
                trackId: track.id, player: player, offsetMs: track.offsetMs,
                trimStartMs: track.trimStartMs, trimEndMs: track.trimEndMs, durationMs: track.durationMs
            )
        }
        order = wanted.map(\.id).filter { items[$0] != nil }
    }

    /// File time in seconds of a video at a song time, clamped into the slice
    /// the track actually plays.
    func fileSeconds(_ item: Item, songMs: Double) -> Double {
        let slice = max(0, item.durationMs - item.trimStartMs - item.trimEndMs)
        let into = min(slice, max(0, songMs - item.offsetMs))
        return (item.trimStartMs + into) / 1000
    }

    /// Show the frame for a song time without playing.
    func park(atSongMs songMs: Double) {
        for item in items.values {
            item.player.pause()
            item.player.seek(
                to: CMTime(seconds: fileSeconds(item, songMs: songMs), preferredTimescale: 600),
                toleranceBefore: .zero, toleranceAfter: .zero
            )
        }
    }

    /// Start every video so it meets the audio. `startHostTime` is the engine's
    /// start (mach host ticks); a video whose slice starts later waits for it.
    func play(atSongMs songMs: Double, startHostTime: UInt64, latencySeconds: Double) {
        let timebase = Self.timebase
        func ticks(_ seconds: Double) -> UInt64 {
            UInt64(max(0, seconds) * 1_000_000_000 * Double(timebase.denom) / Double(timebase.numer))
        }
        for item in items.values {
            let delaySeconds = max(0, (item.offsetMs - songMs) / 1000)
            let fileTime = CMTime(seconds: fileSeconds(item, songMs: songMs), preferredTimescale: 600)
            let at = startHostTime + ticks(latencySeconds + delaySeconds)
            item.player.seek(to: fileTime, toleranceBefore: .zero, toleranceAfter: .zero) { _ in
                // Past the host time already (a slow seek): start now, the
                // drift check below puts it right.
                item.player.setRate(1, time: fileTime, atHostTime: CMClockMakeHostTimeFromSystemUnits(at))
            }
        }
    }

    func pause() {
        for item in items.values { item.player.pause() }
    }

    func stop() {
        for item in items.values { item.player.pause() }
        items.removeAll()
        order = []
    }

    /// Called every half second while playing: any video further from where it
    /// should be than the tolerance is put back. Returns how many were moved.
    @discardableResult
    func correctDrift(songMs: Double, latencySeconds: Double) -> Int {
        var moved = 0
        for item in items.values {
            // Before its slice starts it is parked on frame one: nothing to check.
            guard songMs >= item.offsetMs else { continue }
            let expected = fileSeconds(item, songMs: songMs - latencySeconds * 1000)
            let actual = item.player.currentTime().seconds
            guard actual.isFinite, abs(actual - expected) * 1000 > Self.driftToleranceMs else { continue }
            moved += 1
            let target = CMTime(seconds: expected, preferredTimescale: 600)
            item.player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { _ in
                item.player.rate = 1
            }
        }
        return moved
    }

    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()
}
