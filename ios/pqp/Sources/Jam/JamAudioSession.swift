import AVFoundation
import Foundation
import MediaPlayer

/**
 THE AUDIO SESSION, AND WHO OWNS IT.

 This app is a voice client first. `VoiceClient` and the LiveKit SDK hold
 `.playAndRecord` / `.voiceChat` for a call, and taking `.playback` underneath
 a live call takes the microphone away from it. A jam must never be the thing
 that does that, so it asks the same question the watch party, the Bau's video
 and the voice notes already ask (`BauPlaybackPolicy.audioPlan`, which is
 `WatchAudioSession.wouldInterruptACall` plus the app's own "am I seated"):

 - nothing else owns the session: take `.playback`, so the song plays with the
   ringer switch off and keeps playing with the screen locked (`audio` is in
   `UIBackgroundModes` already), and give the session back when it ends;
 - a call holds it: touch nothing. The song plays through the call's session
   exactly as a voice note does, and the lock screen is left to the call.

 The category is `.playback` with the default mode. `.moviePlayback` would be
 right for a film and wrong here: it lets the system change the audio for the
 content (dynamic range) and a band mix is not content to be normalised.
 */
@MainActor
final class JamAudioSession {
    private var weChangedTheSession = false
    private(set) var ownsLockScreen = false

    /// Take the session when it is free. Returns whether the song may start:
    /// always, since a call's session is played through rather than refused.
    @discardableResult
    func activate(callActive: Bool) -> Bool {
        let audio = AVAudioSession.sharedInstance()
        let plan = BauPlaybackPolicy.audioPlan(callActive: callActive, category: audio.category)
        guard plan == .takePlayback else {
            ownsLockScreen = false
            return true
        }
        if audio.category != .playback {
            do {
                try audio.setCategory(.playback, mode: .default)
                weChangedTheSession = true
            } catch {
                // A song with the wrong routing beats no song.
            }
        }
        do {
            try audio.setActive(true)
            weChangedTheSession = true
        } catch {
            // Same.
        }
        ownsLockScreen = true
        return true
    }

    /// Give the session back, but only if it is still ours: a call may have
    /// taken it since, and a blind deactivate would end that call's audio.
    func deactivate() {
        ownsLockScreen = false
        guard weChangedTheSession else { return }
        weChangedTheSession = false
        guard AVAudioSession.sharedInstance().category == .playback else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Output latency in seconds, for lining a video up with what is HEARD
    /// rather than what is scheduled. Zero is a fine answer (the simulator).
    var outputLatencySeconds: Double {
        AVAudioSession.sharedInstance().outputLatency
    }
}

/// The lock screen and Control Center, while a song is playing. Not touched
/// while a call is up (the call owns them) and torn down with the song.
@MainActor
enum JamNowPlaying {
    private static var installedTargets: [(command: MPRemoteCommand, target: Any)] = []

    static func publish(
        title: String, artist: String?, positionMs: Double, durationMs: Double, isPlaying: Bool
    ) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: positionMs / 1000,
            MPMediaItemPropertyPlaybackDuration: durationMs / 1000,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
        ]
        if let artist { info[MPMediaItemPropertyArtist] = artist }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    static func installCommands(
        play: @escaping @MainActor () -> Void,
        pause: @escaping @MainActor () -> Void,
        seek: @escaping @MainActor (Double) -> Void
    ) {
        removeCommands()
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.isEnabled = true
        center.pauseCommand.isEnabled = true
        center.changePlaybackPositionCommand.isEnabled = true
        let playTarget = center.playCommand.addTarget { _ in
            Task { @MainActor in play() }
            return .success
        }
        let pauseTarget = center.pauseCommand.addTarget { _ in
            Task { @MainActor in pause() }
            return .success
        }
        let seekTarget = center.changePlaybackPositionCommand.addTarget { event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let seconds = event.positionTime
            Task { @MainActor in seek(seconds * 1000) }
            return .success
        }
        installedTargets = [
            (center.playCommand, playTarget), (center.pauseCommand, pauseTarget),
            (center.changePlaybackPositionCommand, seekTarget),
        ]
    }

    static func removeCommands() {
        let center = MPRemoteCommandCenter.shared()
        for entry in installedTargets { entry.command.removeTarget(entry.target) }
        installedTargets = []
        center.changePlaybackPositionCommand.isEnabled = false
    }

    static func clear() {
        removeCommands()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
}
