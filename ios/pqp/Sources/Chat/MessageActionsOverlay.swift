import SwiftUI
import UIKit

/// The long-press menu for a message.
///
/// Deliberately NOT a `.contextMenu`. SwiftUI lays a context menu out as a
/// vertical list and treats a `ControlGroup` of six emoji as "as many as fit,
/// then one per row" — which produced a four-up row followed by 🎉 alone and 👀
/// alone, a broken grid nobody designed. The row of quick reactions is the most
/// used thing in the whole menu, so it is worth owning the layout: here it is
/// one row, equal spacing, with a tail that opens the full picker.
///
/// The rest is a plain action list, in frequency order — react, reply, thread,
/// copy, pin, then the destructive tail. Native feel comes from the details:
/// a blur backdrop, a spring, haptics fired by the caller on the press, and
/// tap-outside-to-dismiss.
struct MessageActionsOverlay: View {
    let message: Message
    let quickReactions: [String]
    let canStartThreads: Bool
    /// Gates EDITING only. Rewriting somebody else's words is not moderation at
    /// any rank; removing them is, which is why deleting has its own flag.
    let isMine: Bool
    /// Your own message, or anybody's when you manage the server it is in —
    /// `Moderation.canDelete`. Defaulted to `isMine`'s old behaviour so a caller
    /// that has no server to reason about keeps it.
    var canDelete: Bool
    /// Free in a conversation, manager-only in a server channel —
    /// `Moderation.canPin`. It used to be offered to everybody, which meant a
    /// plain member tapped Pin and got a 403 back.
    var canPin: Bool
    /// Reporting your own message makes no sense, and neither does reporting a
    /// webhook — there is nobody to sanction.
    let canReport: Bool

    var onReact: (String) -> Void
    var onMoreReactions: () -> Void
    var onReply: () -> Void
    var onOpenThread: () -> Void
    var onCopy: () -> Void
    var onTogglePin: () -> Void
    var onReport: () -> Void
    var onEdit: () -> Void
    var onDelete: () -> Void
    var onDismiss: () -> Void

    /// The menu opens *during* a press that has not ended yet, so the finger is
    /// still down on what is now the backdrop. Without this the lift reads as
    /// "tap outside" and the menu closes the instant it appears — which is
    /// exactly what a long press feels like when you hold it a beat too long.
    @State private var armed = false

    /// Which reactions are already ours, so the row can show them as active
    /// rather than making you remember what you tapped.
    private func isReacted(_ emoji: String) -> Bool {
        message.reactions.contains { $0.emoji == emoji && $0.me }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            // The backdrop is blurred rather than merely dimmed: the transcript
            // stays legible as context without competing with the menu.
            Rectangle()
                .fill(.ultraThinMaterial)
                .ignoresSafeArea()
                .onTapGesture { if armed { onDismiss() } }
                .accessibilityIdentifier("messageActions.backdrop")
                .accessibilityLabel("Close menu")
                .accessibilityAddTraits(.isButton)

            VStack(spacing: 10) {
                reactionBar
                actionList
            }
            .padding(.horizontal, Metrics.hPadding)
            .padding(.bottom, 10)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
        .task {
            // Long enough to outlast the lift of the press that opened this,
            // short enough that a deliberate tap-outside still feels immediate.
            try? await Task.sleep(for: .milliseconds(450))
            armed = true
        }
    }

    // MARK: - Reactions

    private var reactionBar: some View {
        HStack(spacing: 0) {
            ForEach(Array(quickReactions.enumerated()), id: \.element) { index, emoji in
                Button {
                    onReact(emoji)
                    onDismiss()
                } label: {
                    Text(emoji)
                        .font(.system(size: 27))
                        // Equal shares of the row, which is what makes six
                        // emoji a row rather than a ragged grid.
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(
                            Circle()
                                .fill(isReacted(emoji) ? Palette.signal.opacity(0.18) : .clear)
                                .frame(width: 42, height: 42)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("messageActions.quick\(index)")
                .accessibilityLabel(Text("React \(emoji)"))
            }

            // The tail into the full picker. A separator so it reads as "and
            // everything else" rather than as a seventh reaction.
            Rectangle()
                .fill(Palette.border)
                .frame(width: 1, height: 26)
                .padding(.horizontal, 2)

            Button {
                onMoreReactions()
                onDismiss()
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Palette.paperMuted)
                    .frame(width: 46, height: 48)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("messageActions.moreReactions")
            .accessibilityLabel("More reactions")
        }
        .padding(.horizontal, 6)
        .background(
            Capsule(style: .continuous).fill(Palette.surfaceRaised)
        )
        .overlay(
            Capsule(style: .continuous).strokeBorder(Palette.border, lineWidth: 1)
        )
    }

    // MARK: - Actions

    private var actionList: some View {
        VStack(spacing: 0) {
            row("Reply", icon: "arrowshape.turn.up.left") {
                onReply()
                onDismiss()
            }

            if canStartThreads {
                divider
                // Start or open — the server route is idempotent, so both are
                // the same tap and the label only says which one it will be.
                row(message.thread == nil ? "Start thread" : "Open thread",
                    icon: "bubble.left.and.text.bubble.right") {
                    onOpenThread()
                    onDismiss()
                }
            }

            divider
            row("Copy text", icon: "doc.on.doc") {
                onCopy()
                onDismiss()
            }

            if canPin {
                divider
                row(message.pinnedAt == nil ? "Pin" : "Unpin",
                    icon: message.pinnedAt == nil ? "pin" : "pin.slash") {
                    onTogglePin()
                    onDismiss()
                }
            }

            if isMine {
                divider
                row("Edit", icon: "pencil") {
                    onEdit()
                    onDismiss()
                }
            }

            if canDelete {
                divider
                // "Delete" whoever wrote it: a moderator removing a post is the
                // same operation as an author retracting one, and the server
                // treats it as one route. The confirmation the caller shows is
                // what distinguishes them for the person tapping.
                row("Delete", icon: "trash", tint: Palette.danger) {
                    onDelete()
                    onDismiss()
                }
            }

            if canReport {
                divider
                row("Report", icon: "flag", tint: Palette.danger) {
                    onReport()
                    onDismiss()
                }
            }
        }
        .pqpSurface(cornerRadius: Metrics.cornerRadius)
    }

    private var divider: some View {
        Rectangle()
            .fill(Palette.border)
            .frame(height: 1)
            .padding(.leading, 46)
    }

    private func row(
        _ title: LocalizedStringKey,
        icon: String,
        tint: Color = Palette.paper,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 15))
                    .frame(width: 22)
                Text(title)
                    .font(Typography.body)
                Spacer(minLength: 0)
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 12)
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The one place the app asks for a tap-feedback tick, so "which generator,
/// which style" has a single answer. A long press that opens a menu gets the
/// same weight iOS gives its own context menus.
enum Haptics {
    static func menuOpened() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    static func selection() {
        UISelectionFeedbackGenerator().selectionChanged()
    }
}
