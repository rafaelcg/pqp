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
    case other
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
    private var isStopped = false

    init(backend: Backend = .current, tokenProvider: any TokenProviding) {
        self.backend = backend
        self.tokenProvider = tokenProvider
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
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

        // Re-enter the channel the user is looking at; the server forgets on
        // disconnect and would otherwise deliver nothing.
        if let joinedChannelId {
            await send(raw: ["type": "join-channel", "channelId": joinedChannelId])
        }
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
                decode(data)
            }
            listen()
        case .failure:
            guard !isStopped else { return }
            await scheduleReconnect()
        }
    }

    private func scheduleReconnect() async {
        task = nil
        statusHandler?(.reconnecting)
        reconnectAttempt += 1
        // Capped exponential backoff. Without the cap a long outage pushes the
        // next attempt hours out and the app never comes back on its own.
        let delay = min(pow(2, Double(reconnectAttempt)) * 0.5, 20)
        try? await Task.sleep(for: .seconds(delay))
        await openSocket()
    }

    // MARK: - Sending

    private func send(raw: [String: Any]) async {
        guard let task,
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let text = String(data: data, encoding: .utf8) else { return }
        try? await task.send(.string(text))
    }

    func join(channelId: String) async {
        joinedChannelId = channelId
        await send(raw: ["type": "join-channel", "channelId": channelId])
    }

    /// Returns the nonce so the caller can match the echo back to its optimistic
    /// row. There is no ack frame and no error frame — the nonce is the only
    /// correlation the protocol offers.
    @discardableResult
    func sendMessage(channelId: String, body: String, replyToId: String? = nil) async -> String {
        let nonce = UUID().uuidString
        var frame: [String: Any] = [
            "type": "message-create",
            "channelId": channelId,
            "body": body,
            "nonce": nonce,
        ]
        if let replyToId { frame["replyToId"] = replyToId }
        await send(raw: frame)
        return nonce
    }

    func sendTyping(channelId: String) async {
        await send(raw: ["type": "typing", "channelId": channelId])
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
    }

    private func decode(_ data: Data) {
        guard let envelope = try? Coding.decoder.decode(Envelope.self, from: data) else {
            return
        }

        let event: RealtimeEvent
        switch envelope.type {
        case "ready":
            reconnectAttempt = 0
            statusHandler?(.online)
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
        default:
            event = .other
        }
        continuation?.yield(event)
    }
}
