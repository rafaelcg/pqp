import SwiftUI
import ClerkKit

@main
struct PqpApp: App {
    @State private var session = SessionStore()
    /// App-wide because a ring is not tied to a screen: `call-incoming` can
    /// arrive while the user is anywhere, and the stage has to outlive whatever
    /// they navigate to mid-call.
    @State private var call = CallModel()
    /// The only object iOS will hand an APNs device token to. SwiftUI owns its
    /// lifetime; `RootView` attaches the session to it.
    @UIApplicationDelegateAdaptor(PushDelegate.self) private var push

    /// Non-nil only when a publishable key is configured. Held so it can be put
    /// into the SwiftUI environment, which Clerk's own views require.
    private let clerk: Clerk?

    init() {
        // Must happen before anything touches `Clerk.shared`, which asserts in
        // debug builds if it is unconfigured. With no key the app runs on the
        // dev bypass and Clerk is never consulted.
        if let key = AppConfig.clerkPublishableKey {
            clerk = Clerk.configure(publishableKey: key)
        } else {
            clerk = nil
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView(push: push)
                .environment(session)
                .environment(call)
                // Clerk's views read `@Environment(Clerk.self)`. Configuring is
                // not enough — without this injection, presenting `AuthView`
                // traps inside SwiftUI's environment lookup with a stack that
                // never mentions Clerk at all.
                .modifier(ClerkEnvironment(clerk: clerk))
                .preferredColorScheme(.dark)
                .tint(Palette.signal)
        }
    }
}

/// Injects Clerk only when it exists.
///
/// A modifier rather than an `if` around the view, so both branches stay the
/// same view identity — branching in the body would tear down and rebuild the
/// whole tree when the key is present.
private struct ClerkEnvironment: ViewModifier {
    let clerk: Clerk?

    func body(content: Content) -> some View {
        if let clerk {
            content.environment(clerk)
        } else {
            content
        }
    }
}

/// Decides what the app shows at the top level.
///
/// Kept deliberately thin: the transition between onboarding and the app is
/// the first animation anyone sees, and it is easier to keep it honest when
/// exactly one view owns it.
struct RootView: View {
    @Environment(SessionStore.self) private var session
    @Environment(CallModel.self) private var call
    @Environment(\.scenePhase) private var scenePhase

    let push: PushDelegate

    /// Whether the server can send native pushes at all. Nil until asked — the
    /// explainer must not flash on screen and then vanish because the answer
    /// came back "no APNs key configured".
    @State private var serverSupportsApns: Bool?
    @State private var showingPushExplainer = false

    var body: some View {
        @Bindable var call = call

        return ZStack {
            Palette.ink.ignoresSafeArea()

            switch session.phase {
            case .loading:
                SplashView()
                    .transition(.opacity)
            case .onboarding:
                OnboardingView()
                    .transition(.asymmetric(
                        insertion: .opacity,
                        removal: .opacity.combined(with: .scale(scale: 1.04))
                    ))
            case .ageGate:
                AgeGateView()
                    .transition(.opacity)
            case .blocked:
                AgeBlockedView()
                    .transition(.opacity)
            case .ready:
                HomeView()
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .scale(scale: 0.98)),
                        removal: .opacity
                    ))
            }
        }
        // The ring floats above whatever is on screen. Only ever while signed
        // in — a call cannot reach an account that is not authenticated.
        .overlay(alignment: .top) {
            if session.phase == .ready, let incoming = call.incoming.first {
                IncomingCallBanner(incoming: incoming)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(Motion.standard, value: call.incoming)
        // Presented from the root rather than from the chat screen: a call
        // answered from the servers tab has to have somewhere to appear, and
        // collapsing it must not depend on which screen started it.
        .fullScreenCover(isPresented: Binding(
            get: { call.phase.isLive && !call.isCollapsed },
            // The only way this cover dismisses itself is the swipe/back path,
            // which means "let me read something", not "hang up".
            set: { if !$0 { call.isCollapsed = true } }
        )) {
            CallStageView()
        }
        // The pre-permission explainer. A sheet from the root rather than from
        // the hub because it is about the app, not about a screen — and because
        // the hub is not always what `.ready` lands on (a restored channel is).
        .sheet(isPresented: $showingPushExplainer) {
            PushExplainerView { allow in
                showingPushExplainer = false
                guard allow else {
                    // "Not now" still counts as asked. Offering again on the
                    // next launch is how an app teaches people to dismiss it
                    // reflexively, and the system dialog only ever appears once.
                    PushPermission.markAsked()
                    return
                }
                Task { await push.requestAuthorization() }
            }
            .presentationBackground(Palette.ink)
        }
        .animation(Motion.gentle, value: session.phase)
        // Before `restore`, so a notification tap that launched the app has
        // somewhere to deliver its target as soon as the session exists.
        .task { push.attach(session: session) }
        .task { await session.restore() }
        .task { call.attach(session: session) }
        // Deep links. `onOpenURL` covers the custom scheme and a universal link
        // that arrives while the app is running; `onContinueUserActivity` is the
        // universal-link path on a cold launch, which does NOT come through
        // `onOpenURL`. Both are needed — shipping only the first is why "the
        // link works, but only the second time" is such a common bug.
        .onOpenURL { url in
            guard let target = DeepLink.target(url: url) else { return }
            session.requestNavigation(target)
        }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            guard let url = activity.webpageURL,
                  let target = DeepLink.target(url: url) else { return }
            session.requestNavigation(target)
        }
        // Idle is reported on transitions only, exactly as `set-idle` is
        // specified. Backgrounding is the phone's version of walking away.
        .onChange(of: scenePhase) { _, phase in
            session.reportIdle(phase == .background)
            // The realtime heartbeat pauses while suspended — pinging a socket
            // the OS killed during sleep crashed inside CFNetwork on wake.
            Task { await session.realtime.appStateChanged(active: phase == .active) }
        }
        // Notifications are set up on arrival at `.ready` and nowhere earlier:
        // `/api/push/config` needs a token, and asking for permission before
        // somebody has seen the product is the prompt everybody declines.
        .onChange(of: session.phase) { _, phase in
            guard phase == .ready else { return }
            Task { await setUpNotifications() }
        }
    }

    /// Two things, in this order: re-register a device token if permission is
    /// already held (tokens rotate between launches, so this is not optional),
    /// and offer the explainer to somebody who has never been asked.
    private func setUpNotifications() async {
        // `??` cannot take an async right-hand side — its default is an
        // autoclosure, which is not a concurrent context.
        let supported: Bool
        if let known = serverSupportsApns {
            supported = known
        } else {
            supported = (try? await session.api.pushConfig())?.apns ?? false
        }
        serverSupportsApns = supported
        guard supported else { return }
        await push.registerIfAlreadyAuthorized()
        if PushPermission.shouldOfferExplainer(
            phase: session.phase,
            serverSupportsApns: supported,
            hasAsked: PushPermission.hasAsked()
        ) {
            showingPushExplainer = true
        }
    }
}

/// Why this app would like to send notifications, said before iOS asks.
///
/// The system dialog appears once per install and a refusal is permanent, so the
/// only chance to explain is beforehand. It says what will actually arrive —
/// which is not "everything": the server only ever pushes a DM, a mention, a
/// reply or a ring, and only when nothing is connected. That is a promise worth
/// making out loud, because it is the reason to say yes.
struct PushExplainerView: View {
    let decide: (Bool) -> Void

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer(minLength: 0)

                SpeechMark(size: 56)
                    .padding(.bottom, 26)

                Text("Know when someone needs you")
                    .font(Typography.display(26))
                    .foregroundStyle(Palette.paper)
                    .multilineTextAlignment(.center)

                Text("pqp can buzz your phone for direct messages, mentions, replies and incoming calls — and only those, only when you're not already online somewhere. No badges for every message in every channel.")
                    .font(Typography.body)
                    .foregroundStyle(Palette.paperMuted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 330)
                    .padding(.top, 12)

                Text("By default a notification doesn't say who messaged you or what they said. You can change that in Settings.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperSubtle)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 330)
                    .padding(.top, 16)

                Spacer(minLength: 0)

                VStack(spacing: 12) {
                    Button("Turn on notifications") { decide(true) }
                        .buttonStyle(PrimaryButtonStyle())
                        .accessibilityIdentifier("push.allow")

                    Button("Not now") { decide(false) }
                        .font(Typography.callout)
                        .foregroundStyle(Palette.paperMuted)
                        .accessibilityIdentifier("push.decline")
                }
                .padding(.horizontal, Metrics.hPadding)
                .padding(.bottom, 24)
            }
            .padding(.top, 32)
        }
    }
}

/// The first frame. Matches the launch screen's colour exactly so the handoff
/// from the static launch image is invisible.
struct SplashView: View {
    @State private var appeared = false

    var body: some View {
        VStack(spacing: 18) {
            SpeechMark(size: 76)
                .scaleEffect(appeared ? 1 : 0.86)
                .opacity(appeared ? 1 : 0)

            Text("pqp")
                .font(Typography.display(30))
                .foregroundStyle(Palette.paper)
                .opacity(appeared ? 1 : 0)
        }
        .onAppear {
            withAnimation(Motion.gentle) { appeared = true }
        }
    }
}
