import Foundation

/// A moderator's mute, as both call models and both screens read it.
///
/// WHY THIS IS A PURE TYPE. `VoiceModel` and `CallModel` each own a room, and
/// the rules below would otherwise be written twice by eye and drift the way
/// `callStageLayout` nearly did before it was pulled out. Free of SwiftUI and
/// WebRTC so the unit-test target, which cannot open a microphone, can pin them.
///
/// THE CONTRACT, shared with the web and Android clients. `VoiceParticipant`
/// carries `serverMuted`, defaulting to false when an older server omits it,
/// on every frame that carries a participant: `welcome`, `voice-roster`,
/// `peer-joined`, `peer-updated`. On mesh the server never touches media, so
/// the flag is only real because each receiver plays that person at zero (see
/// `RemoteAudioMixer.setServerMuted`) and the target's own client stops the
/// mic. The server refuses the target's `set-muted false` and snaps the roster
/// back, which is why the control goes off rather than merely red.
enum ServerMute {
    /// Whether the mic button does anything.
    ///
    /// `connected` is the room's own gate (a voice channel disables every
    /// control until `welcome`; a DM call never does). The moderator's flag is
    /// the only thing that turns the button off in a connected room.
    static func muteControlIsEnabled(connected: Bool, selfServerMuted: Bool) -> Bool {
        connected && !selfServerMuted
    }

    /// What our own microphone becomes when the roster describes us.
    ///
    /// Muted by a moderator means muted, whatever we had chosen: our client is
    /// the only thing on mesh that can stop the bytes leaving. The flag
    /// CLEARING changes nothing here on purpose, which is why it is not an
    /// argument that can flip the result back: coming back live the instant a
    /// moderator lets go would put whatever is being said mid-sentence into
    /// the room. Unmuting is the person's own tap.
    static func selfMuted(currentlyMuted: Bool, serverMuted: Bool) -> Bool {
        currentlyMuted || serverMuted
    }

    /// The glyph for a moderator's mute. Deliberately not `mic.slash.fill`,
    /// which is what a person who muted themselves shows: one is a choice the
    /// person can undo and the other is something done to them, and a room
    /// that draws them the same cannot tell "they stepped away" from "they
    /// were silenced".
    static let glyph = "mic.slash.circle.fill"

    /// The self-muted glyph, named here so the two are visibly a pair and a
    /// change to one is made next to the other.
    static let selfMutedGlyph = "mic.slash.fill"

    /// The one sentence the target sees.
    static var notice: String {
        String(localized: "A moderator muted you. You can talk again when they unmute you.")
    }
}
