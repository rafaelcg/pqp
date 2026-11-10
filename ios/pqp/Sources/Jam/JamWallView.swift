import SwiftUI

/// A song to open, with what the wall already knows about it.
struct JamSongRoute: Hashable, Identifiable {
    let song: JamSongSummary
    var id: String { song.id }
}

/// A jam channel on a phone: the whole screen is the wall. One strip of
/// filters at the top, then the songs as a mosaic of tiles of different sizes
/// (the newest or most active one large), pull to refresh, paging at the end.
struct JamWallView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var sizeClass

    @State private var model: JamWallModel
    @State private var openedSong: JamSongRoute?
    @State private var showingRecordInfo = false
    /// The first render staggers its tiles in; after that a tile that arrives
    /// uses the transition instead.
    @State private var hasEntered = false
    @Namespace private var zoomSpace
    /// The width the mosaic has, to size its cells.
    @State private var contentWidth: CGFloat = UIScreen.main.bounds.width

    private static let gap: CGFloat = 10
    private static let cellAspect: CGFloat = 0.92

    init(channel: Channel, server: Server) {
        _model = State(initialValue: JamWallModel(channel: channel, server: server))
    }

    private var columns: Int { sizeClass == .regular ? 4 : 2 }

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()
            content
        }
        .navigationTitle(model.channel.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Palette.ink, for: .navigationBar)
        .navigationDestination(item: $openedSong) { route in
            JamSongView(
                song: route.song, channel: model.channel, server: model.server,
                zoomSpace: zoomSpace, wall: model
            )
        }
        .sheet(isPresented: $showingRecordInfo) {
            JamRecordOnComputerSheet(
                title: nil,
                link: JamLinks.channel(serverId: model.server.id, channelId: model.channel.id)
            )
        }
        .task { await model.start(session: session) }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView().tint(Palette.signal)
        case .failed(let message):
            EmptyState(
                icon: "exclamationmark.triangle",
                title: "Could not load songs",
                message: LocalizedStringKey(message),
                actionTitle: "Try again",
                action: { Task { await model.load() } }
            )
        case .ready:
            if model.isEmptyWall {
                emptyWall
            } else {
                wall
            }
        }
    }

    private var emptyWall: some View {
        ScrollView {
            VStack(spacing: 18) {
                EmptyState(
                    icon: "music.note.list",
                    title: "No songs yet",
                    message: "A jam is a channel of songs, each built from recordings of different people playing together.",
                    actionTitle: "Record on the computer",
                    action: { showingRecordInfo = true }
                )
            }
            .padding(.top, 60)
        }
        .refreshable { await model.refresh() }
    }

    private var wall: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                filters
                let songs = model.visibleSongs
                if songs.isEmpty {
                    noMatch
                } else {
                    mosaic(songs)
                        .padding(.horizontal, Metrics.hPadding)
                        .animation(.jam(reduceMotion: reduceMotion), value: songs.map(\.id))
                }
                if model.isLoadingMore {
                    ProgressView().tint(Palette.paperMuted).frame(maxWidth: .infinity)
                } else if model.loadMoreFailed {
                    Button {
                        Task { await model.loadMore() }
                    } label: {
                        Label("Could not load more songs. Tap to try again", systemImage: "arrow.clockwise")
                            .font(JamFont.text(13, .semibold))
                            .foregroundStyle(Palette.warning)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 6)
            .padding(.bottom, 28)
        }
        .refreshable { await model.refresh() }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { contentWidth = $0 }
        .onAppear { hasEntered = true }
    }

    // MARK: The mosaic, in lazy bands

    /// Cells are square-ish; a tile spans whole cells plus the gaps between
    /// them, so a 2 x 2 is exactly four cells and nothing drifts.
    private func mosaic(_ songs: [JamSongSummary]) -> some View {
        let columns = self.columns
        let width = max(1, contentWidth - Metrics.hPadding * 2)
        let cellW = max(1, (width - Self.gap * CGFloat(columns - 1)) / CGFloat(columns))
        let cellH = cellW * Self.cellAspect
        var sizes = songs.enumerated().map { index, song in
            JamMosaic.desiredSize(index: index, song: song, hasVideo: JamTileFacts.resolve(song: song, preview: model.anyPreview(for: song)).hasVideo)
        }
        sizes.append(.small)  // the "your turn" tile closes the grid
        let bands = JamMosaic.bands(JamMosaic.layout(sizes: sizes, columns: columns))
        return LazyVStack(alignment: .leading, spacing: Self.gap) {
            ForEach(bands.indices, id: \.self) { b in
                let band = bands[b]
                let firstRow = band.map(\.row).min() ?? 0
                let rows = (band.map { $0.row + $0.rows }.max() ?? firstRow) - firstRow
                ZStack(alignment: .topLeading) {
                    ForEach(band, id: \.index) { p in
                        let w = CGFloat(p.columns) * cellW + CGFloat(p.columns - 1) * Self.gap
                        let h = CGFloat(p.rows) * cellH + CGFloat(p.rows - 1) * Self.gap
                        Group {
                            if p.index < songs.count {
                                tile(songs[p.index], size: sizes[p.index], index: p.index)
                            } else {
                                recordTile
                            }
                        }
                        .frame(width: w, height: h)
                        .offset(
                            x: CGFloat(p.column) * (cellW + Self.gap),
                            y: CGFloat(p.row - firstRow) * (cellH + Self.gap)
                        )
                    }
                }
                .frame(
                    width: width, height: CGFloat(rows) * cellH + CGFloat(max(0, rows - 1)) * Self.gap,
                    alignment: .topLeading
                )
            }
        }
    }

    // MARK: Filters

    private var filters: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(JamWallFilter.allCases) { option in
                    chip(option)
                }
            }
            .padding(.horizontal, Metrics.hPadding)
        }
        .scrollClipDisabled()
    }

    private func chip(_ option: JamWallFilter) -> some View {
        let selected = model.filter == option
        return Button {
            withAnimation(.jamQuick(reduceMotion: reduceMotion)) { model.filter = option }
        } label: {
            Text(option.title)
                .font(JamFont.text(14, selected ? .bold : .semibold))
                .foregroundStyle(selected ? Palette.ink : Palette.paperSubtle)
                .padding(.horizontal, 16)
                .frame(minHeight: 44)
                .background(Capsule().fill(selected ? Palette.paper : .clear))
                .overlay(Capsule().strokeBorder(selected ? .clear : Palette.border, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier("jam.filter.\(option.rawValue)")
    }

    private var noMatch: some View {
        VStack(spacing: 8) {
            Text("Nothing here")
                .font(JamFont.title(18))
                .foregroundStyle(Palette.paper)
            Text("No song matches this filter right now.")
                .font(Typography.callout)
                .foregroundStyle(Palette.paperMuted)
            if model.state.nextCursor != nil, !model.isLoadingMore {
                Button {
                    Task { await model.loadMore() }
                } label: {
                    Text("Look for more")
                        .font(JamFont.text(14, .semibold))
                        .foregroundStyle(Palette.paperSubtle)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 44)
                        .overlay(Capsule().strokeBorder(Palette.border, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
        // Nothing on the pages loaded matches, but a later one might: read on
        // for a couple of pages (bounded, so a filter with no match anywhere
        // is not a download of the whole channel), then leave it to the button.
        .task(id: model.state.songs.count) {
            if model.state.songs.count < JamLimits.pageSize * 3 { await model.loadMore() }
        }
    }

    // MARK: Tiles

    @ViewBuilder
    private func tile(_ song: JamSongSummary, size: JamTileSize, index: Int) -> some View {
        let preview = model.anyPreview(for: song)
        let _ = model.posterRevision
        Button {
            Haptics.selection()
            model.clearFresh(song.id)
            openedSong = JamSongRoute(song: song)
        } label: {
            JamTileView(
                song: song, size: size, preview: preview,
                poster: preview?.posterTrackId.flatMap { JamPosterCache.shared.cached(trackId: $0) },
                isFresh: model.state.fresh.contains(song.id)
            )
        }
        .buttonStyle(JamTilePressStyle(reduceMotion: reduceMotion))
        .jamMatchedSource(id: song.id, in: zoomSpace, enabled: !reduceMotion)
        .modifier(JamEntrance(index: index, entered: hasEntered, reduceMotion: reduceMotion))
        .transition(reduceMotion ? .opacity : .scale(scale: 0.9).combined(with: .opacity))
        .task(id: song.updatedAt) {
            model.requestPreview(for: song)
        }
        .task(id: preview?.posterTrackId) {
            guard let preview, let id = preview.posterTrackId, let url = preview.posterURL else { return }
            if await JamPosterCache.shared.poster(
                trackId: id, url: url, contentType: preview.posterContentType
            ) != nil {
                // The cache is not observable: touch the model so the tile
                // reads it again.
                model.posterArrived()
            }
        }
        .task { await model.loadMoreIfNeeded(after: song) }
    }

    /// "Tua vez": the end of the grid says where recording happens, calmly.
    private var recordTile: some View {
        Button {
            Haptics.selection()
            showingRecordInfo = true
        } label: {
            VStack(spacing: 8) {
                Image(systemName: "mic")
                    .font(JamFont.text(24, .regular))
                Text("Your turn")
                    .font(JamFont.text(14, .semibold))
                Text("Record on the computer")
                    .font(JamFont.text(11, .medium))
                    .foregroundStyle(Palette.paperMuted)
                    .multilineTextAlignment(.center)
            }
            .foregroundStyle(Palette.paperSubtle)
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                    .strokeBorder(Palette.border, style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(JamTilePressStyle(reduceMotion: reduceMotion))
        .accessibilityIdentifier("jam.recordTile")
    }
}

extension JamWallFilter {
    var title: LocalizedStringKey {
        switch self {
        case .all: "All"
        case .missing: "Needs someone"
        case .finished: "Finished"
        }
    }
}

// MARK: - Motion

struct JamTilePressStyle: ButtonStyle {
    let reduceMotion: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(reduceMotion ? nil : Motion.press, value: configuration.isPressed)
    }
}

/// The wall settling in: each tile rises a little and fades up, a beat after
/// the one before (`Motion.stagger`), once. Reduce Motion lands them at once.
struct JamEntrance: ViewModifier {
    let index: Int
    let entered: Bool
    let reduceMotion: Bool
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(shown || reduceMotion ? 1 : 0)
            .offset(y: shown || reduceMotion ? 0 : 16)
            .onAppear {
                guard !shown else { return }
                if entered {
                    // A tile that scrolled in later needs no stagger.
                    shown = true
                } else {
                    withAnimation(Motion.standard.delay(Motion.stagger(index, step: 0.05, cap: 0.4))) { shown = true }
                }
            }
    }
}

extension View {
    /// The tile a song opens out of (iOS 18's zoom). Earlier systems and
    /// Reduce Motion get the ordinary push.
    @ViewBuilder
    func jamMatchedSource(id: String, in namespace: Namespace.ID, enabled: Bool) -> some View {
        if #available(iOS 18.0, *), enabled {
            matchedTransitionSource(id: id, in: namespace)
        } else {
            self
        }
    }

    @ViewBuilder
    func jamZoomDestination(id: String, in namespace: Namespace.ID, enabled: Bool) -> some View {
        if #available(iOS 18.0, *), enabled {
            navigationTransition(.zoom(sourceID: id, in: namespace))
        } else {
            self
        }
    }
}

// MARK: - Links

enum JamLinks {
    /// The web's permalink for a jam channel.
    static func channel(serverId: String, channelId: String) -> URL? {
        URL(string: "https://pqp.gg/app/server/\(serverId)/channel/\(channelId)")
    }

    /// A song's permalink: `/app/server/<serverId>/channel/<jamChannelId>/song/<songId>`,
    /// the route the web answers (shaped like the forum's `/post/` link). The
    /// copy and share links of the song screen are exactly this.
    static func song(serverId: String, channelId: String, songId: String) -> URL? {
        URL(string: "https://pqp.gg/app/server/\(serverId)/channel/\(channelId)/song/\(songId)")
    }
}

// MARK: - Recording is on the computer

/// Where the web says "Gravar por cima", this phone says so honestly. Not a
/// dead button and not a promise: recording a stem in sync needs the latency
/// work the computer does, and a link is one tap from being there. The record
/// button that replaces this one keeps this sheet's slot in the song screen.
struct JamRecordOnComputerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String?
    let link: URL?
    @State private var copied = false

    var body: some View {
        VStack(spacing: 18) {
            Capsule().fill(Palette.border).frame(width: 36, height: 5).padding(.top, 8)
            Image(systemName: "desktopcomputer")
                .font(JamFont.text(38, .light))
                .foregroundStyle(Palette.paperMuted)
                .padding(.top, 12)
            Text("Recording is on the computer for now")
                .font(JamFont.title(22))
                .foregroundStyle(Palette.paper)
                .multilineTextAlignment(.center)
            Text("Open this on a computer, put your headphones on and play along. Your take lines up by itself and shows up here as soon as it is done.")
                .font(Typography.callout)
                .foregroundStyle(Palette.paperMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
            if let link {
                VStack(spacing: 10) {
                    Button {
                        UIPasteboard.general.string = link.absoluteString
                        Haptics.selection()
                        copied = true
                    } label: {
                        Label(copied ? "Link copied" : "Copy link", systemImage: copied ? "checkmark" : "link")
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .accessibilityIdentifier("jam.record.copy")
                    ShareLink(item: link, subject: Text(verbatim: title ?? "")) {
                        Label("Share link", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    .accessibilityIdentifier("jam.record.share")
                }
                .frame(maxWidth: 320)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.surface.ignoresSafeArea())
        .presentationDetents([.height(420), .medium])
        .presentationDragIndicator(.hidden)
    }
}
