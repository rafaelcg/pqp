import Foundation

/// The DM call stage's decisions, as pure values.
///
/// Mirrors `client/src/components/dm/call-stage-state.ts` deliberately: the two
/// clients meet in the same call, and "which arrangement does this call get" is
/// exactly the kind of rule that drifts into two different products if each
/// platform re-derives it by eye. Kept free of SwiftUI and WebRTC so it can be
/// exercised in the unit-test target, which cannot open a camera.

/// How the stage arranges itself.
enum CallStageLayout: String, Equatable, Sendable {
    /// A shared screen is live: it *is* the stage, people become thumbnails.
    case screen
    /// 1:1 — the remote person is the stage, self floats as a corner preview.
    case spotlight
    /// More than one other person: an even grid.
    case grid
    /// Nobody else is here yet (ringing out, or everyone left).
    case ring
}

/// Which arrangement the stage draws.
///
/// The screen share always wins: a face is glanceable at thumbnail size, a
/// shared screen is not.
func callStageLayout(remoteCount: Int, hasScreenShare: Bool) -> CallStageLayout {
    if hasScreenShare {
        return .screen
    }
    if remoteCount == 0 {
        return .ring
    }
    return remoteCount == 1 ? .spotlight : .grid
}

/// "0:07", "12:41", "1:05:09" — a call timer, never a timestamp.
///
/// Hand-rolled rather than a `DateComponentsFormatter`: the formatter localises
/// the *separator* and drops leading zero minutes in some locales, which turns a
/// running clock into a jittering one.
func formatCallDuration(_ elapsed: TimeInterval) -> String {
    let total = max(0, Int(elapsed))
    let seconds = total % 60
    let minutes = (total / 60) % 60
    let hours = total / 3600
    if hours > 0 {
        return String(format: "%d:%02d:%02d", hours, minutes, seconds)
    }
    return String(format: "%d:%02d", minutes, seconds)
}

/// One ringing invitation, exactly as `callIncomingMessageSchema` sends it.
struct IncomingCall: Identifiable, Equatable, Sendable {
    let conversationId: String
    /// `"dm"` or `"group"`.
    let kind: String
    let callerUserId: String
    let callerName: String
    let callerAvatarUrl: String?

    var id: String { conversationId }
}

/// Where a call is in its life.
///
/// `ringing` and `active` are deliberately distinct even though both mean "we
/// are in the room": the stage draws a pulsing avatar for one and a video
/// spotlight for the other, and the call timer only starts at `active`.
enum CallPhase: Equatable, Sendable {
    case idle
    /// Asking for the mic, fetching ICE, waiting for `welcome`.
    case connecting
    /// In the room, alone, `call-ring` sent — the other end is being buzzed.
    case ringing
    /// Somebody else is in the room with us.
    case active
    /// Over. The sentence is what the stage says on its way out; nil for an
    /// ordinary hang-up, which needs no explanation.
    case ended(String?)

    var isLive: Bool {
        switch self {
        case .connecting, .ringing, .active: true
        case .idle, .ended: false
        }
    }
}

/// How long the server rings before it gives up and records a missed call
/// (`CALL_RING_TIMEOUT_MS` in `server/src/ws/voice.ts`).
///
/// The caller is NOT told when this fires — `endConversationRing` only notifies
/// the people it rang — so the calling side has to run the same clock locally or
/// it sits on "Calling…" forever.
let callRingTimeout: TimeInterval = 45

/// What the stage says when a ring ran out or was refused. Pure so the wording
/// is pinned in one place rather than assembled at three call sites.
enum CallEndReason {
    static let noAnswer = String(localized: "No answer")
    static let declined = String(localized: "Call declined")
    static let ended = String(localized: "Call ended")
}
