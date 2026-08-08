import Foundation

/// An invite that arrived before there was anybody to accept it.
///
/// Tapping an invite link on a phone with the app installed but nobody signed in
/// is the most common way a person ever meets this app, and it is the one that
/// is easiest to drop: the link opens, sign-in runs, and the invite — the whole
/// reason they tapped — is gone. So it is stashed here, survives everything
/// sign-in can do to the process, and is consumed exactly once afterwards.
///
/// `UserDefaults` RATHER THAN A PROPERTY, which is the decision worth arguing.
/// Clerk's sign-in can hand off to a web flow (OAuth, an email magic link), and
/// a hand-off means the app may be backgrounded, memory-warned, or terminated
/// and relaunched before it comes back. An in-memory pending invite is lost in
/// exactly the case that matters most — a brand-new user, who has no account
/// yet, going through the longest sign-in path there is.
///
/// Stored as a bare string for the same reason `LastVisited` is: a value that
/// cannot be parsed is indistinguishable from no value, so this can never
/// strand somebody in a state the app cannot leave.
enum PendingInvite {
    static let defaultsKey = "pqp.pendingInvite"

    /// Records an invite to redeem after sign-in. A second link before sign-in
    /// completes REPLACES the first: two invites cannot both be "the one they
    /// just tapped", and the newest tap is the intent.
    static func stash(_ code: String, to defaults: UserDefaults = .standard) {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= DeepLink.maxInviteCodeLength else {
            return
        }
        defaults.set(trimmed, forKey: defaultsKey)
    }

    /// Reads without consuming — for a view that wants to say "you'll join X
    /// after signing in" while the sheet is still up.
    static func peek(from defaults: UserDefaults = .standard) -> String? {
        guard let code = defaults.string(forKey: defaultsKey), !code.isEmpty else {
            return nil
        }
        return code
    }

    /// Reads and clears, atomically enough for a single-threaded main actor.
    ///
    /// CLEARING BEFORE THE JOIN IS ATTEMPTED, not after it succeeds. A code the
    /// server rejects — expired, revoked, banned — must not be retried on every
    /// subsequent launch: the user would be shown the same refusal forever with
    /// no way to dismiss it, and the failure is reported to them once instead.
    /// A join that fails on the *network* is the cost of that choice, and the
    /// remedy there is the link, which they still have.
    static func consume(from defaults: UserDefaults = .standard) -> String? {
        guard let code = peek(from: defaults) else { return nil }
        defaults.removeObject(forKey: defaultsKey)
        return code
    }

    static func clear(from defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: defaultsKey)
    }
}
