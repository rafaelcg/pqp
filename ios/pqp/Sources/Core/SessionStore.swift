import Foundation
import Observation
import ClerkKit

enum SessionPhase: Equatable, Sendable {
    case loading
    case onboarding
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
            currentUser = user
            await startRealtime()
            phase = .ready
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
                lastError = "The server did not respond. Is it running?"
            }
            phase = .onboarding
        }
    }

    /// Called when onboarding completes. Separate from `restore` because it
    /// must surface a failure — here the user *did* just ask to sign in.
    func signIn() async {
        do {
            let user = try await api.currentUser()
            currentUser = user
            lastError = nil
            hasOnboarded = true
            await startRealtime()
            phase = .ready
        } catch {
            lastError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Re-reads `/api/me` after a profile edit so the change is visible without
    /// signing out and back in.
    func refreshCurrentUser() async {
        if let user = try? await api.currentUser() {
            currentUser = user
        }
    }

    func signOut() async {
        // Deliberately also forgets onboarding: signing out is the only way
        // back to a first-run state, and on a dev build that is how the intro
        // gets exercised.
        hasOnboarded = false
        if authMode == .clerk {
            try? await Clerk.shared.auth.signOut()
        }
        await realtime.stop()
        eventTask?.cancel()
        eventTask = nil
        currentUser = nil
        phase = .onboarding
    }

    private func startRealtime() async {
        guard eventTask == nil else { return }
        let stream = await realtime.events()
        await realtime.onStatusChange { [weak self] status in
            Task { @MainActor in self?.realtimeStatus = status }
        }
        eventTask = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                for handler in self.eventHandlers.values {
                    handler(event)
                }
            }
        }
        await realtime.connect()
    }
}
