import Foundation
import Observation

/// One walk through the first-run wizard, from the age gate to the room.
///
/// Owned by `SessionStore` rather than by the view, because two things outside
/// the view tree write to it: the pending invite is redeemed by `becomeReady`
/// (behind the wizard, exactly as the web joins behind its dialog), and the age
/// gate is a session phase of its own. The view reads it; the store writes it.
@MainActor
@Observable
final class FirstRunSession {
    /// Where the join behind the wizard stands, for somebody who arrived on
    /// an invite link. `none` on a cold start.
    enum Arrival: Equatable {
        case none
        case pending
        case joined(serverId: String)
        case failed
    }

    /// Frozen at creation: the intent that decides it (a stashed invite) is
    /// spent as the app acts on it, and the dots must not change count under
    /// somebody mid-flow.
    let path: OnboardingPath
    let inviteCode: String?
    /// Whether this walk began at the age gate. An account that answered it on
    /// another device starts at "you", and its dots still count the gate as
    /// done rather than restarting at one.
    let startedAtGate: Bool
    let startedAt = Date()

    var arrival: Arrival
    /// The room waiting behind the link, from the public preview. Nil until it
    /// answers, and nil for good when it cannot (the copy then says less, and
    /// nothing else changes).
    var preview: PublicInvitePreview?

    init(path: OnboardingPath, inviteCode: String?, startedAtGate: Bool) {
        self.path = path
        self.inviteCode = inviteCode
        self.startedAtGate = startedAtGate
        self.arrival = path == .invite ? .pending : .none
    }

    /// The name to put in "{server} is waiting for you", whichever source
    /// answered first.
    var serverName: String? {
        preview?.serverName
    }

    var joinedServerId: String? {
        if case .joined(let id) = arrival { return id }
        return nil
    }
}

/// The invitee's moment, shown once the wizard hands them the room: a burst of
/// confetti and one line that says where they are. Kept on the store so it
/// survives the wizard's own teardown, which is the instant it has to appear.
struct ArrivalCelebration: Equatable, Identifiable {
    let id = UUID()
    let serverName: String
}
