import SwiftUI

// A TILE ON THE WALL. Three kinds, the way the approved design draws them:
//
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

    private var need: JamNeed { JamNeed.of(song) }
    private var tint: Color { (JamWho.instruments(of: song).first ?? .other).color }
    private var hasPoster: Bool { poster != nil }
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
        JamWho.line(song: song, contributors: preview?.contributors)
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            background
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
        .onAppear {
            guard !drawn else { return }
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.7).delay(0.1)) { drawn = true }
        }
    }

    // MARK: Layers

    @ViewBuilder
    private var background: some View {
        if let poster {
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
        } else if preview?.hasVideo == true && preview?.envelope.isEmpty != false {
            Palette.surfaceRaised
        } else {
            tint
        }
    }

    private var waveLayer: some View {
        VStack {
            JamWaveform(
                values: preview?.envelope ?? [],
                color: Palette.ink,
                draw: drawn || reduceMotion ? 1 : 0,
                barWidth: isHero ? 4 : 3,
                gap: isHero ? 3 : 2
            )
            .frame(height: isHero ? 72 : 34)
            .padding(.top, 16)
            .opacity(preview == nil ? 0.35 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.5), value: preview != nil)
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

// MARK: - The mosaic as a layout

private struct JamTileSizeKey: LayoutValueKey {
    static let defaultValue: JamTileSize = .small
}

extension View {
    func jamTileSize(_ size: JamTileSize) -> some View {
        layoutValue(key: JamTileSizeKey.self, value: size)
    }
}

/// Places tiles on the grid `JamMosaic.layout` decided. A cell is square-ish
/// (`aspect` is its height over its width) and a tile spans whole cells plus
/// the gaps between them, so a 2 x 2 is exactly four cells and nothing drifts.
struct JamMosaicLayout: Layout {
    var columns: Int
    var spacing: CGFloat = 10
    var aspect: CGFloat = 0.92

    struct Cache {
        var placements: [JamPlacement] = []
    }

    func makeCache(subviews: Subviews) -> Cache { Cache() }

    private func resolve(_ subviews: Subviews) -> [JamPlacement] {
        JamMosaic.layout(sizes: subviews.map { $0[JamTileSizeKey.self] }, columns: columns)
    }

    private func cell(width: CGFloat) -> CGSize {
        let w = (width - spacing * CGFloat(columns - 1)) / CGFloat(columns)
        return CGSize(width: max(1, w), height: max(1, w * aspect))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        let width = proposal.width ?? 320
        cache.placements = resolve(subviews)
        let rows = JamMosaic.rowCount(cache.placements)
        let c = cell(width: width)
        let height = rows == 0 ? 0 : CGFloat(rows) * c.height + CGFloat(rows - 1) * spacing
        return CGSize(width: width, height: height)
    }

    func placeSubviews(
        in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache
    ) {
        if cache.placements.count != subviews.count { cache.placements = resolve(subviews) }
        let c = cell(width: bounds.width)
        for placement in cache.placements {
            let x = bounds.minX + CGFloat(placement.column) * (c.width + spacing)
            let y = bounds.minY + CGFloat(placement.row) * (c.height + spacing)
            let w = CGFloat(placement.columns) * c.width + CGFloat(placement.columns - 1) * spacing
            let h = CGFloat(placement.rows) * c.height + CGFloat(placement.rows - 1) * spacing
            subviews[placement.index].place(
                at: CGPoint(x: x, y: y), anchor: .topLeading,
                proposal: ProposedViewSize(width: w, height: h)
            )
        }
    }
}
