import Foundation

/// WHO MAY DO WHAT TO WHOM — the rank rule, mirrored from
/// `packages/shared/src/moderation.ts`.
///
/// The server owns this decision: `requireOutranked` in
/// `server/src/api/index.ts` refuses kick, ban and timeout against the owner,
/// and refuses an admin acting on a peer. Nothing here can grant anything; the
/// point of having it is the opposite — never OFFERING what the API will refuse.
///
/// WHY IT IS WRITTEN OUT AGAIN. Swift cannot import the TypeScript package, so
/// the alternative to a mirror is what this codebase actually had: `MembersView`
/// gated on "not the owner, not me" alone, so an iOS admin was shown Kick,
/// Ban and Timeout against another admin and got a 403 from the server every
/// single time. The web client implemented the rule; this one guessed at it. One
/// small pure type, with the same four refusals in the same order and its own
/// tests, is what keeps the two from drifting again.
///
/// Deliberately about RANK ONLY. Whether the acting account is even a manager,
/// and whether the target is present in whatever room is being acted on, are
/// separate questions the callers already answer with their own data.
enum Moderation {
    /// A role as the wire spells it. `nil` means "not a member of this server",
    /// which is a real state — a pre-emptive ban targets exactly that person.
    typealias Role = String

    static func isManager(_ role: Role?) -> Bool {
        role == "owner" || role == "admin"
    }

    /// Whether a moderation control — kick, ban, timeout, or any of the voice
    /// three — should be drawn at all.
    ///
    /// Four refusals, in the order the server applies them:
    ///
    /// 1. **Only managers moderate.** A plain member sees none of it.
    /// 2. **Never yourself.** The server answers 400 "use leave instead";
    ///    offering it would be a button whose only outcome is a scolding.
    /// 3. **Never the owner.** Nobody outranks them, themselves included.
    /// 4. **An admin may not act on an admin.** Only the owner may, or a 28-day
    ///    timeout becomes the way one admin deposes a peer.
    static func canModerate(
        actorRole: Role?,
        actorId: String?,
        targetRole: Role?,
        targetId: String
    ) -> Bool {
        guard isManager(actorRole) else { return false }
        if let actorId, actorId == targetId { return false }
        if targetRole == "owner" { return false }
        if targetRole == "admin" && actorRole != "owner" { return false }
        return true
    }

    /// Whether this account may delete somebody else's message, or pin in a
    /// server channel.
    ///
    /// Flat, with NO rank rule, matching `canManageServer` on the server: a
    /// message is not a person, and an admin removing the owner's post is a
    /// moderator doing their job rather than a coup.
    ///
    /// This is the one iOS had wrong in both directions at once. Delete was
    /// gated on `isMine`, so an owner on a phone could not remove anything
    /// anybody else had posted — the single most-used moderation action in the
    /// product, unreachable. Pin was gated on nothing at all, so a plain member
    /// was offered a button that always came back 403.
    static func canManageMessages(_ actorRole: Role?) -> Bool {
        isManager(actorRole)
    }

    /// Whether to offer deleting THIS message: your own always, anyone's when
    /// you manage the server it is in.
    ///
    /// A conversation has no managers, which is why `serverRole` is `nil` there
    /// and a DM keeps its "own messages only" behaviour without a second check.
    static func canDelete(isMine: Bool, serverRole: Role?) -> Bool {
        isMine || canManageMessages(serverRole)
    }

    /// Whether to offer pinning. Free in a conversation — `requirePinAccess`
    /// lets any participant pin there — and manager-only in a server channel.
    static func canPin(inServer: Bool, serverRole: Role?) -> Bool {
        inServer ? canManageMessages(serverRole) : true
    }

    /// The timeout durations offered, matching `TIMEOUT_PRESET_MINUTES` in
    /// shared and the four the web client shows. Any value in range is still
    /// accepted by the API; these are what a menu is willing to say.
    static let timeoutPresets: [(minutes: Int, label: String)] = [
        (5, "5 minutes"),
        (60, "1 hour"),
        (60 * 24, "1 day"),
        (60 * 24 * 7, "1 week"),
    ]
}
