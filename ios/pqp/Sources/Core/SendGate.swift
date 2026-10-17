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
