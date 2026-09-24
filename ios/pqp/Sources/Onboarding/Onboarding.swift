import Foundation

/// The first-run wizard's decisions, with no SwiftUI attached.
///
/// The mirror of `client/src/lib/onboarding.ts` (web V2, PR #786). Both clients
/// read and write the same `preferences.onboardedAt`, so they have to agree on
/// who sees the flow, in how many screens, and what a handle rename means, or
/// finishing it on a phone would leave it waiting on a laptop.
///
/// THE SHAPE. Age, then "you", then (cold start only) "room" with three doors,
/// then "ready" with the invite in hand. Somebody who arrived on an invite link
/// has the room answered already, so theirs is two screens: age, you.
enum OnboardingScreen: String, CaseIterable, Sendable {
    case age
    case you
    case room
    case ready
}

/// Who is walking through, which decides how many screens there are.
///
/// There is no `import` path on iOS: the web one exists for a campaign link
/// (`?import=discord`) that only a browser can arrive on. The Discord door on
/// the room step is how a phone gets there.
enum OnboardingPath: String, Sendable {
    case cold
    case invite
}

enum Onboarding {
    /// The screens a path shows, in order, gate first.
    static func screens(for path: OnboardingPath) -> [OnboardingScreen] {
        path == .cold ? [.age, .you, .room, .ready] : [.age, .you]
    }

    /// Where a screen sits in the dots, zero-based. A screen the path does not
    /// list is clamped to the last dot, so the counter never reads past its end.
    static func position(
        of screen: OnboardingScreen,
        in path: OnboardingPath
    ) -> (index: Int, total: Int) {
        let list = screens(for: path)
        return (list.firstIndex(of: screen) ?? list.count - 1, list.count)
    }

    /// Should this account be walked through the wizard now?
    ///
    /// Same two "no"s as the web's `shouldRunOnboarding`: a server with no
    /// preference store cannot record that the flow ran (running it would mean
    /// running it on every launch, forever), and a stamped `onboardedAt` means
    /// finished, skipped or grandfathered.
    ///
    /// One more "no" that only a phone needs. iOS V1 never wrote `onboardedAt`,
    /// so accounts that signed up here since the web started stamping it have
    /// no stamp and are nonetheless long settled. The wizard runs for them only
    /// if this launch walked them through the age gate (every new account does)
    /// or they have no server at all yet (so there is something to set up). An
    /// active member with rooms of their own is never asked to name themselves
    /// again by an app update.
    static func shouldRun(
        preferences: UserPreferences?,
        answeredAgeGateThisLaunch: Bool,
        serverCount: Int?
    ) -> Bool {
        guard let preferences else { return false }
        guard (preferences.onboardedAt ?? "").isEmpty else { return false }
        if answeredAgeGateThisLaunch { return true }
        return serverCount == 0
    }

    /// The instant to store. Same format as the web's `toISOString()`.
    static func completedStamp(_ now: Date = Date()) -> String {
        FirstRun.dismissedStamp(now)
    }

    // MARK: - Handle

    /// What the username field accepts, applied as you type: `usernameSchema`
    /// is `^[a-z0-9_]+$`, so a capital or an accent is a keystroke to quietly
    /// fix, not an error to report. "João" becomes "joo".
    static func normalizeUsername(_ input: String) -> String {
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789_")
        return String(input.lowercased().filter { allowed.contains($0) }.prefix(32))
    }

    /// Is this something `PATCH /api/me` will accept as a username?
    static func isValidUsername(_ value: String) -> Bool {
        guard (2...32).contains(value.count) else { return false }
        guard value != "everyone", value != "here" else { return false }
        return normalizeUsername(value) == value
    }

    /// Did the server hand back a different number than the one asked for?
    ///
    /// A rename that collides keeps the name and rolls a fresh number, silently.
    /// Here that has to be said out loud: the whole point of the step is that
    /// they are seeing their @ for the first time, and handing out the wrong
    /// number means nobody finds them.
    static func tagWasReassigned(
        requestedUsername: String,
        previousTag: String?,
        nextTag: String?
    ) -> Bool {
        guard let nextTag, nextTag != previousTag else { return false }
        return nextTag.hasPrefix("\(requestedUsername)#")
    }

    /// Which sentence to show for a rename the server refused. Every branch
    /// leaves the field editable: nothing in this flow ends the flow.
    enum HandleError: Equatable, Sendable {
        /// 409: all 9,999 numbers behind that name are gone. Only a different
        /// name helps, so the copy says so instead of "try again".
        case taken
        case invalid
        case generic
    }

    static func handleError(for error: Error) -> HandleError {
        if case APIError.server(let status, _) = error {
            if status == 409 { return .taken }
            if status == 400 || status == 422 { return .invalid }
        }
        return .generic
    }

    // MARK: - Invite

    /// The `?ref=` the wizard's invite carries, so "copied in the wizard, then
    /// somebody joined through it" is a count of its own on the operator
    /// dashboard, beside `convite` and `discord`. Must match the web's
    /// `InviteRef`.
    static let inviteRef = "onboarding"

    /// Where the wizard's invite points. Always the web URL: it is a universal
    /// link, so a phone with the app opens the app and everybody else lands in
    /// the browser, joined, no install.
    static func shareURL(code: String, ref: String = inviteRef) -> URL {
        let escaped = code.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? code
        return URL(string: "https://pqp.gg/app/invite/\(escaped)?ref=\(ref)")!
    }

    /// Lifetime of the invite the wizard mints. Seven days, no use cap.
    static let inviteLifetimeHours = 168

    /// The server's `ref` must be a short lowercase tag; this is the same
    /// check, kept here so a typo in `inviteRef` fails a unit test rather than
    /// silently dropping the count server-side.
    static func isValidRef(_ ref: String) -> Bool {
        guard (1...32).contains(ref.count) else { return false }
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789-_")
        return ref.allSatisfy { allowed.contains($0) }
    }
}

/// The two pastes an organizer drops in a group chat, and the Discord one.
///
/// Localised through the string catalogue like every other line of copy, but
/// deliberately NOT translations of each other: the joke is the product's own
/// name and only works in Portuguese, so English gets the plain sentence. Same
/// rule as the web's `shareInviteText`.
enum InvitePaste: String, CaseIterable, Identifiable, Sendable {
    case short
    case long

    var id: String { rawValue }

    func text(url: URL) -> String {
        let link = url.absoluteString
        switch self {
        case .short:
            return String(localized: "Come hang out on pqp: \(link) #vemprapqp")
        case .long:
            return String(localized: "We moved to pqp. Opens in the browser, join the call and that's it: \(link) #vemprapqp")
        }
    }

    /// The text somebody pastes back into the Discord they just copied.
    static func discord(serverName: String, url: URL) -> String {
        let link = url.absoluteString
        return String(localized: "I copied \(serverName)'s layout into pqp (pqp.gg). Discord itself was not changed. Join: \(link)")
    }
}
