import SwiftUI

// A TILE ON THE WALL. Four kinds, the way the approved design draws them:
//
//  - a song with a COVER shows the picture under its title, on a shade so the
//    words read on any picture; until the picture is here (and when it never
//    comes: offline, an address that has expired) the tile is the one it would
//    be without a cover, so a slow download is never a gap;
//  - a song with video shows a poster frame under its title (the hero gets the
//    lime border);
//  - an audio-only song is a block of its first instrument's colour drawing
//    the waveform of the whole mix, from the stems' `peaks`;
//  - an empty song is a quiet surface with a dashed edge, waiting for a take.
//
// Every tile carries the title, who is on it and what it needs, and every one
// is a single accessibility element that says all three.

struct JamTileView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    let song: JamSongSummary
    let size: JamTileSize
    let preview: JamPreview?
    let poster: UIImage?
    let isFresh: Bool

    @State private var drawn = false
    /// A cover is on screen (`JamCoverImage` says so once it has loaded).
    @State private var hasCover = false

    private var need: JamNeed { JamNeed.of(song) }
    private var facts: JamTileFacts { JamTileFacts.resolve(song: song, preview: preview) }
    private var tint: Color { (JamWho.instruments(of: song).first ?? .other).color }
    /// A picture under the words: the cover, or a video's poster frame.
    private var hasPoster: Bool { poster != nil || hasCover }
    private var isEmptySong: Bool { song.trackCount == 0 }
    private var isHero: Bool { size == .hero }
    /// A small tile at an accessibility text size has no room for a waveform
    /// above two lines of title and a pill: the words win.
    private var showsWave: Bool {
        !hasPoster && !isEmptySong && !(size == .small && typeSize.isAccessibilitySize)
    }
    /// On an instrument colour the text is ink; on a poster or a surface it is
    /// paper. One rule, so a tile never has text it cannot be read on.
    private var onTint: Bool { !hasPoster && !isEmptySong }

    private var whoText: String {
        JamWho.line(song: song, contributors: facts.contributorNames)
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            background
            JamCoverImage(songId: song.id, cover: song.cover) { hasCover = $0 != nil }
            if showsWave { waveLayer }
            if hasPoster { posterShade }
            labels
        }
        .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous))
        .overlay(border)
        .overlay(alignment: .topTrailing) { freshBadge }
        .contentShape(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(Text("Opens the song"))
        .accessibilityAddTraits(.isButton)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.35), value: hasCover)
        .onAppear {
            guard !drawn else { return }
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.7).delay(0.1)) { drawn = true }
        }
    }

    // MARK: Layers

    @ViewBuilder
    private var background: some View {
        if let poster, !hasCover {
            // An overlay on a clear base, so a fill-scaled image can never
            // widen the tile past the cell the mosaic gave it.
            Color.clear.overlay {
                Image(uiImage: poster)
                    .resizable()
                    .scaledToFill()
            }
            .clipped()
        } else if isEmptySong {
            Palette.surface
        } else if facts.hasVideo && facts.envelope.isEmpty {
            Palette.surfaceRaised
        } else {
            tint
        }
    }

    private var waveLayer: some View {
        VStack {
            JamWaveform(
                values: facts.envelope,
                color: Palette.ink,
                draw: drawn || reduceMotion ? 1 : 0,
                barWidth: isHero ? 4 : 3,
                gap: isHero ? 3 : 2
            )
            .frame(height: isHero ? 72 : 34)
            .padding(.top, 16)
            .opacity(facts.isReady ? 1 : 0.35)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.5), value: facts.isReady)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
    }

    private var posterShade: some View {
        LinearGradient(
            colors: [.clear, Palette.inkDeep.opacity(0.85)],
            startPoint: .center, endPoint: .bottom
        )
    }

    private var labels: some View {
        VStack(alignment: .leading, spacing: 3) {
            Spacer(minLength: 0)
            Text(verbatim: song.title)
                .font(JamFont.title(isHero ? 26 : (size == .wide ? 20 : 18)))
                .foregroundStyle(onTint ? Palette.ink : Palette.paper)
                .lineLimit(isHero ? 3 : 2)
                .minimumScaleFactor(0.8)
                .multilineTextAlignment(.leading)
            if size == .small || typeSize.isAccessibilitySize {
                // A small tile has no room for both on one line: the state
                // goes under the names, never truncated into "anyone c...".
                subtitleText
                needPill.padding(.top, 3)
            } else {
                HStack(alignment: .center, spacing: 8) {
                    subtitleText
                    Spacer(minLength: 0)
                    needPill
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var subtitleText: some View {
        Text(verbatim: subtitle)
            .font(JamFont.text(12, .semibold))
            .foregroundStyle(onTint ? Palette.ink.opacity(0.78) : Palette.paperSubtle)
            .lineLimit(1)
    }

    private var subtitle: String {
        var parts: [String] = []
        if let artist = song.artist, !artist.isEmpty { parts.append(artist) }
        if !whoText.isEmpty { parts.append(whoText) }
        return parts.joined(separator: " \u{00B7} ")
    }

    private var needPill: some View {
        Text(verbatim: need.text)
            .font(JamFont.text(12, .bold))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .padding(.horizontal, 9)
            .frame(height: 24)
            .foregroundStyle(pillForeground)
            .background(Capsule().fill(pillBackground))
    }

    private var pillForeground: Color {
        if need.isCallout { return onTint ? Palette.signal : Palette.inkDeep }
        return onTint ? Palette.paper : Palette.paperSubtle
    }

    private var pillBackground: Color {
        if need.isCallout { return onTint ? Palette.inkDeep : Palette.signal }
        return onTint ? Palette.inkDeep : Palette.surfaceRaised.opacity(0.85)
    }

    @ViewBuilder
    private var border: some View {
        let shape = RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
        if isEmptySong {
            shape.strokeBorder(Palette.border, style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
        } else if isHero {
            shape.strokeBorder(Palette.signal, lineWidth: 2)
        } else if hasPoster {
            shape.strokeBorder(Palette.border, lineWidth: 1)
        }
    }

    @ViewBuilder
    private var freshBadge: some View {
        if isFresh {
            Text("New")
                .font(JamFont.text(11, .bold))
                .foregroundStyle(Palette.inkDeep)
                .padding(.horizontal, 8)
                .frame(height: 22)
                .background(Capsule().fill(Palette.signal))
                .padding(10)
                .transition(.scale(scale: 0.4).combined(with: .opacity))
        }
    }

    private var accessibilityLabel: Text {
        var text = Text(verbatim: song.title)
        if let artist = song.artist, !artist.isEmpty { text = text + Text(verbatim: ", \(artist)") }
        if !whoText.isEmpty { text = text + Text(verbatim: ", \(whoText)") }
        return text + Text(verbatim: ", \(need.text)")
    }
}
