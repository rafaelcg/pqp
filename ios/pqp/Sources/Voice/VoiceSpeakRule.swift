import Foundation

/// The server's SPEAK rule for this seat, and what the client does about it.
///
/// Pure, so the two things that go wrong silently can be pinned by a test: a
/// `welcome` whose bit is read from the wrong place (the top-level key and
/// `self.canSpeak` carry the same value, and either may be absent on an older
/// server), and a revoke mid-call that leaves the microphone open because the
/// UI only ever consulted `isMuted`.
///
/// Mirrors `applySpeakRule` in `client/src/hooks/use-voice.ts`. In a LiveKit
/// room the server has already withheld the publish grant, so this is the UI
/// catching up with a fact; in a mesh room this IS the enforcement, which
/// `docs/voice-backends.md` documents under "Speak permission".
enum VoiceSpeakRule {
    /// Where the bit came from. A `welcome` that says false explains itself
    /// once; a later change explains itself in both directions.
    enum Source: Equatable {
        case welcome
        case change
    }

    /// The sentence shown alongside the locked (or unlocked) control, if any.
    /// Same copy as the web client's `voice.notice.speakDenied` and
    /// `voice.notice.speakGranted`.
    enum Notice: Equatable {
        case listenOnly
        case speakGranted

        var text: String {
            switch self {
            case .listenOnly:
                String(localized: "Listening only. You do not have permission to speak in this channel.")
            case .speakGranted:
                String(localized: "You can speak now. Unmute when you are ready.")
            }
        }
    }

    /// What a change of the bit means for the local media.
    struct Outcome: Equatable {
        let canSpeak: Bool
        /// Force the microphone off. Never the other way round: `true` after
        /// `false` unlocks the control and leaves the unmute to the person.
        let mute: Bool
        /// Drop an outgoing camera and screen share; the roster no longer
        /// carries them and the SFU has dropped the tracks.
        let stopPublishing: Bool
        let notice: Notice?
    }

    /// `welcome.canSpeak` at the top level, then `self.canSpeak`, then true.
    /// Absent means a server that predates SPEAK enforcement, where everyone
    /// resolved as allowed.
    static func resolve(topLevel: Bool?, selfPeer: Bool?) -> Bool {
        topLevel ?? selfPeer ?? true
    }

    static func apply(canSpeak: Bool, was: Bool, source: Source) -> Outcome {
        if !canSpeak {
            return Outcome(
                canSpeak: false,
                mute: true,
                stopPublishing: true,
                notice: (was || source == .welcome) ? .listenOnly : nil
            )
        }
        return Outcome(
            canSpeak: true,
            mute: false,
            stopPublishing: false,
            notice: (!was && source == .change) ? .speakGranted : nil
        )
    }
}
