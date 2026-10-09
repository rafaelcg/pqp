import AVFoundation
import Foundation
import Observation

/// Everything the player needs to know about one note, copied out of the
/// message so the player does not hold the transcript.
struct VoicePlayable: Equatable, Sendable {
    let attachmentId: String
    let messageId: String
    let channelId: String
    let authorId: String
    let contentType: String
    let url: String
    let playbackUrl: String?
    let durationMs: Int
    let listenedByMe: Bool?

    init?(message: Message, attachment: Attachment) {
        guard let voice = attachment.voice else { return nil }
        attachmentId = attachment.id
        messageId = message.id
        channelId = message.channelId
        authorId = message.authorId
        contentType = attachment.contentType
        url = attachment.url
        playbackUrl = voice.playbackUrl
        durationMs = voice.durationMs
        listenedByMe = voice.listenedByMe
    }

    var source: VoiceNotePlaybackSource {
        VoiceNotePlaybackSource.choose(contentType: contentType, url: url, playbackUrl: playbackUrl)
    }
}

/// Which note plays after this one.
enum VoiceNoteQueue {
    /// The next note AFTER `id` in `notes` (oldest first, the transcript's
    /// order) that somebody else sent, that this person has not heard, and that
    /// can be played now. A note still waiting on its AAC copy is skipped rather
    /// than stalling the chain on something that cannot play.
    ///
    /// `heard` is what this session has already listened to, which the server
    /// copy on `notes` has not caught up with yet (the receipt takes a round
    /// trip, and auto-continue starts the next note immediately).
    static func next(
        after id: String, in notes: [VoicePlayable], me: String, heard: Set<String>
    ) -> VoicePlayable? {
        guard let index = notes.firstIndex(where: { $0.attachmentId == id }) else { return nil }
        return notes[(index + 1)...].first { note in
            note.authorId != me
                && note.listenedByMe == false
                && !heard.contains(note.attachmentId)
                && note.source != .pending
        }
    }
}

/// How much of a note was actually listened to, which is not where the playhead
/// is. Dragging the waveform to 0:40 is not forty seconds of listening, and a
/// stalled player is not listening either: only small forward steps count.
struct VoiceListenMeter: Equatable, Sendable {
    /// A note counts as listened to once it has played this long.
    static let thresholdSeconds: Double = 1
    /// A step bigger than this between two ticks is a seek, not playback. Ticks
    /// come every 0.1 s, so even 2x playback steps 0.2 s.
    static let maxStepSeconds: Double = 0.6

    private(set) var playedSeconds: Double = 0
    private var last: Double?

    mutating func tick(playhead: Double, playing: Bool) {
        if playing, let last {
            let step = playhead - last
            if step > 0, step < Self.maxStepSeconds { playedSeconds += step }
        }
        last = playhead
    }

    /// The playhead jumped; measure the next step from wherever it landed.
    mutating func seeked() { last = nil }

    mutating func reset() {
        playedSeconds = 0
        last = nil
    }

    /// Past the threshold, or, for a note shorter than it, most of the note.
    /// `finished` is whether the note has just ended.
    func hasListened(durationSeconds: Double, finished: Bool) -> Bool {
        if playedSeconds >= Self.thresholdSeconds { return true }
        return finished && playedSeconds >= durationSeconds * 0.8
    }
}

/// The one voice-note player in the app.
///
/// ONE, app-wide, because two voices at once is noise and because it is what
/// lets a note keep playing while the person scrolls, opens a thread or goes
/// back to the list. It plays through `AVPlayer`, at 1x, 1.5x or 2x with the
/// time-domain pitch algorithm (speech stays natural instead of turning into a
/// chipmunk), and when a note ends it carries on with the next unheard one from
/// somebody else, the way a podcast app would.
///
/// THE LISTEN RECEIPT. The first time a note from someone else plays past one
/// second, `POST /api/attachments/:id/listened` goes out, once per note per
/// launch. A second is the line between "heard it" and "my thumb landed on it".
@MainActor
@Observable
final class VoiceNotePlayer {
    /// The note that owns the player: playing, paused or loading.
    private(set) var currentId: String?
    private(set) var isPlaying = false
    private(set) var isLoading = false
    /// 0...1 of the current note.
    private(set) var progress: Double = 0
    private(set) var elapsedMs = 0
    private(set) var rate: Float
    /// A note that would not play, until the next attempt.
    private(set) var failedId: String?
    /// Notes this session has heard, ahead of the server copy catching up.
    private(set) var heardIds: Set<String> = []

    static let rates: [Float] = [1, 1.5, 2]
    private static let rateKey = "pqp.voiceNoteRate"

    @ObservationIgnored private weak var session: SessionStore?
    @ObservationIgnored private var player: AVPlayer?
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var endObserver: NSObjectProtocol?
    @ObservationIgnored private var statusObservation: NSKeyValueObservation?
    @ObservationIgnored nonisolated(unsafe) private var interruptionObserver: NSObjectProtocol?
    @ObservationIgnored private var current: VoicePlayable?
    @ObservationIgnored private var next: (@MainActor (VoicePlayable) -> VoicePlayable?)?
    @ObservationIgnored private var refresh: (@MainActor () -> Void)?
    @ObservationIgnored private var reported: Set<String> = []
    /// Receipts whose POST failed. Not retried on a timer (the playhead callback
    /// fires ten times a second); retried the next time the person plays the
    /// note.
    @ObservationIgnored private var failedListens: Set<String> = []
    @ObservationIgnored private var meter = VoiceListenMeter()
    @ObservationIgnored private var refetched: Set<String> = []
    @ObservationIgnored private var weChangedTheSession = false

    init() {
        let stored = UserDefaults.standard.float(forKey: Self.rateKey)
        rate = Self.rates.contains(stored) ? stored : 1
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
            Task { @MainActor in self?.pause() }
        }
    }

    deinit {
        if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
    }

    func configure(session: SessionStore) {
        self.session = session
    }

    func isCurrent(_ id: String) -> Bool { currentId == id }

    /// Whether this person has heard `note`, by the server copy or by this
    /// session's own listening.
    func isListened(_ attachment: Attachment) -> Bool {
        attachment.voice?.listenedByMe == true || heardIds.contains(attachment.id)
    }

    // MARK: - Transport

    /// Tap on a card: start it, or pause/resume it if it is already the one.
    /// `next` finds the note to continue with; the chat that owns the card
    /// supplies it because only it knows the order.
    func toggle(
        _ note: VoicePlayable,
        next: (@MainActor (VoicePlayable) -> VoicePlayable?)? = nil,
        refresh: (@MainActor () -> Void)? = nil
    ) {
        if currentId == note.attachmentId, player != nil {
            isPlaying ? pause() : resume()
            return
        }
        self.refresh = refresh
        start(note, next: next)
    }

    func pause() {
        player?.pause()
        isPlaying = false
    }

    func resume() {
        guard let player, currentId != nil else { return }
        activateSession()
        player.defaultRate = rate
        player.rate = rate
        isPlaying = true
    }

    /// A call or a recording needs the microphone and the speaker: let go.
    func stop() {
        tearDown()
        currentId = nil
        current = nil
        isPlaying = false
        isLoading = false
        progress = 0
        elapsedMs = 0
        next = nil
        deactivateSession()
    }

    /// 1x, 1.5x, 2x, around again. The speed is the person's, not the note's: it
    /// carries to the next note and survives a relaunch.
    func cycleRate() {
        let index = Self.rates.firstIndex(of: rate) ?? 0
        setRate(Self.rates[(index + 1) % Self.rates.count])
    }

    func setRate(_ newRate: Float) {
        rate = newRate
        UserDefaults.standard.set(newRate, forKey: Self.rateKey)
        player?.defaultRate = newRate
        if isPlaying { player?.rate = newRate }
    }

    /// Drag on the waveform of the note that is playing.
    func seek(toFraction fraction: Double) {
        guard let player, let current else { return }
        let seconds = max(0, min(1, fraction)) * Double(current.durationMs) / 1000
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600),
                    toleranceBefore: .zero, toleranceAfter: .zero)
        progress = max(0, min(1, fraction))
        elapsedMs = Int(seconds * 1000)
        // A jump is not listening: the next tick measures from the new spot.
        meter.seeked()
    }

    // MARK: - Starting

    private func start(
        _ note: VoicePlayable,
        next: (@MainActor (VoicePlayable) -> VoicePlayable?)?
    ) {
        tearDown()
        current = note
        currentId = note.attachmentId
        self.next = next
        failedId = nil
        progress = 0
        elapsedMs = 0
        isPlaying = false
        meter.reset()
        if failedListens.remove(note.attachmentId) != nil {
            reported.remove(note.attachmentId)
        }

        guard case .play(let url) = note.source else {
            // Nothing AVPlayer can play yet (an Opus note whose AAC copy has not
            // been made). The card already says so; there is nothing to start.
            currentId = nil
            current = nil
            return
        }
        begin(note, url: url)
    }

    private func begin(_ note: VoicePlayable, url: URL) {
        activateSession()
        isLoading = true

        let item = AVPlayerItem(url: url)
        // Speech stays natural at 1.5x and 2x. `.timeDomain` is the algorithm
        // meant for voice; the spectral one is better for music and costs more.
        item.audioTimePitchAlgorithm = .timeDomain
        let player = AVPlayer(playerItem: item)
        player.automaticallyWaitsToMinimizeStalling = true
        player.defaultRate = rate
        self.player = player

        statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            let status = item.status
            Task { @MainActor in self?.itemStatusChanged(status, note: note) }
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.finished(note) }
        }
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.1, preferredTimescale: 600), queue: .main
        ) { [weak self] time in
            let seconds = time.seconds
            Task { @MainActor in self?.tick(seconds: seconds, note: note) }
        }

        player.rate = rate
        isPlaying = true
    }

    private func itemStatusChanged(_ status: AVPlayerItem.Status, note: VoicePlayable) {
        guard currentId == note.attachmentId else { return }
        switch status {
        case .readyToPlay:
            isLoading = false
        case .failed:
            isLoading = false
            Task { await recover(note) }
        default:
            break
        }
    }

    /// A presigned URL expires (`ATTACHMENT_URL_TTL_SECONDS`), so a note scrolled
    /// back to an hour later carries a dead link. One fresh signature, then the
    /// honest failure state: a 404 for a deleted note must not loop.
    private func recover(_ note: VoicePlayable) async {
        guard currentId == note.attachmentId else { return }
        // The fresh URL is the ORIGINAL's, which is only playable when it is
        // already AAC. A failed AAC copy has nothing better to fall back to.
        guard !refetched.contains(note.attachmentId),
              let session,
              VoiceNotePlaybackSource.choose(contentType: note.contentType, url: note.url, playbackUrl: nil) != .pending,
              let fresh = try? await session.api.attachmentUrl(id: note.attachmentId),
              let url = URL(string: fresh),
              currentId == note.attachmentId
        else {
            // The message may carry fresher signatures (an expired AAC copy has
            // no URL endpoint of its own), so read it again; the next tap plays
            // from the new data.
            refresh?()
            fail(note)
            return
        }
        refetched.insert(note.attachmentId)
        tearDown()
        begin(note, url: url)
    }

    private func fail(_ note: VoicePlayable) {
        guard currentId == note.attachmentId else { return }
        failedId = note.attachmentId
        tearDown()
        isPlaying = false
        currentId = nil
        current = nil
    }

    // MARK: - Progress

    private func tick(seconds: Double, note: VoicePlayable) {
        guard currentId == note.attachmentId, seconds.isFinite else { return }
        let total = Double(note.durationMs) / 1000
        elapsedMs = Int(seconds * 1000)
        progress = total > 0 ? min(1, max(0, seconds / total)) : 0
        isLoading = false
        meter.tick(playhead: seconds, playing: isPlaying)
        if meter.hasListened(durationSeconds: total, finished: false) { reportListen(note) }
    }

    private func reportListen(_ note: VoicePlayable) {
        // Your own notes have no receipt for you, and a note you have already
        // heard has nothing to add.
        guard let session, let me = session.currentUser?.id,
              note.authorId != me,
              note.listenedByMe != true,
              !reported.contains(note.attachmentId)
        else { return }
        reported.insert(note.attachmentId)
        heardIds.insert(note.attachmentId)
        Task { [weak self] in
            do {
                let _: EmptyResponse = try await session.api.post("/api/attachments/\(note.attachmentId)/listened")
            } catch {
                // Not heard as far as the server knows. Suppressed for the rest
                // of this play (see `failedListens`), and the dot comes back so
                // the screen does not claim a receipt that was never recorded.
                self?.failedListens.insert(note.attachmentId)
                self?.heardIds.remove(note.attachmentId)
            }
        }
    }

    // MARK: - Ending

    private func finished(_ note: VoicePlayable) {
        guard currentId == note.attachmentId else { return }
        // A note shorter than the threshold ends before it can reach it. Playing
        // most of it counts; a seek straight to the end does not.
        if meter.hasListened(durationSeconds: Double(note.durationMs) / 1000, finished: true) {
            reportListen(note)
        }
        let following = next?(note)
        let chain = next
        tearDown()
        isPlaying = false
        isLoading = false
        progress = 0
        elapsedMs = 0
        currentId = nil
        current = nil
        if let following {
            start(following, next: chain)
        } else {
            self.next = nil
            deactivateSession()
        }
    }

    private func tearDown() {
        if let timeObserver, let player { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        statusObservation?.invalidate()
        statusObservation = nil
        player?.pause()
        player = nil
    }

    // MARK: - Audio session

    /// `.playback` so a note is heard with the ringer switch off and the screen
    /// locked. Never while a call holds the microphone: the call's session is
    /// not ours to reconfigure, and the note simply plays through it.
    private func activateSession() {
        let audio = AVAudioSession.sharedInstance()
        guard !WatchAudioSession.wouldInterruptACall(audio.category) else { return }
        guard audio.category != .playback else { return }
        do {
            try audio.setCategory(.playback, mode: .spokenAudio)
            try audio.setActive(true)
            weChangedTheSession = true
        } catch {
            // A note with the wrong routing beats no note.
        }
    }

    private func deactivateSession() {
        guard weChangedTheSession else { return }
        weChangedTheSession = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
