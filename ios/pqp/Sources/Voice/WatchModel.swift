import Foundation

/**
 WATCHING A CHANNEL'S BROADCAST WITHOUT TAKING A SEAT IN IT.

 This is the audience half of a watch party, and it is deliberately not a
 lighter `VoiceModel`. It opens no microphone, creates no peer connection,
 mints no LiveKit token and never appears on a roster. What it does is send one
 frame, `watch-live`, and play the playlist the server answers with.

 That distinction is the entire economics of the feature. A seat costs the
 media server a participant; six hundred seats cost six hundred. A watcher
 costs one socket in a `Set` on the API and one more reader of an HLS playlist
 that was going to be transcoded anyway, so the six hundred and first watcher
 costs the media server nothing at all. Getting this wrong does not look wrong
 in a test: it looks like a working call, right up to the evening it is not.

 SEATED PEOPLE DO NOT GET A PLAYER. Somebody who pressed Entrar is already
 receiving the presenter's screen as a WebRTC track, with its own audio, in
 `VoiceView`. Playing the HLS of the same broadcast beside it would be the same
 film twice, eight seconds apart, both audible. So `isSeated` suppresses
 everything here, and taking a seat mid-watch tears the player down and tells
 the server to stop counting this socket (which it also does on its own,
 because a seat leaves the audience set; saying so is a frame, and waiting for
 the server to notice is a race).
 */
@MainActor
@Observable
final class WatchModel {
    /// What the viewer should be looking at.
    enum Phase: Equatable {
        /// Nothing is known yet: the seed request has not answered and no
        /// frame has arrived. Renders as a quiet loading state, never as
        /// "nobody is streaming", because those are different sentences and
        /// only one of them is true before the server has spoken.
        case unknown
        /// The channel is real and nothing is being broadcast in it.
        case idle
        /// A playlist is attached and playing.
        case live
        /// Something WAS live during this visit and stopped. Distinct from
        /// `idle` on purpose: "acabou" and "ainda não começou" are opposite
        /// facts and a viewer who reads the wrong one waits for nothing or
        /// leaves too early.
        case ended
        /// The player gave up. Carries the sentence to show.
        case failed(String)
    }

    /**
     WHICH OF THE THREE QUIET STATES A VIEWER IS IN.

     Pulled out of the model because the interesting part is not the assignment
     but the fact that `nil` means two opposite things, and the difference is
     the only thing the viewer actually needs. "Ainda não começou" and "acabou"
     both render as no picture; one of them means wait and the other means go.
     A player that answers with the wrong one either strands somebody in front
     of a finished film or sends them away thirty seconds before it starts.

     What separates them is memory, not the frame: a stream ONCE seen during
     this visit makes the absence an ending. Someone who opens the channel
     after the credits gets `idle`, correctly, because from where they are
     standing nothing ever started.
     */
    static func phase(stream: LiveHlsStream?, sawStream: Bool) -> Phase {
        if stream != nil { return .live }
        return sawStream ? .ended : .idle
    }

    private(set) var phase: Phase = .unknown

    /// The freshest stream the server has described, whether or not it is the
    /// one attached to the player. Never keyed off for identity: see
    /// `LiveHlsStream.hlsUrl`.
    private(set) var stream: LiveHlsStream?

    /// Seatless watchers, from the server's own count. Excludes seats.
    private(set) var watching = 0
    /// Seats in the voice room, presenter included. Seeded from REST and then
    /// left alone: the frames that keep this model current carry the audience,
    /// not the roster.
    private(set) var participants = 0

    /// Everyone the badge should claim, which is both halves. The presenter
    /// holds a seat, so the seat count is not subtracted from: a room of one
    /// presenter and no audience honestly reads as one person here.
    var audienceCount: Int { watching + participants }

    /// Set by whoever owns the screen when this account takes or leaves a seat
    /// in THIS channel. Suppresses the player rather than merely hiding it.
    var isSeated = false {
        didSet {
            guard isSeated != oldValue else { return }
            if isSeated {
                setWatching(false)
            } else {
                syncWatching()
            }
        }
    }

    private var channelId: String?
    private var session: SessionStore?
    private let handlerKey = "watch-" + UUID().uuidString
    /// What we last told the server, so a keyframe does not re-send it and a
    /// reconnect does.
    private var declaredWatching = false
    /// Whether a stream has been seen at all during this visit. What separates
    /// `idle` from `ended`.
    private var sawStream = false

    // MARK: - Lifecycle

    func open(channelId: String, session: SessionStore) async {
        guard self.channelId != channelId else { return }
        close()
        self.channelId = channelId
        self.session = session
        session.eventHandlers[handlerKey] = { [weak self] event in
            self?.apply(event)
        }
        await seed(channelId: channelId, session: session)
    }

    func close() {
        setWatching(false)
        if let session { session.eventHandlers.removeValue(forKey: handlerKey) }
        channelId = nil
        session = nil
        stream = nil
        watching = 0
        participants = 0
        sawStream = false
        phase = .unknown
    }

    /**
     `GET /api/channels/:channelId/live`, once, on open.

     Belt and braces for the ordering that actually happens on a phone: the
     screen is pushed, and the `channel-live` catch-up for this channel either
     already went past (it is sent at socket auth, which was minutes ago) or is
     30 seconds away on the keyframe clock. Without this the first thing a
     viewer sees is a spinner for half a minute on a stream that has been
     running all evening.

     A failure here is not shown. The socket is the live path and it will
     correct this within one keyframe; turning a transient 500 into a red
     screen over a working broadcast is the worse of the two wrong answers.
     */
    private func seed(channelId: String, session: SessionStore) async {
        guard let state: ChannelLiveState =
                try? await session.api.get("/api/channels/\(channelId)/live")
        else {
            if phase == .unknown { phase = .idle }
            return
        }
        guard self.channelId == channelId else { return }
        // THE SEED IS OLDER THAN ANY FRAME, ALWAYS. It was requested before
        // the socket answered and it can land after, so applying it
        // unconditionally can restart a broadcast the wire has already
        // reported stopped, which then plays a finished VOD for the thirty
        // seconds until the next keyframe corrects it. A frame has arrived
        // means the socket is answering, and the socket outranks this.
        guard phase == .unknown else { return }
        participants = state.participants
        watching = state.watching
        applyStream(state.stream)
    }

    // MARK: - Wire

    private func apply(_ event: RealtimeEvent) {
        switch event {
        case .channelLive(let id, let stream, let watching):
            guard id == channelId else { return }
            self.watching = watching
            applyStream(stream)

        // The room's own copy. Only reaches a socket with a seat, so it is
        // here for the case where somebody joined the call from this screen
        // and the model is still alive; it carries no headcount.
        case .voiceStream(let id, let stream):
            guard id == channelId else { return }
            applyStream(stream)

        // A NEW SOCKET KNOWS NOTHING ABOUT THIS VIEWER. The audience is a set
        // of live `WebSocket` objects on one API process, so a reconnect (a
        // tunnel, a deploy, a lift) drops this watcher out of the count and
        // out of the fan-out silently: the picture keeps playing from the CDN
        // and the viewer simply stops existing. Re-asserting is the only thing
        // that puts them back, and it costs one frame.
        case .ready:
            declaredWatching = false
            syncWatching()

        default:
            break
        }
    }

    private func applyStream(_ next: LiveHlsStream?) {
        stream = next
        if next != nil { sawStream = true }
        phase = Self.phase(stream: next, sawStream: sawStream)
        syncWatching()
    }

    /// The player could not keep a picture up. Kept separate from the wire so
    /// a stream that is genuinely still live does not read as "acabou".
    func playbackFailed(_ message: String) {
        phase = .failed(message)
    }

    /// A retry from the failed state: the freshest URL carries the freshest
    /// token, so this is worth more than reattaching the same string.
    func retry() {
        guard stream != nil else {
            phase = sawStream ? .ended : .idle
            return
        }
        phase = .live
    }

    // MARK: - The count

    /// Tell the server iff the answer changed. The audience is counted per
    /// socket, so a repeat is harmless, but a repeat every keyframe is a frame
    /// per viewer per 30 seconds for no reason, and this feature exists to be
    /// cheap with six hundred of them.
    private func syncWatching() {
        setWatching(stream != nil && !isSeated && channelId != nil)
    }

    private func setWatching(_ next: Bool) {
        guard next != declaredWatching, let channelId, let session else { return }
        declaredWatching = next
        Task { await session.realtime.watchLive(channelId: channelId, watching: next) }
    }
}
