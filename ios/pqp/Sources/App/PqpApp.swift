import SwiftUI
import ClerkKit

@main
struct PqpApp: App {
    @State private var session = SessionStore()

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

    var body: some View {
        ZStack {
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
            case .ready:
                HomeView()
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .scale(scale: 0.98)),
                        removal: .opacity
                    ))
            }
        }
        .animation(Motion.gentle, value: session.phase)
        .task { await session.restore() }
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
