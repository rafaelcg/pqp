import SwiftUI

// The parts of a forum post that a chat does not have (UX §2.4, phone mock
// 08), drawn into `ChatView` when it is showing a post: the title and its
// status above the question, the accepted answer under it, the reply count
// that separates the question from the conversation, the "Novas" divider,
// and the closed bar where the composer would be.

/// Ids the transcript scrolls to.
enum ForumScrollAnchor {
    static let header = "forum.header"
    static let divider = "forum.unread-divider"
}

// MARK: - Header

/// Title (the post's, never repeated in the bar until it scrolls away),
/// status badges first, then the tags.
struct ForumPostHeader: View {
    let model: ForumPostModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let post = model.post {
                Text(verbatim: post.title)
                    .font(Typography.title(21))
                    .foregroundStyle(Palette.paper)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("forum.post.title")

                let badges = statusBadges(post)
                if !badges.isEmpty || !model.postTags.isEmpty {
                    ForumWrap(spacing: 6) {
                        ForEach(badges, id: \.self) { ForumBadge(kind: $0) }
                        ForEach(model.postTags) { ForumTagChip(tag: $0) }
                    }
                }
            } else {
                // A deep link that has not answered yet: the shape, not a spinner.
                RoundedRectangle(cornerRadius: 6)
                    .fill(Palette.surfaceRaised)
                    .frame(width: 220, height: 22)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
        .padding(.bottom, 14)
    }

    private func statusBadges(_ post: ForumPostSummary) -> [ForumBadgeKind] {
        var list: [ForumBadgeKind] = []
        if post.isResolved { list.append(.resolved) }
        if post.isLocked { list.append(.locked) }
        if post.isPinned { list.append(.pinned) }
        if post.authorIsWebhook { list.append(.feed) }
        return list
    }
}

/// The answer, quoted under the question, so a visitor from search gets it
/// before twenty replies (UX §2.4 #25).
struct ForumSolutionCard: View {
    let answer: ForumAcceptedAnswer
    var onJump: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 5) {
                Image(systemName: "checkmark.circle")
                    .font(.system(size: 11, weight: .bold))
                Text("SOLUTION")
                    .font(.system(size: 11, weight: .bold))
                    .tracking(0.8)
            }
            .foregroundStyle(Palette.success)

            if answer.deleted {
                Text("The marked answer was deleted.")
                    .font(Typography.callout)
                    .italic()
                    .foregroundStyle(Palette.paperMuted)
            } else {
                HStack(alignment: .top, spacing: 8) {
                    Avatar(
                        name: answer.authorName ?? "?",
                        seed: answer.authorId ?? answer.messageId,
                        size: 20, url: nil
                    )
                    (Text(verbatim: "\(answer.authorName ?? String(localized: "Deleted account")) ")
                        .fontWeight(.semibold)
                        .foregroundStyle(Palette.paper)
                     + Text(verbatim: answer.excerpt ?? "")
                        .foregroundStyle(Palette.paperSubtle))
                        .font(.system(size: 14))
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Button(action: onJump) {
                    HStack(spacing: 4) {
                        Text("Go to answer")
                        Image(systemName: "arrow.down")
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.success)
                    .frame(minHeight: 32)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("forum.solution.jump")
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                .fill(Palette.success.opacity(0.12))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                .strokeBorder(Palette.success.opacity(0.35), lineWidth: 1)
        )
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
    }
}

/// "23 RESPOSTAS", between the question and the conversation.
struct ForumRepliesLabel: View {
    let count: Int

    var body: some View {
        HStack(spacing: 8) {
            Group {
                if count == 0 {
                    Text("NO REPLIES YET")
                } else if count == 1 {
                    Text("1 REPLY")
                } else {
                    Text("\(count) REPLIES")
                }
            }
            .font(Typography.label)
            .tracking(1.2)
            .foregroundStyle(Palette.paperMuted)
            .fixedSize()
            Rectangle().fill(Palette.border).frame(height: 1)
        }
        .padding(.top, 6)
        .padding(.bottom, 8)
    }
}

/// The chat's unread line, red: everything under it is new to this reader.
struct ForumUnreadDivider: View {
    var body: some View {
        HStack(spacing: 8) {
            Rectangle().fill(Palette.danger).frame(height: 1)
            // Its own key: "New" is already "Novo" elsewhere, and replies
            // are feminine ("Novas").
            Text("forum.divider.new")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(Palette.danger)
                .fixedSize()
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }
}

/// "↓ 5 novas": the first unread reply is off screen.
struct ForumJumpPill: View {
    let count: Int
    var onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.down")
                    .font(.system(size: 12, weight: .bold))
                Text(count == 1 ? String(localized: "1 new") : String(localized: "\(count) new"))
                    .font(.system(size: 14, weight: .semibold))
            }
            .foregroundStyle(Palette.inkDeep)
            .padding(.horizontal, 16)
            .frame(height: 36)
            .background(Capsule().fill(Palette.signal))
            .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("forum.jumpNew")
    }
}

/// Where the composer was, for somebody who cannot reply: say why, do not
/// just disable (UX §2.4 #27).
struct ForumLockedBar: View {
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "lock.fill")
                .font(.system(size: 12))
            Text("This post is closed. Only staff can reply.")
                .font(Typography.callout)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
        .foregroundStyle(Palette.paperMuted)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                .strokeBorder(Palette.border, style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
        )
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("forum.lockedBar")
    }
}

/// Staff in a closed post still get a composer, with this above it.
struct ForumLockedStaffNote: View {
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "lock.fill").font(.system(size: 10))
            Text("Closed post. As staff, you can still reply.")
                .font(Typography.caption)
            Spacer(minLength: 0)
        }
        .foregroundStyle(Palette.paperMuted)
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 6)
    }
}

/// The post was deleted while open. No silent close.
struct ForumRemovedState: View {
    var onBack: () -> Void

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()
            VStack(spacing: 14) {
                Image(systemName: "trash")
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(Palette.paperMuted)
                Text("This post was deleted.")
                    .font(Typography.title(20))
                    .foregroundStyle(Palette.paper)
                    .multilineTextAlignment(.center)
                Button("Back to list", action: onBack)
                    .buttonStyle(PrimaryButtonStyle())
                    .frame(maxWidth: 220)
                    .padding(.top, 4)
            }
            .padding(32)
        }
        .accessibilityIdentifier("forum.removed")
    }
}

// MARK: - Edit tags

/// "Editar tags": every tag this person may use, toggled in place, up to five.
struct ForumEditTagsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let tags: [ForumTag]
    /// Staff-only tags already on the post, which a member can see but not
    /// take off.
    let locked: Set<String>
    @State var selected: [String]
    var onSave: ([String]) -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        Text("Tags").font(Typography.bodyMedium).foregroundStyle(Palette.paper)
                        Spacer()
                        Text(verbatim: "\(selected.count)/\(ForumLimits.maxTagsPerPost)")
                            .font(Typography.caption.monospacedDigit())
                            .foregroundStyle(Palette.paperMuted)
                    }
                    ForumWrap(spacing: 8) {
                        ForEach(tags) { tag in
                            ForumTagToggle(
                                tag: tag,
                                isOn: selected.contains(tag.id),
                                isDisabled: locked.contains(tag.id)
                                    || (!selected.contains(tag.id) && selected.count >= ForumLimits.maxTagsPerPost)
                            ) {
                                if let index = selected.firstIndex(of: tag.id) {
                                    selected.remove(at: index)
                                } else if selected.count < ForumLimits.maxTagsPerPost {
                                    selected.append(tag.id)
                                }
                            }
                        }
                    }
                    if selected.count >= ForumLimits.maxTagsPerPost {
                        Text("Up to \(ForumLimits.maxTagsPerPost) tags.")
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paperMuted)
                    }
                }
                .padding(Metrics.hPadding)
            }
            .background(Palette.ink.ignoresSafeArea())
            .navigationTitle("Edit tags")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.tint(Palette.paperMuted)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(selected)
                        dismiss()
                    }
                    .tint(Palette.signal)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Palette.ink)
    }
}

/// A tag that toggles: lime and checked when on. 44 pt tall to the touch.
struct ForumTagToggle: View {
    let tag: ForumTag
    let isOn: Bool
    var isDisabled = false
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let emoji = tag.emoji, !emoji.isEmpty {
                    Text(verbatim: emoji).font(.system(size: 13))
                }
                Text(verbatim: tag.name)
                    .font(.system(size: 14, weight: .medium))
                if tag.moderated {
                    Image(systemName: "shield.lefthalf.filled")
                        .font(.system(size: 10))
                        .accessibilityLabel(Text("Only staff can add this tag."))
                }
                if isOn {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .bold))
                }
            }
            .foregroundStyle(isOn ? Palette.signal : Palette.paperSubtle)
            .padding(.horizontal, 12)
            .frame(height: 34)
            .background(Capsule().fill(isOn ? Palette.signal.opacity(0.16) : Palette.surface))
            .overlay(Capsule().strokeBorder(isOn ? Palette.signal.opacity(0.7) : Palette.border, lineWidth: 1))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled && !isOn ? 0.45 : 1)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

// MARK: - Layout

/// Chips that wrap onto as many lines as they need.
struct ForumWrap: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                y += lineHeight + spacing
                x = 0
                lineHeight = 0
            }
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var lineHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                y += lineHeight + spacing
                x = bounds.minX
                lineHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}
