import Foundation

/// Whether a composer is offered at all. The answer is the permission
/// snapshot's, not a role guess: the route resolves owner, administrator,
/// roles, member overwrites and timeouts before it answers, so asking its
/// SEND_MESSAGES bit for the channel asks the same question the server will.
///
/// UNKNOWN IS ALLOWED, the opposite of `CommunityHomeComposeGate`. Hiding a
/// box from somebody who may type in it is the worse mistake here (every text
/// channel would lose its composer for a second on each open, or for good when
/// the snapshot read fails), and the server stays the gate for the other case:
/// it refuses with 403 and the screen says why. The web does the same
/// ("unknown still means allowed", `canSendHere`).
enum SendGate {
    static func canSend(_ permissions: PermissionsSnapshot?, channelId: String) -> Bool {
        guard let permissions else { return true }
        return permissions.can(PermissionBit.sendMessages, channelId: channelId)
    }
}

/// The snapshot a transcript gates its composer with, tied to the server it was
/// read for. A snapshot is only ever the bits of ONE server, so it is dropped
/// the moment the screen's server changes (or stops applying, as for a
/// conversation), and an answer is accepted only while it is still for the
/// server on screen: a slow read for the server just left can neither gate
/// the new channel nor overwrite the newer snapshot, and a failed read leaves
/// the slot empty (unknown reads as allowed), never the previous server's bits.
struct SendPermissionSlot {
    private(set) var serverId: String?
    private(set) var snapshot: PermissionsSnapshot?

    /// The screen now answers to `serverId` (nil: no server applies).
    mutating func switchTo(_ serverId: String?) {
        if self.serverId != serverId { snapshot = nil }
        self.serverId = serverId
    }

    /// Takes the answer of a read made for `serverId`; false when it is stale.
    @discardableResult
    mutating func accept(_ snapshot: PermissionsSnapshot?, for serverId: String) -> Bool {
        guard self.serverId == serverId else { return false }
        self.snapshot = snapshot
        return true
    }

    func canSend(channelId: String) -> Bool {
        SendGate.canSend(snapshot, channelId: channelId)
    }
}
