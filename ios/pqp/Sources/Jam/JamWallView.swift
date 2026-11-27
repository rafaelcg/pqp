import SwiftUI

/// A new song's studio to open.
struct JamStudioRoute: Identifiable {
    let id = UUID()
    /// The new song to make, or nil for a part on a song that exists.
    let draft: JamSongDraft?
}

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
    @State private var showingNewSong = false
    /// The link's song is read once per wall, whatever the parent does with
    /// the id afterwards.
    @State private var tookInitialSong = false
    @State private var studio: JamStudioRoute?
    /// "N partes esperando" across several songs: which one to open.
    @State private var pickingWaitingSong = false
    /// The first render staggers its tiles in; after that a tile that arrives
    /// uses the transition instead.
    @State private var hasEntered = false
    @Namespace private var zoomSpace
    /// The width the mosaic has, to size its cells.
    @State private var contentWidth: CGFloat = UIScreen.main.bounds.width

    private static let gap: CGFloat = 10
    private static let cellAspect: CGFloat = 0.92

    /// A song link's song: opened on top of the wall once it has loaded.
    private let initialSongId: String?
    private let onInitialSongHandled: () -> Void

    init(
        channel: Channel, server: Server,
        initialSongId: String? = nil, onInitialSongHandled: @escaping () -> Void = {}
    ) {
        _model = State(initialValue: JamWallModel(channel: channel, server: server))
        self.initialSongId = initialSongId
        self.onInitialSongHandled = onInitialSongHandled
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
        .searchable(text: $model.searchText, prompt: Text("Search songs"))
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .onChange(of: model.searchText) { _, now in
            if now.count > JamSongSearch.maxLength { model.searchText = String(now.prefix(JamSongSearch.maxLength)) }
        }
        // Typing cancels the last search; it asks once the words have settled.
        .task(id: model.searchText) { await model.runSearch() }
        .navigationDestination(item: $openedSong) { route in
            JamSongView(
                song: route.song, channel: model.channel, server: model.server,
                zoomSpace: zoomSpace, wall: model
            )
        }
        .sheet(isPresented: $showingNewSong) {
            JamNewSongSheet { draft in
                // The sheet is closing: the studio opens after it has left.
                Task {
                    try? await Task.sleep(for: .milliseconds(350))
                    studio = JamStudioRoute(draft: draft)
                }
            }
        }
        .fullScreenCover(item: $studio) { route in
            JamStudioView(
                model: JamRecordModel(
                    channel: model.channel, server: model.server, destination: .draft(route.draft ?? JamSongDraft()), band: [],
                    addable: JamInstrument.allCases, instrument: .guitar
                )
            ) { result in
                studio = nil
                guard let result else { return }
                // The song exists now: show it, with the take in it.
                Task {
                    await model.refresh()
                    openedSong = JamSongRoute(song: result.song)
                }
            }
        }
        .sheet(isPresented: $pickingWaitingSong) {
            JamWaitingSongsSheet(
                rows: waitingRows,
                onOpen: { song in
                    pickingWaitingSong = false
                    // The sheet is closing: the song opens after it has left.
                    Task {
                        try? await Task.sleep(for: .milliseconds(350))
                        openedSong = JamSongRoute(song: song)
                    }
                }
            )
        }
        .task { await model.start(session: session) }
        // A card never covers the wall (its own row and pills say the same thing).
        .onAppear { session.jamPublic.songOpened("wall:\(model.channel.id)") }
        .onDisappear { session.jamPublic.songClosed("wall:\(model.channel.id)") }
        // The starter's inbox is read again whenever the wall opens: what a push
        // brought them here for may have beaten the first read.
        .task { await session.jamPublic.refresh() }
        // A song link. Its own task so the wall's load is never held up by it,
        // and so a slow song read cannot leave the wall blank. Not keyed on the
        // id: the parent clears the id the moment the link is taken, and a
        // keyed task would be cancelled by that very change.
        .task { await openInitialSong() }
    }

    /// Opens the song a link named. The wall is already under it, so every way
    /// this can fail leaves a screen with the songs on it, and says why:
    /// a song that is gone, or one that lives in another jam (a link edited by
    /// hand), is "not available"; a failed read is "try again".
    private func openInitialSong() async {
        guard !tookInitialSong, let id = initialSongId else { return }
        tookInitialSong = true
        onInitialSongHandled()
        do {
            let detail = try await session.api.jamSong(id: id)
            guard JamSongLinkRules.belongs(detail.song, toChannel: model.channel.id) else {
                await report(JamSongLinkMessage.unavailable)
                return
            }
            openedSong = JamSongRoute(song: detail.song)
        } catch {
            await report(JamSongLinkMessage.forFailure(error))
        }
    }

    /// The wall is still being pushed when a fast refusal arrives, and an alert
    /// raised mid-push drops the push (the person ended on the channel list,
    /// without the wall). It speaks once the stack has stopped moving, so the
    /// alert always lands over the wall.
    private func report(_ message: String) async {
        await NavigationSettle.untilIdle()
        guard !Task.isCancelled else { return }
        session.linkError = message
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
                if canStartSong {
                    EmptyState(
                        icon: "music.note.list",
                        title: "No songs yet",
                        message: "A jam is a channel of songs, each built from recordings of different people playing together.",
                        actionTitle: "Record the first song",
                        action: { showingNewSong = true }
                    )
                } else {
                    EmptyState(
                        icon: "music.note.list",
                        title: "No songs yet",
                        message: "A jam is a channel of songs, each built from recordings of different people playing together."
                    )
                }
            }
            .padding(.top, 60)
        }
        .refreshable { await model.refresh() }
    }

    private var wall: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                waitingRow
                if model.search != .idle {
                    searchResults
                } else {
                    browse
                }
            }
            .padding(.top, 6)
            .padding(.bottom, 28)
        }
        .refreshable { await model.refresh() }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { contentWidth = $0 }
        .onAppear { hasEntered = true }
    }

    /// The filters and the mosaic, with the end of the pages.
    @ViewBuilder
    private var browse: some View {
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
    }

    // MARK: Search results

    /// The songs the server found for the words: a plain list, one row each,
    /// never the mosaic (a result is something to open, not to browse).
    @ViewBuilder
    private var searchResults: some View {
        switch model.search {
        case .idle:
            EmptyView()
        case .searching:
            ProgressView().tint(Palette.signal).frame(maxWidth: .infinity).padding(.top, 40)
        case .results(let words, let songs):
            if songs.isEmpty {
                VStack(spacing: 8) {
                    Text("No song found")
                        .font(JamFont.title(18))
                        .foregroundStyle(Palette.paper)
                    Text("Nothing in this jam matches \"\(words)\", by title or artist.")
                        .font(Typography.callout)
                        .foregroundStyle(Palette.paperMuted)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, Metrics.hPadding)
                .padding(.top, 50)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("jam.search.empty")
            } else {
                VStack(spacing: 0) {
                    Text("\(songs.count) songs")
                        .font(Typography.label)
                        .tracking(1.2)
                        .foregroundStyle(Palette.paperMuted)
                        .textCase(.uppercase)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Metrics.hPadding)
                        .padding(.bottom, 6)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(Array(songs.enumerated()), id: \.element.id) { index, song in
                        if index > 0 { Rectangle().fill(Palette.border).frame(height: 1).padding(.horizontal, Metrics.hPadding) }
                        Button {
                            Haptics.selection()
                            openedSong = JamSongRoute(song: song)
                        } label: {
                            JamSearchRow(song: song)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("jam.search.result")
                    }
                }
            }
        }
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
        if canStartSong { sizes.append(.small) }  // the "your turn" tile closes the grid
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

    // MARK: Parts waiting for the starter

    /// What waits for this account on THIS wall's songs (the inbox is account
    /// wide: the other jams' and standalone songs are not this wall's to open).
    private var waitingOnWall: [JamPublicInboxItem] {
        JamWaiting.onWall(session.jamPublic.inbox, songIds: Set(model.state.songs.map(\.id)))
    }

    private var waitingCounts: [String: Int] { JamWaiting.counts(in: waitingOnWall) }

    private var waitingRows: [JamWaitingRow] {
        let counts = waitingCounts
        return model.state.songs.compactMap { song in
            counts[song.id].map { JamWaitingRow(song: song, count: $0) }
        }
    }

    /// "N partes esperando tua resposta": the quiet row above the wall. With every
    /// waiting part on ONE song its button opens that song, where they are the
    /// first thing on the page; across several it asks which.
    @ViewBuilder
    private var waitingRow: some View {
        let total = waitingOnWall.count
        if total > 0 {
            HStack(spacing: 12) {
                Text("\(total) parts waiting for your answer")
                    .font(JamFont.text(14, .semibold))
                    .foregroundStyle(Palette.paper)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    Haptics.selection()
                    let rows = waitingRows
                    if rows.count == 1, let only = rows.first {
                        openedSong = JamSongRoute(song: only.song)
                    } else {
                        pickingWaitingSong = true
                    }
                } label: {
                    Text("See")
                        .font(JamFont.text(14, .bold))
                        .lineLimit(1)
                        .fixedSize()
                        .foregroundStyle(Palette.inkDeep)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 44)
                        .background(Capsule().fill(Palette.signal))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("jam.waiting.see")
            }
            .padding(.leading, 14)
            .padding(.trailing, 8)
            .padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).fill(Palette.surface))
            .overlay(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).strokeBorder(Palette.border, lineWidth: 1))
            .padding(.horizontal, Metrics.hPadding)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("jam.waiting")
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
                isFresh: model.state.fresh.contains(song.id),
                waiting: waitingCounts[song.id] ?? 0
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
            // A song with a cover never reads its video for a poster: the
            // picture is what the tile shows.
            guard song.cover == nil, let preview, let id = preview.posterTrackId, let url = preview.posterURL else { return }
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

    /// Whether this phone may start a song here: the flag is on for the server
    /// and storage is configured (`GET /api/jam/config`).
    private var canStartSong: Bool { model.config.enabled && model.config.uploads }

    /// "Tua vez": the end of the grid is where a song starts.
    private var recordTile: some View {
        Button {
            Haptics.selection()
            showingNewSong = true
        } label: {
            VStack(spacing: 8) {
                Image(systemName: "mic")
                    .font(JamFont.text(24, .regular))
                Text("Your turn")
                    .font(JamFont.text(14, .semibold))
                Text("Record a song")
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
                    ShareLink(item: link, subject: Text(verbatim: JamBidi.clean(title ?? ""))) {
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


// MARK: - Which song is asking

struct JamWaitingRow: Identifiable, Equatable {
    let song: JamSongSummary
    let count: Int
    var id: String { song.id }
}

/// The wall's row across more than one song: each song with parts waiting,
/// one tap to open it (the web's `JamInboxDialog`).
struct JamWaitingSongsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let rows: [JamWaitingRow]
    let onOpen: (JamSongSummary) -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Hearing and deciding happens in the song itself, with the band playing, so each row opens it.")
                        .font(JamFont.text(13))
                        .foregroundStyle(Palette.paperMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    VStack(spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            if index > 0 { Rectangle().fill(Palette.border).frame(height: 1) }
                            Button { onOpen(row.song) } label: {
                                HStack(spacing: 10) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(verbatim: JamBidi.clean(row.song.title))
                                            .font(JamFont.text(15, .bold))
                                            .foregroundStyle(Palette.paper)
                                            .multilineTextAlignment(.leading)
                                        Text("\(row.count) waiting")
                                            .font(JamFont.text(13, .semibold))
                                            .foregroundStyle(Palette.paperMuted)
                                    }
                                    Spacer(minLength: 0)
                                    Image(systemName: "chevron.right")
                                        .font(JamFont.text(13, .bold))
                                        .foregroundStyle(Palette.paperMuted)
                                        .accessibilityHidden(true)
                                }
                                .padding(.horizontal, 14)
                                .frame(minHeight: 56)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text(verbatim: JamBidi.clean(row.song.title)))
                            .accessibilityValue(Text("\(row.count) parts waiting for your answer"))
                            .accessibilityIdentifier("jam.waiting.song")
                        }
                    }
                    .background(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).fill(Palette.surfaceRaised))
                }
                .padding(Metrics.hPadding)
            }
            .background(Palette.ink.ignoresSafeArea())
            .navigationTitle("Parts waiting for you")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}


// MARK: - A found song

/// One result: the title, who is on it and what it needs, the way a tile says
/// them, on a row. One accessibility element that says all three.
struct JamSearchRow: View {
    let song: JamSongSummary

    private var who: String {
        JamWho.line(song: song, contributors: song.contributors.map { $0.compactMap(\.name) })
    }

    private var subtitle: String {
        var parts: [String] = []
        let artist = JamBidi.isolateOpt(song.artist)
        if !artist.isEmpty { parts.append(artist) }
        if !who.isEmpty { parts.append(who) }
        return parts.joined(separator: " \u{00B7} ")
    }

    var body: some View {
        let need = JamNeed.of(song)
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: JamBidi.clean(song.title))
                    .font(JamFont.text(16, .bold))
                    .foregroundStyle(Palette.paper)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                if !subtitle.isEmpty {
                    Text(verbatim: subtitle)
                        .font(JamFont.text(13, .semibold))
                        .foregroundStyle(Palette.paperMuted)
                        .lineLimit(2)
                }
                Text(verbatim: need.text)
                    .font(JamFont.text(12, .bold))
                    .foregroundStyle(need.isCallout ? Palette.signal : Palette.paperSubtle)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(JamFont.text(13, .bold))
                .foregroundStyle(Palette.paperMuted)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, Metrics.hPadding)
        .frame(minHeight: 64)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: JamBidi.clean([song.title, subtitle, need.text].filter { !$0.isEmpty }.joined(separator: ", "))))
        .accessibilityHint(Text("Opens the song"))
        .accessibilityAddTraits(.isButton)
    }
}
