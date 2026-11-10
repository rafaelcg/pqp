import AVFoundation
import SwiftUI

/// One song: the stage (the videos, or the song's colour), the title, the
/// stack of stems with a playhead running across them, the takes waiting for a
/// vote, and a transport at the thumb. Scrubbing is a drag on the ruler or a tap
/// on any lane; everything else about the mix is per track and local.
struct JamSongView: View {
    @Environment(SessionStore.self) private var session
    @Environment(VoiceModel.self) private var voice
    @Environment(CallModel.self) private var call
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize

    @State private var model: JamSongModel
    @State private var showingRecordInfo = false
    @State private var confirmingDeleteSong = false
    @State private var trackToDelete: JamTrack?
    @State private var scrubbing = false
    let zoomSpace: Namespace.ID
    let wall: JamWallModel?

    init(song: JamSongSummary, channel: Channel, server: Server, zoomSpace: Namespace.ID, wall: JamWallModel?) {
        _model = State(initialValue: JamSongModel(song: song, channel: channel, server: server))
        self.zoomSpace = zoomSpace
        self.wall = wall
    }

    private var callActive: Bool { voice.holdsSeat || call.phase.isInRoom }
    private var songLink: URL? {
        JamLinks.song(serverId: model.server.id, channelId: model.channel.id, songId: model.song.id)
    }

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()
            content
            if model.isSongGone { goneOverlay }
        }
        .navigationTitle(model.song.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Palette.ink, for: .navigationBar)
        .toolbar { toolbar }
        .safeAreaInset(edge: .bottom, spacing: 0) { transport }
        .overlay(alignment: .top) { noticeBanner }
        .jamZoomDestination(id: model.song.id, in: zoomSpace, enabled: !reduceMotion)
        .sheet(isPresented: $showingRecordInfo) {
            JamRecordOnComputerSheet(title: model.song.title, link: songLink)
        }
        .confirmationDialog("Delete this song?", isPresented: $confirmingDeleteSong, titleVisibility: .visible) {
            Button("Delete song", role: .destructive) {
                Task { if await model.deleteSong() { dismiss() } }
            }
        } message: {
            Text("Every take on it goes too. This cannot be undone.")
        }
        .confirmationDialog(
            "Delete this take?",
            isPresented: Binding(get: { trackToDelete != nil }, set: { if !$0 { trackToDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete take", role: .destructive) {
                if let track = trackToDelete { Task { await model.deleteTrack(track) } }
                trackToDelete = nil
            }
        }
        .task {
            model.callActive = callActive
            await model.start(session: session)
        }
        .onChange(of: callActive) { _, now in model.callActive = now }
        .onDisappear { model.stop() }
        .sensoryFeedback(.impact(weight: .medium), trigger: model.isPlaying)
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView().tint(Palette.signal)
        case .failed(let message):
            EmptyState(
                icon: "exclamationmark.triangle",
                title: "Could not load this song",
                message: LocalizedStringKey(message),
                actionTitle: "Try again",
                action: { Task { await model.load(); await model.syncEngine() } }
            )
        case .ready:
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    JamStageView(model: model)
                    header
                    if let progress = model.loading { loadingRow(progress) }
                    if model.downloadFailed { retryRow }
                    JamStackView(model: model, scrubbing: $scrubbing, onDelete: { trackToDelete = $0 })
                    JamOtherTakesView(model: model, onDelete: { trackToDelete = $0 })
                    Color.clear.frame(height: 8)
                }
                .padding(.bottom, 12)
            }
            .scrollDisabled(scrubbing)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: model.song.title)
                .font(JamFont.title(26))
                .foregroundStyle(Palette.paper)
                .fixedSize(horizontal: false, vertical: true)
            Text(verbatim: headerLine)
                .font(JamFont.text(14))
                .foregroundStyle(Palette.paperMuted)
            JamInstrumentChips(song: model.song, tracks: model.tracks)
        }
        .padding(.horizontal, Metrics.hPadding)
        .accessibilityElement(children: .contain)
    }

    private var headerLine: String {
        var parts: [String] = []
        if let artist = model.song.artist, !artist.isEmpty { parts.append(artist) }
        parts.append(model.song.authorName ?? String(localized: "Deleted account"))
        return parts.joined(separator: " \u{00B7} ")
    }

    private func loadingRow(_ progress: (done: Int, total: Int)) -> some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small).tint(Palette.signal)
            Text("Getting the tracks \(progress.done) of \(progress.total)")
                .font(JamFont.text(13, .medium))
                .foregroundStyle(Palette.paperMuted)
        }
        .padding(.horizontal, Metrics.hPadding)
        .transition(.opacity)
    }

    private var retryRow: some View {
        Button {
            Task { await model.load(); await model.syncEngine() }
        } label: {
            Label("Some tracks did not download. Tap to try again", systemImage: "arrow.clockwise")
                .font(JamFont.text(13, .semibold))
                .foregroundStyle(Palette.warning)
        }
        .padding(.horizontal, Metrics.hPadding)
    }

    // MARK: Chrome

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if let songLink {
                    Button {
                        UIPasteboard.general.string = songLink.absoluteString
                        Haptics.selection()
                    } label: {
                        Label("Copy link", systemImage: "link")
                    }
                    ShareLink(item: songLink) {
                        Label("Share link", systemImage: "square.and.arrow.up")
                    }
                }
                if model.canDeleteSong {
                    Divider()
                    Button(role: .destructive) { confirmingDeleteSong = true } label: {
                        Label("Delete song", systemImage: "trash")
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
            }
            .tint(Palette.paper)
            .accessibilityIdentifier("jam.song.menu")
        }
    }

    private var transport: some View {
        HStack(spacing: 14) {
            Button {
                model.togglePlay()
            } label: {
                Image(systemName: model.isPlaying ? "pause.fill" : "play.fill")
                    .font(JamFont.text(22, .bold))
                    .foregroundStyle(Palette.inkDeep)
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: 56, height: 56)
                    .background(Circle().fill(Palette.signal))
            }
            .buttonStyle(JamTilePressStyle(reduceMotion: reduceMotion))
            .disabled(model.phase != .ready || model.tracks.isEmpty)
            .accessibilityLabel(Text(model.isPlaying ? "Pause" : "Play"))
            .accessibilityIdentifier("jam.song.play")

            JamClock(model: model)

            Spacer(minLength: 8)

            if !JamPermissions.canRecordHere {
                Button {
                    Haptics.selection()
                    showingRecordInfo = true
                } label: {
                    Label("On the computer", systemImage: "desktopcomputer")
                        .labelStyle(JamCompactLabelStyle(iconOnly: typeSize.isAccessibilitySize))
                        .lineLimit(1)
                        .font(JamFont.text(13, .semibold))
                        .foregroundStyle(Palette.paperSubtle)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .overlay(Capsule().strokeBorder(Palette.border, lineWidth: 1))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Record on the computer"))
                .accessibilityIdentifier("jam.song.record")
            }
        }
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 10)
        .background(Palette.surface.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(Palette.border).frame(height: 1) }
    }

    @ViewBuilder
    private var noticeBanner: some View {
        if let notice = model.notice {
            Text(verbatim: notice)
                .font(JamFont.text(13, .semibold))
                .foregroundStyle(Palette.paper)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Capsule().fill(Palette.surfaceRaised))
                .overlay(Capsule().strokeBorder(Palette.border, lineWidth: 1))
                .padding(.top, 8)
                .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                .task(id: notice) {
                    try? await Task.sleep(for: .seconds(3.5))
                    model.clearNotice()
                }
                .accessibilityAddTraits(.updatesFrequently)
        }
    }

    private var goneOverlay: some View {
        ZStack {
            Palette.ink.opacity(0.96).ignoresSafeArea()
            EmptyState(
                icon: "trash",
                title: "This song was deleted",
                message: "Somebody took it down while you were in it.",
                actionTitle: "Back to the songs",
                action: { dismiss() }
            )
        }
        .transition(.opacity)
    }
}

// MARK: - The clock

/// 0:14 / 0:42, sampled from the engine at the frame rate while playing.
struct JamClock: View {
    let model: JamSongModel

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.2, paused: !model.isPlaying)) { _ in
            let _ = model.seekRevision
            Text(verbatim: "\(JamTime.clock(model.positionMs)) / \(JamTime.clock(model.durationMs))")
                .font(JamFont.text(14, .medium).monospacedDigit())
                .foregroundStyle(Palette.paperMuted)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Position"))
        .accessibilityValue(Text(verbatim: "\(JamTime.clock(model.positionMs)) / \(JamTime.clock(model.durationMs))"))
    }
}

// MARK: - Instrument chips

/// Who is on the song and what is still open: a filled chip with the colour's
/// dot for an instrument with a take, a dashed one for what the author is
/// still looking for ("Voz livre").
struct JamInstrumentChips: View {
    let song: JamSongSummary
    let tracks: [JamTrack]

    private var present: [JamInstrument] {
        JamInstrument.allCases.filter { instrument in tracks.contains { $0.instrument == instrument } }
    }

    private var open: [JamInstrument] {
        song.joinMode == .wanted ? song.wantedInstruments.filter { !present.contains($0) } : []
    }

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(present, id: \.self) { instrument in
                HStack(spacing: 6) {
                    Circle().fill(instrument.color).frame(width: 8, height: 8)
                    Text(verbatim: JamTrackNaming.chip(instrument: instrument, tracks: tracks))
                        .lineLimit(1)
                }
                .font(JamFont.text(12, .bold))
                .foregroundStyle(Palette.paper)
                .padding(.horizontal, 10)
                .frame(height: 28)
                .background(Capsule().fill(instrument.color.opacity(0.22)))
            }
            ForEach(open, id: \.self) { instrument in
                Text("\(instrument.title) open")
                    .font(JamFont.text(12, .semibold))
                    .foregroundStyle(Palette.paperSubtle)
                    .padding(.horizontal, 10)
                    .frame(height: 26)
                    .overlay(Capsule().strokeBorder(Palette.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
            }
            if song.joinMode == .open {
                Text("Anyone can join")
                    .font(JamFont.text(12, .semibold))
                    .foregroundStyle(Palette.paperSubtle)
                    .padding(.horizontal, 10)
                    .frame(height: 26)
                    .overlay(Capsule().strokeBorder(Palette.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
            }
        }
    }
}

/// Chips that wrap.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? 320, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(width: bounds.width, subviews: subviews)
        for (index, origin) in result.origins.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y),
                proposal: .unspecified
            )
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
        var origins: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var maxX: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            maxX = max(maxX, x - spacing)
        }
        return (CGSize(width: maxX, height: y + rowHeight), origins)
    }
}


/// At accessibility text sizes the transport has no room for the words: the
/// icon alone stays (the button keeps its spoken label).
struct JamCompactLabelStyle: LabelStyle {
    let iconOnly: Bool

    func makeBody(configuration: Configuration) -> some View {
        if iconOnly {
            configuration.icon
        } else {
            Label(configuration)
        }
    }
}
