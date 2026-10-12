import SwiftUI

// The pieces of a forum card (UX §2.3, phone mock 07): status badges that are
// never truncated, the title, "author: start of the question", tags on the
// left and the numbers on the right, and a thumbnail when the question has a
// picture. Every card has the same rhythm so the eye can run down the right
// column for numbers.

// MARK: - Time

/// "4 min", "2 h", "3 d", then a date. Shorter than the system's relative
/// style ("4 minutes ago"), which does not fit a card's number column.
enum ForumTime {
    static func short(_ date: Date, now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<60:
            return String(localized: "now")
        case ..<3600:
            return String(localized: "\(Int(seconds / 60)) min")
        case ..<86_400:
            return String(localized: "\(Int(seconds / 3600)) h")
        case ..<(7 * 86_400):
            return String(localized: "\(Int(seconds / 86_400)) d")
        default:
            return date.formatted(.dateTime.day().month(.abbreviated))
        }
    }
}

// MARK: - Badges

/// The four statuses a card can carry, in the order they are drawn.
enum ForumBadgeKind: Hashable {
    case new
    case resolved
    case locked
    case pinned
    case feed

    var title: LocalizedStringKey {
        switch self {
        case .new: "NEW"
        case .resolved: "RESOLVED"
        case .locked: "CLOSED"
        case .pinned: "PINNED"
        case .feed: "FEED"
        }
    }

    var icon: String? {
        switch self {
        case .resolved: "checkmark.circle"
        case .locked: "lock.fill"
        default: nil
        }
    }

    var foreground: Color {
        switch self {
        case .new: Palette.inkDeep
        case .resolved: Palette.success
        case .locked: Palette.paperMuted
        case .pinned, .feed: Palette.signal
        }
    }

    var background: Color {
        switch self {
        case .new: Palette.signal
        case .resolved: Palette.success.opacity(0.16)
        case .locked: Palette.surfaceRaised
        case .pinned, .feed: Palette.signal.opacity(0.14)
        }
    }
}

/// 18 pt, uppercase, never truncated: on Discord the Solved tag hides behind
/// "+1", and the status is the first thing a reader is looking for.
struct ForumBadge: View {
    let kind: ForumBadgeKind

    var body: some View {
        HStack(spacing: 3) {
            if let icon = kind.icon {
                Image(systemName: icon)
                    .font(.system(size: 8, weight: .bold))
            }
            Text(kind.title)
                .font(.system(size: 10, weight: .bold))
                .tracking(0.5)
        }
        .foregroundStyle(kind.foreground)
        .padding(.horizontal, 5)
        .frame(height: 18)
        .background(kind.background, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
        .fixedSize()
    }
}

// MARK: - Tags

/// A tag on a card. A staff-only tag carries an inner ring so it reads as
/// official.
struct ForumTagChip: View {
    let tag: ForumTag
    var compact = true

    var body: some View {
        HStack(spacing: 4) {
            if let emoji = tag.emoji, !emoji.isEmpty {
                Text(verbatim: emoji).font(.system(size: compact ? 10 : 12))
            }
            Text(verbatim: tag.name)
                .font(.system(size: compact ? 11 : 13, weight: .medium))
                .lineLimit(1)
        }
        .foregroundStyle(Palette.paperSubtle)
        .padding(.horizontal, compact ? 7 : 10)
        .frame(height: compact ? 20 : 28)
        .background(Capsule().fill(Palette.surfaceRaised))
        .overlay {
            if tag.moderated {
                Capsule().strokeBorder(Palette.border, lineWidth: 1)
            }
        }
        .fixedSize()
    }
}

/// Up to `limit` chips, then "+N". The status badges are never part of this
/// row, so collapsing tags never hides whether a post is solved.
struct ForumTagRow: View {
    let tags: [ForumTag]
    var limit = 2

    var body: some View {
        HStack(spacing: 4) {
            ForEach(tags.prefix(limit)) { tag in
                ForumTagChip(tag: tag)
            }
            if tags.count > limit {
                Text(verbatim: "+\(tags.count - limit)")
                    .font(.system(size: 11, weight: .medium).monospacedDigit())
                    .foregroundStyle(Palette.paperMuted)
                    .padding(.horizontal, 6)
                    .frame(height: 20)
                    .background(Capsule().fill(Palette.surfaceRaised))
            }
        }
    }
}

// MARK: - Card

struct ForumPostCard: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let post: ForumPostSummary
    let unread: ForumUnreadState
    let tags: [ForumTag]

    private var isUnread: Bool {
        if case .unread = unread { return true }
        return unread == .new
    }

    private var newReplies: Int {
        if case .unread(let count) = unread { return count }
        return 0
    }

    private var badges: [ForumBadgeKind] {
        var list: [ForumBadgeKind] = []
        if unread == .new { list.append(.new) }
        if post.isResolved { list.append(.resolved) }
        if post.isLocked { list.append(.locked) }
        if post.isPinned { list.append(.pinned) }
        if post.authorIsWebhook { list.append(.feed) }
        return list
    }

    private var authorName: String {
        post.authorName ?? String(localized: "Deleted account")
    }

    private var previewText: String { Self.previewText(for: post) }

    /// The second line when the opening message has no words of its own.
    static func previewText(for post: ForumPostSummary) -> String {
        if post.openingDeleted { return String(localized: "The original message was deleted") }
        if let preview = post.preview, !preview.isEmpty { return preview }
        switch post.openingKind {
        case "voice": return String(localized: "Voice message")
        case "attachment":
            // One picture or one clip says what it is; several say how many.
            if post.attachmentCount == 1, post.thumbnailUrl != nil {
                return String(localized: "📷 Image")
            }
            if post.attachmentCount == 1, post.thumbnailVideoUrl != nil {
                return String(localized: "🎬 Video")
            }
            return post.attachmentCount == 1
                ? String(localized: "1 attachment")
                : String(localized: "\(post.attachmentCount) attachments")
        default: return ""
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                if !badges.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(badges, id: \.self) { ForumBadge(kind: $0) }
                    }
                }
                Text(verbatim: post.title)
                    .font(.system(size: 16, weight: isUnread ? .bold : .semibold))
                    .foregroundStyle(isUnread ? Palette.paper : Palette.paperSubtle)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                preview
                meta
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let url = Avatar.resolve(post.thumbnailUrl) {
                ForumThumbnail(url: url)
            } else if let video = Avatar.resolve(post.thumbnailVideoUrl) {
                ForumThumbnail(url: video, isVideo: true)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                .fill(Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                .strokeBorder(Palette.border, lineWidth: 1)
        )
        .overlay(alignment: .leading) {
            if isUnread {
                // The sidebar's pip, on the card's own edge.
                Capsule()
                    .fill(Palette.paper)
                    .frame(width: 4, height: 18)
                    .offset(x: -2)
                    .transition(.scale(scale: 0.2).combined(with: .opacity))
            }
        }
        .animation(.channelList(reduceMotion: reduceMotion), value: unread)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(accessibilityText))
        .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder
    private var preview: some View {
        let text = previewText
        if !text.isEmpty {
            (Text(verbatim: "\(authorName): ").foregroundStyle(Palette.paperSubtle).fontWeight(.semibold)
             + Text(verbatim: text).foregroundStyle(Palette.paperMuted).italic(post.openingDeleted))
                .font(.system(size: 14))
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Text(verbatim: authorName)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Palette.paperSubtle)
        }
    }

    private var meta: some View {
        HStack(spacing: 8) {
            ForumTagRow(tags: tags)
            Spacer(minLength: 4)
            HStack(spacing: 8) {
                if let top = post.topReaction {
                    HStack(spacing: 2) {
                        Text(verbatim: top.emoji).font(.system(size: 11))
                        Text(verbatim: "\(top.count)")
                    }
                }
                if post.replyCount == 0 {
                    Text("No replies")
                } else {
                    HStack(spacing: 3) {
                        Image(systemName: "bubble.left")
                            .font(.system(size: 10, weight: .semibold))
                        Text(verbatim: "\(post.replyCount)")
                    }
                }
                if newReplies > 0 {
                    Text(verbatim: "+\(min(newReplies, ForumLimits.unreadCap))")
                        .fontWeight(.bold)
                        .foregroundStyle(Palette.signal)
                }
                Text(verbatim: ForumTime.short(post.lastActivityAt))
            }
            .font(.system(size: 12, weight: .medium).monospacedDigit())
            .foregroundStyle(Palette.paperMuted)
            .lineLimit(1)
            .fixedSize()
        }
    }

    /// "{title}, {status}, por {author}, {replies}, {time}", plus "novo" or the
    /// new-reply count, so colour is never the only signal.
    private var accessibilityText: String {
        var parts = [post.title]
        if post.isResolved { parts.append(String(localized: "Resolved")) }
        if post.isLocked { parts.append(String(localized: "Closed")) }
        if post.isPinned { parts.append(String(localized: "Pinned")) }
        parts.append(String(localized: "by \(authorName)"))
        parts.append(post.replyCount == 0
                     ? String(localized: "No replies")
                     : String(localized: "\(post.replyCount) replies"))
        parts.append(ForumTime.short(post.lastActivityAt))
        if unread == .new { parts.append(String(localized: "new")) }
        if newReplies > 0 { parts.append(String(localized: "\(newReplies) new replies")) }
        return parts.joined(separator: ", ")
    }
}

/// The first image of the question, 56 pt on a phone, with a hairline so a
/// dark screenshot does not melt into the card. A video post (`isVideo`) draws
/// the clip's first frame instead, under a small play badge, like the web card.
struct ForumThumbnail: View {
    let url: URL
    var size: CGFloat = 56
    var isVideo = false

    var body: some View {
        Group {
            if isVideo {
                ZStack {
                    Palette.surfaceRaised
                    // 3x the side: sharp on a 3x screen without a full-size decode.
                    BauVideoFrame(url: url, maxSide: size * 3)
                    Image(systemName: "play.fill")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.white)
                        .offset(x: 0.5)
                        .frame(width: 22, height: 22)
                        .background(Circle().fill(Color.black.opacity(0.55)))
                }
            } else {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        Palette.surfaceRaised
                    }
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                .strokeBorder(Palette.paper.opacity(0.08), lineWidth: 1)
        )
        .accessibilityHidden(true)
    }
}

/// A pinned post: one compact line under "Fixados", the way the phone mock
/// draws it. Pins are guidelines and announcements; they do not need a card.
struct ForumPinnedRow: View {
    let post: ForumPostSummary
    let unread: ForumUnreadState

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "pin.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Palette.signal)
                .frame(width: 24, height: 24)
                .background(Palette.signal.opacity(0.14), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            Text(verbatim: post.title)
                .font(.system(size: 15, weight: unread == .read ? .medium : .bold))
                .foregroundStyle(unread == .read ? Palette.paperSubtle : Palette.paper)
                .lineLimit(1)
            Spacer(minLength: 4)
            if post.isLocked {
                Image(systemName: "lock.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.paperMuted)
                    .accessibilityLabel(Text("Closed"))
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 48)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                .fill(Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                .strokeBorder(Palette.border, lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

/// Pressed cards lift to the raised surface, like every row in the app.
struct ForumCardButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        PressedLift(isPressed: configuration.isPressed) { configuration.label }
    }

    /// A view so it can read Reduce Motion, which a style cannot: the press
    /// still brightens, it just does not move.
    private struct PressedLift<Label: View>: View {
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        let isPressed: Bool
        @ViewBuilder let label: () -> Label

        var body: some View {
            label()
                .brightness(isPressed ? 0.04 : 0)
                .scaleEffect(isPressed && !reduceMotion ? 0.985 : 1)
                .animation(reduceMotion ? nil : Motion.press, value: isPressed)
                .contentShape(Rectangle())
        }
    }
}
