import SwiftUI

// The Baú at the top of the channel list (option M2): a card with the newest
// post while there is something new, shrinking to a slim row with a thumbnail
// once it has been seen. The staff post a few times a week, so the card only
// takes space while there is a reason to look. Data: `BauPreviewMode`.

struct BauPreview: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let mode: BauPreviewMode
    /// Staff, on an empty Baú: opens the composer.
    var onCompose: () -> Void = {}

    var body: some View {
        Group {
            switch mode {
            case .loading:
                BauRow(unread: 0)
            case .legacy(let unread):
                BauRow(unread: unread)
            case .fresh(let lead, let moreNew, let next):
                BauFreshCard(lead: lead, moreNew: moreNew, next: next)
                    .transition(.opacity.combined(with: .scale(scale: 0.97, anchor: .top)))
            case .seen(let post, let unread):
                BauSeenRow(post: post, unread: unread)
                    .transition(.opacity)
            case .empty(let canPost):
                if canPost {
                    BauEmptyStaffCard(onCompose: onCompose)
                } else {
                    BauEmptyRow()
                }
            }
        }
        .animation(.channelList(reduceMotion: reduceMotion), value: mode)
    }
}

/// Today's row, kept for an API without `/home/latest`.
struct BauRow: View {
    /// Posts not yet seen. Lime like a mention: the feature the product leads
    /// with should not be the quietest row in the list.
    var unread: Int = 0

    var body: some View {
        HStack(spacing: 12) {
            BauGlyph()
            VStack(alignment: .leading, spacing: 2) {
                Text("Baú")
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                    .lineLimit(1)
                Text("Posts that stay. Not chat.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                    .lineLimit(1)
            }
            Spacer()
            if unread > 0 {
                UnreadBadge(count: unread, isMention: true)
            }
            chevron
        }
        .padding(.horizontal, 10)
        .frame(height: 56)
    }
}

// MARK: - Fresh: the card

private struct BauFreshCard: View {
    let lead: CommunityHomeLatestPost
    let moreNew: Int
    let next: CommunityHomeLatestPost?

    private var title: String { bauTitle(lead.card) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            HStack(alignment: .top, spacing: 12) {
                BauThumbnail(post: lead, width: 112, height: 72, playSize: 24)
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Palette.paper)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    BauByline(post: lead, size: 16)
                    HStack(spacing: 12) {
                        counter("heart", lead.card.likeCount)
                        counter("bubble.right", lead.card.commentCount)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 12)

            if moreNew > 0 {
                Divider().overlay(Palette.border)
                footer
            }
        }
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                .fill(Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                .strokeBorder(Palette.border, lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("Baú, new post: \(title)"))
        .accessibilityAddTraits(.isButton)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "archivebox")
                .font(.system(size: 12, weight: .semibold))
            Text("Baú")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Palette.paper)
            Text("NEW")
                .font(.system(size: 10, weight: .heavy))
                .tracking(0.6)
                .foregroundStyle(Palette.inkDeep)
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(RoundedRectangle(cornerRadius: 4).fill(Palette.signal))
            Spacer()
            Text("Open")
                .font(.system(size: 13))
            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold))
        }
        .foregroundStyle(Palette.paperMuted)
        .padding(.horizontal, 12)
        .frame(height: 36)
    }

    private var footer: some View {
        HStack(spacing: 8) {
            if let next {
                BauThumbnail(post: next, width: 22, height: 22, playSize: 0)
            }
            Group {
                if moreNew == 1, let next {
                    Text("+1 new post: \(bauTitle(next.card))")
                } else {
                    Text("+\(moreNew) new posts")
                }
            }
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Palette.paperSubtle)
            .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
    }

    private func counter(_ symbol: String, _ count: Int) -> some View {
        HStack(spacing: 3) {
            Image(systemName: symbol)
            Text(verbatim: "\(count)")
        }
        .font(.system(size: 12, weight: .medium).monospacedDigit())
        .foregroundStyle(Palette.paperMuted)
    }
}

// MARK: - Seen: the slim row

private struct BauSeenRow: View {
    let post: CommunityHomeLatestPost
    var unread: Int = 0

    var body: some View {
        HStack(spacing: 12) {
            BauThumbnail(post: post, width: 40, height: 40, playSize: 16)
                .overlay(alignment: .topTrailing) {
                    if unread > 0 {
                        UnreadBadge(count: unread, isMention: true)
                            .scaleEffect(0.8)
                            .offset(x: 8, y: -8)
                    }
                }
            VStack(alignment: .leading, spacing: 2) {
                Text("Baú")
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                    .lineLimit(1)
                Group {
                    if let author = post.card.author?.displayName {
                        Text("Latest: \"\(bauTitle(post.card))\" · \(author)")
                    } else {
                        Text("Latest: \"\(bauTitle(post.card))\"")
                    }
                }
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
                .lineLimit(1)
            }
            Spacer(minLength: 8)
            chevron
        }
        .padding(.horizontal, 10)
        .frame(height: 56)
    }
}

// MARK: - Empty

private struct BauEmptyStaffCard: View {
    let onCompose: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                BauGlyph(tint: Palette.signal)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Your Baú is empty")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Palette.paper)
                    Text("Post the first clip, screenshot or announcement. Here it does not get lost in the chat.")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                    .strokeBorder(Palette.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            )

            Button(action: onCompose) {
                Label("Post to the Baú", systemImage: "square.and.pencil")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.inkDeep)
                    .padding(.horizontal, 12)
                    .frame(height: 30)
                    .background(Capsule().fill(Palette.signal))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("channels.bau.compose")
        }
    }
}

private struct BauEmptyRow: View {
    var body: some View {
        HStack(spacing: 12) {
            BauGlyph()
            VStack(alignment: .leading, spacing: 2) {
                Text("Baú")
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                Text("Still empty. When the staff posts, it shows up here.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            chevron
        }
        .padding(.horizontal, 10)
        .frame(height: 56)
    }
}

// MARK: - Pieces

private var chevron: some View {
    Image(systemName: "chevron.right")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(Palette.paperMuted)
}

private func bauTitle(_ card: CommunityHomePostCard) -> String {
    let trimmed = card.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !trimmed.isEmpty { return trimmed }
    let teaser = card.teaser?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return teaser.isEmpty ? String(localized: "New in the Baú") : teaser
}

private struct BauGlyph: View {
    var tint: Color = Palette.paperMuted

    var body: some View {
        Image(systemName: "archivebox")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: 40, height: 40)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                    .fill(Palette.surfaceRaised)
            )
    }
}

/// Who posted and when: "Bia · há 5 min". A locked post has no author.
private struct BauByline: View {
    let post: CommunityHomeLatestPost
    var size: CGFloat = 16

    var body: some View {
        HStack(spacing: 6) {
            if let author = post.card.author {
                Avatar(name: author.displayName, seed: author.id, size: size, url: author.avatarUrl)
                Text(verbatim: author.displayName)
                    .lineLimit(1)
            }
            if let date = post.publishedDate {
                if post.card.author != nil { Text(verbatim: "·") }
                Text(date, format: .relative(presentation: .named, unitsStyle: .abbreviated))
                    .lineLimit(1)
            }
        }
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(Palette.paperMuted)
    }
}

/// The post's picture, cropped to a box. An image or a chosen cover is
/// fetched; everything that plays without one is a plate in the post's own
/// hue with a play badge, and a text post is the plate with no badge.
struct BauThumbnail: View {
    let post: CommunityHomeLatestPost
    let width: CGFloat
    let height: CGFloat
    /// Zero hides the play badge (the footer's tiny thumbnail).
    var playSize: CGFloat = 20

    var body: some View {
        ZStack {
            plate
            if case .image(let url) = post.thumbnail {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        Color.clear
                    }
                }
                .blur(radius: post.card.locked ? 8 : 0)
            }
            if post.card.isPlayable && !post.card.locked && playSize > 0 {
                Circle()
                    .fill(Palette.inkDeep.opacity(0.75))
                    .frame(width: playSize, height: playSize)
                    .overlay(
                        Image(systemName: "play.fill")
                            .font(.system(size: playSize * 0.4, weight: .bold))
                            .foregroundStyle(Palette.paper)
                            .offset(x: playSize * 0.04)
                    )
            }
            if post.card.locked {
                Image(systemName: "lock.fill")
                    .font(.system(size: min(14, height * 0.3), weight: .bold))
                    .foregroundStyle(Palette.paper)
            }
        }
        .frame(width: width, height: height)
        .clipShape(RoundedRectangle(cornerRadius: min(8, height / 4), style: .continuous))
        .accessibilityHidden(true)
    }

    private var plate: some View {
        let hue = Avatar.hue(seed: post.card.postId)
        return LinearGradient(
            colors: [
                Color(hue: hue, saturation: 0.45, brightness: 0.42),
                Color(hue: hue, saturation: 0.55, brightness: 0.18),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}
