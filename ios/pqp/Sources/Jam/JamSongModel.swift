import AVFoundation
import Foundation
import Observation

/// One song on screen: its tracks, what this phone is doing to the mix, the
/// transport, and the live frames that move all of it.
///
/// WHAT IS LOCAL. Mute, solo, volume and auditioning a competing take are this
/// phone's alone (they are how a person listens), and never leave it. What
/// reaches the server is a vote, the in-mix switch (author or moderator) and a
/// delete. The engine plays `JamMixRules.activeTracks`.
@MainActor
@Observable
final class JamSongModel {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(String)
    }

    let channel: Channel
    let server: Server

    private(set) var state: JamSongState
    private(set) var phase: Phase = .loading
    private(set) var isPlaying = false
    /// Stems being fetched, `done` of `total`. Nil when nothing is loading.
    private(set) var loading: (done: Int, total: Int)?
    /// Tracks CoreAudio could not open, so their row says so.
    private(set) var unplayable: Set<String> = []
    /// A track whose download failed (offline, expired link): a retry is one tap.
    private(set) var downloadFailed = false
    private(set) var notice: String?
    private(set) var busyVotes: Set<String> = []
    /// Bumped when the playhead is moved from outside the tick (a scrub), so
    /// the clock redraws while paused.
    private(set) var seekRevision = 0

    var volumes: [String: Double] = [:]
    private(set) var muted: Set<String> = []
    private(set) var soloed: Set<String> = []
    private(set) var auditioning: [JamInstrument: String] = [:]
    var expandedTrackId: String?

    /// Set from the environment (`voice.holdsSeat || call.phase.isInRoom`).
    @ObservationIgnored var callActive = false

    @ObservationIgnored let engine = JamEngine()
    @ObservationIgnored let video = JamVideoSync()
    @ObservationIgnored private let audioSession = JamAudioSession()
    @ObservationIgnored private weak var session: SessionStore?
    @ObservationIgnored private let handlerKey = "jam-song-\(UUID().uuidString)"
    @ObservationIgnored private var files: [String: URL] = [:]
    @ObservationIgnored private var syncGeneration = 0
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var started = false
    /// Bumped by `stop`: work that was started before it finds the number
    /// changed and does nothing (a download finishing after the screen left).
    @ObservationIgnored private var lifecycle = 0
    /// Frames that arrive while the detail read is out. The read was produced
    /// before them, so they are applied on top of its answer.
    @ObservationIgnored private var bufferedFrames: [JamFrame] = []
    @ObservationIgnored private var isReading = false
    @ObservationIgnored private var interruptionObserver: NSObjectProtocol?
    @ObservationIgnored private var routeObserver: NSObjectProtocol?
    @ObservationIgnored private var lastNowPlaying = Date.distantPast

    init(song: JamSongSummary, channel: Channel, server: Server) {
        self.channel = channel
        self.server = server
        state = JamSongState(song: song, tracks: [], viewer: .none)
    }

    // MARK: - What the screen reads

    var song: JamSongSummary { state.song }
    var tracks: [JamTrack] { state.tracks }
    var viewer: JamSongViewer { state.viewer }
    var viewerId: String? { session?.currentUser?.id }

    var active: [JamTrack] { JamMixRules.activeTracks(tracks, auditioning: auditioning) }
    var stack: [JamTrack] { JamMixRules.stack(tracks, auditioning: auditioning) }
    var otherTakes: [JamTrack] { JamMixRules.otherTakes(tracks, auditioning: auditioning) }
    var timeline: (originMs: Double, durationMs: Double) { JamMixRules.timeline(of: active) }
    var durationMs: Double { timeline.durationMs }

    /// The playhead, ms from the origin. Read from a `TimelineView`, so it is
    /// the engine's own clock sampled at the frame rate and not a published
    /// value fighting for 60 invalidations a second.
    var positionMs: Double { engine.positionMs }

    var isSongGone: Bool { state.wasDeleted }

    func isAudible(_ track: JamTrack) -> Bool {
        JamMixRules.isAudible(trackId: track.id, soloed: soloed, muted: muted)
    }
    func isMuted(_ id: String) -> Bool { muted.contains(id) }
    func isSoloed(_ id: String) -> Bool { soloed.contains(id) }
    func isVoted(_ id: String) -> Bool { viewer.votedTrackIds.contains(id) }
    func volume(_ id: String) -> Double { volumes[id] ?? 1 }
    func isAuditioned(_ track: JamTrack) -> Bool { auditioning[track.instrument] == track.id }

    var canSetMix: Bool { JamPermissions.canSetMix(viewer) }
    var canDeleteSong: Bool { JamPermissions.canDeleteSong(viewer) }
    func canDelete(_ track: JamTrack) -> Bool {
        JamPermissions.canDeleteTrack(track, viewer: viewer, viewerId: viewerId)
    }

    // MARK: - Lifecycle

    func start(session: SessionStore) async {
        self.session = session
        guard !started else { return }
        started = true
        let mine = lifecycle
        let key = handlerKey
        session.eventHandlers[key] = { [weak self, weak session] event in
            guard let self else {
                session?.eventHandlers.removeValue(forKey: key)
                return
            }
            self.apply(event)
        }
        engine.onInterruption = { [weak self] in self?.engineStopped() }
        observeSystem()
        await load()
        guard mine == lifecycle else { return }
        await syncEngine()
    }

    /// Leaving the screen stops the song: nothing keeps playing behind a wall
    /// the person has gone back to.
    func stop() {
        guard started else { return }
        lifecycle += 1
        syncGeneration += 1
        pauseInternal(keepSession: false)
        ticker?.cancel()
        video.stop()
        engine.tearDown()
        audioSession.deactivate()
        JamNowPlaying.clear()
        session?.eventHandlers.removeValue(forKey: handlerKey)
        if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
        if let routeObserver { NotificationCenter.default.removeObserver(routeObserver) }
        started = false
    }

    func load() async {
        guard let session else { return }
        isReading = true
        bufferedFrames = []
        defer {
            isReading = false
            bufferedFrames = []
        }
        do {
            let detail = try await session.api.jamSong(id: song.id)
            var next = JamSongState(song: detail.song, tracks: detail.tracks, viewer: detail.viewer)
            for frame in bufferedFrames { next.apply(frame) }
            state = next
            phase = .ready
        } catch {
            if state.tracks.isEmpty {
                phase = .failed((error as? APIError)?.errorDescription ?? error.localizedDescription)
            } else if phase == .loading {
                phase = .ready
            }
        }
    }

    /// After a vote whose outcome is unknown (the answer never came): ask the
    /// server where the viewer stands rather than guessing it back.
    private func reconcileVotes() async {
        guard let session, let detail = try? await session.api.jamSong(id: song.id) else { return }
        var next = state
        for fresh in detail.tracks {
            if let i = next.tracks.firstIndex(where: { $0.id == fresh.id }) { next.tracks[i].voteCount = fresh.voteCount }
        }
        next.viewer.votedTrackIds = detail.viewer.votedTrackIds
        state = next
    }

    // MARK: - Engine

    /// Make the engine hold exactly the playing tracks: fetch what is missing,
    /// hand it over, and carry on from where the song was.
    func syncEngine() async {
        guard started else { return }
        syncGeneration += 1
        let generation = syncGeneration
        let wanted = active
        video.load(wanted)
        let missing = wanted.filter { files[$0.id] == nil }
        downloadFailed = false
        if !missing.isEmpty {
            loading = (0, missing.count)
            var done = 0
            await withTaskGroup(of: (String, URL?).self) { group in
                for track in missing {
                    group.addTask {
                        let url = try? await JamMediaCache.shared.localURL(
                            id: track.id, remote: track.audioUrl,
                            contentType: track.audioContentType, expectedBytes: track.audioBytes
                        )
                        return (track.id, url)
                    }
                }
                for await (id, url) in group {
                    done += 1
                    if let url { files[id] = url } else { downloadFailed = true }
                    if generation == syncGeneration { loading = (done, missing.count) }
                }
            }
            loading = nil
        }
        guard generation == syncGeneration, started else { return }

        let wasPlaying = isPlaying
        let songTime = engine.originMs + engine.positionMs
        let hadStems = engine.durationMs > 0
        let stems = JamMixRules.stems(wanted, files: files)
        let failures = engine.load(stems)
        unplayable = Set(failures.keys)
        applyMix()
        if hadStems {
            // The origin may have moved (a stem that starts earlier arrived):
            // keep the same moment of the SONG, not the same number.
            try? engine.seek(to: max(0, songTime - engine.originMs))
        }
        if wasPlaying { startPlayback(from: engine.positionMs) } else { video.park(atSongMs: engine.originMs + engine.positionMs) }
    }

    private func applyMix() {
        for track in active {
            engine.setMix(
                JamEngine.Mix(gain: track.gain, volume: volume(track.id), muted: false),
                for: track.id
            )
            engine.setAudible(isAudible(track), for: track.id)
        }
    }

    // MARK: - Transport

    func togglePlay() {
        isPlaying ? pause() : play()
    }

    func play() {
        guard !isPlaying else { return }
        guard engine.durationMs > 0 else {
            // Nothing loaded yet: load, then play.
            Task {
                await syncEngine()
                if engine.durationMs > 0 { startPlayback(from: engine.positionMs >= engine.durationMs ? 0 : engine.positionMs) }
            }
            return
        }
        // Parked at the end: from the top.
        let from = engine.positionMs >= engine.durationMs - 5 ? 0 : engine.positionMs
        startPlayback(from: from)
    }

    private func startPlayback(from positionMs: Double) {
        audioSession.activate(callActive: callActive)
        do {
            let host = try engine.play(from: positionMs)
            isPlaying = true
            video.play(
                atSongMs: engine.originMs + positionMs, startHostTime: host,
                latencySeconds: audioSession.outputLatencySeconds
            )
            startTicker()
            installLockScreen()
            publishNowPlaying(force: true)
        } catch {
            isPlaying = false
            audioSession.deactivate()
            notice = String(localized: "Could not start the audio. Try again.")
        }
    }

    func pause() { pauseInternal(keepSession: true) }

    private func pauseInternal(keepSession: Bool) {
        guard isPlaying else { return }
        engine.pause()
        video.pause()
        isPlaying = false
        ticker?.cancel()
        seekRevision += 1
        publishNowPlaying(force: true)
    }

    /// Scrubbing: move the playhead (and restart if playing).
    func seek(to positionMs: Double) {
        let clamped = max(0, min(positionMs, durationMs))
        let wasPlaying = isPlaying
        if wasPlaying {
            startPlayback(from: clamped)
        } else {
            try? engine.seek(to: clamped)
            video.park(atSongMs: engine.originMs + clamped)
        }
        seekRevision += 1
        publishNowPlaying(force: true)
    }

    private func engineStopped() {
        isPlaying = false
        video.pause()
        ticker?.cancel()
        seekRevision += 1
        publishNowPlaying(force: true)
    }

    private func startTicker() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard let self, !Task.isCancelled else { return }
                self.tick()
            }
        }
    }

    private func tick() {
        guard isPlaying else { return }
        if engine.positionMs >= engine.durationMs - 2 {
            engine.finish()
            video.pause()
            video.park(atSongMs: engine.originMs + engine.durationMs)
            isPlaying = false
            ticker?.cancel()
            seekRevision += 1
            publishNowPlaying(force: true)
            return
        }
        video.correctDrift(
            songMs: engine.originMs + engine.positionMs,
            latencySeconds: audioSession.outputLatencySeconds
        )
        publishNowPlaying(force: false)
    }

    // MARK: - Mix controls (local)

    func toggleMute(_ track: JamTrack) {
        if muted.contains(track.id) { muted.remove(track.id) } else { muted.insert(track.id) }
        applyMix()
    }

    func toggleSolo(_ track: JamTrack) {
        if soloed.contains(track.id) { soloed.remove(track.id) } else { soloed.insert(track.id) }
        applyMix()
    }

    func setVolume(_ value: Double, for track: JamTrack) {
        volumes[track.id] = max(0, min(1, value))
        applyMix()
    }

    /// Hear a competing take in place of the in-mix one, on this phone only.
    func audition(_ track: JamTrack) {
        if auditioning[track.instrument] == track.id {
            auditioning.removeValue(forKey: track.instrument)
        } else {
            auditioning[track.instrument] = track.id
        }
        Task { await syncEngine() }
    }

    // MARK: - Server actions

    func vote(_ track: JamTrack) async {
        guard let session, !busyVotes.contains(track.id) else { return }
        busyVotes.insert(track.id)
        defer { busyVotes.remove(track.id) }
        let want = !isVoted(track.id)
        // Optimistic: the count and the mark move at once, and the answer
        // (or the failure) settles them.
        var optimistic = state
        optimistic.apply(vote: JamVoteResponse(
            trackId: track.id, songId: song.id,
            voteCount: max(0, track.voteCount + (want ? 1 : -1)), voted: want
        ))
        state = optimistic
        do {
            let answer = try await session.api.setJamVote(trackId: track.id, voted: want)
            state.apply(vote: answer)
        } catch {
            // The server may or may not have taken it: do not put a captured
            // count back over a newer one, ask where things stand.
            notice = Self.message(for: error)
            await reconcileVotes()
        }
    }

    func setInMix(_ track: JamTrack, _ inMix: Bool) async {
        guard let session else { return }
        do {
            let answer = try await session.api.updateJamTrack(id: track.id, patch: .init(inMix: inMix))
            let effect = state.apply(.trackUpdated(channelId: channel.id, song: answer.song, track: answer.track))
            if effect == .reloadStems { await syncEngine() }
        } catch {
            notice = Self.message(for: error)
        }
    }

    func deleteTrack(_ track: JamTrack) async {
        guard let session else { return }
        do {
            try await session.api.deleteJamTrack(id: track.id)
            // The frame carries the refreshed song; apply the removal now too,
            // idempotent by id, so the row goes without waiting for the socket.
            var next = state
            let effect = next.apply(.trackDeleted(channelId: channel.id, song: state.song, trackId: track.id))
            state = next
            files.removeValue(forKey: track.id)
            if effect == .reloadStems { await syncEngine() }
        } catch {
            notice = Self.message(for: error)
        }
    }

    /// Deletes the song. True when it is gone (the screen then closes).
    func deleteSong() async -> Bool {
        guard let session else { return false }
        do {
            try await session.api.deleteJamSong(id: song.id)
            return true
        } catch {
            notice = Self.message(for: error)
            return false
        }
    }

    func clearNotice() { notice = nil }
    func clearFresh(_ id: String) { state.fresh.remove(id) }

    static func message(for error: Error) -> String {
        if let api = error as? APIError, let text = api.errorDescription { return text }
        return error.localizedDescription
    }

    // MARK: - Live frames

    func apply(_ event: RealtimeEvent) {
        guard case .jam(let frame) = event, frame.channelId == channel.id else { return }
        if isReading { bufferedFrames.append(frame) }
        var next = state
        var effect = next.apply(frame)
        guard next != state else { return }
        state = next
        // A track that left must not be the one auditioned.
        let stillThere = auditioning.filter { entry in next.tracks.contains { $0.id == entry.value } }
        if stillThere != auditioning {
            // The take being auditioned was deleted: the in-mix take of its
            // instrument comes back, which is a change of stems.
            auditioning = stillThere
            effect = .reloadStems
        }
        switch effect {
        case .reloadStems:
            Task { await syncEngine() }
        case .levels:
            applyMix()
        case .none:
            break
        }
        if state.wasDeleted {
            pause()
            notice = String(localized: "This song was deleted.")
        }
    }

    // MARK: - System

    private func observeSystem() {
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
            MainActor.assumeIsolated { self?.pause() }
        }
        // Headphones pulled out: a song does not blast out of the speaker.
        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            guard raw == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
            MainActor.assumeIsolated { self?.pause() }
        }
    }

    private func installLockScreen() {
        guard audioSession.ownsLockScreen else { return }
        JamNowPlaying.installCommands(
            play: { [weak self] in self?.play() },
            pause: { [weak self] in self?.pause() },
            seek: { [weak self] ms in self?.seek(to: ms) }
        )
    }

    private func publishNowPlaying(force: Bool) {
        guard audioSession.ownsLockScreen else { return }
        guard force || Date().timeIntervalSince(lastNowPlaying) > 1 else { return }
        lastNowPlaying = Date()
        JamNowPlaying.publish(
            title: song.title,
            artist: song.artist ?? song.authorName,
            positionMs: engine.positionMs,
            durationMs: engine.durationMs,
            isPlaying: isPlaying
        )
    }
}
