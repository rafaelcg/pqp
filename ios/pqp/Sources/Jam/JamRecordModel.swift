import AVFoundation
import Foundation
import Observation

/// THE STUDIO: record a part over the band, hear it with the band, send it.
///
/// One screen's worth of state and the effects it drives. The arithmetic is in
/// `JamRecordingRules` and `JamLatency` (pure, tested); the audio is in
/// `JamRecorder` (one engine, one clock); this is the order things happen in and
/// what is shown when they go wrong.
///
///   setup -> countIn -> recording -> building -> review -> sending -> done
///      ^                                            |
///      +---------------- record again -------------+
///
/// WHAT IS NEVER LOST SILENTLY. A take that finished is a FILE (FLAC, the very
/// bytes that will be sent) until it is sent or discarded on purpose: leaving
/// asks first; a call, a route change or a lost microphone mid-take stops the
/// recording and KEEPS what was captured when there is something to hear.
@MainActor
@Observable
final class JamRecordModel {
    enum Phase: Equatable {
        case preparing, setup, countIn, recording, building, review, sending, done
    }

    enum Destination: Equatable {
        case song(JamSongSummary)
        case draft(JamSongDraft)
    }

    enum Permission: Equatable { case undetermined, denied, granted }

    /// What the screen says besides the state itself.
    enum Notice: Equatable {
        case micDenied
        case noInput
        case startFailed
        case diskFailed
        /// The recording is safe on disk but could not be prepared.
        case buildFailed
        /// The take was stopped from outside: what was captured is kept (a take
        /// to hear) or there was nothing worth keeping.
        case stopped(Cause, kept: Bool)
        case tooShort
        case unplayable(Int)

        enum Cause: Equatable { case microphone, interruption, route }
    }

    enum Calibration: Equatable {
        case idle
        /// The sheet that says what is about to happen.
        case asking
        case measuring(JamCalibrator.Method)
        case measured(JamLatencyResult)
        case failed(JamCalibrator.Method)
    }

    /// What closing the studio would throw away.
    enum Leaving: Equatable {
        case nothing
        case recording
        case take
        case sending
    }

    let channel: Channel
    let server: Server
    private(set) var destination: Destination
    /// The band: what plays under the take.
    let band: [JamTrack]
    let addable: [JamInstrument]
    var instrument: JamInstrument
    var countInOn = true

    private(set) var phase: Phase = .preparing
    private(set) var notice: Notice?
    private(set) var refusal: JamRecordingGate.Refusal?
    private(set) var permission: Permission = .undetermined
    private(set) var route: JamAudioRoute = .unknown
    private(set) var latency: JamLatencyResult
    var calibration: Calibration = .idle
    /// When the running measurement began, for the sheet's progress bar.
    private(set) var measuringSince = Date()
    /// Band stems being fetched.
    private(set) var loading: (done: Int, total: Int)?
    private(set) var downloadFailed = false

    // Recording
    private(set) var elapsedMs: Double = 0
    private(set) var beat = 0
    private(set) var level: Float = 0
    private(set) var levels: [Float] = []

    // Review
    private(set) var take: JamTake?
    private(set) var edits = JamTakeEdits()
    private(set) var isPlaying = false
    private(set) var seekRevision = 0
    var confirmingSilent = false

    // Sending
    private(set) var progress: Double = 0
    private(set) var sendError: JamErrorKind?
    private(set) var posted: (song: JamSongSummary, track: JamTrack)?

    @ObservationIgnored var callActive = false
    @ObservationIgnored private weak var session: SessionStore?
    @ObservationIgnored private let audioSession = JamRecordingSession()
    @ObservationIgnored private let store: JamLatencyStore
    @ObservationIgnored private let review = JamEngine()
    @ObservationIgnored private var recorder: JamRecorder?
    @ObservationIgnored private var calibrator: JamCalibrator?
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var playTicker: Task<Void, Never>?
    @ObservationIgnored private var sendTask: Task<Void, Never>?
    @ObservationIgnored private var bandFiles: [String: URL] = [:]
    @ObservationIgnored private var routeObserver: NSObjectProtocol?
    @ObservationIgnored private var started: JamRecorder.Started?
    /// The capture file of the take in progress, so cancelling deletes it.
    @ObservationIgnored private var rawURL: URL?
    /// A capture whose FLAC could not be written (the disk was full): kept so a
    /// retry can build it again instead of losing the take.
    @ObservationIgnored private var failedBuild: (raw: JamRecorder.Raw, latency: JamLatencyResult)?
    @ObservationIgnored private var countIn: JamCountIn?
    @ObservationIgnored private var postState = JamPostState()
    @ObservationIgnored private var createdSongId: String?
    @ObservationIgnored private var sessionHeld = false
    @ObservationIgnored private var torn = false
    @ObservationIgnored private var lifecycle = 0

    init(
        channel: Channel, server: Server, destination: Destination, band: [JamTrack],
        addable: [JamInstrument], instrument: JamInstrument, store: JamLatencyStore = JamLatencyStore()
    ) {
        self.channel = channel
        self.server = server
        self.destination = destination
        self.band = band
        self.addable = addable
        self.instrument = instrument
        self.store = store
        latency = JamLatencyRules.estimate(outputLatency: 0, inputLatency: 0)
        review.onInterruption = { [weak self] in self?.reviewStopped() }
    }

    // MARK: - What the screen reads

    var songTitle: String {
        switch destination {
        case .song(let song): song.title
        case .draft(let draft): draft.cleanTitle
        }
    }

    var isNewSong: Bool {
        if case .draft = destination { return true }
        return false
    }

    var songId: String? {
        if case .song(let song) = destination { return song.id }
        return createdSongId
    }

    /// Every lane the review draws: the band and, once there is one, the take
    /// at the place it will be sent.
    var lanes: [JamTrack] {
        var out = band
        if let take { out.append(takeTrack(take)) }
        return out
    }

    /// The take as a lane (the numbers the server would store).
    func takeTrack(_ take: JamTake) -> JamTrack {
        let placed = edits.placed(take.timing)
        return JamTrack(
            id: Self.takeId, songId: songId ?? "", authorId: session?.currentUser?.id ?? "me",
            authorName: session?.currentUser?.username, instrument: instrument,
            offsetMs: placed.offsetMs, trimStartMs: placed.trimStartMs, trimEndMs: placed.trimEndMs,
            durationMs: placed.durationMs, peaks: take.peaks, inMix: true
        )
    }

    static let takeId = "take"

    var timeline: (originMs: Double, durationMs: Double) { JamMixRules.timeline(of: lanes) }
    var bandTimeline: (originMs: Double, durationMs: Double) { JamMixRules.timeline(of: band) }
    var positionMs: Double { review.positionMs }
    var reviewDurationMs: Double { review.durationMs }

    /// The take's own words about how it was placed.
    var latencyMethod: JamLatencyMethod { take?.latencyMethod ?? latency.method }

    var canRecord: Bool {
        phase == .setup && refusal == nil && loading == nil && !addable.isEmpty
    }

    var leaving: Leaving {
        switch phase {
        case .countIn, .recording, .building: .recording
        case .review: .take
        case .sending: .sending
        default: .nothing
        }
    }

    // MARK: - Opening

    func prepare(session: SessionStore) async {
        self.session = session
        guard phase == .preparing else { return }
        let mine = lifecycle
        permission = Self.readPermission()
        refusal = JamRecordingGate.refusal(
            callActive: callActive, category: AVAudioSession.sharedInstance().category, studioOwnsSession: false,
            categoryProvesACall: false
        )
        if refusal == nil {
            do {
                try audioSession.activate()
                sessionHeld = true
            } catch {
                // The system gave the session to somebody else between the
                // gate and here: the same answer as a call.
                refusal = .inCall
            }
        }
        refreshRoute()
        observeRoute()
        phase = .setup
        await loadBand()
        guard mine == lifecycle, !torn else { return }
    }

    /// The call started (or ended) while the studio was open.
    func callStateChanged(active: Bool) {
        callActive = active
        // A call that starts in-app does not always post an audio interruption:
        // stop the take here and keep what was captured.
        if active, phase == .countIn || phase == .recording {
            stopRecording(cause: .interruption)
            return
        }
        guard phase == .setup else { return }
        if active {
            refusal = .inCall
            review.pause()
            isPlaying = false
            if sessionHeld {
                audioSession.deactivate()
                sessionHeld = false
            }
        } else if refusal == .inCall {
            refusal = JamRecordingGate.refusal(
                callActive: false, category: AVAudioSession.sharedInstance().category, studioOwnsSession: false,
                categoryProvesACall: false
            )
            if refusal == nil, !sessionHeld, (try? audioSession.activate()) != nil {
                sessionHeld = true
                refreshRoute()
            }
        }
    }

    private static func readPermission() -> Permission {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: .granted
        case .denied: .denied
        default: .undetermined
        }
    }

    private func loadBand() async {
        let stems = band.filter { $0.playedMs > 0 }
        let missing = stems.filter { bandFiles[$0.id] == nil }
        if !missing.isEmpty {
            loading = (0, missing.count)
            var done = 0
            // At most four at a time: a song can hold 32 stems.
            await withTaskGroup(of: (String, URL?).self) { group in
                var next = 0
                func startOne() {
                    guard next < missing.count else { return }
                    let track = missing[next]
                    next += 1
                    group.addTask {
                        let url = try? await JamMediaCache.shared.localURL(
                            id: track.id, remote: track.audioUrl,
                            contentType: track.audioContentType, expectedBytes: track.audioBytes
                        )
                        return (track.id, url)
                    }
                }
                for _ in 0..<min(4, missing.count) { startOne() }
                for await (id, url) in group {
                    done += 1
                    if let url { bandFiles[id] = url } else { downloadFailed = true }
                    loading = (done, missing.count)
                    startOne()
                }
            }
            loading = nil
        }
        loadReview()
    }

    func retryBand() async {
        downloadFailed = false
        await loadBand()
    }

    /// The stems the band is: what the engine can open, with the takes it cannot
    /// (a WebM) left out and counted.
    private func bandStems() -> [JamEngine.Stem] {
        JamMixRules.stems(band, files: bandFiles)
    }

    private func loadReview() {
        var stems = bandStems()
        if let take { stems.append(takeStem(take)) }
        let failures = review.load(stems)
        if !failures.isEmpty { notice = .unplayable(failures.count) }
    }

    private func takeStem(_ take: JamTake) -> JamEngine.Stem {
        let placed = edits.placed(take.timing)
        return JamEngine.Stem(
            id: Self.takeId, url: take.fileURL, offsetMs: placed.offsetMs,
            trimStartMs: placed.trimStartMs, trimEndMs: placed.trimEndMs
        )
    }

    // MARK: - The route and the latency

    func refreshRoute() {
        route = JamRouteReader.current()
        let estimate = JamLatencyRules.estimate(
            outputLatency: audioSession.outputLatencySeconds, inputLatency: audioSession.inputLatencySeconds
        )
        latency = JamLatencyRules.choose(
            stored: store.results(for: route.key), estimate: estimate, currentOutputMs: route.reportedOutputMs
        )
    }

    private func observeRoute() {
        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.phase == .setup || self.phase == .review else { return }
                self.refreshRoute()
            }
        }
    }

    // MARK: - Calibration

    func askToCalibrate() { calibration = .asking }
    func dismissCalibration() { if case .measuring = calibration { return }; calibration = .idle }

    func calibrate(_ method: JamCalibrator.Method) async {
        guard phase == .setup, refusal == nil else { return }
        review.pause()
        isPlaying = false
        if permission == .undetermined { await requestPermission() }
        guard permission == .granted else {
            notice = .micDenied
            calibration = .idle
            return
        }
        let calibrator = JamCalibrator()
        self.calibrator = calibrator
        calibration = .measuring(method)
        measuringSince = Date()
        refreshRoute()
        do {
            let result = try await calibrator.measure(method, reportedOutputMs: route.reportedOutputMs)
            guard calibration == .measuring(method) else { return }
            if result.isUsable {
                store.save(result, for: route.key)
                refreshRoute()
                calibration = .measured(result)
            } else {
                calibration = .failed(method)
            }
        } catch is CancellationError {
            calibration = .idle
        } catch JamCalibrator.CalibrationError.noInput {
            notice = .noInput
            calibration = .idle
        } catch {
            calibration = .failed(method)
        }
        self.calibrator = nil
    }

    func cancelCalibration() {
        calibrator?.cancel()
        calibrator = nil
        calibration = .idle
    }

    /// Forget the measurement for this route and go back to the estimate.
    func forgetCalibration() {
        store.clear(method: .loopback, for: route.key)
        store.clear(method: .tapAlong, for: route.key)
        refreshRoute()
    }

    // MARK: - Permission

    func requestPermission() async {
        _ = await AVAudioApplication.requestRecordPermission()
        permission = Self.readPermission()
    }

    // MARK: - Recording

    func startRecording() async {
        guard canRecord, !torn else { return }
        notice = nil
        if permission == .undetermined { await requestPermission() }
        guard permission == .granted else {
            notice = .micDenied
            return
        }
        guard !torn, phase == .setup else { return }
        review.pause()
        isPlaying = false
        playTicker?.cancel()
        refreshRoute()

        let recorder = JamRecorder()
        let failures = recorder.loadBand(bandStems())
        if !failures.isEmpty { notice = .unplayable(failures.count) }
        recorder.onEvent = { [weak self] event in self?.recorderEvent(event) }
        let raw = Self.takesDirectory().appendingPathComponent("\(UUID().uuidString)-raw.caf")
        let countIn: JamCountIn? = countInOn ? .standard : nil
        do {
            started = try recorder.start(countIn: countIn, rawURL: raw)
        } catch JamRecorder.StartError.noInput {
            try? FileManager.default.removeItem(at: raw)
            notice = .noInput
            return
        } catch {
            try? FileManager.default.removeItem(at: raw)
            notice = .startFailed
            return
        }
        rawURL = raw
        self.recorder = recorder
        self.countIn = countIn
        elapsedMs = -(countIn?.durationSeconds ?? 0) * 1000
        beat = 0
        level = 0
        levels = []
        phase = countIn == nil ? .recording : .countIn
        startTicker()
    }

    private func startTicker() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(40))
                guard let self, !Task.isCancelled else { return }
                self.tick()
            }
        }
    }

    private func tick() {
        guard let recorder, let started, phase == .countIn || phase == .recording else { return }
        let now = JamHostClock.nowSeconds
        elapsedMs = (now - started.backingStartSeconds) * 1000
        if let countIn, phase == .countIn {
            let since = now - started.countInStartSeconds
            beat = since < 0 ? 0 : min(countIn.totalBeats, Int(since / countIn.beatSeconds) + 1)
            if now >= started.backingStartSeconds { phase = .recording }
        }
        let peak = recorder.levelPeak()
        level = max(peak, level * 0.82)
        // One bar every other tick (80 ms), the live waveform of the take.
        tickCount += 1
        if tickCount % 2 == 0 { levels.append(max(peak, pendingPeak)); pendingPeak = 0 } else { pendingPeak = max(pendingPeak, peak) }
        if recorder.captureFailed {
            stopRecording(cause: nil, failure: .diskFailed)
        } else if phase == .recording, elapsedMs >= Double(JamUploadPlan.autoStopMs) {
            stopRecording()
        }
    }

    @ObservationIgnored private var tickCount = 0
    @ObservationIgnored private var pendingPeak: Float = 0

    private func recorderEvent(_ event: JamRecorder.Event) {
        guard phase == .countIn || phase == .recording else { return }
        switch event {
        case .routeChanged: stopRecording(cause: .route)
        case .interrupted: stopRecording(cause: .interruption)
        case .engineStopped: stopRecording(cause: .microphone)
        }
    }

    /// Stop the take. `cause` is nil when the person pressed stop; otherwise
    /// something outside did, and what was captured is kept if it is worth
    /// hearing.
    func stopRecording(cause: Notice.Cause? = nil, failure: Notice? = nil) {
        guard phase == .countIn || phase == .recording, let recorder else { return }
        ticker?.cancel()
        let wasCountIn = phase == .countIn
        let raw = recorder.stop()
        self.recorder = nil
        let latency = self.latency
        guard let raw, !wasCountIn || cause != nil || raw.capture.frames > 0 else {
            backToSetup(notice: failure ?? (cause.map { .stopped($0, kept: false) } ?? .tooShort))
            return
        }
        phase = .building
        rawURL = nil
        build(raw: raw, latency: latency, cause: cause, failure: failure)
    }

    private func build(raw: JamRecorder.Raw, latency: JamLatencyResult, cause: Notice.Cause?, failure: Notice?) {
        let output = Self.takesDirectory().appendingPathComponent("\(UUID().uuidString).flac")
        let mine = lifecycle
        Task { [weak self] in
            let built: JamTake? = await Task.detached(priority: .userInitiated) {
                try? JamTakeBuilder.build(raw: raw, latency: latency, outputURL: output)
            }.value
            guard let self, mine == self.lifecycle, !self.torn else {
                if let built { try? FileManager.default.removeItem(at: built.fileURL) }
                if let url = raw.capture.url { try? FileManager.default.removeItem(at: url) }
                return
            }
            if built == nil, let url = raw.capture.url, FileManager.default.fileExists(atPath: url.path) {
                // The take is on disk and could not be turned into a FLAC (the
                // disk is full): kept, so freeing space and trying again works.
                self.failedBuild = (raw, latency)
            }
            self.finishBuilding(built, cause: cause, failure: failure)
        }
    }

    /// Whether a take is waiting to be built again.
    var canRetryBuild: Bool { failedBuild != nil && phase == .setup }

    func retryBuild() {
        guard let pending = failedBuild, phase == .setup else { return }
        failedBuild = nil
        notice = nil
        phase = .building
        build(raw: pending.raw, latency: pending.latency, cause: nil, failure: nil)
    }

    private func finishBuilding(_ built: JamTake?, cause: Notice.Cause?, failure: Notice?) {
        guard let built else {
            backToSetup(notice: failedBuild != nil ? .buildFailed : (failure ?? (cause.map { .stopped($0, kept: false) } ?? .tooShort)))
            return
        }
        failedBuild = nil
        let played = built.playedMs
        // A tap on the button, or a take cut short with nothing in it: not worth
        // a review. A take cut short with something to hear is KEPT.
        if cause == nil, failure == nil {
            if played < Double(JamUploadPlan.minDurationMs) {
                discardFile(built)
                backToSetup(notice: .tooShort)
                return
            }
        } else if played < Double(JamUploadPlan.minDurationMs) || built.isSilent {
            discardFile(built)
            backToSetup(notice: failure ?? .stopped(cause ?? .microphone, kept: false))
            return
        }
        take = built
        edits = JamTakeEdits()
        loadReview()
        phase = .review
        notice = failure ?? cause.map { .stopped($0, kept: true) }
        playReview(from: 0)
    }

    func cancelRecording() {
        guard phase == .countIn || phase == .recording else { return }
        ticker?.cancel()
        recorder?.cancel()
        recorder = nil
        removeRaw()
        backToSetup(notice: nil)
    }

    private func removeRaw() {
        if let rawURL { try? FileManager.default.removeItem(at: rawURL) }
        rawURL = nil
    }

    private func backToSetup(notice: Notice?) {
        take = nil
        edits = JamTakeEdits()
        levels = []
        level = 0
        elapsedMs = 0
        beat = 0
        self.notice = notice
        phase = .setup
        loadReview()
    }

    // MARK: - Review

    func togglePlay() {
        if isPlaying { pauseReview() } else {
            let from = review.positionMs >= review.durationMs - 5 ? 0 : review.positionMs
            playReview(from: from)
        }
    }

    func playReview(from positionMs: Double) {
        guard refusal == nil, review.durationMs > 0 else { return }
        do {
            try review.play(from: positionMs)
            isPlaying = true
            startPlayTicker()
        } catch {
            isPlaying = false
        }
        seekRevision += 1
    }

    func pauseReview() {
        guard isPlaying else { return }
        review.pause()
        isPlaying = false
        playTicker?.cancel()
        seekRevision += 1
    }

    func seek(to positionMs: Double) {
        if isPlaying { playReview(from: positionMs) } else { try? review.seek(to: positionMs) }
        seekRevision += 1
    }

    private func reviewStopped() {
        isPlaying = false
        playTicker?.cancel()
        seekRevision += 1
    }

    private func startPlayTicker() {
        playTicker?.cancel()
        playTicker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard let self, !Task.isCancelled else { return }
                if self.isPlaying, self.review.positionMs >= self.review.durationMs - 2 {
                    self.review.finish()
                    self.isPlaying = false
                    self.seekRevision += 1
                    return
                }
            }
        }
    }

    /// Move the take earlier or later, in milliseconds. Heard at once: the
    /// stem is placed again and the band carries on from the same song time.
    func nudge(by deltaMs: Double) {
        guard take != nil, phase == .review else { return }
        let next = edits.nudged(by: deltaMs)
        guard next != edits else { return }
        let wasPlaying = isPlaying
        let songTime = review.originMs + review.positionMs
        edits = next
        loadReview()
        if wasPlaying {
            playReview(from: max(0, songTime - review.originMs))
        } else {
            try? review.seek(to: max(0, songTime - review.originMs))
        }
        seekRevision += 1
    }

    func resetNudge() {
        guard edits.isEdited else { return }
        nudge(by: -edits.nudgeMs)
    }

    func recordAgain() {
        guard phase == .review else { return }
        pauseReview()
        if let take { discardFile(take) }
        backToSetup(notice: nil)
    }

    // MARK: - Sending

    /// Send. A take with no sound asks first (`confirmingSilent`).
    func send(confirmedSilent: Bool = false) {
        guard phase == .review || (phase == .sending && sendError != nil), let take, let session else { return }
        if take.isSilent, !confirmedSilent, sendError == nil {
            confirmingSilent = true
            return
        }
        confirmingSilent = false
        if let problem = JamUploadPlan.problem(durationMs: take.timing.durationMs, byteSize: take.byteSize) {
            sendError = problem == .tooShort ? .other : .tooLarge
            phase = .sending
            return
        }
        pauseReview()
        sendError = nil
        progress = 0
        phase = .sending
        let mine = lifecycle
        sendTask?.cancel()
        sendTask = Task { [weak self] in
            await self?.runSend(take: take, session: session, lifecycle: mine)
        }
    }

    private func runSend(take: JamTake, session: SessionStore, lifecycle mine: Int) async {
        let api = session.api
        do {
            var songId: String
            switch destination {
            case .song(let song): songId = song.id
            case .draft(let draft):
                if let created = createdSongId {
                    songId = created
                } else {
                    let song = try await api.createJamSong(channelId: channel.id, body: draft.body)
                    songId = song.id
                    guard mine == lifecycle, !torn else {
                        // The studio closed while the song was being made: nobody
                        // is left to fill it, so it goes (only while still empty).
                        Task { try? await api.deleteJamSongIfEmpty(id: song.id) }
                        return
                    }
                    createdSongId = song.id
                }
            }
            if postState.result == nil {
                if !postState.ticketUsable() {
                    postState.stored = false
                    postState.ticket = try await api.createJamUpload(
                        songId: songId, body: .audio(contentType: JamUploadPlan.contentType, byteSize: take.byteSize)
                    )
                }
                guard mine == lifecycle, !torn, let ticket = postState.ticket else { return }
                if !postState.stored {
                    try await JamStorageUpload.put(
                        file: take.fileURL, to: ticket.uploadUrl, contentType: JamUploadPlan.contentType
                    ) { [weak self] fraction in
                        Task { @MainActor in
                            guard let self, mine == self.lifecycle else { return }
                            // The claim is the last step: the bar stops short of full.
                            self.progress = min(0.95, fraction * 0.95)
                        }
                    }
                    postState.stored = true
                }
                guard mine == lifecycle, !torn else { return }
                progress = 0.97
                let body = JamUploadPlan.body(
                    timing: take.timing, edits: edits, instrument: instrument, label: nil,
                    audioUploadId: ticket.uploadId, peaks: take.peaks
                )
                postState.result = JamTrackWithSongBox(value: try await api.addJamTrack(songId: songId, body: body))
            }
            guard mine == lifecycle, !torn, let result = postState.result?.value else { return }
            progress = 1
            posted = (result.song, result.track)
            discardFile(take)
            self.take = nil
            phase = .done
        } catch is CancellationError {
            return
        } catch {
            guard mine == lifecycle, !torn else { return }
            sendError = JamErrorKind.of(error)
            // A song that is gone: the take is kept, and the person chooses.
            if let kind = sendError, kind == .gone { postState = JamPostState() }
        }
    }

    /// The song was deleted while the take waited: send it as a song of its own.
    func sendAsNewSong() {
        guard case .song(let song) = destination, sendError == .gone else { return }
        var draft = JamSongDraft()
        draft.title = song.title
        draft.artist = song.artist ?? ""
        draft.joinMode = .open
        destination = .draft(draft)
        createdSongId = nil
        postState = JamPostState()
        sendError = nil
        send(confirmedSilent: true)
    }

    /// Back to the review from a failed send, keeping the take.
    func backToReview() {
        guard phase == .sending, sendError != nil else { return }
        sendTask?.cancel()
        sendError = nil
        phase = .review
    }

    // MARK: - Leaving

    /// Close the studio: stop everything, delete the files, and give back the
    /// audio session. A song this studio made and never filled is deleted too
    /// (only while it is still empty: `?ifEmpty=true`).
    func tearDown() {
        guard !torn else { return }
        torn = true
        lifecycle += 1
        ticker?.cancel()
        playTicker?.cancel()
        sendTask?.cancel()
        calibrator?.cancel()
        recorder?.cancel()
        recorder = nil
        review.tearDown()
        if let routeObserver { NotificationCenter.default.removeObserver(routeObserver) }
        if let take { discardFile(take) }
        take = nil
        removeRaw()
        if let url = failedBuild?.raw.capture.url { try? FileManager.default.removeItem(at: url) }
        failedBuild = nil
        if sessionHeld {
            audioSession.deactivate()
            sessionHeld = false
        }
        if posted == nil, let created = createdSongId, let api = session?.api {
            createdSongId = nil
            Task { try? await api.deleteJamSongIfEmpty(id: created) }
        }
    }

    private func discardFile(_ take: JamTake) {
        try? FileManager.default.removeItem(at: take.fileURL)
    }

    static func takesDirectory() -> URL {
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("jam-takes", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    /// Takes older than a day are leftovers of a process that died mid-take.
    static func sweepOldTakes() {
        let manager = FileManager.default
        guard let urls = try? manager.contentsOfDirectory(
            at: takesDirectory(), includingPropertiesForKeys: [.contentModificationDateKey]
        ) else { return }
        let cutoff = Date().addingTimeInterval(-86_400)
        for url in urls {
            let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
            if let date, date < cutoff { try? manager.removeItem(at: url) }
        }
    }
}
