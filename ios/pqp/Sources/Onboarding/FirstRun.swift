import Foundation

/// The first-run checklist's decisions, with no SwiftUI attached.
///
/// The mirror of `client/src/lib/first-run.ts`, and deliberately so: the flag it
/// reads is a *server* preference, so web and iOS have to agree on when the card
/// shows and when it is answered, or dismissing it on a phone would leave it
/// sitting there on a laptop. Keeping the rules in a plain value type also means
/// they can be tested without a simulator, the way `LastVisited` is.
///
/// WHAT IT FIXES ON iOS. The hub is better off than the web's was — it has a real
/// "Create a server" card and a real "Start a conversation" card. What it has
/// never had is any pointer at *friends* (the only affordance is an unlabelled
/// `person.2.fill` circle in the dock, with no badge at zero) or at an avatar
/// (three taps deep behind that dock, and nothing in first run mentions it). And
/// "Start a conversation" on a fresh account opens a sheet whose suggestion list
/// is friends-only, so it opens on nothing at all.
enum FirstRunTask: String, CaseIterable, Identifiable, Sendable {
    case server
    case friend
    case avatar

    var id: String { rawValue }
}

/// What is still outstanding, and whether that is nothing.
struct FirstRunState: Equatable, Sendable {
    /// Every task, in display order, paired with its done-ness.
    let tasks: [(task: FirstRunTask, done: Bool)]

    var complete: Bool { tasks.allSatisfy(\.done) }

    func isDone(_ task: FirstRunTask) -> Bool {
        tasks.first { $0.task == task }?.done ?? false
    }

    static func == (lhs: FirstRunState, rhs: FirstRunState) -> Bool {
        lhs.tasks.count == rhs.tasks.count
            && zip(lhs.tasks, rhs.tasks).allSatisfy {
                $0.task == $1.task && $0.done == $1.done
            }
    }
}

enum FirstRun {
    /// Everything the two questions below are asked about.
    struct Inputs: Sendable {
        /// Nil where the account has not loaded yet.
        var avatarURL: String?
        var serverCount: Int
        var friendCount: Int
        /// Nil where the API predates the preference store entirely.
        var preferences: UserPreferences?

        init(
            avatarURL: String? = nil,
            serverCount: Int = 0,
            friendCount: Int = 0,
            preferences: UserPreferences? = UserPreferences()
        ) {
            self.avatarURL = avatarURL
            self.serverCount = serverCount
            self.friendCount = friendCount
            self.preferences = preferences
        }
    }

    /// What is outstanding, read from live state rather than from stored flags.
    ///
    /// Derived on purpose, exactly as on the web. A stored "created a server" bit
    /// would go stale the moment somebody leaves the server again, and it would
    /// need a write on each of the three paths — three more chances to record
    /// something that did not happen.
    ///
    /// An empty avatar string counts as absent: a cleared field has round-tripped
    /// as `""` rather than null, and ticking that box would credit somebody for a
    /// face nobody can see.
    static func state(_ inputs: Inputs) -> FirstRunState {
        let hasAvatar = !(inputs.avatarURL ?? "").isEmpty
        return FirstRunState(tasks: [
            (.server, inputs.serverCount > 0),
            (.friend, inputs.friendCount > 0),
            (.avatar, hasAvatar),
        ])
    }

    /// Should the hub draw the checklist?
    ///
    /// Three "no"s: no preference store to record a dismissal in (a card whose
    /// "no thanks" does not stick is a card that nags forever), already dismissed,
    /// or nothing left to offer.
    ///
    /// Nothing here consults an onboarding flag. iOS onboarding is three marketing
    /// beats and a sign-in, recorded in a device-local `UserDefaults` bool that
    /// says nothing about whether this account has a server, a friend or a face.
    static func shouldShow(_ inputs: Inputs) -> Bool {
        guard let preferences = inputs.preferences else { return false }
        guard !isDismissed(preferences) else { return false }
        return !state(inputs).complete
    }

    /// Has the checklist been answered?
    ///
    /// An EMPTY STRING COUNTS AS NOT ANSWERED, and that is not a technicality.
    /// Preferences are one JSONB blob merged with `||` server-side, so a key can
    /// be overwritten but never removed — which means once this field is written
    /// there is no way back to absent, and no way to put an account back in the
    /// state that shows the card. Reading `""` as "never dismissed" is the only
    /// re-arm there is, and it is what makes the flag testable at all.
    ///
    /// The web reaches the same answer through JavaScript truthiness
    /// (`if (preferences.firstRunDismissedAt)`), where `""` is already falsy. This
    /// has to say it out loud, because in Swift `""` is not nil.
    static func isDismissed(_ preferences: UserPreferences) -> Bool {
        !(preferences.firstRunDismissedAt ?? "").isEmpty
    }

    /// Should the dismissal be recorded without anybody tapping anything?
    ///
    /// Yes exactly when there is nothing left to do and nothing recorded. This is
    /// what makes "never returns" true rather than "usually does not return":
    /// visibility is derived from live state, and live state comes back. Leaving
    /// your last server a year from now must not reopen a "get into a server"
    /// nudge at somebody who has been here a year.
    static func shouldStampComplete(_ inputs: Inputs) -> Bool {
        guard let preferences = inputs.preferences else { return false }
        guard !isDismissed(preferences) else { return false }
        return state(inputs).complete
    }

    /// The instant to store, formatted the way the shared schema expects.
    ///
    /// `onboardedAt` and this are both bare `z.string()` on the server, so nothing
    /// validates the format — which is exactly why it is pinned here rather than
    /// left to whatever `Date.description` happens to produce. ISO-8601 with a
    /// `Z`, matching what `new Date().toISOString()` writes from the web, so a row
    /// dismissed on a phone reads the same as one dismissed in a browser.
    static func dismissedStamp(_ now: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: now)
    }
}
