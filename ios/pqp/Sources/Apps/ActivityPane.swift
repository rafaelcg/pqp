import SwiftUI

/// The full-screen room an activity runs in: a thin native bar (leave, who is in,
/// the menu) over the sandboxed frame. The frame never gets a token, an id or the
/// socket; everything it may know comes through `AppBridge`.
///
/// States, from data alone (`ActivityRunner.phase`): opening (a calm pulse while
/// the seat is taken and the page loads), ready, failed (a sentence and "Try
/// again"), ended (what happened and a close), and a warning bar while the socket
/// is away (the seat is kept for 90 seconds).
struct ActivityPaneView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let runner: ActivityRunner
    @State private var confirmingEnd = false
    @State private var showingPeople = false
    @State private var endFailed = false
    @State private var ending = false

    private var apps: AppsStore { session.apps }
    private var live: AppSessionSummary? { apps.live(in: runner.channelId) }
    private var canEnd: Bool {
        runner.isHost || live?.hostUserId == apps.viewerId
    }

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()
            VStack(spacing: 0) {
                bar
                if !runner.online { offlineBanner.transition(.move(edge: .top).combined(with: .opacity)) }
                ZStack {
                    if let frame = runner.frame, showsFrame {
                        AppFrameRepresentable(controller: frame)
                            .opacity(runner.phase == .ready ? 1 : 0)
                            .animation(reduceMotion ? .easeOut(duration: 0.12) : .easeOut(duration: 0.3), value: runner.phase == .ready)
                            .accessibilityLabel(runner.app.name())
                            .accessibilityIdentifier("activity.frame")
                    }
                    overlay
                }
            }
            .animation(Motion.standard, value: runner.online)
        }
        .confirmationDialog(
            "End \(runner.app.name()) for everyone?",
            isPresented: $confirmingEnd, titleVisibility: .visible
        ) {
            Button("End the app for everyone", role: .destructive) {
                Task {
                    ending = true
                    let ok = await runner.endForEveryone()
                    ending = false
                    if !ok { endFailed = true; Haptics.failure() }
                }
            }
            Button("Keep it", role: .cancel) {}
        } message: {
            Text("Everyone inside is taken out and the room closes.")
        }
        .alert("Could not end it. Try again.", isPresented: $endFailed) {
            Button("OK", role: .cancel) {}
        }
        .sheet(isPresented: $showingPeople) {
            ActivityPeopleSheet(runner: runner)
        }
        .onChange(of: runner.phase) { _, phase in
            switch phase {
            case .ended: Haptics.soft()
            case .failed: Haptics.failure()
            default: break
            }
        }
        .accessibilityIdentifier("activity.pane")
    }

    private var showsFrame: Bool {
        switch runner.phase {
        case .loading, .ready: true
        default: false
        }
    }

    // MARK: Bar

    private var bar: some View {
        HStack(spacing: 10) {
            Button {
                Haptics.selection()
                apps.closePane()
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(Palette.paper)
                    .frame(width: 40, height: 40)
            }
            .accessibilityLabel("Leave app")
            .accessibilityIdentifier("activity.pane.leave")

            ActivityGlyph(icon: runner.app.icon, size: 30)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: runner.app.name())
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.paper)
                    .lineLimit(1)
                subtitle
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            Menu {
                Button { showingPeople = true } label: { Label("See who is in", systemImage: "person.2") }
                Button { apps.closePane() } label: { Label("Leave app", systemImage: "rectangle.portrait.and.arrow.right") }
                if canEnd, runner.phase == .ready {
                    Button(role: .destructive) { confirmingEnd = true } label: { Label("End app", systemImage: "stop.circle") }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(Palette.paper)
                    .frame(width: 40, height: 40)
            }
            .accessibilityLabel("More app options")
            .accessibilityIdentifier("activity.pane.menu")
        }
        .padding(.horizontal, 8)
        .frame(height: 52)
        .background(Palette.inkDeep)
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.border).frame(height: 1) }
    }

    @ViewBuilder
    private var subtitle: some View {
        if let live {
            if live.players == 0 && live.spectators == 0 {
                Text("Nobody in yet")
            } else {
                Text("\(live.players) in")
            }
        } else {
            Text(verbatim: "#\(runner.channelName)")
        }
    }

    private var offlineBanner: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small).tint(Palette.warning)
            Text("No connection. Trying to get back, your spot is kept for 90 s.")
                .font(Typography.caption)
                .foregroundStyle(Palette.warning)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 8)
        .background(Palette.warning.opacity(0.12))
        .accessibilityIdentifier("activity.pane.offline")
    }

    // MARK: States

    @ViewBuilder
    private var overlay: some View {
        switch runner.phase {
        case .joining, .loading:
            OpeningState(icon: runner.app.icon, name: runner.app.name())
                .transition(.opacity)
        case .failed(let failure):
            StateCard(
                symbol: "exclamationmark.triangle",
                tint: Palette.warning,
                title: Text(verbatim: runner.app.name()),
                message: failureText(failure),
                primary: ("Try again", {
                    Haptics.selection()
                    apps.retryPane(store: session)
                }),
                secondary: ("Close", { apps.closePane(leaving: false) })
            )
            .transition(.opacity)
        case .ended(let reason):
            StateCard(
                symbol: "checkmark.circle",
                tint: Palette.paperMuted,
                title: Text("\(runner.app.name()) ended"),
                message: endedText(reason),
                primary: ("Close", { apps.dismissEndedPane() }),
                secondary: nil
            )
            .transition(.opacity)
        case .ready, .left:
            EmptyView()
        }
    }

    private func failureText(_ failure: ActivityRunner.Failure) -> Text {
        switch failure {
        case .join(let code):
            switch code {
            case .full: Text("Somebody got in before you.")
            case .notAllowed: Text("You cannot join this app here.")
            case .rateLimited: Text("Too much at once. Try again in a moment.")
            case .ended: Text("This app already ended")
            default: Text("This app is not available right now.")
            }
        case .connection: Text("Could not join. Check your connection and try again.")
        case .frame: Text("The app stopped responding. Try again.")
        }
    }

    private func endedText(_ reason: AppEndReason) -> Text {
        switch reason {
        case .host: Text("The host ended it.")
        case .moderator: Text("A moderator ended it.")
        case .idle: Text("It ended after a while with nobody active.")
        case .hostGone: Text("The host did not come back, so it ended.")
        case .empty: Text("The room was empty, so it ended.")
        case .maxDuration: Text("It reached the 12 hour limit.")
        case .channelGone: Text("The channel was deleted.")
        case .appDisabled, .flagOff, .operator: Text("pqp turned this app off. Your conversation stays here.")
        case .unknown: Text("It ended.")
        }
    }
}

/// The calm moment while the seat is taken and the page loads: the glyph breathes
/// (still under Reduce Motion) and one line says what is happening.
private struct OpeningState: View {
    let icon: String
    let name: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    var body: some View {
        VStack(spacing: 16) {
            ActivityGlyph(icon: icon, size: 72)
                .scaleEffect(breathing ? 1.06 : 0.96)
            Text(verbatim: name)
                .font(Typography.title(20))
                .foregroundStyle(Palette.paper)
            Text("Opening the room...")
                .font(Typography.callout)
                .foregroundStyle(Palette.paperMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.ink)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("activity.pane.opening")
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { breathing = true }
        }
    }
}

private struct StateCard: View {
    let symbol: String
    let tint: Color
    let title: Text
    let message: Text
    let primary: (LocalizedStringKey, () -> Void)
    let secondary: (LocalizedStringKey, () -> Void)?

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 38, weight: .light))
                .foregroundStyle(tint)
            title
                .font(Typography.title(21))
                .foregroundStyle(Palette.paper)
                .multilineTextAlignment(.center)
            message
                .font(Typography.callout)
                .foregroundStyle(Palette.paperMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 300)
            VStack(spacing: 10) {
                Button(action: primary.1) { Text(primary.0) }
                    .buttonStyle(PrimaryButtonStyle())
                    .accessibilityIdentifier("activity.pane.primary")
                if let secondary {
                    Button(action: secondary.1) { Text(secondary.0) }
                        .buttonStyle(SecondaryButtonStyle())
                        .accessibilityIdentifier("activity.pane.secondary")
                }
            }
            .frame(maxWidth: 260)
            .padding(.top, 6)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.ink)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("activity.pane.state")
    }
}

/// "Quem está em {app}": the seats, with the host and anybody held for the resume window marked.
struct ActivityPeopleSheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let runner: ActivityRunner

    private var seats: [AppSeatParticipant] { runner.snapshot?.participants ?? [] }

    var body: some View {
        NavigationStack {
            List {
                ForEach(seats, id: \.seatId) { seat in
                    let person = session.apps.person(seat.userId)
                    HStack(spacing: 12) {
                        Avatar(name: person?.displayName ?? "?", seed: seat.userId, size: 38, url: person?.avatarUrl)
                        Text(verbatim: person?.displayName ?? "?")
                            .font(Typography.body)
                            .foregroundStyle(Palette.paper)
                        Spacer(minLength: 0)
                        badge(seat)
                    }
                    .listRowBackground(Palette.surface)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.ink)
            .navigationTitle("Who is in \(runner.app.name())")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close") { dismiss() }.tint(Palette.signal)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Palette.ink)
        .preferredColorScheme(.dark)
    }

    @ViewBuilder
    private func badge(_ seat: AppSeatParticipant) -> some View {
        if seat.connection == .reconnecting {
            chip("Reconnecting", tint: Palette.warning)
        } else if seat.isHost {
            chip("Host", tint: Palette.signal)
        } else if seat.role == .spectator {
            chip("Watching", tint: Palette.paperMuted)
        }
    }

    private func chip(_ text: LocalizedStringKey, tint: Color) -> some View {
        Text(text)
            .font(Typography.caption)
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(tint.opacity(0.14)))
    }
}
