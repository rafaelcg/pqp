import SwiftUI

/// What entering an activity for the first time says (mock 04): what the app can
/// and cannot see of the person, and one button. The platform's two lines are
/// always there; the app adds nothing of its own on the phone. A consent on file
/// that is not stale skips this sheet (`ActivitiesChannelModel.enter`).
struct ActivityJoinSheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss

    let model: ActivitiesChannelModel
    let offer: ActivitiesChannelModel.JoinOffer
    @State private var shareId = false

    private var appName: String { offer.app.name() }
    private var me: ActivityPerson? { session.apps.viewerId.flatMap { session.apps.person($0) } }
    private var wantsId: Bool { offer.app.capabilities.identity == "user-id" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 12) {
                    ActivityGlyph(icon: offer.app.icon, size: 52)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Join \(appName)?")
                            .font(Typography.title(21))
                            .foregroundStyle(Palette.paper)
                        if !offer.startedByViewer {
                            Text("\(session.apps.name(of: offer.session.startedBy)) started it.")
                                .font(Typography.callout)
                                .foregroundStyle(Palette.paperMuted)
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel(text: "How you appear")
                    HStack(spacing: 12) {
                        Avatar(name: me?.displayName ?? "?", seed: me?.userId ?? "?", size: 40, url: me?.avatarUrl)
                        Text("Your display name and photo")
                            .font(Typography.body)
                            .foregroundStyle(Palette.paper)
                        Spacer(minLength: 0)
                    }
                    .padding(12)
                    .pqpSurface()
                }

                line("eye", lead: "The app sees", text: "your display name and photo. Anyone in the app sees them too.")
                line("eye.slash", lead: "The app does not see", text: "your email, your pqp id, your conversations or the rest of pqp.")
                if offer.app.capabilities.deviceStoreAllowed {
                    line("internaldrive", lead: "Keeps things on this device", text: "saves and preferences stay here only. pqp does not read or send them.")
                }

                Text("The app runs in an isolated box, with no access to your account, your cookies or the internet.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                    .fixedSize(horizontal: false, vertical: true)

                if wantsId {
                    Toggle(isOn: $shareId) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Let this app see my pqp id")
                                .font(Typography.bodyMedium)
                                .foregroundStyle(Palette.paper)
                            Text("To keep your score between sessions. You can turn it off later in Settings. Unchecked, you join the same way, without saving.")
                                .font(Typography.caption)
                                .foregroundStyle(Palette.paperMuted)
                        }
                    }
                    .tint(Palette.signal)
                }

                if model.enterFailed {
                    Text("Could not join. Check your connection and try again.")
                        .font(Typography.callout)
                        .foregroundStyle(Palette.danger)
                        .accessibilityIdentifier("activity.join.error")
                }

                VStack(spacing: 10) {
                    Button {
                        Task { await model.accept(offer, identityGranted: shareId, session: session) }
                    } label: {
                        ZStack {
                            Text(model.enterFailed ? "Try again" : "Join").opacity(model.entering ? 0 : 1)
                            if model.entering { ProgressView().tint(Palette.inkDeep) }
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle(isEnabled: !model.entering))
                    .disabled(model.entering)
                    .accessibilityIdentifier("activity.join.enter")

                    Button("Not now") {
                        model.dismissOffer()
                        dismiss()
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(model.entering)
                    .accessibilityIdentifier("activity.join.cancel")
                }
                .padding(.top, 4)
            }
            .padding(.horizontal, Metrics.hPadding)
            .padding(.top, 22)
            .padding(.bottom, 24)
        }
        .background(Palette.ink)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Palette.ink)
        .interactiveDismissDisabled(model.entering)
        .accessibilityIdentifier("activity.join")
    }

    private func line(_ symbol: String, lead: LocalizedStringKey, text: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Palette.paperMuted)
                .frame(width: 24)
                .padding(.top, 1)
            (Text(lead).fontWeight(.semibold).foregroundStyle(Palette.paper)
                + Text(verbatim: " ")
                + Text(text).foregroundStyle(Palette.paperSubtle))
                .font(Typography.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
