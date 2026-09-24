import SwiftUI
import ClerkKit
import ClerkKitUI

/// The welcome, before there is an account.
///
/// V1 was three marketing beats in a row, each one a tap between somebody and
/// the thing they came for. V2 is one screen that says what pqp is in a line,
/// three skimmable things it does, and the door. Or, when a link brought them
/// here, the room that is waiting for them: "You're invited to {server}", its
/// picture and how many people are inside, read from the public invite
/// preview before any sign-in exists.
///
/// The mark is the same view as the small one in the wizard's header (matched
/// geometry through `brand`), so signing in reads as the mark settling into
/// its corner rather than one screen replacing another.
struct OnboardingView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let brand: Namespace.ID

    @State private var markProgress = 0.0
    @State private var signingIn = false
    @State private var authSheet: AuthSheet?
    @State private var preview: PublicInvitePreview?
    @State private var heroShown = false
    /// A short screen (iPhone SE, or a big text size on any phone): the mark
    /// and the headline step down a size so the three moments stay in view
    /// above the buttons instead of scrolling under them.
    @State private var compact = false

    /// Which of Clerk's flows the sheet opens on.
    private struct AuthSheet: Identifiable {
        let mode: AuthView.Mode
        var id: String { mode.rawValue }
    }

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()
            WelcomeGlow(invite: session.pendingInviteCode != nil)

            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: compact ? 20 : 30) {
                        SpeechMark(size: compact ? 52 : 72, dotProgress: markProgress)
                            .matchedGeometryEffect(id: "mark", in: brand)
                            .accessibilityHidden(true)
                            .padding(.top, compact ? 12 : 24)

                        if session.pendingInviteCode != nil {
                            inviteHero
                                .transition(.opacity)
                        } else {
                            coldHero
                                .transition(.opacity)
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 24)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollBounceBehavior(.basedOnSize)

                controls
                    .padding(.horizontal, 24)
                    .padding(.top, 8)
                    .padding(.bottom, 12)
            }
        }
        .onGeometryChange(for: Bool.self) { $0.size.height < 700 } action: { compact = $0 }
        .animation(FirstRunMotion.step(reduceMotion), value: session.pendingInviteCode)
        .animation(FirstRunMotion.pop(reduceMotion), value: preview)
        .onAppear {
            // The dots land after the bubble has settled, so the mark
            // assembles rather than appearing complete.
            withAnimation(.easeOut(duration: reduceMotion ? 0.2 : 1.1).delay(reduceMotion ? 0 : 0.25)) {
                markProgress = 1
            }
            withAnimation(FirstRunMotion.pop(reduceMotion).delay(0.15)) {
                heroShown = true
            }
        }
        .task(id: session.pendingInviteCode) {
            guard let code = session.pendingInviteCode else {
                preview = nil
                return
            }
            preview = await APIClient.publicInvitePreview(code: code)
        }
        // Clerk's own flow, used as shipped. It covers email codes, OAuth and
        // MFA, none of which can be exercised without a real inbox, so a
        // hand-rolled replacement would be unverifiable code on the one path
        // where being wrong locks everybody out.
        .sheet(item: $authSheet) { sheet in
            AuthView(mode: sheet.mode)
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

    // MARK: - Heroes

    private var coldHero: some View {
        VStack(alignment: .leading, spacing: 28) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Open source · Free · No card required")
                    .font(FirstRunType.eyebrow)
                    .textCase(.uppercase)
                    .tracking(1.1)
                    .foregroundStyle(Palette.signal)

                Text("Voice, screen share and chat. For your crew, on your terms.")
                    .font(compact ? FirstRunType.title : FirstRunType.display)
                    .foregroundStyle(Palette.paper)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            .opacity(heroShown ? 1 : 0)
            .offset(y: heroShown || reduceMotion ? 0 : 12)

            FeatureMomentList(moments: FeatureMoment.welcome, delay: 0.35)
        }
    }

    private var inviteHero: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 6) {
                Image(systemName: "envelope.open.fill").imageScale(.small)
                Text("Invite")
                    .textCase(.uppercase)
                    .tracking(1.1)
            }
            .font(FirstRunType.eyebrow)
            .foregroundStyle(Palette.signal)

            HStack(alignment: .center, spacing: 16) {
                ServerIconTile(
                    name: preview?.serverName ?? "pqp",
                    iconUrl: preview?.iconUrl,
                    size: 76
                )
                .shadow(color: Palette.signal.opacity(0.25), radius: 18)
                .scaleEffect(preview != nil || reduceMotion ? 1 : 0.9)
                .opacity(preview != nil ? 1 : 0.5)

                if let count = preview?.memberCount {
                    Label {
                        Text("\(count) people inside")
                    } icon: {
                        Image(systemName: "person.2.fill")
                    }
                    .font(FirstRunType.callout.weight(.semibold))
                    .foregroundStyle(Palette.paperSubtle)
                    .transition(.opacity)
                }
            }

            Group {
                if let name = preview?.serverName {
                    Text("You're invited to \(name)")
                } else {
                    Text("Somebody sent you an invite")
                }
            }
            .font(compact ? FirstRunType.title : FirstRunType.display)
            .foregroundStyle(Palette.paper)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("welcome.inviteTitle")

            Text("Create an account and you're in. Takes a minute.")
                .font(FirstRunType.body)
                .foregroundStyle(Palette.paperMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .opacity(heroShown ? 1 : 0)
        .offset(y: heroShown || reduceMotion ? 0 : 12)
    }

    // MARK: - Controls

    private var controls: some View {
        VStack(spacing: 10) {
            if let error = session.lastError {
                Text(error)
                    .font(FirstRunType.callout)
                    .foregroundStyle(Palette.danger)
                    .multilineTextAlignment(.center)
                    .transition(.opacity)
            }

            Button {
                begin(.signInOrUp)
            } label: {
                HStack(spacing: 8) {
                    if signingIn { ProgressView().tint(Palette.inkDeep) }
                    Text("Create account")
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(signingIn)
            .accessibilityIdentifier("welcome.start")

            Button("I have an account") {
                begin(.signIn)
            }
            .font(.callout.weight(.semibold))
            .foregroundStyle(Palette.paperSubtle)
            .frame(minHeight: 44)
            .disabled(signingIn)
            .accessibilityIdentifier("welcome.signIn")
        }
    }

    private func begin(_ mode: AuthView.Mode) {
        // Under the bypass there is nothing to sign into: the server accepts a
        // fixed token, so the welcome completes straight through.
        guard session.authMode == .clerk else {
            signingIn = true
            Task {
                await session.signIn()
                signingIn = false
            }
            return
        }
        // A keychain session can predate this install (the keychain outlives
        // an uninstall). Adopt it when it works, with no sheet at all, and
        // purge it when the API refuses it, or the sheet would open straight
        // onto "you're already signed in" with no way forward.
        signingIn = true
        Task {
            let adopted = await session.adoptExistingSession()
            signingIn = false
            if !adopted {
                authSheet = AuthSheet(mode: mode)
            }
        }
    }
}

/// Two slow washes of colour drifting behind the welcome. Low contrast on
/// purpose; still under Reduce Motion.
private struct WelcomeGlow: View {
    let invite: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drift = false

    var body: some View {
        ZStack {
            RadialGradient(
                colors: [Palette.signal.opacity(invite ? 0.2 : 0.15), .clear],
                center: drift ? UnitPoint(x: 0.9, y: 0.1) : UnitPoint(x: 0.2, y: 0.05),
                startRadius: 10,
                endRadius: 420
            )
            RadialGradient(
                colors: [Color(red: 0.45, green: 0.72, blue: 1).opacity(0.08), .clear],
                center: drift ? UnitPoint(x: 0.1, y: 0.9) : UnitPoint(x: 0.8, y: 0.75),
                startRadius: 10,
                endRadius: 380
            )
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 9).repeatForever(autoreverses: true)) {
                drift = true
            }
        }
    }
}
