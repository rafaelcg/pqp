import SwiftUI

/// The three things a new account has not done yet, offered at the top of the hub.
///
/// WHY IT IS HERE AND NOT A TOUR. iOS onboarding is three marketing beats and a
/// sign-in — it never asks for a handle, a face, or a friend, and it ends by
/// dropping somebody on a hub with two cards on it. Those two cards are good, but
/// between them they cover one and a half of the three things that make the app
/// work: `Create a server` is real, `Start a conversation` opens a sheet whose
/// suggestions are friends-only and therefore opens on nothing, and the avatar is
/// three taps behind a dock pill that says nothing about it.
///
/// So this is three errands with buttons, at the top of the screen the errands get
/// done on, and one tap to be rid of forever — not a modal sequence over an app
/// nobody has a reason to be in yet.
///
/// The done rows stay put and lose their buttons rather than vanishing: a row that
/// disappears on completion re-lays the card out under the thumb that just tapped
/// it. When the third one ticks the whole card goes, and that is the only
/// disappearance worth animating.
struct FirstRunCard: View {
    let state: FirstRunState
    let tag: String?
    let onCreateServer: () -> Void
    let onAddFriend: () -> Void
    let onPickAvatar: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                Text("Three things and this place works")
                    .font(Typography.title(18))
                    .foregroundStyle(Palette.paper)
                    .fixedSize(horizontal: false, vertical: true)

                Spacer(minLength: 8)

                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Palette.paperMuted)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("firstRun.dismiss")
                .accessibilityLabel("Hide this")
            }

            ForEach(state.tasks, id: \.task.id) { entry in
                row(for: entry.task, done: entry.done)
            }
        }
        .padding(16)
        .pqpSurface()
        .padding(.horizontal, Metrics.hPadding)
        .accessibilityIdentifier("firstRun.card")
    }

    @ViewBuilder
    private func row(for task: FirstRunTask, done: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: done ? "checkmark" : icon(for: task))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(done ? Palette.success : Palette.signal)
                .frame(width: 28, height: 28)
                .background(
                    Circle().fill(
                        done
                            ? Palette.success.opacity(0.15)
                            : Palette.inkDeep
                    )
                )
                .overlay(
                    Circle().strokeBorder(
                        done ? Palette.success.opacity(0.4) : Palette.border,
                        lineWidth: 1
                    )
                )

            VStack(alignment: .leading, spacing: 4) {
                Text(title(for: task))
                    .font(Typography.bodyMedium)
                    .foregroundStyle(done ? Palette.paperMuted : Palette.paper)
                    .strikethrough(done, color: Palette.paperMuted)
                    .fixedSize(horizontal: false, vertical: true)

                if done {
                    // No sales pitch for something already done, and no praise
                    // for it either. One quiet word that the row is settled.
                    Text("Done")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                } else {
                    body(for: task)
                        .font(Typography.callout)
                        .foregroundStyle(Palette.paperMuted)
                        .fixedSize(horizontal: false, vertical: true)

                    Button(action: action(for: task)) {
                        Text(actionTitle(for: task))
                            .font(Typography.caption)
                            .foregroundStyle(Palette.inkDeep)
                            .padding(.horizontal, 12)
                            .frame(height: 32)
                            .background(
                                RoundedRectangle(
                                    cornerRadius: Metrics.cornerRadiusSmall,
                                    style: .continuous
                                )
                                .fill(Palette.signal)
                            )
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 2)
                    .accessibilityIdentifier("firstRun.action.\(task.rawValue)")
                }
            }

            Spacer(minLength: 0)
        }
        .accessibilityIdentifier("firstRun.task.\(task.rawValue)")
        .accessibilityValue(done ? Text("Done") : Text("Not done"))
    }

    private func icon(for task: FirstRunTask) -> String {
        switch task {
        case .server: "plus.circle"
        case .friend: "person.badge.plus"
        case .avatar: "person.crop.circle.badge.plus"
        }
    }

    // Written as the thing you get, not the chore you do — the same register the
    // web catalogue uses, and the reason none of these say "Set up your profile".
    private func title(for task: FirstRunTask) -> LocalizedStringKey {
        switch task {
        case .server: "Get into a server"
        case .friend: "Find your people"
        case .avatar: "Put a face on it"
        }
    }

    @ViewBuilder
    private func body(for task: FirstRunTask) -> some View {
        switch task {
        case .server:
            Text("Make one for your people. Invites open on this app too.")
        case .friend:
            // Prints the reader's own handle, because "add someone by their
            // handle" is useless advice until you know that you have one and
            // what it is — and iOS never tells anybody, outside a dock subtitle
            // nobody reads as an identifier.
            if let tag {
                Text("Add someone by their handle. Yours is \(tag) — hand it out.")
            } else {
                Text("Add someone by their handle.")
            }
        case .avatar:
            Text("A letter in a box works. A photo works better.")
        }
    }

    private func actionTitle(for task: FirstRunTask) -> LocalizedStringKey {
        switch task {
        case .server: "Make a server"
        case .friend: "Add a friend"
        case .avatar: "Pick an avatar"
        }
    }

    private func action(for task: FirstRunTask) -> () -> Void {
        switch task {
        case .server: onCreateServer
        case .friend: onAddFriend
        case .avatar: onPickAvatar
        }
    }
}
