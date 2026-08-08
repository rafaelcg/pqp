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
    case reaction(channelId: String, messageId: String, emoji: String, userId: String, added: Bool)
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

    // Voice signalling. The server is a pure relay for offer/answer/candidate;
    // everything else here is room membership.
    case voiceWelcome(peerId: String, voiceChannelId: String, peers: [VoiceParticipant],
                      selfPeer: VoiceParticipant, transport: String?)
    case voicePeerJoined(VoiceParticipant)
    case voicePeerLeft(peerId: String)
    case voiceRoster(voiceChannelId: String, participants: [VoiceParticipant])
    case voiceRoomFull(limit: Int)
    /// Somebody else is already presenting. The protocol allows exactly one
    /// screen per room (`set-sharing-screen` in `server/src/ws/voice.ts`), and
    /// this is the only refusal it explains — unicast to whoever tried.
    case voiceScreenShareDenied(voiceChannelId: String)
    /// The server refused the join because this room is pinned to a transport
    /// we declared we cannot do. Nobody ever saw us in the roster.
    case voiceTransportUnsupported(voiceChannelId: String, transport: String)
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
    /// Self-reported over `set-voice-state`; display only, never enforcement.
    var muted: Bool = false
    var deafened: Bool = false

    var id: String { peerId }

    enum CodingKeys: String, CodingKey {
        case peerId, userId, displayName, avatarUrl, sharingScreen
        case cameraStreamId, muted, deafened
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        peerId = try c.decode(String.self, forKey: .peerId)
        userId = try c.decode(String.self, forKey: .userId)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName) ?? "Someone"
        avatarUrl = try c.decodeIfPresent(String.self, forKey: .avatarUrl)
        sharingScreen = try c.decodeIfPresent(Bool.self, forKey: .sharingScreen) ?? false
        cameraStreamId = try c.decodeIfPresent(String.self, forKey: .cameraStreamId)
        muted = try c.decodeIfPresent(Bool.self, forKey: .muted) ?? false
        deafened = try c.decodeIfPresent(Bool.self, forKey: .deafened) ?? false
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

        await send(raw: ["type": "auth", "token": token])
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
    /// row. There is no ack frame and no error frame — the nonce is the only
    /// correlation the protocol offers.
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

    func joinVoice(channelId: String) async {
        // `transports` is a capability declaration, not a preference. This
        // client only speaks mesh; saying so lets the server refuse a
        // LiveKit-pinned room *before* a peer exists, instead of us appearing
        // in the roster and then hearing nobody. Omitting it means "assume
        // everything", which is a lie here.
        await send(raw: [
            "type": "join-voice-room",
            "voiceChannelId": channelId,
            "transports": ["mesh"],
        ])
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
    /// presenting", and what the server checks to keep the room to one presenter.
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
        // Conversation calls
        let conversationId: String?
        let kind: String?
        let caller: CallerSummary?
        let reason: String?
        // Threads
        let thread: ThreadSummary?

        enum CodingKeys: String, CodingKey {
            case type, nonce, message, channelId, messageId, emoji, userId
            case displayName, added, users, serverId, mention
            case peerId, voiceChannelId, peers, participants, peer, sdp, from
            case candidate, limit, transport
            case conversationId, kind, caller, reason, thread
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
                              emoji: emoji, userId: userId, added: added)
        case "typing-broadcast":
            guard let channelId = envelope.channelId, let userId = envelope.userId,
                  let displayName = envelope.displayName else { return }
            event = .typing(channelId: channelId, userId: userId, displayName: displayName)
        case "presence-update":
            guard let channelId = envelope.channelId else { return }
            event = .presence(channelId: channelId, users: envelope.users ?? [])
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

        case "welcome":
            guard let peerId = envelope.peerId,
                  let voiceChannelId = envelope.voiceChannelId,
                  let selfPeer = envelope.selfPeer else { return }
            event = .voiceWelcome(peerId: peerId, voiceChannelId: voiceChannelId,
                                  peers: envelope.peers ?? [], selfPeer: selfPeer,
                                  transport: envelope.transport)
        case "peer-joined":
            guard let peer = envelope.peer else { return }
            event = .voicePeerJoined(peer)
        case "peer-left":
            guard let peerId = envelope.peerId else { return }
            event = .voicePeerLeft(peerId: peerId)
        case "voice-roster":
            guard let voiceChannelId = envelope.voiceChannelId else { return }
            event = .voiceRoster(voiceChannelId: voiceChannelId,
                                 participants: envelope.participants ?? [])
        case "voice-room-full":
            event = .voiceRoomFull(limit: envelope.limit ?? 0)
        case "screen-share-denied":
            guard let voiceChannelId = envelope.voiceChannelId else { return }
            event = .voiceScreenShareDenied(voiceChannelId: voiceChannelId)
        case "voice-transport-unsupported":
            guard let voiceChannelId = envelope.voiceChannelId,
                  let transport = envelope.transport else { return }
            event = .voiceTransportUnsupported(voiceChannelId: voiceChannelId, transport: transport)
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
