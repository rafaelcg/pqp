import Foundation
import UIKit
import UserNotifications

/// Native push notifications: asking, registering, presenting, routing.
///
/// The server half is `server/src/services/push.ts` + `apns.ts`. What arrives
/// here is a payload built for *both* clients — the same title and body the web
/// client's service worker shows, plus a `path` which is a web-client route
/// (`/app/dm/<id>`, `/app/server/<sid>/channel/<cid>`). Parsing it is
/// `DeepLink`'s job, so a notification tap and an invite link go through the
/// same code.
///
/// WHAT IS NOT HERE: any decision about whether a notification *should* have
/// been sent. That is entirely server-side — no live socket anywhere, not on
/// do-not-disturb, level allows it — and re-deciding it on the phone would only
/// produce a second, disagreeing opinion. The one presentation decision this
/// file makes is narrower and genuinely local: whether to draw a banner over a
/// conversation the user is already reading.

// MARK: - Presentation

/// Whether a notification that arrived while the app is in the foreground
/// deserves a banner.
///
/// Pure, and tested, because the failure is embarrassing rather than loud: a
/// banner sliding over the very message it is announcing, in the channel the
/// user is looking at, while the message itself appears underneath it.
enum PushPresentation {
    /// `visibleChannelId` is `SessionStore.visibleChannelId` — the channel a
    /// `ChatModel` currently has open, or nil when the user is anywhere else.
    ///
    /// A notification with no channel in it (an invite, a malformed path) always
    /// interrupts: there is no conversation it could be redundant with.
    static func shouldInterrupt(path: String?, visibleChannelId: String?) -> Bool {
        guard let visibleChannelId, let path else { return true }
        switch DeepLink.target(path: path) {
        case .conversation(let channelId):
            return channelId != visibleChannelId
        case .channel(_, let channelId):
            return channelId != visibleChannelId
        case .invite, .server, .none:
            return true
        }
    }
}

/// The custom keys `buildApnsBody` puts alongside `aps`. Read as a struct rather
/// than poked at with string subscripts so a server-side rename is one edit.
struct PushPayloadKeys {
    /// The web-client route to open. Also the only routing input.
    static let path = "path"
    /// The conversation id, which is also the `apns-collapse-id`. Not used for
    /// routing — `path` is — but present, and worth knowing about.
    static let tag = "tag"
}

// MARK: - Permission

/// Whether the app has ever put the system permission dialog on screen.
///
/// The dialog is one-shot per install: iOS answers `.denied` forever after a
/// single refusal, with no second chance and no way for the app to re-ask. That
/// is the entire reason for the explainer sheet — the cost of asking at the
/// wrong moment is permanent.
enum PushPermission {
    static let askedKey = "pqp.hasAskedForPushPermission"

    static func hasAsked(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: askedKey)
    }

    static func markAsked(_ defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: askedKey)
    }

    /// Whether to put the explainer in front of somebody.
    ///
    /// Pure so the timing rule is testable, because the rule *is* the feature:
    /// asked at launch, before the person has seen a single message, this is the
    /// prompt everybody declines. It is offered once, after a real sign-in has
    /// landed on `.ready`, and never again.
    static func shouldOfferExplainer(
        phase: SessionPhase,
        serverSupportsApns: Bool,
        hasAsked: Bool
    ) -> Bool {
        phase == .ready && serverSupportsApns && !hasAsked
    }
}

// MARK: - The delegate

/// The APNs plumbing, as a `UIApplicationDelegate` because that is the only
/// object iOS will hand a device token to.
///
/// Attached to the session once, from `RootView`, rather than constructed with
/// it: SwiftUI owns this object's lifetime through
/// `@UIApplicationDelegateAdaptor` and creates it with `init()` before any
/// `@State` exists. The reference is weak — the delegate outlives nothing, but
/// a strong cycle between the two roots of the app is not worth having.
@MainActor
final class PushDelegate: NSObject, UIApplicationDelegate {
    private weak var session: SessionStore?

    /// A tapped notification that arrived before there was a session to tell.
    ///
    /// Launching from a cold start *via* a notification runs the tap callback
    /// while the app is still on its splash screen and `RootView` has not yet
    /// attached anything, so the target has to wait somewhere. Exactly one is
    /// held: two taps before launch completes is not a thing, and if it were,
    /// the second is the one the user meant.
    private var bufferedTarget: DeepLinkTarget?

    /// Same idea for a device token. Registration is only ever *started* after
    /// the session is attached, so in practice this stays nil — but a token
    /// dropped on the floor is a device that silently never gets notifications,
    /// and four lines is cheap insurance against a future caller getting the
    /// order wrong.
    private var bufferedToken: String?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions:
            [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Set here and not later: the delegate must be in place before iOS
        // delivers the notification that launched the app, which it does
        // immediately after this returns.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /// Wires the delegate to the session, and hands over anything that arrived
    /// before there was one.
    ///
    /// Navigation requests go *through the session* rather than being observed
    /// on this object: `SessionStore` is already `@Observable` and already in
    /// every view's environment, whereas a `UIApplicationDelegateAdaptor` is
    /// not something SwiftUI re-renders on.
    func attach(session: SessionStore) {
        self.session = session
        if let token = bufferedToken {
            bufferedToken = nil
            Task { await session.registerPushToken(token) }
        }
        if let buffered = bufferedTarget {
            bufferedTarget = nil
            session.requestNavigation(buffered)
        }
    }

    private func deliver(_ target: DeepLinkTarget) {
        guard let session else {
            bufferedTarget = target
            return
        }
        session.requestNavigation(target)
    }

    // MARK: Registration

    /// Asks iOS for permission and, if granted, for a device token.
    ///
    /// Returns whether permission is now held, so the caller can stop offering
    /// the explainer either way — a refusal is as final as an acceptance.
    @discardableResult
    func requestAuthorization() async -> Bool {
        PushPermission.markAsked()
        let center = UNUserNotificationCenter.current()
        let granted: Bool
        do {
            granted = try await center.requestAuthorization(options: [
                .alert, .sound, .badge,
            ])
        } catch {
            // A throw here is the system failing to present, not the user
            // saying no. Nothing to show them: there is no notification to
            // miss yet, and the settings screen can offer it again.
            return false
        }
        if granted {
            // Registration is a separate step from permission and must follow
            // it: calling it first yields a token for an app that will never be
            // allowed to show anything.
            UIApplication.shared.registerForRemoteNotifications()
        }
        return granted
    }

    /// Re-registers on every launch when permission is already held.
    ///
    /// Not an optimisation — a requirement. iOS may hand the app a DIFFERENT
    /// device token at any launch (restore from backup, some OS updates, an app
    /// reinstall), the old one silently stops working, and the only way to learn
    /// the new one is to ask. An app that registers once, on the launch where
    /// permission was granted, works until the day it quietly stops.
    func registerIfAlreadyAuthorized() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .authorized
            || settings.authorizationStatus == .provisional
        else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        // Lowercase hex, which is what the server's schema validates.
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        guard let session else {
            bufferedToken = token
            return
        }
        Task { await session.registerPushToken(token) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Expected on a simulator without a paired push environment, and on a
        // device with no network at launch. Nothing to tell the user: they did
        // not ask for anything, and the next launch retries.
        print("[push] registration failed: \(error.localizedDescription)")
    }
}

// MARK: - Notification delegate

/// `UNUserNotificationCenterDelegate` is NOT main-actor isolated — its callbacks
/// arrive on whatever queue UserNotifications feels like — so these two are
/// `nonisolated`. Each pulls the one `Sendable` value it needs out of the
/// notification (`path`, a `String?`) and only then crosses onto the main actor.
///
/// This is not ceremony to satisfy the compiler: `UNNotification` is not
/// `Sendable`, and handing it to main-actor code is precisely the data race
/// Swift 6 exists to reject.
extension PushDelegate: UNUserNotificationCenterDelegate {
    /// A notification arriving while the app is open.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let path = notification.request.content.userInfo[PushPayloadKeys.path] as? String
        return await presentationOptions(path: path)
    }

    private func presentationOptions(
        path: String?
    ) -> UNNotificationPresentationOptions {
        guard PushPresentation.shouldInterrupt(
            path: path,
            visibleChannelId: session?.visibleChannelId
        ) else {
            // Still listed in Notification Center, just not banner-ed over the
            // conversation it is about. Suppressing it entirely would mean a
            // message read on another device left no trace here.
            return [.list]
        }
        return [.banner, .list, .sound]
    }

    /// A notification the user tapped.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let path = response.notification.request.content
            .userInfo[PushPayloadKeys.path] as? String
        else { return }
        await handleTap(path: path)
    }

    private func handleTap(path: String) {
        guard let target = DeepLink.target(path: path) else { return }
        deliver(target)
    }
}
