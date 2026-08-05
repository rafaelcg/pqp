import SwiftUI

@main
struct PqpApp: App {
    @State private var session = SessionStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .preferredColorScheme(.dark)
                .tint(Palette.signal)
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
