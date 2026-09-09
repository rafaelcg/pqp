import Foundation

/// Server → client frames the chat UI cares about.
///
/// Voice frames and anything unrecognised decode to `.other` rather than
/// throwing: the server sends `voice-roster` immediately after auth whether or
/// not you asked, so a strict decoder would fail on the very first frame.
enum RealtimeEvent: Sendable {
    case ready
    case messageCreated(Message, nonce: String?)
    case messageUpdated(Message)
    case messageDeleted(channelId: String, messageId: String)
    case reaction(channelId: String, messageId: String, emoji: String, userId: String, added: Bool, displayName: String?)
    case typing(channelId: String, userId: String, displayName: String)
    case presence(channelId: String, users: [PresenceUser])
    case activity(channelId: String, serverId: String?, mention: Bool)
    /// A thread on `messageId` was created, or gained a message. Fanned out to
    /// viewers of the PARENT channel — `channelId` is the parent, not the
    /// thread — and deliberately content-free: the thread's own messages travel
    /// only to the thread's own viewers, so this can never leak a body into a
    /// channel view.
    case threadUpdate(channelId: String, messageId: String, thread: ThreadSummary)
    /// The one WS refusal that explains itself. Every other refused frame is a
    /// silent drop; this one is unicast to the person who tried, so the client
    /// can say why the send vanished instead of showing a bug-shaped nothing.
    case sanctionNotice(SanctionNotice)
    /// The server refused a `message-create`, and said so. Unicast to the
    /// sender like `sanctionNotice`; `nonce` is the echo of the create frame,
    /// which is what finds the optimistic row to take down.
    ///
    /// For most of this app's life the only answer to a refused send was
    /// silence: the row stayed dimmed at 55% forever, nothing reaped it short
    /// of a reconnect, and the person walked away believing it had been sent.
    /// The server has explained itself since the web client's PR #204; this
    /// app dropped the explanation as `.other`.
    case messageRejected(MessageRejection)
    /// Your friendships changed — re-read them.
    ///
    /// Unicast, like `sanctionNotice`, and CONTENT-FREE by design: it names
    /// nobody, because the recipient learns who from `GET /api/friends`, which is
    /// access-controlled. `kind` is `request` (somebody asked you) or `accepted`
    /// (somebody said yes to you); nothing is sent for a decline, a cancel, an
    /// unfriend or a block, all of which are silent on purpose.
    ///
    /// Before this frame existed, a request reached this app only on a cold
    /// launch or a pull-to-refresh of the friends screen — there was no polling
    /// at all — so somebody holding their phone could be sitting on a request
    /// indefinitely and see nothing.
    case friendActivity(kind: FriendActivityKind)
    /// What you are allowed to see on `serverId` changed, so re-read it.
    ///
    /// Content-free on purpose, exactly like `friendActivity`: it names no
    /// channel and no bit, because the answer is whatever
    /// `GET /api/servers/:id/channels` gives back, and that endpoint already
    /// filters by VIEW_CHANNEL in the database. Sent to every member of the
    /// server, not to viewers of a channel, because losing access is precisely
    /// the case where you are no longer in the audience of the thing that
    /// changed.
    ///
    /// WHY IT MATTERS ON A PHONE. The server evicts a socket from a channel it
    /// may no longer see, so no content leaks either way. What leaks is the
    /// *name*: without this frame the channel sits in the sidebar until the app
    /// is relaunched, and tapping it opens a room the server will not talk
    /// about. The web client has refetched on this frame since roles shipped;
    /// this app dropped it on the floor as `.other`.
    case permissionsUpdate(serverId: String, version: Int?)
    /// `serverId`'s Baú changed (a publish, a comment, a deletion), so re-read
    /// it. Content-free like `permissionsUpdate`, and server-scoped: it goes to
    /// every member, never through a channel relay. Likes deliberately do not
    /// send it. See `packages/shared/src/community-home.ts`.
    case communityHomeUpdate(serverId: String)

    // Voice signalling. The server is a pure relay for offer/answer/candidate;
    // everything else here is room membership.
    /// `resumed` is true when the server reattached an existing peer id after a
    /// socket drop rather than minting a new one; `resumeToken` is the HMAC a
    /// later rejoin presents to ask for exactly that. Both optional on the wire.
    /// `canSpeak` is the server's SPEAK rule for this seat, resolved by
    /// `VoiceSpeakRule.resolve` from the top-level key and `self.canSpeak`.
    /// False means: join muted, keep the mic locked, offer no share or camera.
    case voiceWelcome(peerId: String, voiceChannelId: String, peers: [VoiceParticipant],
                      selfPeer: VoiceParticipant, transport: String?,
                      resumed: Bool, resumeToken: String?, canSpeak: Bool, canStream: Bool)
    case voicePeerJoined(VoiceParticipant)
    /// Somebody already in the room now shows a different name or picture.
    /// Distinct from `voicePeerJoined` on purpose: that one opens a peer
    /// connection, and a rename is not somebody walking in. The roster entry
    /// is replaced and NOTHING is renegotiated.
    case voicePeerUpdated(VoiceParticipant)
    case voicePeerLeft(peerId: String)
    /// The whole room, however the server described it.
    ///
    /// Two frames arrive here as one event. `voice-roster` carries every
    /// participant and is what a socket receives when it has negotiated
    /// nothing; `voice-roster-delta` carries only what changed, and
    /// `VoiceRosterTracker` turns it back into this before it is yielded. A
    /// delta the tracker refuses (a sequence gap, a size that disagrees)
    /// yields nothing at all, so a receiver of this case is always looking at
    /// a room the server and this client agree about.
    case voiceRoster(voiceChannelId: String, participants: [VoiceParticipant])
    /// The SPEAK rule for this seat changed mid-call: a role edit, a channel
    /// override, a timeout. `false` mutes and locks the controls; `true`
    /// unlocks them and leaves the unmute to the person. Unicast; the roster
    /// frame that follows carries the same bit for everybody else.
    case voiceSpeakChanged(voiceChannelId: String, canSpeak: Bool, canStream: Bool)
    /// The join was refused after we asked to resume (an ACL change, the
    /// orphan window elapsed, a block), or a cold mesh join was refused
    /// because the API is on more than one machine and this one cannot relay
    /// to the room's peers.
    ///
    /// A client that is HOLDING media when this lands has to hang up. It is
    /// not in the room, nobody can hear it, and it is absent from every
    /// roster, so sitting on a live microphone and a call screen is the same
    /// silent broken call a released seat produces.
    case voiceJoinRefused(voiceChannelId: String, reason: String?)
    case voiceRoomFull(limit: Int)
    /// The call is already at the screen-share cap. Unicast to whoever tried.
    case voiceScreenShareDenied(voiceChannelId: String)
    /// The call is already at the camera cap. Unicast to whoever tried.
    case voiceCameraDenied(voiceChannelId: String)
    /// The server refused the join because this room is pinned to a transport
    /// we declared we cannot do. Nobody ever saw us in the roster.
    ///
    /// `reason` is `"promoted"` in the one case where this reaches a seat that
    /// already existed: the room moved to the SFU and this socket did not
    /// negotiate `voice-transport-changed`, so the server released the seat.
    /// Since this build DOES negotiate it, `promoted` now only arrives when
    /// the two ends disagree, which is worth a different sentence.
    case voiceTransportUnsupported(voiceChannelId: String, transport: String, reason: String?)
    /// THE ROOM MOVED UNDER US, ON PURPOSE, AND WE KEEP OUR SEAT.
    ///
    /// The server promoted this mesh room to the SFU (a fourth person, a
    /// camera past the mesh cap, a ninth at the door) and is telling every
    /// seat that negotiated the frame. Deliberately not a rejoin: the peer id
    /// and the seat are still ours, so nobody sees a leave and an arrival, and
    /// only the media path is rebuilt.
    ///
    /// `participants` is the room as the server holds it at that instant,
    /// **self included** (unlike `welcome.peers`, which excludes it), so the
    /// receiver can build its SFU session without waiting for a roster.
    /// `reason` only decides the sentence on screen. See
    /// `voicePromotionAction`.
    case voiceTransportChanged(voiceChannelId: String, transport: String, reason: String?,
                               participants: [VoiceParticipant])
    case voiceOffer(from: String, sdp: String)
    case voiceAnswer(from: String, sdp: String)
    case voiceCandidate(from: String, candidate: IceCandidatePayload?)

    // Conversation calls. A DM "rings" where a server voice channel is
    // join-when-you-want; these three frames are that whole lifecycle as the
    // client sees it. Accepting a ring is not a frame — it is `join-voice-room`.
    case callIncoming(IncomingCall)
    /// Stop ringing. `reason` is `answered` | `declined` | `cancelled` | `timeout`.
    case callRingCancelled(conversationId: String, reason: String)
    /// Somebody we were waiting for said no; the call itself continues.
    case callDeclined(conversationId: String, userId: String)
    case other
}

/// `friendActivitySchema`'s `kind`. A closed set rather than a `String` so a
/// spelling the server never sends cannot reach a `switch` — an unknown value is
/// dropped at decode, which for a nudge means "do nothing" rather than
/// "refresh for a reason we invented".
enum FriendActivityKind: String, Sendable {
    case request
    case accepted
}

/// `message-rejected`, as the client keeps it. The reason is left as the
/// wire token rather than an enum: a token this build has never heard of is
/// still a refusal, and it must still take the dimmed row down and put the
/// text back. The copy for an unknown token is the generic one.
///
/// `retryAfterMs` arrives for `slow-mode` (and may for `rate-limited`), and is
/// what drives the countdown under the composer. It is a duration, not a
/// deadline: the clocks on a phone and a server do not agree well enough for
/// the server to send a timestamp.
struct MessageRejection: Hashable, Sendable {
    let channelId: String
    let nonce: String?
    let reason: String
    let retryAfterMs: Int?
    /// `automod` only: the rule's own copy, when the owner wrote one.
    var automodMessage: String? = nil
}

/// `sanctionNoticeSchema` — currently always a timeout. `message` is the whole
/// sentence, pre-written by the server; rendering it verbatim is correct.
struct SanctionNotice: Codable, Hashable, Sendable {
    let sanction: String
    let serverId: String
    let channelId: String
    let expiresAt: Date
    let reason: String?
    let message: String
}

struct VoiceParticipant: Codable, Identifiable, Hashable, Sendable {
    let peerId: String
    let userId: String
    let displayName: String
    let avatarUrl: String?
    /// Defaulted: older servers predate screen share and omit the key.
    var sharingScreen: Bool = false
    /// The sender-side MediaStream id of this participant's camera capture, or
    /// nil when their camera is off.
    ///
    /// Load-bearing on the mesh receive path and nowhere else: an arriving video
    /// track carries only its stream id, and one peer may legitimately be
    /// sending two (camera *and* screen). This is what files each under the
    /// right tile instead of guessing from arrival order.
    var cameraStreamId: String?
    /// The stream id of this participant's screen capture WHEN it carries
    /// sound, or nil. Announced on `set-sharing-screen` and re-sent with every
    /// one, so a reconnect cannot leave a stale id on the roster.
    ///
    /// Load-bearing for the server mute, which is the reason it is decoded at
    /// all on this platform: a moderator's mute silences a person's
    /// microphone and NOT their share. The watch-party case is a host muting
    /// chatter while the film keeps playing; zeroing the presenter's screen
    /// audio would defeat the point. Receivers can only make that distinction
    /// if they know which incoming audio track is the screen's, and the stream
    /// id is the only thing an arriving track carries.
    var screenAudioStreamId: String?
    /// Self-reported over `set-voice-state`; display only, never enforcement.
    var muted: Bool = false
    var deafened: Bool = false
    /// A moderator muted this person, and the server is the one holding the
    /// flag: their own `set-muted false` is refused and the roster snaps back.
    ///
    /// THE ONLY ENFORCEMENT ON MESH IS THE RECEIVER. The server never touches
    /// media in a peer-to-peer room, so it cannot stop the bytes; what it can
    /// do is put this on the roster and rely on every phone in the call to play
    /// that person at zero, exactly the way eviction already works by changing
    /// the roster and letting each client act on it. A client that decodes the
    /// key and ignores it keeps hearing somebody the whole room agreed not to.
    ///
    /// Defaulted false for the same reason as `muted`: an older server omits
    /// it, and absent has to read as "nobody is muted", not as a failed frame.
    var serverMuted: Bool = false
    /// Set by the server, never self-reported: the channel's SPEAK permission
    /// resolved for this person. The MICROPHONE grant, and only that. Absent
    /// on a server that predates the field, which reads as true, exactly as
    /// `welcome.canSpeak` does on the web.
    var canSpeak: Bool = true
    /// The channel's STREAM permission, which is the camera and screen share
    /// grant and is a SEPARATE bit from `canSpeak`.
    ///
    /// Defaulted to `canSpeak` rather than to true, and decoded after it for
    /// that reason: absent means a server from before the grants were split,
    /// where SPEAK gated publishing too. See `VoiceSpeakRule.resolveStream`.
    var canStream: Bool = true

    var id: String { peerId }

    enum CodingKeys: String, CodingKey {
        case peerId, userId, displayName, avatarUrl, sharingScreen
        case cameraStreamId, screenAudioStreamId, muted, deafened, serverMuted
        case canSpeak, canStream
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        peerId = try c.decode(String.self, forKey: .peerId)
        userId = try c.decode(String.self, forKey: .userId)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName) ?? "Someone"
        avatarUrl = try c.decodeIfPresent(String.self, forKey: .avatarUrl)
        sharingScreen = try c.decodeIfPresent(Bool.self, forKey: .sharingScreen) ?? false
        cameraStreamId = try c.decodeIfPresent(String.self, forKey: .cameraStreamId)
        screenAudioStreamId = try c.decodeIfPresent(String.self, forKey: .screenAudioStreamId)
        muted = try c.decodeIfPresent(Bool.self, forKey: .muted) ?? false
        deafened = try c.decodeIfPresent(Bool.self, forKey: .deafened) ?? false
        serverMuted = try c.decodeIfPresent(Bool.self, forKey: .serverMuted) ?? false
        canSpeak = try c.decodeIfPresent(Bool.self, forKey: .canSpeak) ?? true
        canStream = try c.decodeIfPresent(Bool.self, forKey: .canStream) ?? canSpeak
    }
}

/// `callerSummarySchema` — who is ringing, as `call-incoming` carries them.
struct CallerSummary: Codable, Hashable, Sendable {
    let userId: String
    let displayName: String
    let avatarUrl: String?
}

/// Mirrors `iceCandidateInitSchema`. Every field is optional on the wire, and
/// an end-of-candidates signal arrives as an explicit `null` candidate.
struct IceCandidatePayload: Codable, Hashable, Sendable {
    let candidate: String?
    let sdpMid: String?
    let sdpMLineIndex: Int?
}

struct PresenceUser: Codable, Identifiable, Hashable, Sendable {
    let id: String
    /// The wire key here is `name`, not `displayName` — the one payload in the
    /// protocol that differs.
    let name: String
    let avatarUrl: String?
}

enum RealtimeStatus: Equatable, Sendable {
    case idle
    case connecting
    case online
    case reconnecting
    case unauthorized
}

/// The WebSocket half of the API.
///
/// Sending a message is a WS frame, not an HTTP call — there is no
/// `POST /api/channels/:id/messages`. That makes this connection load-bearing
/// rather than an enhancement, which is why it reconnects rather than giving up.
actor RealtimeClient {
    private let backend: Backend
    private let tokenProvider: any TokenProviding
    private var task: URLSessionWebSocketTask?
    private var session: URLSession
    private var continuation: AsyncStream<RealtimeEvent>.Continuation?
    private var statusHandler: (@Sendable (RealtimeStatus) -> Void)?
    private var reconnectAttempt = 0
    private var joinedChannelId: String?
    /// The thread panel's slot, re-asserted on reconnect for the same reason
    /// the primary channel is: the server forgets both when the socket dies.
    private var joinedThreadChannelId: String?
    private var isStopped = false
    private var pingTask: Task<Void, Never>?
    private var missedPongs = 0
    /// One reconnect at a time — see `scheduleReconnect`.
    private var isReconnecting = false
    /// The baseline every `voice-roster-delta` is applied to. Kept here rather
    /// than in `VoiceModel` or `CallModel` because the sequence is a property
    /// of the SOCKET, not of whichever room this device happens to be in: both
    /// of those models see only their own channel, and neither is alive at all
    /// while the phone is merely sitting in a text channel receiving the
    /// rosters this change exists to shrink. See `VoiceRosterTracker`.
    private var rosterTracker = VoiceRosterTracker()
    /// The baseline every `presence-delta` is applied to. Here for the same
    /// reason `rosterTracker` is: the sequence belongs to the SOCKET, and this
    /// client is sent presence for every channel it has open, not only the one
    /// on screen. See `PresenceTracker`.
    private var presenceTracker = PresenceTracker()

    /**
     OPTIONAL WIRE FEATURES THIS BUILD UNDERSTANDS, declared on `auth`.

     The server keeps sending the old frames to anything that does not ask,
     which is the only reason a wire change can ship at all while an app store
     review sits between a merge and a phone. An entry here is a promise about
     THIS build, so it is added alongside the handler for the frame and never
     before it.

     `voice-roster-delta`: send what changed in a voice room instead of the
     whole room. Applied by `VoiceRosterTracker` under the convergence rule
     written on `voiceRosterDeltaMessageSchema` in `@pqp/shared`. The web
     client declares the identical string in `client/src/lib/realtime.ts` and
     the server reads it in `server/src/ws/sockets.ts`.

     `voice-transport-changed`: keep the seat when the server moves a mesh room
     onto the SFU mid call, instead of being released and told to rejoin.
     Applied by `followPromotion` in `VoiceModel` and `CallModel`, under
     `voicePromotionAction`.

     THIS ONE IS NOT AN OPTIMISATION, and its failure runs the other way from
     the roster delta's. Declaring the roster delta and mishandling it costs a
     stale list. Declaring THIS and mishandling it means the server stops
     releasing our seat on a promotion, so the person stays seated in a room
     whose media they cannot reach: a silent broken call rather than a visible
     drop, which is strictly worse than never asking. It is here only because
     both models act on it and the SFU half of `welcome` already existed to be
     reused.

     `presence-delta`: send what changed in a channel's viewer list instead of
     the whole list. Applied by `PresenceTracker` under the same convergence
     rule as the roster delta's, on purpose. Bytes only, like the roster
     delta: the viewer list this app reconstructs is byte for byte the one it
     was already being sent, and every phone on mobile data was paying for the
     whole of it every time anybody opened or closed a channel.
     */
    static let wireCaps = ["voice-roster-delta", "voice-transport-changed", "presence-delta"]

    /**
     The handshake, as a value rather than as a side effect.

     Pulled out of `openSocket` so a test can read what this build actually
     declares. A capability this app can apply but forgets to ask for costs
     nothing visible: the server keeps sending whole rosters, everything
     carries on working, and the only trace is a phone quietly paying for
     frames it did not need. That is the failure this whole change exists to
     remove, so it is pinned from inside rather than hoped for.
     */
    static func authFrame(token: String) -> [String: Any] {
        ["type": "auth", "token": token, "caps": wireCaps]
    }

    /// Matches the web client (`PING_INTERVAL_MS` / `MAX_MISSED_PONGS`). The
    /// server answers `{"type":"ping"}` with `{"type":"pong"}`; two misses in a
    /// row means the link is dead even though the OS still thinks it is open —
    /// which is exactly the state a phone leaving Wi-Fi produces.
    private static let pingInterval: Duration = .seconds(20)
    private static let maxMissedPongs = 2

    init(backend: Backend = .current, tokenProvider: any TokenProviding) {
        self.backend = backend
        self.tokenProvider = tokenProvider
        let config = URLSessionConfiguration.default
        // Same reasoning as APIClient: waiting for connectivity here would
        // swallow the failure that drives reconnection, so the socket would
        // never retry on its own schedule.
        config.waitsForConnectivity = false
        // NOT `timeoutIntervalForResource`. That is a ceiling on the whole
        // resource load, and a WebSocket *is* the resource — a 30s ceiling
        // meant every socket was timed out by URLSession thirty seconds after
        // it opened. The failure was invisible: already-buffered frames kept
        // arriving through the pending `receive`, so presence, other people's
        // messages and incoming call rings all worked, while every outgoing
        // frame was silently dropped by the `.running` guard in `send`. That is
        // why answering a DM call sat on "Connecting…" forever (the
        // `join-voice-room` never left) and why a message sent after half a
        // minute vanished. A long-lived socket gets no lifetime ceiling; the
        // heartbeat below is what detects a link that has actually died.
        //
        // The per-request timeout is an *idle* timeout, so it has to be
        // comfortably longer than the ping interval or the keepalive itself
        // would trip it.
        config.timeoutIntervalForRequest = 60
        self.session = URLSession(configuration: config)
    }

    func events() -> AsyncStream<RealtimeEvent> {
        AsyncStream { continuation in
            self.continuation = continuation
        }
    }

    func onStatusChange(_ handler: @escaping @Sendable (RealtimeStatus) -> Void) {
        statusHandler = handler
    }

    func connect() async {
        isStopped = false
        await openSocket()
    }

    func stop() {
        isStopped = true
        pingTask?.cancel()
        pingTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        joinedChannelId = nil
        statusHandler?(.idle)
    }

    private func openSocket() async {
        guard !isStopped else { return }
        statusHandler?(reconnectAttempt == 0 ? .connecting : .reconnecting)

        // Resolved per attempt, never captured once: a token read at app launch
        // is expired by the time a reconnect happens an hour later.
        guard let token = await tokenProvider.currentToken() else {
            statusHandler?(.unauthorized)
            return
        }

        let socket = session.webSocketTask(with: backend.webSocketURL)
        task = socket
        socket.resume()

        // A new socket, so every roster sequence this app was following belongs
        // to a connection that is gone, and possibly to a server process that
        // has restarted its numbering. The full rosters the server sends right
        // after `auth` are what re-baseline whatever is still live.
        rosterTracker.forgetAll()
        presenceTracker.forgetAll()
        await send(raw: RealtimeClient.authFrame(token: token))
        listen()
        // The channel re-joins wait for `ready`. The server verifies the token
        // asynchronously, and any frame that lands during that window hits an
        // unauthenticated socket, which answers 4401 "Auth required" — so a
        // reconnect with a channel open (a server restart mid-conversation,
        // precisely) sent auth and join back-to-back and lost the race every
        // time, looping on "Reconnecting…" forever. First connects never hit
        // it: there is nothing to rejoin yet.

        startHeartbeat()
    }

    private func startHeartbeat() {
        pingTask?.cancel()
        missedPongs = 0
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: RealtimeClient.pingInterval)
                guard !Task.isCancelled, let self else { return }
                await self.beat()
            }
        }
    }

    private func beat() async {
        guard !isStopped, task != nil else { return }
        if missedPongs >= Self.maxMissedPongs {
            // Rebuild rather than merely cancelling and trusting the pending
            // receive to fail: a socket URLSession has already given up on can
            // keep delivering buffered frames, so the failure that was supposed
            // to drive the reconnect never arrives.
            await scheduleReconnect()
            return
        }
        missedPongs += 1
        await send(raw: ["type": "ping"])
    }

    private func listen() {
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            Task { await self.handle(result: result) }
        }
    }

    private func handle(result: Result<URLSessionWebSocketTask.Message, any Error>) async {
        switch result {
        case .success(let message):
            if case .string(let text) = message, let data = text.data(using: .utf8) {
                ingest(data)
            }
            listen()
        case .failure:
            guard !isStopped else { return }
            await scheduleReconnect()
        }
    }

    /// Tear the socket down and open a new one, once.
    ///
    /// Guarded because there are now three callers — a failed receive, a
    /// heartbeat that ran out of pongs, and a send that could not leave — and
    /// two of them can fire for the same dead socket. Without the flag that
    /// opens two sockets, and the server keeps one peer per socket.
    private func scheduleReconnect() async {
        guard !isStopped, !isReconnecting else { return }
        isReconnecting = true
        task?.cancel(with: .abnormalClosure, reason: nil)
        task = nil
        missedPongs = 0
        statusHandler?(.reconnecting)
        reconnectAttempt += 1
        // Capped exponential backoff. Without the cap a long outage pushes the
        // next attempt hours out and the app never comes back on its own.
        let delay = min(pow(2, Double(reconnectAttempt)) * 0.5, 20)
        try? await Task.sleep(for: .seconds(delay))
        isReconnecting = false
        await openSocket()
    }

    // MARK: - Sending

    private func send(raw: [String: Any]) async {
        guard let data = try? JSONSerialization.data(withJSONObject: raw),
              let text = String(data: data, encoding: .utf8) else { return }
        // `.running` is checked because sending on a task the OS tore down
        // while the app slept crashes inside CFNetwork itself (a null deref in
        // -[__NSURLSessionWebSocketTask _onqueue_sendMessage:], seen from
        // TestFlight on wake-from-lock). The state read races the teardown in
        // principle, but it closes the window that actually fired: a heartbeat
        // queued against a socket that died during suspension.
        //
        // A frame that cannot leave is NOT swallowed. This connection is the
        // only way to send anything, so a silent drop is a client that looks
        // online and does nothing — messages that never send, calls that never
        // answer, voice rooms that are never joined. Reconnecting is the only
        // honest response.
        guard let socket = task, socket.state == .running else {
            await scheduleReconnect()
            return
        }
        do {
            try await socket.send(.string(text))
        } catch {
            // Only if this is still the live socket: a reconnect that already
            // happened has made this failure history.
            guard task === socket else { return }
            await scheduleReconnect()
        }
    }

    /// Called on scene-phase changes. Suspension kills sockets out from under
    /// the process, and a ping fired into that corpse is the crash above —
    /// so the heartbeat pauses in the background and the foreground transition
    /// nudges the socket instead: a live one answers the immediate ping, a
    /// dead one fails the pending receive, which is the reconnect path.
    func appStateChanged(active: Bool) async {
        if active {
            if task != nil, !isStopped {
                startHeartbeat()
                await beat()
            }
        } else {
            pingTask?.cancel()
            pingTask = nil
        }
    }

    func join(channelId: String) async {
        joinedChannelId = channelId
        await send(raw: ["type": "join-channel", "channelId": channelId])
    }

    /// Open a thread's live view *beside* the primary channel.
    ///
    /// Deliberately not `join-channel`: a connection has exactly one primary
    /// channel slot, and joining a thread through it would silently stop
    /// delivery for the channel the panel is open next to. The server holds one
    /// extra slot per connection for exactly this.
    ///
    /// The phone shows one conversation at a time, so opening a thread as a
    /// full screen uses `join(channelId:)` — a thread id IS a channel id. This
    /// pair exists for a side-by-side view (iPad, or a future split layout) and
    /// keeps the client honest about the frame the server already speaks.
    func joinThread(channelId: String) async {
        joinedThreadChannelId = channelId
        await send(raw: ["type": "thread-join", "channelId": channelId])
    }

    func leaveThread() async {
        joinedThreadChannelId = nil
        await send(raw: ["type": "thread-leave"])
    }

    /// Returns the nonce so the caller can match the echo back to its optimistic
    /// row. There is no ack frame: the echo on `message-broadcast` is what
    /// confirms a send, and `message-rejected` (same nonce) is what refuses
    /// one. Anything else the server dislikes is still dropped silently.
    @discardableResult
    func sendMessage(
        channelId: String,
        body: String,
        replyToId: String? = nil,
        attachmentIds: [String] = []
    ) async -> String {
        let nonce = UUID().uuidString
        var frame: [String: Any] = [
            "type": "message-create",
            "channelId": channelId,
            "body": body,
            "nonce": nonce,
        ]
        if let replyToId { frame["replyToId"] = replyToId }
        if !attachmentIds.isEmpty { frame["attachmentIds"] = attachmentIds }
        await send(raw: frame)
        return nonce
    }

    // MARK: - Voice

    /// `transports` is a capability declaration, not a preference: this client
    /// speaks mesh and LiveKit, and saying exactly that lets the server refuse a
    /// room pinned to anything else *before* a peer exists, instead of us
    /// appearing in the roster and then hearing nobody. Omitting it means
    /// "assume everything", which would be a lie the day a third one ships.
    ///
    /// `declaresResume` and `resume` are the two halves of surviving a socket
    /// drop in an SFU room; see `joinVoiceRoomFrame` for what each means.
    func joinVoice(
        channelId: String,
        declaresResume: Bool = false,
        resume: VoiceResumeClaim? = nil
    ) async {
        await send(raw: joinVoiceRoomFrame(
            channelId: channelId, declaresResume: declaresResume, resume: resume
        ))
    }

    func leaveVoice() async {
        await send(raw: ["type": "leave-voice-room"])
    }

    func sendOffer(to peerId: String, from selfPeerId: String, sdp: String) async {
        await send(raw: ["type": "offer", "from": selfPeerId, "to": peerId, "sdp": sdp])
    }

    func sendAnswer(to peerId: String, from selfPeerId: String, sdp: String) async {
        await send(raw: ["type": "answer", "from": selfPeerId, "to": peerId, "sdp": sdp])
    }

    func sendCandidate(
        to peerId: String,
        from selfPeerId: String,
        sdp: String,
        sdpMid: String?,
        sdpMLineIndex: Int32
    ) async {
        await send(raw: [
            "type": "ice-candidate",
            "from": selfPeerId,
            "to": peerId,
            "candidate": [
                "candidate": sdp,
                "sdpMid": sdpMid as Any,
                "sdpMLineIndex": Int(sdpMLineIndex),
            ],
        ])
    }

    // MARK: - Conversation calls

    /// Ring the conversation's absent participants.
    ///
    /// Only ever sent *after* `welcome` for that same conversation: the server
    /// refuses a ring from anyone who is not already a live peer of exactly this
    /// room, which is what stops a forged ring from reaching a stranger.
    func ringCall(conversationId: String) async {
        await send(raw: ["type": "call-ring", "conversationId": conversationId])
    }

    /// Refuse a ring. There is no matching "accept" — accepting is joining.
    func declineCall(conversationId: String) async {
        await send(raw: ["type": "call-decline", "conversationId": conversationId])
    }

    /// Declare the camera to the room. `streamId` is our local capture's
    /// MediaStream id, or nil for "camera off". Receivers cannot tell our camera
    /// from a screen share without this.
    func setCamera(streamId: String?) async {
        // `NSNull`, not `nil as Any`: JSONSerialization rejects an Optional and
        // `send` swallows the throw, so the "camera off" frame would simply
        // never leave — and the far end would keep drawing a frozen face.
        let value: Any = streamId ?? NSNull()
        await send(raw: ["type": "set-camera", "streamId": value])
    }

    /// Declare a screen share to the room.
    ///
    /// Separate from the media: the track travels over WebRTC, this is what puts
    /// `sharingScreen` on everyone's roster — which is what draws "X is
    /// presenting", and what the server checks against the per-transport cap.
    /// The web client sends exactly this (`use-voice.ts`), so a share announced
    /// any other way is invisible to it.
    func setSharingScreen(_ sharing: Bool) async {
        await send(raw: ["type": "set-sharing-screen", "sharing": sharing])
    }

    /// Mute/deafen, for the roster badges people outside the call see. Display
    /// state — the actual silencing is local and already done by the time this
    /// goes out.
    func setVoiceState(muted: Bool, deafened: Bool) async {
        await send(raw: ["type": "set-voice-state", "muted": muted, "deafened": deafened])
    }

    func sendTyping(channelId: String) async {
        await send(raw: ["type": "typing", "channelId": channelId])
    }

    /// Idle is socket-scoped and dies with the connection, so the caller must
    /// re-send it after a reconnect if the device is still asleep.
    func sendIdle(_ idle: Bool) async {
        await send(raw: ["type": "set-idle", "idle": idle])
    }

    func toggleReaction(channelId: String, messageId: String, emoji: String) async {
        await send(raw: [
            "type": "reaction-toggle",
            "channelId": channelId,
            "messageId": messageId,
            "emoji": emoji,
        ])
    }

    // MARK: - Decoding

    private struct Envelope: Decodable {
        let type: String
        let nonce: String?
        let message: Message?
        let channelId: String?
        let messageId: String?
        let emoji: String?
        let userId: String?
        let displayName: String?
        let added: Bool?
        let users: [PresenceUser]?
        let serverId: String?
        let mention: Bool?
        // Voice
        let peerId: String?
        let voiceChannelId: String?
        let peers: [VoiceParticipant]?
        let participants: [VoiceParticipant]?
        let peer: VoiceParticipant?
        let selfPeer: VoiceParticipant?
        let sdp: String?
        let from: String?
        let candidate: IceCandidatePayload?
        let limit: Int?
        let transport: String?
        /// Roster frames only: where this frame sits in the room's sequence.
        /// Absent on a `voice-roster` from a server that predates deltas, and
        /// absent reads as 0. See `VoiceRosterTracker`.
        let seq: Int?
        /// `voice-roster-delta` only: how many participants the room has once
        /// the frame has been applied. The second, independent check on a
        /// delta, and the one that catches divergence `seq` cannot see.
        let size: Int?
        /// `voice-roster-delta` only. Absent means "nothing of this kind
        /// changed", never "nobody is here".
        let joined: [VoiceParticipant]?
        let updated: [VoiceParticipant]?
        /// `voice-roster-delta` only: peer ids, not participants.
        let left: [String]?
        /// `welcome` only. See `RealtimeEvent.voiceWelcome`.
        let resumed: Bool?
        let resumeToken: String?
        /// `welcome` (top level, same value as `self.canSpeak`) and
        /// `voice-speak-changed`.
        let canSpeak: Bool?
        /// `welcome` (top level, same value as `self.canStream`) and
        /// `voice-speak-changed`. Absent means a server from before SPEAK and
        /// STREAM were separate grants.
        let canStream: Bool?
        /// `permissions-update` only. Optional because the frame is advisory:
        /// the client refetches either way, and a missing version just means
        /// "refetch anyway" (`shouldApplyPermissionsVersion` on the web).
        let version: Int?
        // Conversation calls
        let conversationId: String?
        let kind: String?
        let caller: CallerSummary?
        let reason: String?
        // Threads
        let thread: ThreadSummary?
        /// `message-rejected` only: how long the sender must wait, when the
        /// refusal is a temporary one.
        let retryAfterMs: Int?
        /// `message-rejected` with `reason: automod`: the rule's own copy.
        let automodMessage: String?

        enum CodingKeys: String, CodingKey {
            case type, nonce, message, channelId, messageId, emoji, userId
            case displayName, added, users, serverId, mention
            case peerId, voiceChannelId, peers, participants, peer, sdp, from
            case candidate, limit, transport, version, resumed, resumeToken
            case canSpeak, canStream
            case seq, size, joined, updated, left
            case conversationId, kind, caller, reason, thread, retryAfterMs, automodMessage
            // `self` is a Swift keyword, so the wire key is remapped.
            case selfPeer = "self"
        }
    }

    /// `sanction-notice` reuses the key `message` for a *string* where every
    /// chat frame uses it for an object, so it cannot share the envelope — the
    /// shared decode would fail on exactly the frame that explains a refusal.
    private struct SanctionFrame: Decodable {
        let sanction: String
        let serverId: String
        let channelId: String
        let expiresAt: Date
        let reason: String?
        let message: String
    }

    /**
     `presence-delta`, decoded on its own rather than through `Envelope`.

     It has to be, and the reason is a live trap in this file. `Envelope.joined`
     is `[VoiceParticipant]?`, because the voice roster delta got there first
     and the two frames happen to share a key name. A `PresenceUser` is
     `{id, name, avatarUrl}` and a `VoiceParticipant` needs `peerId`,
     `userId` and `displayName`, so decoding a presence delta through
     `Envelope` THROWS on that one field, `try?` swallows it, and every frame
     is dropped with nothing anywhere saying so. That would look exactly like
     the capability having no effect, which is the failure shape this repo
     keeps getting bitten by. `SanctionFrame` exists for the same reason.
     */
    private struct PresenceDeltaFrame: Decodable {
        let channelId: String
        let seq: Int
        let size: Int
        let joined: [PresenceUser]?
        let left: [String]?
    }

    private struct TypeProbe: Decodable { let type: String }

    /// Internal rather than private so tests can feed frames straight in —
    /// the decode rules ARE the wire contract, and they are exactly the kind
    /// of thing that silently drifts.
    func ingest(_ data: Data) {
        guard let probe = try? Coding.decoder.decode(TypeProbe.self, from: data) else {
            return
        }

        if probe.type == "pong" {
            missedPongs = 0
            return
        }

        if probe.type == "sanction-notice" {
            guard let frame = try? Coding.decoder.decode(SanctionFrame.self, from: data) else { return }
            continuation?.yield(.sanctionNotice(SanctionNotice(
                sanction: frame.sanction,
                serverId: frame.serverId,
                channelId: frame.channelId,
                expiresAt: frame.expiresAt,
                reason: frame.reason,
                message: frame.message
            )))
            return
        }

        // BEFORE `Envelope`, and it has to be: see `PresenceDeltaFrame` for the
        // key collision that makes decoding this frame through the shared
        // envelope throw and vanish.
        //
        // Only ever sent to a socket that asked for it on `auth`. A frame the
        // tracker refuses is not an error and is deliberately silent: nothing
        // is emitted, whoever is reading keeps the list they had, and the
        // server's next whole list repairs it wholesale.
        if probe.type == "presence-delta" {
            guard let frame = try? Coding.decoder.decode(PresenceDeltaFrame.self, from: data),
                  let users = presenceTracker.apply(
                      deltaFor: frame.channelId,
                      seq: frame.seq,
                      size: frame.size,
                      joined: frame.joined ?? [],
                      left: frame.left ?? []
                  )
            else { return }
            continuation?.yield(.presence(channelId: frame.channelId, users: users))
            return
        }

        guard let envelope = try? Coding.decoder.decode(Envelope.self, from: data) else {
            return
        }

        let event: RealtimeEvent
        switch envelope.type {
        case "ready":
            reconnectAttempt = 0
            missedPongs = 0
            statusHandler?(.online)
            // Now — and only now — the socket is authenticated, so the slots
            // the server forgot on disconnect can be re-asserted.
            Task { [joinedChannelId, joinedThreadChannelId] in
                if let joinedChannelId {
                    await self.send(raw: ["type": "join-channel", "channelId": joinedChannelId])
                }
                if let joinedThreadChannelId {
                    await self.send(raw: ["type": "thread-join", "channelId": joinedThreadChannelId])
                }
            }
            event = .ready
        case "message-broadcast":
            guard let message = envelope.message else { return }
            event = .messageCreated(message, nonce: envelope.nonce)
        case "message-update":
            guard let message = envelope.message else { return }
            event = .messageUpdated(message)
        case "message-rejected":
            // `reason` is required by the schema; a frame without one is not
            // a refusal this client can act on. `nonce` is optional on the
            // wire, though this app always sends one, so a refusal that comes
            // back without it is passed along and the model decides.
            guard let channelId = envelope.channelId, let reason = envelope.reason else { return }
            event = .messageRejected(MessageRejection(
                channelId: channelId,
                nonce: envelope.nonce,
                reason: reason,
                retryAfterMs: envelope.retryAfterMs,
                automodMessage: envelope.automodMessage
            ))
        // Two spellings on the wire — `message-deleted` is a legacy duplicate
        // that is still emitted, so both are handled.
        case "message-delete", "message-deleted":
            guard let channelId = envelope.channelId, let messageId = envelope.messageId else { return }
            event = .messageDeleted(channelId: channelId, messageId: messageId)
        case "reaction-broadcast":
            guard let channelId = envelope.channelId, let messageId = envelope.messageId,
                  let emoji = envelope.emoji, let userId = envelope.userId,
                  let added = envelope.added else { return }
            event = .reaction(channelId: channelId, messageId: messageId,
                              emoji: emoji, userId: userId, added: added,
                              displayName: envelope.displayName)
        case "typing-broadcast":
            guard let channelId = envelope.channelId, let userId = envelope.userId,
                  let displayName = envelope.displayName else { return }
            event = .typing(channelId: channelId, userId: userId, displayName: displayName)
        case "presence-update":
            guard let channelId = envelope.channelId else { return }
            let users = envelope.users ?? []
            // Recorded even though the list is passed on verbatim: a snapshot
            // is the baseline every following delta is measured against, and
            // its `seq` is the number they have to follow on from.
            presenceTracker.apply(snapshot: users, channelId: channelId, seq: envelope.seq)
            event = .presence(channelId: channelId, users: users)
        case "channel-activity":
            guard let channelId = envelope.channelId else { return }
            event = .activity(channelId: channelId, serverId: envelope.serverId,
                              mention: envelope.mention ?? false)
        case "thread-update":
            guard let channelId = envelope.channelId, let messageId = envelope.messageId,
                  let thread = envelope.thread else { return }
            event = .threadUpdate(channelId: channelId, messageId: messageId, thread: thread)
        case "friend-activity":
            // Reuses the envelope's `kind`, which the call frames already carry.
            // A value outside the enum is dropped rather than defaulted: a nudge
            // whose reason we cannot name is a refresh with no story behind it.
            guard let raw = envelope.kind, let kind = FriendActivityKind(rawValue: raw)
            else { return }
            event = .friendActivity(kind: kind)
        case "permissions-update":
            guard let serverId = envelope.serverId else { return }
            event = .permissionsUpdate(serverId: serverId, version: envelope.version)
        case "community-home-update":
            guard let serverId = envelope.serverId else { return }
            event = .communityHomeUpdate(serverId: serverId)

        case "welcome":
            guard let peerId = envelope.peerId,
                  let voiceChannelId = envelope.voiceChannelId,
                  let selfPeer = envelope.selfPeer else { return }
            event = .voiceWelcome(peerId: peerId, voiceChannelId: voiceChannelId,
                                  peers: envelope.peers ?? [], selfPeer: selfPeer,
                                  transport: envelope.transport,
                                  resumed: envelope.resumed ?? false,
                                  resumeToken: envelope.resumeToken,
                                  canSpeak: VoiceSpeakRule.resolve(
                                      topLevel: envelope.canSpeak,
                                      selfPeer: selfPeer.canSpeak
                                  ),
                                  canStream: VoiceSpeakRule.resolveStream(
                                      topLevel: envelope.canStream,
                                      selfPeer: selfPeer.canStream,
                                      canSpeak: VoiceSpeakRule.resolve(
                                          topLevel: envelope.canSpeak,
                                          selfPeer: selfPeer.canSpeak
                                      )
                                  ))
        case "peer-joined":
            guard let peer = envelope.peer else { return }
            event = .voicePeerJoined(peer)
        case "peer-updated":
            guard let peer = envelope.peer else { return }
            event = .voicePeerUpdated(peer)
        case "peer-left":
            guard let peerId = envelope.peerId else { return }
            event = .voicePeerLeft(peerId: peerId)
        // BOTH ROSTER FRAMES LEAVE HERE AS THE SAME EVENT, carrying the whole
        // room. A snapshot brings its own list; a delta produces one by
        // patching the list this client already held. Everything downstream
        // reads one case and therefore cannot behave differently depending on
        // which frame the server happened to send, which is the property worth
        // having: `VoiceModel` and `CallModel` both fold a roster into their
        // peers by peer id and remove nobody (departures are `peer-left`, which
        // still arrives for the room this device is in), so a complete list is
        // exactly what both of them already expect.
        case "voice-roster":
            guard let voiceChannelId = envelope.voiceChannelId else { return }
            let participants = envelope.participants ?? []
            // Recorded even though the list is passed on verbatim: a snapshot
            // is the baseline every following delta is measured against, and
            // its `seq` is the number they have to follow on from.
            rosterTracker.apply(snapshot: participants,
                                voiceChannelId: voiceChannelId,
                                seq: envelope.seq)
            event = .voiceRoster(voiceChannelId: voiceChannelId, participants: participants)
        case "voice-roster-delta":
            // Only ever sent to a socket that asked for it on `auth`. A frame
            // the tracker refuses is not an error and is deliberately silent:
            // nothing is emitted, the models keep the room they had, and the
            // server's next full roster repairs the state wholesale.
            guard let voiceChannelId = envelope.voiceChannelId,
                  let seq = envelope.seq,
                  let size = envelope.size,
                  let participants = rosterTracker.apply(
                      deltaFor: voiceChannelId,
                      seq: seq,
                      size: size,
                      joined: envelope.joined ?? [],
                      updated: envelope.updated ?? [],
                      left: envelope.left ?? []
                  )
            else { return }
            event = .voiceRoster(voiceChannelId: voiceChannelId, participants: participants)
        case "voice-speak-changed":
            guard let voiceChannelId = envelope.voiceChannelId,
                  let canSpeak = envelope.canSpeak else { return }
            // `canStream` absent means a server from before the grants were
            // split, where SPEAK carried both. Never `true`: defaulting a
            // missing permission open is the wrong direction to be wrong in.
            event = .voiceSpeakChanged(
                voiceChannelId: voiceChannelId,
                canSpeak: canSpeak,
                canStream: envelope.canStream ?? canSpeak
            )
        case "voice-join-refused":
            guard let voiceChannelId = envelope.voiceChannelId else { return }
            event = .voiceJoinRefused(voiceChannelId: voiceChannelId, reason: envelope.reason)
        case "voice-room-full":
            event = .voiceRoomFull(limit: envelope.limit ?? 0)
        case "screen-share-denied":
            guard let voiceChannelId = envelope.voiceChannelId else { return }
            event = .voiceScreenShareDenied(voiceChannelId: voiceChannelId)
        case "camera-denied":
            guard let voiceChannelId = envelope.voiceChannelId else { return }
            event = .voiceCameraDenied(voiceChannelId: voiceChannelId)
        case "voice-transport-unsupported":
            guard let voiceChannelId = envelope.voiceChannelId,
                  let transport = envelope.transport else { return }
            event = .voiceTransportUnsupported(voiceChannelId: voiceChannelId,
                                               transport: transport,
                                               reason: envelope.reason)
        case "voice-transport-changed":
            // `participants` is required rather than defaulted to empty. The
            // whole point of the frame carrying the room is that the follower
            // does not have to wait for a roster, and an empty list would move
            // this session to the SFU holding a roster of nobody, so everyone
            // else in the call would vanish from the screen until a keyframe
            // arrived. A frame without it is one this build does not
            // understand, and dropping it leaves the seat exactly where it is
            // rather than half moving it.
            guard let voiceChannelId = envelope.voiceChannelId,
                  let transport = envelope.transport,
                  let participants = envelope.participants else { return }
            event = .voiceTransportChanged(voiceChannelId: voiceChannelId,
                                           transport: transport,
                                           reason: envelope.reason,
                                           participants: participants)
        case "offer":
            guard let from = envelope.from, let sdp = envelope.sdp else { return }
            event = .voiceOffer(from: from, sdp: sdp)
        case "answer":
            guard let from = envelope.from, let sdp = envelope.sdp else { return }
            event = .voiceAnswer(from: from, sdp: sdp)
        case "ice-candidate":
            guard let from = envelope.from else { return }
            event = .voiceCandidate(from: from, candidate: envelope.candidate)

        case "call-incoming":
            guard let conversationId = envelope.conversationId,
                  let caller = envelope.caller else { return }
            event = .callIncoming(IncomingCall(
                conversationId: conversationId,
                // Absent would be a server that predates group calls; a 1:1 is
                // the safe read and the only shape iOS draws differently.
                kind: envelope.kind ?? "dm",
                callerUserId: caller.userId,
                callerName: caller.displayName,
                callerAvatarUrl: caller.avatarUrl
            ))
        case "call-ring-cancelled":
            guard let conversationId = envelope.conversationId else { return }
            event = .callRingCancelled(conversationId: conversationId,
                                       reason: envelope.reason ?? "cancelled")
        case "call-declined":
            guard let conversationId = envelope.conversationId,
                  let userId = envelope.userId else { return }
            event = .callDeclined(conversationId: conversationId, userId: userId)
        default:
            event = .other
        }
        continuation?.yield(event)
    }
}
