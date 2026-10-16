import SwiftUI
import UIKit

/// The card a forwarded message draws under the forwarder's own words: where
/// it came from, a title, a three-line excerpt, a picture when there is one.
/// A tap opens the original (`ForwardOpen`).
///
/// THE SNAPSHOT IS TEXT. A `@mention` in the excerpt is not a link and pings
/// nobody, so it is drawn with `Text(verbatim:)` and never through the
/// markdown renderer the message body uses: that renderer would turn a pasted
/// URL in the snapshot into a tappable link, and the card's own tap is the
/// only door out of it.
struct ForwardCard: View {
    @Environment(SessionStore.self) private var session
    let forward: MessageForward

    private var content: ForwardCardContent { ForwardCardContent(forward) }

    var body: some View {
        Button {
            Task { await open() }
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    sourceLine
                    if let heading = content.heading {
                        Text(verbatim: heading)
                            .font(Typography.bodyMedium)
                            .foregroundStyle(Palette.paper)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .accessibilityIdentifier("forward.card.heading")
                    }
                    if !content.excerpt.isEmpty {
                        Text(verbatim: content.excerpt)
                            .font(Typography.callout)
                            .foregroundStyle(Palette.paperSubtle)
                            .lineLimit(3)
                            .multilineTextAlignment(.leading)
                            .accessibilityIdentifier("forward.card.excerpt")
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)

                media
            }
            .frame(maxWidth: 380, alignment: .leading)
            .background(Palette.surface)
            .overlay(alignment: .leading) {
                Rectangle().fill(Palette.signal).frame(width: 3)
            }
            .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                    .strokeBorder(Palette.border, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous))
        }
        .buttonStyle(ForwardCardPressStyle())
        .padding(.top, 4)
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text("Opens the original"))
        .accessibilityIdentifier("message.forwardCard")
    }

    // MARK: Pieces

    private var sourceLine: some View {
        HStack(spacing: 6) {
            Avatar(name: forward.sourceServerName, seed: forward.sourceServerId, size: 18,
                   url: content.iconPath)
            sourceText
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
                .lineLimit(1)
                .accessibilityIdentifier("forward.card.source")
            if content.restricted {
                Image(systemName: "lock.fill")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Palette.paperMuted)
                    .accessibilityLabel(Text("Stays in its server"))
            }
            Spacer(minLength: 0)
        }
    }

    private var sourceText: Text {
        switch content.source {
        case .bau(let server):
            Text("Forwarded from \(server) · Baú")
        case .channel(let server, let channel):
            Text("Forwarded from \(server) · #\(channel)")
        case .server(let server):
            Text("Forwarded from \(server)")
        }
    }

    @ViewBuilder
    private var media: some View {
        if let thumbnail = content.thumbnail {
            AsyncImage(url: thumbnail) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                case .failure:
                    plate(glyph: content.glyph ?? "photo")
                default:
                    Palette.surfaceRaised
                }
            }
            .frame(maxWidth: .infinity)
            .aspectRatio(16.0 / 9.0, contentMode: .fit)
            .clipped()
            .accessibilityHidden(true)
            .accessibilityIdentifier("forward.card.thumbnail")
        } else if let glyph = content.glyph {
            plate(glyph: glyph)
                .accessibilityHidden(true)
                .accessibilityIdentifier("forward.card.glyph")
        }
    }

    /// No picture to show (a signed media URL is never stored in a snapshot):
    /// a short plate with a glyph for what the source had.
    private func plate(glyph: String) -> some View {
        Palette.surfaceRaised
            .frame(maxWidth: .infinity)
            .frame(height: 56)
            .overlay {
                Image(systemName: glyph)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Palette.paperMuted)
            }
    }

    // MARK: Opening

    private func open() async {
        // Which servers this account is in decides app or browser: the app can
        // only resolve a source it belongs to. `servers()` is a conditional
        // read, so this is a header exchange on a warm list.
        let members = (try? await session.api.servers()).map { Set($0.map(\.id)) }
        switch ForwardOpen.resolve(forward, memberServerIds: members) {
        case .inApp(let target):
            session.requestNavigation(target)
        case .external(let url):
            // Not `openURL`: the app's own handler would route a Baú link of
            // this instance straight back into the app, which is exactly what
            // this branch decided against.
            await UIApplication.shared.open(url)
        case .none:
            break
        }
    }
}

/// Dims on press instead of moving, so it is the same under Reduce Motion.
private struct ForwardCardPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}
