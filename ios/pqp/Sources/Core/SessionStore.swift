import Foundation
import Observation
import ClerkKit

enum SessionPhase: Equatable, Sendable {
    case loading
    case onboarding
    /// Signed in, but the server refuses every route until a date of birth is
    /// declared (`GET /api/me` → `ageGate: "pending"`). The realtime socket is
    /// not even opened in this phase — the server would close it with 4401.
    case ageGate
    /// Declared under 18. Terminal: one attempt, no self-serve way out.
    case blocked
    case ready
}

/// Owns identity and the two clients, and is the single thing views observe for
/// "am I signed in".
///
/// `@MainActor` on the whole type rather than sprinkled per property: every
/// mutation here drives SwiftUI, and Swift 6 strict concurrency turns the
/// alternative into a pile of hops that are easy to get subtly wrong.
struct DeadlineExceeded: Error {}

/// Runs `work`, or throws `DeadlineExceeded` if it outlives `seconds`.
///
/// A plain `Task.sleep` race rather than anything clever: whichever finishes
/// first wins and the loser is cancelled.
func withDeadline<T: Sendable>(
    seconds: Double,
    _ work: @escaping @Sendable () async throws -> T
) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await work() }
        group.addTask {
            try await Task.sleep(for: .seconds(seconds))
            throw DeadlineExceeded()
        }
        guard let first = try await group.next() else {
            throw DeadlineExceeded()
        }
        group.cancelAll()
        return first
    }
}

@MainActor
@Observable
final class SessionStore {
    private(set) var phase: SessionPhase = .loading
    private(set) var currentUser: CurrentUser?
    private(set) var realtimeStatus: RealtimeStatus = .idle
    private(set) var lastError: String?

    private let tokenProvider: any TokenProviding
    let authMode: AuthMode

    // Stored, not lazy: @Observable rewrites stored properties into computed
    // ones, and `lazy` is illegal on those.
    let api: APIClient
    let realtime: RealtimeClient

    init() {
        let mode = AppConfig.authMode
        authMode = mode
        let provider: any TokenProviding = switch mode {
        case .clerk: ClerkTokenProvider()
        case .devBypass: DevTokenProvider()
        }
        tokenProvider = provider
        api = APIClient(tokenProvider: provider)
        realtime = RealtimeClient(tokenProvider: provider)
    }

    /// Whether Clerk currently holds a session. Meaningless under the bypass,
    /// where there is nothing to hold.
    var hasClerkSession: Bool {
        authMode == .clerk && Clerk.shared.session != nil
    }

    private var eventTask: Task<Void, Never>?

    /// Whoever wants to react to realtime events registers here. A single
    /// fan-out point means the socket is consumed once no matter how many
    /// screens are alive.
    var eventHandlers: [String: @MainActor (RealtimeEvent) -> Void] = [:]

    /// Whether the intro has ever been completed on this device.
    ///
    /// Separate from "is there a session". A restorable session does not mean
    /// the person has seen the product explained — and with the dev bypass a
    /// session always restores, which would otherwise make onboarding
    /// unreachable and therefore untested.
    private static let onboardedKey = "pqp.hasCompletedOnboarding"

    private var hasOnboarded: Bool {
        get { UserDefaults.standard.bool(forKey: Self.onboardedKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.onboardedKey) }
    }

    func restore() async {
        guard phase == .loading else { return }
        guard hasOnboarded else {
            phase = .onboarding
            return
        }
        // Clerk restores its own session from the keychain; without a session
        // there is no token to send and `/api/me` would just 401.
        if authMode == .clerk, !hasClerkSession {
            phase = .onboarding
            return
        }
        do {
            // Hard deadline. The splash has no controls on it, so anything that
            // can hang here is a way to strand the app on a logo with no way
            // out — which is exactly what shipped once already. The network
            // layer should now fail fast on its own; this is the backstop that
            // holds even if some future call does not.
            let user = try await withDeadline(seconds: 12) {
                try await self.api.currentUser()
            }
            await route(user)
        } catch {
            // "No session" is the expected state on a first launch, so this is
            // not surfaced as a failure — but a *connection* problem is worth
            // saying out loud, because otherwise onboarding looks fine and the
            // sign-in button just quietly does nothing.
            if case APIError.transport(let detail) = error {
                // `detail` is URLError's own sentence ("Could not connect to
                // the server."), so it is used as-is rather than prefixed —
                // otherwise the two stack into "Can't reach the server. Could
                // not connect to the server."
                lastError = detail
            } else if error is DeadlineExceeded {
                lastError = String(localized: "The server did not respond. Is it running?")
            } else if case APIError.unauthorized = error {
                // A Clerk session that cannot produce a working token is dead
                // weight: it blocks the sign-in sheet ("you're already signed
                // in") while the API refuses it — a deadlock the user cannot
                // escape. The concrete way this happens: a keychain session
                // minted against a different Clerk instance (a dev build's
                // pk_test surviving into a pk_live build). Purge it so the
                // next tap starts clean, and say so without alarm.
                await purgeClerkSession()
                lastError = String(localized: "Signed out — sign in again to continue.")
            }
            phase = .onboarding
        }
    }

    /// Tries to reuse a keychain Clerk session before the sign-in sheet is
    /// shown. Returns true when it works and the user has been routed onward.
    ///
    /// This must run *before* the sheet because the keychain outlives an app
    /// uninstall: a fresh install (UserDefaults wiped, so `restore` never gets
    /// past onboarding) can still hold a session — possibly minted by a
    /// different Clerk instance — and the sheet refuses to run while one
    /// exists ("you're already signed in") even though the API refuses its
    /// tokens. A session the API rejects is purged here so the sheet that
    /// follows starts clean.
    func adoptExistingSession() async -> Bool {
        guard authMode == .clerk, hasClerkSession else { return false }
        do {
            let user = try await withDeadline(seconds: 12) {
                try await self.api.currentUser()
            }
            lastError = nil
            hasOnboarded = true
            await route(user)
            return true
        } catch {
            if case APIError.unauthorized = error {
                await purgeClerkSession()
                // Not surfaced as an error: the sheet is about to offer a
                // clean sign-in, which is the remedy.
                lastError = nil
            }
            return false
        }
    }

    /// Called when onboarding completes. Separate from `restore` because it
    /// must surface a failure — here the user *did* just ask to sign in.
    func signIn() async {
        do {
            let user = try await api.currentUser()
            lastError = nil
            hasOnboarded = true
            await route(user)
        } catch {
            if authMode == .clerk, case APIError.unauthorized = error {
                // Purge rather than strand: a refused session left in the
                // keychain would block the next sign-in sheet the same way.
                await purgeClerkSession()
            }
            lastError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Where a freshly identified account lands. The age gate outranks
    /// everything: until it says `passed` (or the server predates it and says
    /// nothing) every other route answers 403 and the socket answers 4401, so
    /// proceeding to the app would produce a screen of errors.
    private func route(_ user: CurrentUser) async {
        currentUser = user
        switch user.ageGate {
        case "pending":
            phase = .ageGate
        case "blocked":
            phase = .blocked
        default:
            await startRealtime()
            phase = .ready
        }
    }

    /// The one-shot declaration. `POST /api/me/age-check` answers **200 for
    /// both outcomes** — refusal is a routing decision, not an HTTP error.
    /// Returns an error sentence to show inline, or nil when routed onward.
    func submitAgeDeclaration(dateOfBirth: String) async -> String? {
        struct Body: Encodable { let dateOfBirth: String }
        struct Response: Decodable { let ageGate: String }
        do {
            let response: Response = try await api.post(
                "/api/me/age-check", body: Body(dateOfBirth: dateOfBirth)
            )
            if response.ageGate == "passed" {
                await refreshCurrentUser()
                await startRealtime()
                phase = .ready
            } else {
                phase = .blocked
            }
            return nil
        } catch let apiError as APIError {
            if case .server(let status, _) = apiError, status == 409 {
                // Already answered — this screen is stale (another device got
                // there first). The server's record wins; re-read and route.
                if let user = try? await api.currentUser() {
                    await route(user)
                    return nil
                }
            }
            // A 400 is "that date does not exist" and does not consume the
            // attempt; the server's own sentence is the clearest thing to show.
            return apiError.errorDescription
        } catch {
            return error.localizedDescription
        }
    }

    /// Re-reads `/api/me` after a profile edit so the change is visible without
    /// signing out and back in.
    func refreshCurrentUser() async {
        if let user = try? await api.currentUser() {
            currentUser = user
        }
    }

    /// Ends the Clerk session for real, whatever state it is in.
    ///
    /// `auth.signOut()` is only a network call against the *current* frontend
    /// API — a keychain session minted by a different Clerk instance (a dev
    /// build's pk_test surviving into a pk_live build) makes it 401 and throw,
    /// leaving the dead session in the keychain and the sign-in sheet still
    /// insisting "you're already signed in". This shipped as build 3: the
    /// `try?` swallowed exactly that throw and nothing changed. When the
    /// session survives the polite path, reconfigure with the same key —
    /// `Clerk.reconfigure` is the SDK's public "clear local state" operation,
    /// documented as requiring everyone to sign in again afterwards.
    private func purgeClerkSession() async {
        try? await Clerk.shared.auth.signOut()
        if Clerk.shared.session != nil, let key = AppConfig.clerkPublishableKey {
            try? await Clerk.reconfigure(publishableKey: key)
        }
    }

    func signOut() async {
        // Deliberately also forgets onboarding: signing out is the only way
        // back to a first-run state, and on a dev build that is how the intro
        // gets exercised.
        hasOnboarded = false
        // The next account to use this device must not be dropped into the
        // previous one's conversation.
        LastVisited.clear()
        if authMode == .clerk {
            await purgeClerkSession()
        }
        await realtime.stop()
        eventTask?.cancel()
        eventTask = nil
        eventHandlers.removeValue(forKey: Self.cacheHandlerKey)
        // Cached pages are one account's private messages sitting in
        // Application Support. The next person to sign in on this device must
        // not find them, so the whole directory goes.
        await ReadCache.shared.clear()
        currentUser = nil
        phase = .onboarding
    }

    /// Whether this device has told the server it is idle. Kept here because
    /// the flag is socket-scoped server-side: a reconnect wipes it and it has
    /// to be re-asserted, or a phone in a pocket reads as freshly active.
    private var reportedIdle = false

    /// Called from scene-phase changes. On a phone "nobody is touching this"
    /// is the app leaving the foreground — there is no cursor to watch.
    func reportIdle(_ idle: Bool) {
        guard phase == .ready, reportedIdle != idle else { return }
        reportedIdle = idle
        Task { await realtime.sendIdle(idle) }
    }

    /// The one handler that is not a screen. Registered here because the cache
    /// has to stay current for channels *nobody is looking at* — a `ChatModel`
    /// only exists while its channel is open, so leaving this to the views
    /// would mean reopening a busy channel showed a page that is visibly
    /// behind until the refetch landed.
    private static let cacheHandlerKey = "read-cache"

    private func startRealtime() async {
        guard eventTask == nil else { return }
        eventHandlers[Self.cacheHandlerKey] = { event in
            Task { await ReadCache.shared.apply(event) }
        }
        let stream = await realtime.events()
        await realtime.onStatusChange { [weak self] status in
            Task { @MainActor in self?.realtimeStatus = status }
        }
        eventTask = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                if case .ready = event, self.reportedIdle {
                    // The new socket does not know what the old one was told.
                    Task { await self.realtime.sendIdle(true) }
                }
                for handler in self.eventHandlers.values {
                    handler(event)
                }
            }
        }
        await realtime.connect()
    }
}
