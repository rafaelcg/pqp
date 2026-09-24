import SwiftUI

/// The three things a new account has not done yet, offered at the top of the hub.
///
/// WHERE IT SITS NEXT TO THE WIZARD. First run V2 (`FirstRunFlowView`) asks for
/// the name, the face and the room up front, and it can be skipped from its
/// first real screen. This card is where somebody who skipped picks up: the
/// same three doors into a room (make one, bring it from Discord, use an
/// invite), a friend, and a picture, one tap to be rid of forever.
///
/// The done rows stay put and lose their buttons rather than vanishing: a row that
/// disappears on completion re-lays the card out under the thumb that just tapped
/// it. When the third one ticks the whole card goes, and that is the only
/// disappearance worth animating.
struct FirstRunCard: View {
    let state: FirstRunState
    let tag: String?
    let onCreateServer: () -> Void
    /// The Discord door, the same one the wizard's room step has.
    var onImportDiscord: (() -> Void)?
    /// "Use an invite": the hub's paste-a-code prompt.
    var onJoinInvite: (() -> Void)?
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

                    if task == .server {
                        // Three ways into a room, the wizard's three doors.
                        // Wraps to a column when large text will not fit a row.
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 8) { serverActions }
                            VStack(alignment: .leading, spacing: 8) { serverActions }
                        }
                        .padding(.top, 2)
                    } else {
                        actionButton(actionTitle(for: task), primary: true, action: action(for: task))
                            .padding(.top, 2)
                            .accessibilityIdentifier("firstRun.action.\(task.rawValue)")
                    }
                }
            }

            Spacer(minLength: 0)
        }
        .accessibilityIdentifier("firstRun.task.\(task.rawValue)")
        .accessibilityValue(done ? Text("Done") : Text("Not done"))
    }

    @ViewBuilder
    private var serverActions: some View {
        actionButton("Make one", primary: true, action: onCreateServer)
            .accessibilityIdentifier("firstRun.action.server")
        if let onImportDiscord {
            actionButton("Bring it from Discord", primary: false, action: onImportDiscord)
                .accessibilityIdentifier("firstRun.action.discord")
        }
        if let onJoinInvite {
            actionButton("Use an invite", primary: false, action: onJoinInvite)
                .accessibilityIdentifier("firstRun.action.invite")
        }
    }

    private func actionButton(
        _ title: LocalizedStringKey,
        primary: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(title)
                .font(Typography.caption)
                .foregroundStyle(primary ? Palette.inkDeep : Palette.paper)
                .lineLimit(1)
                .padding(.horizontal, 12)
                .frame(height: 32)
                .background(
                    RoundedRectangle(
                        cornerRadius: Metrics.cornerRadiusSmall,
                        style: .continuous
                    )
                    .fill(primary ? Palette.signal : Palette.surfaceRaised)
                )
        }
        .buttonStyle(.plain)
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
        case .server: "Get into a community"
        case .friend: "Find your people"
        case .avatar: "Put a face on it"
        }
    }

    @ViewBuilder
    private func body(for task: FirstRunTask) -> some View {
        switch task {
        case .server:
            Text("Make one, bring it from Discord, or paste an invite.")
        case .friend:
            // Prints the reader's own handle, because "add someone by their
            // handle" is useless advice until you know that you have one and
            // what it is — and iOS never tells anybody, outside a dock subtitle
            // nobody reads as an identifier.
            if let tag {
                Text("Add someone by their handle. Yours is \(tag), hand it out.")
            } else {
                Text("Add someone by their handle.")
            }
        case .avatar:
            Text("A letter in a box works. A photo works better.")
        }
    }

    private func actionTitle(for task: FirstRunTask) -> LocalizedStringKey {
        switch task {
        case .server: "Make a community"
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
