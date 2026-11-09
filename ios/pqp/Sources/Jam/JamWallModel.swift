import Foundation
import Observation
import UIKit

/// What a tile knows about a song beyond its summary. The list carries no
/// media, no peaks and no names (`docs/JAM.md`: the summary is counts), so a
/// tile that wants a waveform, a poster or "rafa, duda, leo" reads the song's
/// detail once, lazily, as it scrolls into view.
struct JamPreview: Equatable, Sendable {
    /// The bump this was read at: a newer `updatedAt` on the summary says it is
    /// stale and the next appearance reads it again.
    let readAt: Date
    /// The mix's loudness across its length, for a coloured tile's waveform.
    let envelope: [Double]
    /// People with a track, in the order they joined.
    let contributors: [String]
    /// The first in-mix track with a video this build can draw a poster for.
    let posterTrackId: String?
    let posterURL: String?
    let posterContentType: String?
    let hasVideo: Bool

    static let envelopeBars = 48

    init(readAt: Date, tracks: [JamTrack]) {
        self.readAt = readAt
        envelope = JamPeaks.mixEnvelope(tracks: tracks, bars: Self.envelopeBars)
        var seen = Set<String>()
        contributors = tracks.compactMap { track in
            guard let name = track.authorName, seen.insert(track.authorId).inserted else { return nil }
            return name
        }
        let withVideo = tracks.filter { $0.hasVideo && $0.inMix }
        hasVideo = !withVideo.isEmpty
        let poster = withVideo.first { JamPosterCache.canPoster(contentType: $0.videoContentType) }
        posterTrackId = poster?.id
        posterURL = poster?.videoUrl
        posterContentType = poster?.videoContentType
    }
}

/// One jam channel's wall on screen: the pages, the filter, the live frames and
/// the lazily read previews. The rules for each live in `JamWallRules`; this
/// object fetches, holds and hands frames to them.
@MainActor
@Observable
final class JamWallModel {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(String)
    }

    let channel: Channel
    let server: Server

    private(set) var state = JamWallState()
    var filter: JamWallFilter = .all
    private(set) var config: JamConfig = .off
    private(set) var phase: Phase = .loading
    private(set) var isRefreshing = false
    private(set) var isLoadingMore = false
    /// The last page request failed: the wall offers a retry at its end.
    private(set) var loadMoreFailed = false
    private(set) var previews: [String: JamPreview] = [:]
    /// Bumped when a poster frame lands in `JamPosterCache`, which is not
    /// observable itself: tiles read it so they draw again.
    private(set) var posterRevision = 0

    @ObservationIgnored private weak var session: SessionStore?
    @ObservationIgnored private let handlerKey = "jam-wall-\(UUID().uuidString)"
    @ObservationIgnored private var started = false
    @ObservationIgnored private var generation = 0
    /// Live frames that arrive while a page-one read is in flight. The read's
    /// answer was produced before them, so replacing the wall with it would
    /// lose them; they are applied on top of it instead.
    @ObservationIgnored private var bufferedFrames: [JamFrame] = []
    @ObservationIgnored private var isReading = false
    @ObservationIgnored private var previewsInFlight: Set<String> = []
    @ObservationIgnored private var previewQueue: [String] = []
    @ObservationIgnored private var previewWorkers = 0
    @ObservationIgnored private let seen = JamSeenStore()

    init(channel: Channel, server: Server) {
        self.channel = channel
        self.server = server
    }

    /// The songs the filter lets through, in the server's order.
    var visibleSongs: [JamSongSummary] { state.songs.filter(filter.matches) }

    var isEmptyWall: Bool { phase == .ready && state.isEmpty }

    // MARK: - Lifecycle

    /// Once per appearance. The handler holds this model weakly and removes
    /// itself once the model is gone, so it stays registered while a song is
    /// pushed on top (the wall keeps up) and does not outlive the screen.
    func start(session: SessionStore) async {
        self.session = session
        if started {
            await session.realtime.join(channelId: channel.id)
            await refresh()
            return
        }
        started = true
        let key = handlerKey
        session.eventHandlers[key] = { [weak self, weak session] event in
            guard let self else {
                session?.eventHandlers.removeValue(forKey: key)
                return
            }
            self.apply(event)
        }
        await session.realtime.join(channelId: channel.id)
        async let configAnswer = session.api.jamConfig(serverId: server.id)
        await load()
        config = await configAnswer
    }

    func load() async {
        guard let session else { return }
        generation += 1
        let request = generation
        if state.isEmpty { phase = .loading } else { isRefreshing = true }
        loadMoreFailed = false
        isReading = true
        bufferedFrames = []
        defer {
            if request == generation {
                isRefreshing = false
                isReading = false
                bufferedFrames = []
            }
        }
        do {
            let page = try await session.api.jamSongs(channelId: channel.id)
            guard request == generation else { return }
            state.replace(with: page)
            // What happened while the read was out, on top of what it says.
            for frame in bufferedFrames { state.apply(frame, channelId: channel.id) }
            phase = .ready
            markSeen()
        } catch {
            guard request == generation else { return }
            // A wall already on screen keeps it; only a first read fails loud.
            if state.isEmpty {
                phase = .failed((error as? APIError)?.errorDescription ?? error.localizedDescription)
            }
        }
    }

    /// Pull to refresh. Throws nothing: a failed refresh keeps the wall.
    func refresh() async {
        await load()
        if let session { config = await session.api.jamConfig(serverId: server.id) }
    }

    func loadMoreIfNeeded(after song: JamSongSummary) async {
        guard song.id == state.songs.last?.id else { return }
        await loadMore()
    }

    /// The next page. An answer that a refresh has overtaken (the cursor it
    /// followed is no longer the wall's) is dropped, and a failure leaves a
    /// retry in place of the end of the wall.
    func loadMore() async {
        guard let session, let cursor = state.nextCursor, !isLoadingMore else { return }
        let request = generation
        isLoadingMore = true
        loadMoreFailed = false
        defer { isLoadingMore = false }
        do {
            let page = try await session.api.jamSongs(channelId: channel.id, cursor: cursor)
            guard request == generation, state.nextCursor == cursor else { return }
            state.append(page: page)
        } catch {
            if request == generation { loadMoreFailed = true }
        }
    }

    private func markSeen() {
        guard let newest = state.songs.first?.updatedAt else { return }
        seen.markSeen(channelId: channel.id, at: newest)
    }

    // MARK: - Live frames

    func apply(_ event: RealtimeEvent) {
        guard case .jam(let frame) = event else { return }
        if isReading { bufferedFrames.append(frame) }
        let before = state
        if state.apply(frame, channelId: channel.id), before != state {
            // Looking at the wall is reading it.
            markSeen()
        }
        if case .songDeleted(_, let songId) = frame { previews.removeValue(forKey: songId) }
    }

    func clearFresh(_ id: String) { state.clearFresh(id) }

    func posterArrived() { posterRevision += 1 }

    // MARK: - Previews

    func preview(for song: JamSongSummary) -> JamPreview? {
        guard let preview = previews[song.id], preview.readAt >= song.updatedAt else { return nil }
        return preview
    }

    /// The best a tile can say right now: a current preview, else a stale one
    /// (better a waveform from a minute ago than a flash of nothing).
    func anyPreview(for song: JamSongSummary) -> JamPreview? { previews[song.id] }

    /// Ask for a song's preview. Queued and at most three at a time, so a fast
    /// scroll over twenty tiles is three requests in flight, not twenty.
    func requestPreview(for song: JamSongSummary) {
        guard song.trackCount > 0, preview(for: song) == nil else { return }
        guard !previewsInFlight.contains(song.id), !previewQueue.contains(song.id) else { return }
        previewQueue.append(song.id)
        pumpPreviews()
    }

    private func pumpPreviews() {
        while previewWorkers < 3, !previewQueue.isEmpty {
            let id = previewQueue.removeFirst()
            previewsInFlight.insert(id)
            previewWorkers += 1
            Task { [weak self] in
                await self?.readPreview(id: id)
                self?.previewWorkers -= 1
                self?.pumpPreviews()
            }
        }
    }

    private func readPreview(id: String) async {
        defer { previewsInFlight.remove(id) }
        guard let session else { return }
        guard let detail = try? await session.api.jamSong(id: id) else { return }
        previews[id] = JamPreview(readAt: detail.song.updatedAt, tracks: detail.tracks)
    }
}

// MARK: - The channel list's side of it

/// Everything the channel list needs to draw jam rows: whether jam is on for
/// this server, and per channel the song count and whether something is new.
/// One object so `ChannelListView` carries a single extra property.
@MainActor
@Observable
final class JamListModel {
    private(set) var config: JamConfig = .off
    private(set) var rows: [String: JamRowSummary] = [:]

    @ObservationIgnored private let seen = JamSeenStore()

    /// With the flag off the row is not drawn at all: an unflagged server must
    /// look exactly as it does without this feature.
    var isEnabled: Bool { config.enabled }

    func row(for channelId: String) -> JamRowSummary? { rows[channelId] }

    func refresh(session: SessionStore, serverId: String, jamChannelIds: [String]) async {
        let answer = await session.api.jamConfig(serverId: serverId)
        config = answer
        guard answer.enabled else {
            rows = [:]
            return
        }
        let viewerId = session.currentUser?.id
        let seen = self.seen
        let api = session.api
        // One request per jam channel, all at once (a server has a handful).
        let answers: [(String, JamSongListResponse?)] = await withTaskGroup(
            of: (String, JamSongListResponse?).self
        ) { group in
            for id in jamChannelIds {
                group.addTask {
                    (id, try? await api.jamSongs(channelId: id, limit: JamLimits.pageMax))
                }
            }
            var all: [(String, JamSongListResponse?)] = []
            for await answer in group { all.append(answer) }
            return all
        }
        var next: [String: JamRowSummary] = [:]
        for (id, page) in answers {
            guard let page else {
                // A failed read keeps what the row said.
                if let old = rows[id] { next[id] = old }
                continue
            }
            let newest = page.songs.first
            let mine = newest.map { $0.authorId == viewerId && $0.updatedAt == $0.createdAt } ?? false
            next[id] = JamRowSummary(
                songCount: page.songs.count,
                hasMore: page.nextCursor != nil,
                isUnread: JamUnread.isUnread(
                    newestBump: newest?.updatedAt,
                    lastSeen: seen.lastSeen(channelId: id),
                    newestBumpIsMine: mine
                )
            )
        }
        rows = next
    }
}
