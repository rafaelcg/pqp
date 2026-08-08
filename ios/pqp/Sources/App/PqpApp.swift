import SwiftUI
import ClerkKit

@main
struct PqpApp: App {
    @State private var session = SessionStore()
    /// App-wide because a ring is not tied to a screen: `call-incoming` can
    /// arrive while the user is anywhere, and the stage has to outlive whatever
    /// they navigate to mid-call.
    @State private var call = CallModel()

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
            RootView()
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
        .animation(Motion.gentle, value: session.phase)
        .task { await session.restore() }
        .task { call.attach(session: session) }
        // Idle is reported on transitions only, exactly as `set-idle` is
        // specified. Backgrounding is the phone's version of walking away.
        .onChange(of: scenePhase) { _, phase in
            session.reportIdle(phase == .background)
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
