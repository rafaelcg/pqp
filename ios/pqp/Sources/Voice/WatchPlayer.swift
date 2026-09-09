import AVFoundation
import Foundation
import MediaPlayer

/**
 THE AUDIO SESSION, AND THE ONE CALL THIS MUST NEVER MAKE.

 A watch party is watched with the screen off, on the bus, while doing
 something else. That needs `.playback`, which is the category that keeps
 sound coming with the ringer switch flipped and, with `audio` in
 `UIBackgroundModes` (already declared), keeps it coming when the app is not
 on screen.

 It is also the category that would break a call. This app is a voice client
 first: `VoiceClient` and the LiveKit SDK take `.playAndRecord` with
 `.voiceChat`, and setting `.playback` underneath a live call takes the
 microphone away from it. Two owners of one `AVAudioSession` is a fight, and
 the one publishing a person's voice has to win.

 So the seat is the interlock. A watcher HAS no seat and no microphone (that
 is the whole feature), and `WatchModel.isSeated` suppresses the player before
 this is ever reached. `activate` additionally refuses when the category in
 force is a recording one, so a future screen that gets the ordering wrong
 degrades to a silent player rather than to a call nobody can hear.
 */
enum WatchAudioSession {
    /// Categories that mean somebody is holding a microphone.
    private static let recording: Set<AVAudioSession.Category> = [
        .playAndRecord, .record,
    ]

    /// Whether taking `.playback` now would take a microphone away from
    /// whoever is using it. Pure, and separated from the side effect so the
    /// interlock can be tested without a real audio session: a simulator will
    /// happily grant a category no phone would, which makes the honest version
    /// of this test unrunnable in CI.
    static func wouldInterruptACall(_ category: AVAudioSession.Category) -> Bool {
        recording.contains(category)
    }

    @discardableResult
    static func activate() -> Bool {
        let session = AVAudioSession.sharedInstance()
        guard !wouldInterruptACall(session.category) else { return false }
        do {
            try session.setCategory(.playback, mode: .moviePlayback)
            try session.setActive(true)
            return true
        } catch {
            // A player with no sound is worth more than no player.
            return false
        }
    }

    static func deactivate() {
        // Deliberately NOT `setActive(false)` unconditionally: another screen
        // may have taken the session since. Notifying others lets whoever was
        // ducked come back, and does nothing when nobody was.
        try? AVAudioSession.sharedInstance().setActive(
            false, options: .notifyOthersOnDeactivation
        )
    }
}

/**
 THE LOCK SCREEN.

 Cheap, because `MPNowPlayingInfoCenter` is a dictionary and the remote
 commands are two closures. Worth it, because the alternative on a locked
 phone is sound coming out with nothing to pause it with, and the transport
 controls that appear by default would otherwise be dead.

 `MPNowPlayingInfoPropertyIsLiveStream` is what turns the scrubber into a LIVE
 badge. Without it the lock screen offers to seek a stream with no duration,
 which reads as a broken player.

 Skip and seek are deliberately left unregistered. There is nothing to seek to
 in a live broadcast, and an enabled control that does nothing is worse than
 an absent one.
 */
@MainActor
enum WatchNowPlaying {
    static func begin(title: String, subtitle: String?, onPlay: @escaping () -> Void,
                      onPause: @escaping () -> Void) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPNowPlayingInfoPropertyIsLiveStream: true,
        ]
        if let subtitle { info[MPMediaItemPropertyArtist] = subtitle }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        let center = MPRemoteCommandCenter.shared()
        center.playCommand.removeTarget(nil)
        center.pauseCommand.removeTarget(nil)
        center.playCommand.isEnabled = true
        center.pauseCommand.isEnabled = true
        center.playCommand.addTarget { _ in onPlay(); return .success }
        center.pauseCommand.addTarget { _ in onPause(); return .success }
    }

    static func end() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.removeTarget(nil)
        center.pauseCommand.removeTarget(nil)
        center.playCommand.isEnabled = false
        center.pauseCommand.isEnabled = false
    }
}

/**
 WHEN A PLAYER THAT IS NOT COMPLAINING HAS NONETHELESS STOPPED.

 `AVPlayer` reports the failures it recognises, and those are handled where
 they are raised. This is for the one it does not: a playlist that answers 200
 forever with the same segments, which is what a dead egress and a stalled
 upload both look like from here. `timeControlStatus` says `.playing`, no error
 is posted, and the picture is frozen. From the sofa that is indistinguishable
 from the film being paused, so nothing recovers it and nobody reports it.

 The rule is only about time moving. A player that is buffering honestly
 (`.waitingToPlayAtSpecifiedRate`) is not stalled, it is slow, and restarting
 it makes the buffering worse. So the clock only runs while the player claims
 to be playing.

 `deadAfter` is set against the segment length: segments are 2 s and the
 playlist is refetched at about that cadence, so 20 s is ten missed segments,
 which is long past a network hiccup and well short of a viewer giving up.
 */
struct WatchStallWatch: Equatable {
    static let deadAfter: TimeInterval = 20

    private var lastPosition: Double?
    private var lastMovedAt: Date?

    /// Returns true the first time the picture has been stuck long enough to
    /// be worth reattaching. Resets itself on the way out so a caller that
    /// acts on it does not get a second answer for the same stall.
    mutating func tick(position: Double, isPlaying: Bool, now: Date) -> Bool {
        guard isPlaying else {
            // Not claiming to play: buffering, paused, or between items.
            // Nothing to judge, and the clock must not run.
            lastPosition = nil
            lastMovedAt = nil
            return false
        }
        guard let previous = lastPosition, let movedAt = lastMovedAt else {
            lastPosition = position
            lastMovedAt = now
            return false
        }
        if position > previous {
            lastPosition = position
            lastMovedAt = now
            return false
        }
        guard now.timeIntervalSince(movedAt) >= Self.deadAfter else {
            lastPosition = position
            return false
        }
        // Answered once. Cleared so a caller that reattaches does not get the
        // same stall a second time before the new item has had a chance.
        lastPosition = nil
        lastMovedAt = nil
        return true
    }
}
