import SwiftUI

/// The quote on a DM that replied to a story.
///
/// While the story lives: its picture (or the text card's colour and words)
/// and its caption, with how long is left. After it expires, or once staff
/// removed it: a hatched "Story expirou" plate with no picture and no text,
/// which is how the 24 hour promise holds inside conversations too. The card
/// is asked for, never carried on the message, for exactly that reason.
struct StoryQuoteCard: View {
    @Environment(SessionStore.self) private var session
    let storyId: String
    /// Who wrote the reply, to say whose story it was.
    let authorName: String

    @State private var card: StoryCard?

    private var mine: Bool { card?.authorId == session.currentUser?.id }

    var body: some View {
        HStack(spacing: 10) {
            thumbnail
                .frame(width: 44, height: 62)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: header)
                    .textCase(.uppercase)
                    .font(.system(size: 10, weight: .bold))
                    .tracking(0.8)
                    .foregroundStyle(Palette.paperMuted)
                if let card, card.isLive {
                    if let line = card.caption ?? card.text, !line.isEmpty {
                        Text(verbatim: line)
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paper)
                            .lineLimit(2)
                    }
                    Text(verbatim: String(localized: "gone in \(StoryRules.left(until: card.expiresAt))"))
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.paperMuted)
                } else if card != nil {
                    Text("Story expired")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paper)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .frame(maxWidth: 280, alignment: .leading)
        .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
        .task(id: storyId) {
            card = await StoryCardCache.shared.card(storyId, api: session.api)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("story.quote")
    }

    private var header: String {
        guard let card else { return String(localized: "Story") }
        return mine
            ? String(localized: "Replied to your story")
            : String(localized: "Replied to a story")
    }

    @ViewBuilder
    private var thumbnail: some View {
        if let card, card.isLive {
            if let poster = card.posterUrl, let url = Avatar.resolve(poster) ?? URL(string: poster) {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Palette.surfaceRaised
                }
            } else {
                LinearGradient(colors: StoryRules.backgroundColors(card.background), startPoint: .top, endPoint: .bottom)
            }
        } else {
            // The hatched plate: nothing of the story is left to show.
            Canvas { context, size in
                var path = Path()
                var x: CGFloat = -size.height
                while x < size.width {
                    path.move(to: CGPoint(x: x, y: size.height))
                    path.addLine(to: CGPoint(x: x + size.height, y: 0))
                    x += 6
                }
                context.stroke(path, with: .color(Palette.border), lineWidth: 1)
            }
            .background(Palette.surfaceRaised)
        }
    }
}

/// One fetch per story per minute for every quote on screen: a long thread
/// replying to the same story asks once.
actor StoryCardCache {
    static let shared = StoryCardCache()
    private var cards: [String: (card: StoryCard, at: Date)] = [:]

    func card(_ id: String, api: APIClient) async -> StoryCard? {
        if let hit = cards[id], Date().timeIntervalSince(hit.at) < 60 { return hit.card }
        guard let fresh = try? await api.storyCard(id: id) else { return cards[id]?.card }
        cards[id] = (fresh, Date())
        return fresh
    }
}
