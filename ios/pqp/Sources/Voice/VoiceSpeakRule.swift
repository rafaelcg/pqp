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
        case streamDenied
        case streamGranted

        var text: String {
            switch self {
            case .listenOnly:
                String(localized: "Listening only. You do not have permission to speak in this channel.")
            case .speakGranted:
                String(localized: "You can speak now. Unmute when you are ready.")
            case .streamDenied:
                String(localized: "No camera or screen share in this channel.")
            case .streamGranted:
                String(localized: "You can turn on camera or share a screen now.")
            }
        }
    }

    /// What a change of the bits means for the local media.
    struct Outcome: Equatable {
        let canSpeak: Bool
        /// SPEAK and STREAM are separate grants on the server and they are
        /// separate here. Folding them together is what told somebody with a
        /// microphone but no camera grant that the call "already has the
        /// maximum number of cameras", which sends them to ask why rather than
        /// to the permission that is actually missing.
        let canStream: Bool
        /// Force the microphone off. Never the other way round: `true` after
        /// `false` unlocks the control and leaves the unmute to the person.
        let mute: Bool
        /// Drop an outgoing camera and screen share; the roster no longer
        /// carries them and the SFU has dropped the tracks. Follows STREAM,
        /// not SPEAK.
        let stopPublishing: Bool
        let notice: Notice?
    }

    /// `welcome.canSpeak` at the top level, then `self.canSpeak`, then true.
    /// Absent means a server that predates SPEAK enforcement, where everyone
    /// resolved as allowed.
    static func resolve(topLevel: Bool?, selfPeer: Bool?) -> Bool {
        topLevel ?? selfPeer ?? true
    }

    /// The same walk for STREAM, falling back to SPEAK rather than to `true`.
    ///
    /// Absent means a server that predates the separate STREAM grant, and on
    /// one of those the right answer is whatever SPEAK said, because that is
    /// what gated camera and screen share before the split. Matches
    /// `message.canStream ?? message.canSpeak` in `use-voice.ts`.
    static func resolveStream(topLevel: Bool?, selfPeer: Bool?, canSpeak: Bool) -> Bool {
        topLevel ?? selfPeer ?? canSpeak
    }

    /// One notice at a time, and SPEAK outranks STREAM: losing the microphone
    /// is the bigger news, and stacking two sentences under the controls on a
    /// phone is how both get ignored. Same precedence as `applyPublishRules`.
    static func apply(
        canSpeak: Bool,
        canStream: Bool,
        wasSpeak: Bool,
        wasStream: Bool,
        source: Source
    ) -> Outcome {
        Outcome(
            canSpeak: canSpeak,
            canStream: canStream,
            mute: !canSpeak,
            stopPublishing: !canStream,
            notice: notice(
                canSpeak: canSpeak, canStream: canStream,
                wasSpeak: wasSpeak, wasStream: wasStream, source: source
            )
        )
    }

    private static func notice(
        canSpeak: Bool, canStream: Bool, wasSpeak: Bool, wasStream: Bool, source: Source
    ) -> Notice? {
        if source == .welcome {
            // A seat that walks in restricted is told once, on arrival. It has
            // no "was" worth comparing against.
            if !canSpeak { return .listenOnly }
            if !canStream { return .streamDenied }
            return nil
        }
        if wasSpeak && !canSpeak { return .listenOnly }
        if !wasSpeak && canSpeak { return .speakGranted }
        if wasStream && !canStream { return .streamDenied }
        if !wasStream && canStream { return .streamGranted }
        return nil
    }
}
