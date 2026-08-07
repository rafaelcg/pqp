import SwiftUI
import ClerkKit
import ClerkKitUI

/// Onboarding.
///
/// Three beats, and the mark is continuous through all of them — it shrinks and
/// moves rather than being replaced per page, so the sequence reads as one
/// object being handled rather than three unrelated screens. `matchedGeometry`
/// is what makes that literal instead of two views that happen to look alike.
struct OnboardingView: View {
    @Environment(SessionStore.self) private var session
    @State private var step = 0
    @State private var markProgress = 0.0
    @State private var signingIn = false
    @State private var showingAuth = false
    @Namespace private var mark

    private let beats: [(title: String, body: String)] = [
        (
            "Your friends.\nYour server.\nYour mess.",
            "Group chat you actually own. Text that flies, voice that doesn't flake."
        ),
        (
            "Rooms for\neverything.",
            "Servers, channels, DMs. Voice you can drop into without scheduling it first."
        ),
        (
            "Yours to keep.",
            "Open source. Self-host it, or use the hosted one. Same product either way."
        ),
    ]

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()
            AmbientGlow(step: step)

            VStack(spacing: 0) {
                Spacer(minLength: 0)

                SpeechMark(size: 108, dotProgress: markProgress)
                    .matchedGeometryEffect(id: "mark", in: mark)
                    .padding(.bottom, 40)

                copyBlock
                    .padding(.horizontal, 28)

                Spacer(minLength: 0)

                controls
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
            }
        }
        .onAppear {
            // The dots land after the bubble has settled, so the mark
            // assembles rather than appearing complete.
            withAnimation(.easeOut(duration: 1.1).delay(0.25)) {
                markProgress = 1
            }
        }
        // Clerk's own flow, used as shipped. It covers email codes, OAuth and
        // MFA — none of which can be exercised without a real inbox, so a
        // hand-rolled replacement would be unverifiable code on the one path
        // where being wrong locks everybody out.
        .sheet(isPresented: $showingAuth) {
            AuthView(mode: .signInOrUp)
                .onDisappear {
                    guard session.hasClerkSession else { return }
                    signingIn = true
                    Task {
                        await session.signIn()
                        signingIn = false
                    }
                }
        }
    }

    private var copyBlock: some View {
        VStack(spacing: 14) {
            Text(beats[step].title)
                .font(Typography.display(34))
                .foregroundStyle(Palette.paper)
                .multilineTextAlignment(.center)
                .lineSpacing(2)
                // A different id per step makes SwiftUI treat the copy as a new
                // view and run the transition, instead of cross-fading text in
                // place, which reads as a glitch.
                .id("title-\(step)")
                .transition(.asymmetric(
                    insertion: .move(edge: .trailing).combined(with: .opacity),
                    removal: .move(edge: .leading).combined(with: .opacity)
                ))

            Text(beats[step].body)
                .font(Typography.body)
                .foregroundStyle(Palette.paperMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
                .id("body-\(step)")
                .transition(.opacity)
        }
        .frame(minHeight: 200, alignment: .top)
    }

    private var controls: some View {
        VStack(spacing: 16) {
            HStack(spacing: 7) {
                ForEach(beats.indices, id: \.self) { index in
                    Capsule()
                        .fill(index == step ? Palette.signal : Palette.border)
                        // The active dot widens rather than just brightening —
                        // position stays readable at a glance, and in a glance
                        // is all anyone gives a progress indicator.
                        .frame(width: index == step ? 22 : 7, height: 7)
                }
            }
            .animation(Motion.standard, value: step)
            .padding(.bottom, 8)

            if let error = session.lastError {
                Text(error)
                    .font(Typography.callout)
                    .foregroundStyle(Palette.danger)
                    .multilineTextAlignment(.center)
                    .transition(.opacity)
            }

            Button(step == beats.count - 1 ? "Get started" : "Next") {
                if step == beats.count - 1 {
                    signIn()
                } else {
                    withAnimation(Motion.standard) { step += 1 }
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(signingIn)
            .overlay {
                if signingIn {
                    ProgressView().tint(Palette.inkDeep)
                }
            }

            Button("Skip") {
                signIn()
            }
            .font(Typography.callout)
            .foregroundStyle(Palette.paperMuted)
            .opacity(step == beats.count - 1 ? 0 : 1)
            .disabled(step == beats.count - 1 || signingIn)
            .animation(Motion.standard, value: step)
        }
    }

    private func signIn() {
        // Under the bypass there is nothing to sign into — the server accepts a
        // fixed token — so onboarding completes straight through.
        guard session.authMode == .clerk else {
            signingIn = true
            Task {
                await session.signIn()
                signingIn = false
            }
            return
        }
        showingAuth = true
    }
}

/// A slow gradient wash that shifts per beat.
///
/// Deliberately low-contrast and animated over more than a second: the job is
/// to make the background feel lit rather than flat, and anything faster or
/// brighter competes with the copy for attention.
private struct AmbientGlow: View {
    let step: Int

    private var alignment: UnitPoint {
        switch step {
        case 0: .topLeading
        case 1: .topTrailing
        default: .bottom
        }
    }

    var body: some View {
        RadialGradient(
            colors: [Palette.signal.opacity(0.16), .clear],
            center: alignment,
            startRadius: 10,
            endRadius: 420
        )
        .ignoresSafeArea()
        .animation(.easeInOut(duration: 1.2), value: step)
        .allowsHitTesting(false)
    }
}
