import SwiftUI

// The top of a server's channel list: the banner (when the server has one)
// running under a transparent navigation bar, with the name and one line of
// activity on it. Scrolled away, the navigation bar takes over with a compact
// copy of the same two lines, so the name is never printed twice at once.

/// The list watches where this header's bottom edge is (`onGeometryChange`)
/// and swaps in `ServerCompactTitle` once it has gone under the bar.
struct ServerHeader: View {
    static let coordinateSpace = "channelListScroll"

    let name: String
    let bannerURL: URL?
    let activity: ServerActivity
    /// Status bar plus navigation bar: the header runs under both.
    let topInset: CGFloat

    private var bannerHeight: CGFloat { topInset + 120 }

    var body: some View {
        Group {
            if let bannerURL {
                banner(bannerURL)
            } else {
                plain
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    /// The picture is whatever the owner uploaded, a white photograph as
    /// likely as a dark one, so the scrim is what keeps the name readable. It
    /// clears at the top so the picture is still the thing you see.
    private func banner(_ url: URL) -> some View {
        GeometryReader { geo in
            // Pulled past the top, the picture stretches instead of leaving a gap.
            let pull = max(0, geo.frame(in: .named(Self.coordinateSpace)).minY)
            ZStack {
                Palette.surface
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Color.clear
                }
            }
            .frame(width: geo.size.width, height: bannerHeight + pull)
            .clipped()
            .overlay {
                LinearGradient(
                    stops: [
                        .init(color: Palette.ink.opacity(0.55), location: 0),
                        .init(color: Palette.ink.opacity(0), location: 0.35),
                        .init(color: Palette.ink.opacity(0.6), location: 0.7),
                        .init(color: Palette.ink, location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }
            .offset(y: -pull)
        }
        .frame(height: bannerHeight)
        .overlay(alignment: .bottomLeading) { titleBlock.padding(.bottom, 10) }
    }

    private var plain: some View {
        titleBlock
            .padding(.top, topInset + 4)
            .padding(.bottom, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Fades and shrinks a little as it slides under the bar, so the large
    /// name never sits behind the back button while the compact copy fades in.
    /// `visualEffect` reads the geometry without re-running the list's body on
    /// every scrolled point.
    private var titleBlock: some View {
        let inset = topInset
        return titleContent.visualEffect { content, proxy in
            let bottom = proxy.frame(in: .named(ServerHeader.coordinateSpace)).maxY
            let progress = min(1, max(0, (bottom - inset) / 56))
            return content
                .opacity(progress)
                .scaleEffect(0.94 + 0.06 * progress, anchor: .bottomLeading)
        }
    }

    private var titleContent: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: name)
                .font(Typography.display(26))
                .foregroundStyle(Palette.paper)
                .lineLimit(2)
                .shadow(color: .black.opacity(bannerURL == nil ? 0 : 0.45), radius: 6, y: 1)
            if !activity.isEmpty {
                ServerActivityLine(activity: activity)
            }
        }
        .padding(.horizontal, Metrics.hPadding)
    }
}

/// "● 8 em call  ● 1 ao vivo". Lime for people in calls, red for a broadcast.
struct ServerActivityLine: View {
    let activity: ServerActivity
    var size: CGFloat = 13

    var body: some View {
        HStack(spacing: 10) {
            if activity.inCall > 0 {
                dot(Palette.signal)
                Text("\(activity.inCall) in call")
                    .padding(.leading, -6)
            }
            if activity.live > 0 {
                dot(Palette.danger)
                Text("\(activity.live) live")
                    .padding(.leading, -6)
            }
        }
        .font(.system(size: size, weight: .medium))
        .foregroundStyle(Palette.paperSubtle)
        .lineLimit(1)
    }

    private func dot(_ color: Color) -> some View {
        Circle().fill(color).frame(width: 6, height: 6)
    }
}

/// What the navigation bar shows once the header has scrolled under it.
struct ServerCompactTitle: View {
    let name: String
    let activity: ServerActivity

    var body: some View {
        VStack(spacing: 1) {
            Text(verbatim: name)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Palette.paper)
                .lineLimit(1)
            if !activity.isEmpty {
                ServerActivityLine(activity: activity, size: 11)
            }
        }
    }
}
