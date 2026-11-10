import AVFoundation
import SwiftUI

// THE STAGE, THE STACK AND THE TAKES. The stack is the heart of the song
// screen: one lane per playing stem on a SHARED timeline, so a stem that starts
// later sits further right, a trimmed one is shorter, and one playhead runs
// down all of them. The lane gutter and the vote button are fixed widths, which
// is what makes the lanes' left and right edges the same x for every row and
// lets one line be the playhead for the whole stack.

// MARK: - Stage

struct JamStageView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let model: JamSongModel

    private var videoTracks: [JamTrack] {
        model.active.filter { model.video.player(for: $0.id) != nil }.prefix(4).map { $0 }
    }

    /// A video this phone cannot play (WebM, what Chrome and Firefox record):
    /// the song still plays, its audio is a separate stem, and the stage says
    /// why there is no picture instead of showing a frame that never loads.
    private var hasUnplayableVideo: Bool {
        model.active.contains { $0.hasVideo && !JamVideoSync.canPlay(contentType: $0.videoContentType) }
    }

    private var artTint: Color {
        (model.stack.first?.instrument ?? JamWho.instruments(of: model.song).first ?? .other).color
    }

    var body: some View {
        Group {
            if videoTracks.isEmpty {
                artwork
            } else {
                videoGrid
            }
        }
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous))
        .padding(.horizontal, Metrics.hPadding)
        .accessibilityHidden(!(hasUnplayableVideo && videoTracks.isEmpty))
    }

    private var videoGrid: some View {
        let tracks = videoTracks
        let columns = tracks.count == 1 ? 1 : 2
        return LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: columns), spacing: 2
        ) {
            ForEach(tracks) { track in
                if let player = model.video.player(for: track.id) {
                    JamPlayerLayerView(player: player)
                        .aspectRatio(tracks.count == 1 ? 16.0 / 9.0 : 4.0 / 3.0, contentMode: .fit)
                        .overlay(alignment: .bottomLeading) {
                            Text(verbatim: track.authorName ?? "")
                                .font(JamFont.text(11, .bold))
                                .foregroundStyle(Palette.paper)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(Capsule().fill(Palette.inkDeep.opacity(0.7)))
                                .padding(6)
                        }
                }
            }
        }
        .background(Palette.inkDeep)
    }

    /// With no video this phone can play, the song is its colour and the
    /// shape of its sound.
    private var artwork: some View {
        ZStack(alignment: .bottomLeading) {
            LinearGradient(
                colors: [artTint, artTint.opacity(0.55)], startPoint: .topLeading, endPoint: .bottomTrailing
            )
            JamWaveform(
                values: JamPeaks.mixEnvelope(tracks: model.active, bars: 64),
                color: Palette.ink.opacity(0.85),
                barWidth: 4, gap: 3
            )
            .frame(height: 84)
            .frame(maxHeight: .infinity, alignment: .center)
            .padding(.horizontal, 18)
            if hasUnplayableVideo {
                Label("The video does not play on iPhone yet", systemImage: "video.slash")
                    .font(JamFont.text(12, .semibold))
                    .foregroundStyle(Palette.ink.opacity(0.85))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Capsule().fill(Palette.ink.opacity(0.14)))
                    .padding(12)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .accessibilityHidden(false)
            }
            HStack(spacing: -8) {
                ForEach(model.active.prefix(5)) { track in
                    Avatar(name: track.displayName, seed: track.authorId, size: 28, url: track.authorAvatarUrl)
                        .overlay(Circle().strokeBorder(artTint, lineWidth: 2))
                }
            }
            .padding(14)
        }
        .frame(height: 190)
    }
}

/// An `AVPlayerLayer`, muted video only. Fills its frame.
struct JamPlayerLayerView: UIViewRepresentable {
    let player: AVPlayer

    final class LayerView: UIView {
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }

    func makeUIView(context: Context) -> LayerView {
        let view = LayerView()
        view.playerLayer.videoGravity = .resizeAspectFill
        view.playerLayer.player = player
        view.backgroundColor = .black
        return view
    }

    func updateUIView(_ view: LayerView, context: Context) {
        if view.playerLayer.player !== player { view.playerLayer.player = player }
    }
}

// MARK: - The stack

struct JamStackView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let model: JamSongModel
    @Binding var scrubbing: Bool
    let onDelete: (JamTrack) -> Void

    static let gutter: CGFloat = 92
    static let trailing: CGFloat = 56
    static let laneSpacing: CGFloat = 8

    @State private var laneWidth: CGFloat = 0

    var body: some View {
        let tl = model.timeline
        VStack(alignment: .leading, spacing: 6) {
            Text("Tracks")
                .font(Typography.label)
                .tracking(1.2)
                .foregroundStyle(Palette.paperMuted)
                .textCase(.uppercase)
                .padding(.horizontal, Metrics.hPadding)
                .accessibilityAddTraits(.isHeader)

            if model.stack.isEmpty {
                Text("No tracks in the mix yet.")
                    .font(JamFont.text(14))
                    .foregroundStyle(Palette.paperMuted)
                    .padding(.horizontal, Metrics.hPadding)
                    .padding(.vertical, 12)
            } else {
                ruler(tl.durationMs)
                ForEach(model.stack) { track in
                    JamTrackRow(model: model, track: track, timeline: tl, onDelete: onDelete)
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.96).combined(with: .opacity))
                        .onTapGesture {}  // keeps the row from swallowing the lane's own tap
                }
            }
        }
        .animation(.jam(reduceMotion: reduceMotion), value: model.stack.map(\.id))
        .overlay { playheadOverlay(tl.durationMs) }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            laneWidth = max(0, width - Metrics.hPadding * 2 - Self.gutter - Self.trailing - Self.laneSpacing * 2)
        }
    }

    // MARK: Ruler (the scrub strip)

    private func ruler(_ durationMs: Double) -> some View {
        HStack(spacing: Self.laneSpacing) {
            Color.clear.frame(width: Self.gutter)
            GeometryReader { proxy in
                TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !model.isPlaying && !scrubbing)) { _ in
                    let _ = model.seekRevision
                    ZStack(alignment: .leading) {
                        Capsule().fill(Palette.border).frame(height: 4)
                        Capsule().fill(Palette.signal)
                            .frame(
                                width: JamPlayhead.x(
                                    forPositionMs: model.positionMs, width: proxy.size.width, durationMs: durationMs
                                ),
                                height: 4
                            )
                    }
                    .frame(maxHeight: .infinity)
                }
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            if !scrubbing { scrubbing = true; Haptics.selection() }
                            model.seek(
                                to: JamPlayhead.position(
                                    forX: value.location.x, width: proxy.size.width, durationMs: durationMs
                                )
                            )
                        }
                        .onEnded { _ in scrubbing = false }
                )
            }
            .frame(height: 40)
            Color.clear.frame(width: Self.trailing)
        }
        .padding(.horizontal, Metrics.hPadding)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Playhead"))
        .accessibilityValue(Text(verbatim: "\(JamTime.clock(model.positionMs)) / \(JamTime.clock(durationMs))"))
        .accessibilityAdjustableAction { direction in
            let step = max(1000, durationMs / 20)
            model.seek(to: model.positionMs + (direction == .increment ? step : -step))
        }
    }

    // MARK: Playhead

    /// One line down every lane, from the ruler to the last row.
    private func playheadOverlay(_ durationMs: Double) -> some View {
        GeometryReader { proxy in
            TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !model.isPlaying && !scrubbing)) { _ in
                let _ = model.seekRevision
                let x = Metrics.hPadding + Self.gutter + Self.laneSpacing
                    + JamPlayhead.x(forPositionMs: model.positionMs, width: laneWidth, durationMs: durationMs)
                Rectangle()
                    .fill(Palette.signal)
                    .frame(width: 2)
                    .shadow(color: Palette.signal.opacity(0.6), radius: 4)
                    .offset(x: x - 1, y: 40)
                    .frame(height: max(0, proxy.size.height - 40), alignment: .top)
                    .opacity(durationMs > 0 ? 1 : 0)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - One lane

struct JamTrackRow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let model: JamSongModel
    let track: JamTrack
    let timeline: (originMs: Double, durationMs: Double)
    let onDelete: (JamTrack) -> Void

    @State private var drawn = false

    private var expanded: Bool { model.expandedTrackId == track.id }
    private var audible: Bool { model.isAudible(track) }
    private var isFresh: Bool { model.state.fresh.contains(track.id) }

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: JamStackView.laneSpacing) {
                gutter
                lane
                JamVoteButton(
                    count: track.voteCount, voted: model.isVoted(track.id),
                    busy: model.busyVotes.contains(track.id), label: voteLabel
                ) { Task { await model.vote(track) } }
                .frame(width: JamStackView.trailing)
            }
            if expanded { controls.transition(.opacity.combined(with: .move(edge: .top))) }
        }
        .padding(.horizontal, Metrics.hPadding)
        .opacity(audible ? 1 : 0.45)
        .animation(.jam(reduceMotion: reduceMotion), value: expanded)
        .animation(.jamQuick(reduceMotion: reduceMotion), value: audible)
        .onAppear {
            guard !drawn else { return }
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.8).delay(0.15)) { drawn = true }
            if isFresh { Task { try? await Task.sleep(for: .seconds(4)); model.clearFresh(track.id) } }
        }
        .contextMenu { menu }
        .accessibilityElement(children: .contain)
    }

    private var voteLabel: Text {
        Text("Vote for \(JamTrackNaming.spoken(track))")
    }

    // MARK: Gutter

    private var gutter: some View {
        Button {
            withAnimation(.jam(reduceMotion: reduceMotion)) {
                model.expandedTrackId = expanded ? nil : track.id
            }
        } label: {
            HStack(spacing: 8) {
                Avatar(name: track.displayName, seed: track.authorId, size: 30, url: track.authorAvatarUrl)
                    .overlay(Circle().strokeBorder(track.instrument.color, lineWidth: 2))
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: track.instrument.title)
                        .font(JamFont.text(13, .bold))
                        .foregroundStyle(Palette.paper)
                    Text(verbatim: JamTrackNaming.caption(track))
                        .font(JamFont.text(11))
                        .foregroundStyle(Palette.paperMuted)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            }
            .frame(width: JamStackView.gutter, alignment: .leading)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: JamTrackNaming.spoken(track)))
        .accessibilityHint(Text("Shows the mix controls"))
        .accessibilityAddTraits(expanded ? [.isSelected] : [])
    }

    // MARK: Lane

    @ViewBuilder
    private var lane: some View {
        GeometryReader { proxy in
            let span = JamMixRules.fractions(of: track, originMs: timeline.originMs, durationMs: timeline.durationMs)
            let width = proxy.size.width
            ZStack(alignment: .leading) {
                // The lane itself: the whole song's length, faint, so a short
                // or late stem is visibly a part of it.
                Capsule().fill(Palette.surface).frame(height: 2).opacity(0.9)
                if model.unplayable.contains(track.id) {
                    Label("Does not play on iPhone yet", systemImage: "exclamationmark.triangle")
                        .font(JamFont.text(11, .medium))
                        .foregroundStyle(Palette.warning)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .frame(width: width, alignment: .leading)
                } else {
                    let slice = max(2, (span.end - span.start) * width)
                    JamLaneWave(model: model, track: track, timeline: timeline, draw: drawn || reduceMotion ? 1 : 0)
                        .frame(width: slice, height: 36)
                        .offset(x: span.start * width)
                }
            }
            .frame(width: width, height: 44)
            .contentShape(Rectangle())
            .gesture(
                SpatialTapGesture().onEnded { value in
                    Haptics.selection()
                    model.seek(to: JamPlayhead.position(forX: value.location.x, width: width, durationMs: timeline.durationMs))
                }
            )
        }
        .frame(height: 44)
        .accessibilityHidden(true)
    }

    // MARK: Controls

    private var controls: some View {
        HStack(spacing: 10) {
            toggle(
                symbol: "speaker.slash.fill", on: model.isMuted(track.id),
                label: "Mute", id: "mute"
            ) { model.toggleMute(track) }
            toggle(
                symbol: "headphones", on: model.isSoloed(track.id),
                label: "Solo", id: "solo"
            ) { model.toggleSolo(track) }
            Slider(
                value: Binding(get: { model.volume(track.id) }, set: { model.setVolume($0, for: track) }),
                in: 0...1
            )
            .tint(track.instrument.color)
            .accessibilityLabel(Text("Volume"))
            .accessibilityValue(Text(verbatim: "\(Int(model.volume(track.id) * 100))%"))
            Menu { menu } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 44, height: 44)
                    .foregroundStyle(Palette.paperSubtle)
            }
        }
        .padding(.leading, 4)
    }

    private func toggle(
        symbol: String, on: Bool, label: LocalizedStringKey, id: String, action: @escaping () -> Void
    ) -> some View {
        Button(action: {
            Haptics.selection()
            action()
        }) {
            Image(systemName: symbol)
                .font(JamFont.text(16, .semibold))
                .foregroundStyle(on ? Palette.inkDeep : Palette.paperSubtle)
                .frame(width: 44, height: 44)
                .background(Circle().fill(on ? track.instrument.color : Palette.surfaceRaised))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
        .accessibilityAddTraits(on ? [.isSelected] : [])
        .accessibilityIdentifier("jam.track.\(id)")
    }

    @ViewBuilder
    private var menu: some View {
        if model.canSetMix {
            Button { Task { await model.setInMix(track, false) } } label: {
                Label("Take out of the mix", systemImage: "minus.circle")
            }
        }
        if model.canDelete(track) {
            Button(role: .destructive) { onDelete(track) } label: {
                Label("Delete take", systemImage: "trash")
            }
        }
    }
}

/// A lane's waveform with the played part in the instrument's colour: the
/// lane shows where the playhead has been, not just the line.
private struct JamLaneWave: View {
    let model: JamSongModel
    let track: JamTrack
    let timeline: (originMs: Double, durationMs: Double)
    let draw: Double

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20, paused: !model.isPlaying)) { _ in
            let _ = model.seekRevision
            let span = JamMixRules.fractions(of: track, originMs: timeline.originMs, durationMs: timeline.durationMs)
            let position = timeline.durationMs > 0 ? model.positionMs / timeline.durationMs : 0
            let local = span.end > span.start ? (position - span.start) / (span.end - span.start) : 0
            JamWaveform(
                values: JamPeaks.trackBars(track, bars: 120),
                color: track.instrument.color.opacity(0.35),
                playedColor: track.instrument.color,
                played: min(1, max(0, local)),
                draw: draw
            )
        }
    }
}

// MARK: - Vote

struct JamVoteButton: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let count: Int
    let voted: Bool
    let busy: Bool
    let label: Text
    let action: () -> Void

    var body: some View {
        Button {
            action()
        } label: {
            VStack(spacing: 1) {
                Image(systemName: voted ? "hand.thumbsup.fill" : "hand.thumbsup")
                    .font(JamFont.text(16, .semibold))
                    .symbolEffect(.bounce, options: .nonRepeating, value: voted && !reduceMotion)
                Text(verbatim: "\(count)")
                    .font(JamFont.text(11, .bold).monospacedDigit())
                    .contentTransition(.numericText())
            }
            .foregroundStyle(voted ? Palette.signal : Palette.paperMuted)
            .frame(width: 44, height: 44)
            .background(Circle().fill(voted ? Palette.signal.opacity(0.16) : .clear))
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .animation(reduceMotion ? nil : Motion.press, value: voted)
        .animation(reduceMotion ? nil : Motion.press, value: count)
        .sensoryFeedback(.success, trigger: voted) { old, new in !old && new }
        .accessibilityLabel(label)
        .accessibilityValue(Text("\(count) votes"))
        .accessibilityAddTraits(voted ? [.isSelected] : [])
        .accessibilityIdentifier("jam.vote")
    }
}

// MARK: - Other takes

/// Takes that are not in the mix: competing versions of an instrument. A
/// person can HEAR one in place of the in-mix take (local, nothing is sent) and
/// vote for it; the song's author or a moderator puts the winner in the mix.
struct JamOtherTakesView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let model: JamSongModel
    let onDelete: (JamTrack) -> Void

    var body: some View {
        let takes = model.otherTakes
        if !takes.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text("Other takes")
                    .font(Typography.label)
                    .tracking(1.2)
                    .foregroundStyle(Palette.paperMuted)
                    .textCase(.uppercase)
                    .padding(.horizontal, Metrics.hPadding)
                    .accessibilityAddTraits(.isHeader)
                Text("Listen to a take in place of the one in the mix, and vote for the one that should win.")
                    .font(JamFont.text(12))
                    .foregroundStyle(Palette.paperMuted)
                    .padding(.horizontal, Metrics.hPadding)
                    .padding(.bottom, 4)
                ForEach(takes) { track in
                    row(track)
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.96).combined(with: .opacity))
                }
            }
            .animation(.jam(reduceMotion: reduceMotion), value: takes.map(\.id))
        }
    }

    private func row(_ track: JamTrack) -> some View {
        let hearing = model.isAuditioned(track)
        return HStack(spacing: 10) {
            Avatar(name: track.displayName, seed: track.authorId, size: 30, url: track.authorAvatarUrl)
                .overlay(Circle().strokeBorder(track.instrument.color, lineWidth: 2))
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: track.instrument.title)
                    .font(JamFont.text(13, .bold))
                    .foregroundStyle(Palette.paper)
                Text(verbatim: track.label ?? track.displayName)
                    .font(JamFont.text(12))
                    .foregroundStyle(Palette.paperMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            Button {
                Haptics.selection()
                model.audition(track)
            } label: {
                Label(hearing ? "Hearing" : "Listen", systemImage: hearing ? "speaker.wave.2.fill" : "play.fill")
                    .font(JamFont.text(12, .bold))
                    .foregroundStyle(hearing ? Palette.inkDeep : Palette.paperSubtle)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 44)
                    .background(Capsule().fill(hearing ? Palette.signal : Palette.surfaceRaised))
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("jam.take.listen")
            if model.canSetMix {
                Button {
                    Haptics.selection()
                    Task { await model.setInMix(track, true) }
                } label: {
                    Image(systemName: "plus.circle")
                        .font(JamFont.text(20))
                        .foregroundStyle(Palette.paperSubtle)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Put in the mix"))
                .accessibilityIdentifier("jam.take.mix")
            }
            JamVoteButton(
                count: track.voteCount, voted: model.isVoted(track.id),
                busy: model.busyVotes.contains(track.id),
                label: Text("Vote for \(JamTrackNaming.spoken(track))")
            ) { Task { await model.vote(track) } }
        }
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 2)
        .contextMenu {
            if model.canDelete(track) {
                Button(role: .destructive) { onDelete(track) } label: {
                    Label("Delete take", systemImage: "trash")
                }
            }
        }
    }
}
