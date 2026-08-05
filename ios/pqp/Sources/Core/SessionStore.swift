import Foundation
import Observation

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
@MainActor
@Observable
final class SessionStore {
    private(set) var phase: SessionPhase = .loading
    private(set) var currentUser: CurrentUser?
    private(set) var realtimeStatus: RealtimeStatus = .idle
    private(set) var lastError: String?

    /// Development identity. Real Clerk sign-in replaces this provider without
    /// anything else in the app changing — see docs/IOS.md.
    private let tokenProvider: any TokenProviding

    // Stored, not lazy: @Observable rewrites stored properties into computed
    // ones, and `lazy` is illegal on those.
    let api: APIClient
    let realtime: RealtimeClient

    init() {
        let provider = DevTokenProvider()
        tokenProvider = provider
        api = APIClient(tokenProvider: provider)
        realtime = RealtimeClient(tokenProvider: provider)
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
        do {
            let user = try await api.currentUser()
            currentUser = user
            await startRealtime()
            phase = .ready
        } catch {
            // Not an error worth showing: "no session" is the expected state on
            // a first launch, and onboarding is where that leads.
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

    func signOut() async {
        // Deliberately also forgets onboarding: signing out is the only way
        // back to a first-run state, and on a dev build that is how the intro
        // gets exercised.
        hasOnboarded = false
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
