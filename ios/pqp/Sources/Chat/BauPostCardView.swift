import AVFoundation
import SwiftUI

/// A Baú post pasted into chat, drawn as a card: the poster, a play badge for
/// anything that plays, the title, a two-line teaser, who wrote it, and a
/// button that opens the post inside the Baú.
///
/// The twin of `client/src/components/chat/bau-post-card.tsx`. The data is the
/// server's `…/card` answer, which runs the feed's own authorization; a reader
/// who may not see the post gets `.unavailable` and the row keeps showing the
/// plain link, so a card is never a way to learn that a post exists.
struct BauPostCardView: View {
    let card: CommunityHomePostCard
    let onOpen: () -> Void

    private var title: String {
        let trimmed = card.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? String(localized: "New in the Baú") : trimmed
    }

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 0) {
                poster
                VStack(alignment: .leading, spacing: 8) {
                    Text(title)
                        .font(Typography.title(16))
                        .foregroundStyle(Palette.paper)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    if let teaser = card.teaser, !teaser.isEmpty {
                        Text(teaser)
                            .font(Typography.callout)
                            .foregroundStyle(Palette.paperMuted)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    byline
                    openButton
                }
                .padding(12)
            }
            .frame(maxWidth: 380, alignment: .leading)
            .background(Palette.surface)
            .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                    .strokeBorder(Palette.border, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous))
        }
        .buttonStyle(.plain)
        .padding(.top, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("Baú post: \(title)"))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("message.bauCard")
    }

    // MARK: Poster

    private var hasPicture: Bool {
        switch card.poster {
        case .image, .videoFrame, .plate: true
        case .none: false
        }
    }

    @ViewBuilder
    private var poster: some View {
        // The base fixes the size (16:9, or a short plate); everything else is
        // an overlay, so a picture that is wider than it is tall cannot widen it.
        PosterBase(hasPicture: hasPicture)
            .frame(maxWidth: .infinity)
            .overlay { posterContent }
            .overlay(alignment: .topLeading) { brandChip.padding(10) }
            .overlay(alignment: .topTrailing) { pinnedChip }
            .overlay(alignment: .bottomTrailing) { lockedChip }
            .clipped()
    }

    @ViewBuilder
    private var posterContent: some View {
        ZStack {
            Palette.surfaceRaised
            switch card.poster {
            case .image(let url):
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        Color.clear
                    }
                }
                .blur(radius: card.locked ? 10 : 0)
                .scaleEffect(card.locked ? 1.05 : 1)
            case .videoFrame(let url):
                BauVideoFrame(url: url)
            case .plate, .none:
                EmptyView()
            }
            // Lime glow top-left on every card without a picture behind it, so
            // a text-only post and a photo read as the same family.
            if isPictureBacked {
                LinearGradient(
                    colors: [Palette.inkDeep.opacity(0.85), Palette.inkDeep.opacity(0.1), .clear],
                    startPoint: .bottom, endPoint: .top
                )
            } else {
                plateWash
            }
            if card.isPlayable && !card.locked && hasPicture {
                Circle()
                    .fill(Palette.signal)
                    .frame(width: 48, height: 48)
                    .overlay(
                        Image(systemName: "play.fill")
                            .font(.system(size: 18, weight: .bold))
                            .foregroundStyle(Palette.inkDeep)
                            .offset(x: 1)
                    )
                    .shadow(color: Palette.signal.opacity(0.35), radius: 14, y: 6)
                    .accessibilityLabel(Text("Video"))
            }
        }
    }

    @ViewBuilder
    private var pinnedChip: some View {
            if card.pinned {
                Label("Pinned post", systemImage: "pin.fill")
                    .labelStyle(.titleAndIcon)
                    .font(.system(size: 10, weight: .semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(Palette.paper)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Palette.inkDeep.opacity(0.7)))
                    .padding(10)
            }
    }

    @ViewBuilder
    private var lockedChip: some View {
            if card.locked {
                Label("Locked", systemImage: "lock.fill")
                    .font(.system(size: 10, weight: .semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(Palette.paper)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Palette.inkDeep.opacity(0.75)))
                    .padding(10)
            }
    }

    /// A real picture is behind the wash (image or first video frame), so the
    /// bottom gradient is what keeps the chips legible rather than the lime.
    private var isPictureBacked: Bool {
        switch card.poster {
        case .image, .videoFrame: true
        case .plate, .none: false
        }
    }

    private var plateWash: some View {
        ZStack {
            LinearGradient(
                colors: [Palette.signal.opacity(0.16), .clear],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            RadialGradient(
                colors: [Palette.signal.opacity(0.28), .clear],
                center: .topLeading, startRadius: 0, endRadius: 220
            )
        }
    }

    private var brandChip: some View {
        HStack(spacing: 4) {
            Image(systemName: "archivebox.fill")
                .font(.system(size: 9, weight: .bold))
            Text("BAÚ")
                .font(.system(size: 10, weight: .bold))
                .tracking(0.8)
        }
        .foregroundStyle(Palette.inkDeep)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill(Palette.signal))
    }

    // MARK: Footer

    private var byline: some View {
        HStack(spacing: 8) {
            if let author = card.author {
                Avatar(name: author.displayName, seed: author.id, size: 20, url: author.avatarUrl)
                (Text(author.displayName).foregroundStyle(Palette.paperSubtle).fontWeight(.medium)
                    + Text(verbatim: " · ")
                    + Text("in the Baú"))
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                    .lineLimit(1)
            } else {
                // A locked post withholds its author: the server's name stands in.
                (Text(card.serverName).foregroundStyle(Palette.paperSubtle).fontWeight(.medium)
                    + Text(verbatim: " · ")
                    + Text("in the Baú"))
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            HStack(spacing: 10) {
                if card.likeCount > 0 {
                    counter("heart", card.likeCount)
                        .accessibilityLabel(Text("\(card.likeCount) likes"))
                }
                if card.commentCount > 0 {
                    counter("bubble.left", card.commentCount)
                        .accessibilityLabel(Text("\(card.commentCount) comments"))
                }
            }
        }
    }

    private func counter(_ symbol: String, _ count: Int) -> some View {
        HStack(spacing: 3) {
            Image(systemName: symbol).font(.system(size: 11))
            Text(String(count)).monospacedDigit()
        }
        .font(Typography.caption)
        .foregroundStyle(Palette.paperMuted)
    }

    private var openButton: some View {
        HStack(spacing: 8) {
            Text("Open in Baú")
                .font(.system(size: 15, weight: .semibold))
            Image(systemName: "arrow.right")
                .font(.system(size: 13, weight: .bold))
        }
        .foregroundStyle(Palette.inkDeep)
        .frame(maxWidth: .infinity)
        .frame(height: 40)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                .fill(Palette.signal)
        )
    }
}

/// A poster is a 16:9 picture, or a short plate when there is no picture.
private struct PosterBase: View {
    let hasPicture: Bool

    var body: some View {
        if hasPicture {
            Color.clear.aspectRatio(16.0 / 9.0, contentMode: .fit)
        } else {
            Color.clear.frame(height: 64)
        }
    }
}

/// The first frame of a stored video, painted without playing it. A signed
/// file URL is all the card has, so the frame comes from the asset itself.
private struct BauVideoFrame: View {
    let url: URL
    @State private var frame: CGImage?

    var body: some View {
        ZStack {
            if let frame {
                Image(decorative: frame, scale: 1)
                    .resizable()
                    .scaledToFill()
            }
        }
        .task(id: url) {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 800, height: 800)
            frame = try? await generator.image(at: CMTime(seconds: 0.001, preferredTimescale: 600)).image
        }
    }
}

/// The placeholder while the card loads: same footprint, so the row does not
/// jump when the answer lands.
struct BauPostCardSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Rectangle().fill(Palette.surfaceRaised)
                .aspectRatio(16.0 / 9.0, contentMode: .fit)
            VStack(alignment: .leading, spacing: 8) {
                bar(width: 200, height: 14)
                bar(width: nil, height: 11)
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                    .fill(Palette.surfaceRaised)
                    .frame(height: 40)
            }
            .padding(12)
        }
        .frame(maxWidth: 380, alignment: .leading)
        .background(Palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                .strokeBorder(Palette.border, lineWidth: 1)
        )
        .padding(.top, 4)
        .accessibilityHidden(true)
        .accessibilityIdentifier("message.bauCard.loading")
    }

    private func bar(width: CGFloat?, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 4, style: .continuous)
            .fill(Palette.surfaceRaised)
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }
}

/// What a message row draws for its card: the skeleton while it loads, the card
/// when it resolves, nothing when the viewer may not see the post (the row then
/// shows the link as it always has).
struct BauPostCardSlot: View {
    @Environment(SessionStore.self) private var session
    let link: BauPostLink
    let state: BauCardState

    var body: some View {
        switch state {
        case .loading:
            BauPostCardSkeleton()
        case .ok(let card):
            BauPostCardView(card: card) {
                session.requestNavigation(.bauPost(serverId: link.serverId, postId: link.postId))
            }
        case .unavailable:
            EmptyView()
        }
    }
}
