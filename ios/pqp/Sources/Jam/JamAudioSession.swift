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
/// The part of `AVAudioSession` this song touches, so the ownership rules can be
/// tested against a fake that records every call and can refuse like the real
/// one does (a simulator will grant any category and never says "busy").
protocol JamAudioSessionDriver: AnyObject {
    var category: AVAudioSession.Category { get }
    var mode: AVAudioSession.Mode { get }
    var categoryOptions: AVAudioSession.CategoryOptions { get }
    var outputLatency: TimeInterval { get }
    func setCategory(_ category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions) throws
    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws
}

extension AVAudioSession: JamAudioSessionDriver {}

/// What a release did.
enum JamSessionRelease: Equatable {
    /// Nothing of ours to give back.
    case notOurs
    /// A call (or a recording category) holds the session now: left alone.
    case takenOver
    /// Something in this process is still playing through it (iOS says
    /// "busy"): left running, and nothing is restored under it.
    case busy
    /// The release was refused for another reason: still active, still ours,
    /// the next release tries again.
    case stillActive
    case released
}

@MainActor
final class JamAudioSession {
    private let driver: any JamAudioSessionDriver
    private var weChangedTheSession = false
    /// What the session was before this one took it, put back on release so a
    /// song does not leave the rest of the app on `.playback`.
    private var previous: (category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions)?
    private(set) var ownsLockScreen = false
    /// The category could not be put back after the session was released: the
    /// next release tries again, so the rest of the app is not left on it.
    private var pendingRestore = false
    /// Whether this song holds the session right now (changed it, or is the
    /// one that activated it). Only a holder may release it.
    var isHolding: Bool { weChangedTheSession }

    init(driver: any JamAudioSessionDriver = AVAudioSession.sharedInstance()) {
        self.driver = driver
    }

    /// Take the session when it is free. Returns whether the song may start:
    /// always, since a call's session is played through rather than refused.
    @discardableResult
    func activate(callActive: Bool) -> Bool {
        let plan = BauPlaybackPolicy.audioPlan(callActive: callActive, category: driver.category)
        guard plan == .takePlayback else {
            ownsLockScreen = false
            return true
        }
        // Somebody else's `.playback` session (a video, a voice note) is theirs:
        // sharing it is fine, releasing it under them is not, so only a session
        // THIS song changed is one it gives back.
        // The exception: a `.playback` left behind by this song's own release
        // (its old category could not be put back yet) is ours, not theirs.
        let alreadyPlayback = driver.category == .playback && !pendingRestore
        if !alreadyPlayback {
            do {
                let before = (driver.category, driver.mode, driver.categoryOptions)
                try driver.setCategory(.playback, mode: .default, options: [])
                if previous == nil { previous = before }
                weChangedTheSession = true
            } catch {
                // A song with the wrong routing beats no song.
            }
        }
        do {
            try driver.setActive(true, options: [])
            if !alreadyPlayback { weChangedTheSession = true }
            // Held again: the next release deactivates it AND retries the
            // category, in that order, rather than only restoring.
            if pendingRestore { weChangedTheSession = true }
            ownsLockScreen = true
        } catch {
            // The song still plays through whatever route there is, but the
            // lock screen is not ours to draw on without an active session.
            ownsLockScreen = false
        }
        return true
    }

    /// Give the session back, but only if it is still ours: a call may have
    /// taken it since, and a blind deactivate would end that call's audio. The
    /// caller stops its engine first; iOS then refuses (busy) while anything
    /// else in the process is still playing, and that refusal is respected.
    @discardableResult
    func deactivate() -> JamSessionRelease {
        ownsLockScreen = false
        if pendingRestore, !weChangedTheSession {
            // Released earlier, only the category is left to put back (the
            // session is not active: nothing of ours to deactivate).
            restorePreviousCategory()
            return pendingRestore ? .stillActive : .released
        }
        guard weChangedTheSession else { return .notOurs }
        // A call (or anything recording) holds it now: not ours to touch, and
        // nothing of ours is left to give back. A category that is merely not
        // `.playback` (our own category change was refused) is still ours to
        // deactivate: leaving it active would hold the session with no song.
        guard !WatchAudioSession.wouldInterruptACall(driver.category) else {
            weChangedTheSession = false
            previous = nil
            return .takenOver
        }
        do {
            try driver.setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            if (error as NSError).code == AVAudioSession.ErrorCode.isBusy.rawValue {
                // Another player is on it: step aside, restore nothing.
                weChangedTheSession = false
                previous = nil
                return .busy
            }
            // Still active for some other reason: keep what we know so the
            // next release tries again.
            return .stillActive
        }
        weChangedTheSession = false
        restorePreviousCategory()
        return .released
    }

    /// Put the old category back. A refusal keeps it for the next release.
    private func restorePreviousCategory() {
        guard let previous else {
            pendingRestore = false
            return
        }
        guard driver.category == .playback else {
            // Already something else (a call, or never changed): nothing to undo.
            self.previous = nil
            pendingRestore = false
            return
        }
        do {
            try driver.setCategory(previous.category, mode: previous.mode, options: previous.options)
            self.previous = nil
            pendingRestore = false
        } catch {
            pendingRestore = true
        }
    }

    /// Output latency in seconds, for lining a video up with what is HEARD
    /// rather than what is scheduled. Zero is a fine answer (the simulator).
    var outputLatencySeconds: Double { driver.outputLatency }
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
        center.playCommand.isEnabled = false
        center.pauseCommand.isEnabled = false
        center.changePlaybackPositionCommand.isEnabled = false
    }

    static func clear() {
        removeCommands()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
}
