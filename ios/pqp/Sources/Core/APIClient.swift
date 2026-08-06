import Foundation

enum APIError: LocalizedError, Sendable {
    case unauthorized
    case notFound(String)
    case rateLimited(retryAfter: Int?)
    case server(status: Int, message: String)
    case transport(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .unauthorized:
            "Your session expired. Sign in again."
        case .notFound(let what):
            what
        case .rateLimited(let retryAfter):
            retryAfter.map { "Too many requests. Try again in \($0)s." }
                ?? "Too many requests. Try again shortly."
        case .server(_, let message):
            message
        case .transport(let message):
            message
        case .decoding(let detail):
            // Surfaced rather than swallowed: a decode failure means the client
            // and server disagree about a shape, and a silent empty list makes
            // that look like "no data" for weeks.
            "Could not read the server's response. \(detail)"
        }
    }
}

/// Where the app is pointed. Debug builds default to the local dev server so
/// the whole app is exercisable against `pnpm dev`; release points at hosted.
struct Backend: Sendable, Equatable {
    var apiBaseURL: URL
    var webSocketURL: URL

    static let local = Backend(
        apiBaseURL: URL(string: "http://localhost:3001")!,
        webSocketURL: URL(string: "ws://localhost:3001/ws")!
    )

    static let hosted = Backend(
        apiBaseURL: URL(string: "https://api-production-206d.up.railway.app")!,
        webSocketURL: URL(string: "wss://api-production-206d.up.railway.app/ws")!
    )

    static var current: Backend {
        #if DEBUG
        // Lets a UI test point the app at a dead port to prove launch survives
        // an unreachable server. Debug-only, so it cannot affect a release.
        if let override = ProcessInfo.processInfo.environment["PQP_API_OVERRIDE"],
           let url = URL(string: override) {
            return Backend(
                apiBaseURL: url,
                webSocketURL: URL(string: "ws://127.0.0.1:9/ws")!
            )
        }
        // On a physical device `localhost` is the phone, not the Mac running
        // the dev server — so a device build has to be told the Mac's address.
        // Set `PQP_API_HOST` at build time; the simulator needs nothing.
        if let host = Bundle.main.object(forInfoDictionaryKey: "PqpApiHost") as? String,
           !host.isEmpty, !host.hasPrefix("$("),
           let api = URL(string: "http://\(host):3001"),
           let ws = URL(string: "ws://\(host):3001/ws") {
            return Backend(apiBaseURL: api, webSocketURL: ws)
        }
        return .local
        #else
        return .hosted
        #endif
    }
}

/// JSON coding configured once.
///
/// The server emits `Date.toISOString()`, which always carries milliseconds.
/// `JSONDecoder.DateDecodingStrategy.iso8601` rejects fractional seconds, so
/// using it here would fail on literally every message. This tries both.
enum Coding {
    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]

        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            if let date = withFraction.date(from: raw) ?? plain.date(from: raw) {
                return date
            }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath,
                      debugDescription: "Unrecognised date: \(raw)")
            )
        }
        return decoder
    }()

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}

/// Supplies the bearer token for each request. A protocol rather than a stored
/// string because a Clerk token expires and must be re-read per request, which
/// is exactly the mistake the web client already made once.
protocol TokenProviding: Sendable {
    func currentToken() async -> String?
}

/// Development identity. The server accepts this only when `DEV_AUTH_BYPASS`
/// is on and `NODE_ENV != production`, so it cannot work against the hosted API.
struct DevTokenProvider: TokenProviding {
    func currentToken() async -> String? { "dev-local-token" }
}

actor APIClient {
    private let backend: Backend
    private let tokenProvider: any TokenProviding
    private let session: URLSession

    init(backend: Backend = .current, tokenProvider: any TokenProviding) {
        self.backend = backend
        self.tokenProvider = tokenProvider
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        // Deliberately NOT waitsForConnectivity. That flag parks a request
        // until the network comes back, bounded only by
        // `timeoutIntervalForResource` — which defaults to seven days. With an
        // unreachable server the very first call never returns, and an app
        // whose launch awaits it sits on its splash screen forever. Failing
        // fast and showing something is strictly better.
        config.waitsForConnectivity = false
        config.timeoutIntervalForResource = 30
        self.session = URLSession(configuration: config)
    }

    // MARK: - Requests

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        try await send(path: path, method: "GET", query: query, body: Optional<Data>.none)
    }

    @discardableResult
    func post<T: Decodable>(_ path: String, body: (some Encodable)? = Optional<Data>.none) async throws -> T {
        let data = try body.map { try Coding.encoder.encode($0) }
        return try await send(path: path, method: "POST", query: [], body: data)
    }

    @discardableResult
    func patch<T: Decodable>(_ path: String, body: some Encodable) async throws -> T {
        try await send(path: path, method: "PATCH", query: [], body: try Coding.encoder.encode(body))
    }

    fileprivate func send<T: Decodable>(
        path: String,
        method: String,
        query: [URLQueryItem],
        body: Data?
    ) async throws -> T {
        guard var components = URLComponents(
            url: backend.apiBaseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        ) else {
            throw APIError.transport("Bad URL for \(path)")
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else {
            throw APIError.transport("Bad URL for \(path)")
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = await tokenProvider.currentToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = body

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("Malformed response")
        }

        guard (200..<300).contains(http.statusCode) else {
            // Every non-2xx body is `{ "error": "..." }`; fall back to the
            // status if we somehow got something else (e.g. hit a static host).
            let message = (try? Coding.decoder.decode(ApiErrorBody.self, from: data))?.error
                ?? "Request failed (\(http.statusCode))"
            switch http.statusCode {
            case 401: throw APIError.unauthorized
            case 404: throw APIError.notFound(message)
            case 429:
                let retry = (http.value(forHTTPHeaderField: "Retry-After")).flatMap(Int.init)
                throw APIError.rateLimited(retryAfter: retry)
            default: throw APIError.server(status: http.statusCode, message: message)
            }
        }

        if T.self == EmptyResponse.self, let empty = EmptyResponse() as? T {
            return empty
        }

        do {
            return try Coding.decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }
}

struct EmptyResponse: Codable, Sendable {}

/// An explicit empty JSON body, for POSTs that take no arguments.
struct EmptyBody: Encodable, Sendable {}

// MARK: - Endpoints

extension APIClient {
    func currentUser() async throws -> CurrentUser {
        try await get("/api/me")
    }

    func servers() async throws -> [Server] {
        let response: ServersResponse = try await get("/api/servers")
        return response.servers
    }

    func channels(serverId: String) async throws -> [Channel] {
        let response: ChannelsResponse = try await get("/api/servers/\(serverId)/channels")
        return response.channels
    }

    /// `before` is a **message id**, not a timestamp or an offset.
    func messages(channelId: String, before: String? = nil, limit: Int = 50) async throws -> MessagesResponse {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        return try await get("/api/channels/\(channelId)/messages", query: query)
    }

    func conversations() async throws -> [DmSummary] {
        let response: DmsResponse = try await get("/api/dms")
        return response.conversations
    }

    func unread(serverId: String) async throws -> [UnreadEntry] {
        let response: UnreadResponse = try await get("/api/servers/\(serverId)/unread")
        return response.unread
    }

    func markRead(channelId: String) async throws {
        let _: EmptyResponse = try await post("/api/channels/\(channelId)/read")
    }

    func members(serverId: String) async throws -> [ServerMember] {
        let response: MembersResponse = try await get("/api/servers/\(serverId)/members")
        return response.members
    }

    func createServer(name: String) async throws -> Server {
        struct Body: Encodable { let name: String }
        struct Response: Decodable { let server: Server }
        let response: Response = try await post("/api/servers", body: Body(name: name))
        return response.server
    }

    func editMessage(id: String, body: String) async throws -> Message {
        struct Body: Encodable { let body: String }
        struct Response: Decodable { let message: Message }
        let response: Response = try await patch("/api/messages/\(id)", body: Body(body: body))
        return response.message
    }

    func deleteServer(id: String) async throws {
        let _: EmptyResponse = try await send(
            path: "/api/servers/\(id)", method: "DELETE", query: [], body: nil
        )
    }

    func deleteMessage(id: String) async throws {
        let _: EmptyResponse = try await send(
            path: "/api/messages/\(id)", method: "DELETE", query: [], body: nil
        )
    }

    /// Prefix search over handles. Excludes the caller server-side.
    func searchUsers(query: String) async throws -> [PublicUser] {
        struct Response: Decodable { let users: [PublicUser] }
        let response: Response = try await get(
            "/api/users/search", query: [URLQueryItem(name: "q", value: query)]
        )
        return response.users
    }

    /// Exact `name#1234` lookup — the half of discovery that is not enumerable.
    func lookupUser(tag: String) async throws -> PublicUser {
        struct Response: Decodable { let user: PublicUser }
        let response: Response = try await get(
            "/api/users/lookup", query: [URLQueryItem(name: "tag", value: tag)]
        )
        return response.user
    }

    func openConversation(userIds: [String]) async throws -> DmSummary {
        struct Body: Encodable { let userIds: [String] }
        struct Response: Decodable { let conversation: DmSummary }
        let response: Response = try await post("/api/dms", body: Body(userIds: userIds))
        return response.conversation
    }

    // MARK: Preferences, audit, webhooks, channel members

    func preferences() async throws -> UserPreferences {
        struct Me: Decodable { let preferences: UserPreferences? }
        let me: Me = try await get("/api/me")
        return me.preferences ?? UserPreferences()
    }

    /// Preferences merge one level deep server-side, so the whole notification
    /// object is sent every time — patching a single key would drop the rest.
    func updatePreferences(_ preferences: UserPreferences) async throws -> UserPreferences {
        let response: PreferencesResponse = try await patch("/api/me/preferences", body: preferences)
        return response.preferences
    }

    func auditLog(serverId: String) async throws -> [AuditEntry] {
        let response: AuditResponse = try await get("/api/servers/\(serverId)/audit-log")
        return response.entries
    }

    func webhooks(channelId: String) async throws -> [Webhook] {
        let response: WebhooksResponse = try await get("/api/channels/\(channelId)/webhooks")
        return response.webhooks
    }

    func createWebhook(channelId: String, name: String) async throws -> Webhook {
        struct Body: Encodable { let name: String }
        struct Response: Decodable { let webhook: Webhook }
        let response: Response = try await post(
            "/api/channels/\(channelId)/webhooks", body: Body(name: name)
        )
        return response.webhook
    }

    func deleteWebhook(id: String) async throws {
        let _: EmptyResponse = try await send(
            path: "/api/webhooks/\(id)", method: "DELETE", query: [], body: nil
        )
    }

    func channelMembers(channelId: String) async throws -> [PublicUser] {
        let response: ChannelMembersResponse = try await get("/api/channels/\(channelId)/members")
        return response.members
    }

    func addChannelMember(channelId: String, userId: String) async throws {
        struct Body: Encodable { let userId: String }
        let _: EmptyResponse = try await post(
            "/api/channels/\(channelId)/members", body: Body(userId: userId)
        )
    }

    func removeChannelMember(channelId: String, userId: String) async throws {
        let _: EmptyResponse = try await send(
            path: "/api/channels/\(channelId)/members/\(userId)",
            method: "DELETE", query: [], body: nil
        )
    }

    func setRetention(serverId: String, days: Int?) async throws -> Server {
        struct Body: Encodable { let messageRetentionDays: Int? }
        struct Response: Decodable { let server: Server? }
        let response: Response = try await patch(
            "/api/servers/\(serverId)", body: Body(messageRetentionDays: days)
        )
        guard let server = response.server else {
            throw APIError.server(status: 200, message: "Server did not return the update")
        }
        return server
    }

    func setSsoDomain(serverId: String, domain: String?) async throws -> Server {
        struct Body: Encodable { let ssoEmailDomain: String? }
        struct Response: Decodable { let server: Server? }
        let response: Response = try await patch(
            "/api/servers/\(serverId)", body: Body(ssoEmailDomain: domain)
        )
        guard let server = response.server else {
            throw APIError.server(status: 200, message: "Server did not return the update")
        }
        return server
    }

    /// Raw bytes, not JSON-decoded: this is a file the user is about to save,
    /// not data the app reads.
    func exportServer(id: String) async throws -> Data {
        var request = URLRequest(
            url: backend.apiBaseURL.appendingPathComponent("/api/servers/\(id)/export")
        )
        if let token = await tokenProvider.currentToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.server(
                status: (response as? HTTPURLResponse)?.statusCode ?? 0,
                message: "Export failed"
            )
        }
        return data
    }

    func transferOwnership(serverId: String, to userId: String) async throws -> Server {
        struct Body: Encodable { let ownerId: String }
        struct Response: Decodable { let server: Server? }
        let response: Response = try await patch(
            "/api/servers/\(serverId)", body: Body(ownerId: userId)
        )
        guard let server = response.server else {
            throw APIError.server(status: 200, message: "Server did not return the update")
        }
        return server
    }

    func moveChannel(id: String, parentId: String?, index: Int) async throws {
        struct Body: Encodable { let parentId: String?; let index: Int }
        let _: EmptyResponse = try await patch(
            "/api/channels/\(id)/move", body: Body(parentId: parentId, index: index)
        )
    }

    // MARK: GIFs

    func gifConfig() async throws -> GifConfig {
        try await get("/api/gifs/config")
    }

    func trendingGifs() async throws -> [Gif] {
        let response: GifsResponse = try await get("/api/gifs/trending")
        return response.gifs
    }

    func searchGifs(query: String) async throws -> [Gif] {
        let response: GifsResponse = try await get(
            "/api/gifs/search", query: [URLQueryItem(name: "q", value: query)]
        )
        return response.gifs
    }

    /// GIFs are attached by URL rather than uploaded — the server fetches the
    /// bytes itself, so there is no presign/PUT step.
    func attachGif(channelId: String, gif: Gif) async throws -> String {
        struct Body: Encodable {
            let url: String
            let width: Int
            let height: Int
            let title: String
        }
        struct Response: Decodable { let attachment: Attachment }
        let response: Response = try await post(
            "/api/channels/\(channelId)/attachments/gif",
            body: Body(url: gif.url, width: gif.width, height: gif.height, title: gif.title)
        )
        return response.attachment.id
    }

    // MARK: Moderation

    func bans(serverId: String) async throws -> [ServerBan] {
        let response: BansResponse = try await get("/api/servers/\(serverId)/bans")
        return response.bans
    }

    func setMemberRole(serverId: String, userId: String, role: String) async throws {
        struct Body: Encodable { let role: String }
        let _: EmptyResponse = try await patch(
            "/api/servers/\(serverId)/members/\(userId)", body: Body(role: role)
        )
    }

    /// Kick, or kick and ban. One call because the server models it that way —
    /// banning is removing with the door locked behind them.
    func removeMember(serverId: String, userId: String, ban: Bool) async throws {
        struct Body: Encodable { let ban: Bool }
        let data = try Coding.encoder.encode(Body(ban: ban))
        let _: EmptyResponse = try await send(
            path: "/api/servers/\(serverId)/members/\(userId)",
            method: "DELETE", query: [], body: data
        )
    }

    func unban(serverId: String, userId: String) async throws {
        let _: EmptyResponse = try await send(
            path: "/api/servers/\(serverId)/bans/\(userId)",
            method: "DELETE", query: [], body: nil
        )
    }

    // MARK: Server + channel management

    func renameServer(id: String, name: String) async throws -> Server {
        struct Body: Encodable { let name: String }
        struct Response: Decodable { let server: Server? }
        let response: Response = try await patch("/api/servers/\(id)", body: Body(name: name))
        guard let server = response.server else {
            throw APIError.server(status: 200, message: "Server did not return the update")
        }
        return server
    }

    func leaveServer(id: String) async throws {
        let _: EmptyResponse = try await post("/api/servers/\(id)/leave", body: EmptyBody())
    }

    func createChannel(serverId: String, name: String, type: String, isPrivate: Bool) async throws -> Channel {
        struct Body: Encodable {
            let name: String
            let type: String
            let isPrivate: Bool
        }
        struct Response: Decodable { let channel: Channel }
        let response: Response = try await post(
            "/api/servers/\(serverId)/channels",
            body: Body(name: name, type: type, isPrivate: isPrivate)
        )
        return response.channel
    }

    func renameChannel(id: String, name: String) async throws -> Channel {
        struct Body: Encodable { let name: String }
        struct Response: Decodable { let channel: Channel }
        let response: Response = try await patch("/api/channels/\(id)", body: Body(name: name))
        return response.channel
    }

    func deleteChannel(id: String) async throws {
        let _: EmptyResponse = try await send(
            path: "/api/channels/\(id)", method: "DELETE", query: [], body: nil
        )
    }

    // MARK: Profile + blocking

    func updateProfile(displayName: String?, dmPrivacy: String?) async throws -> CurrentUser {
        struct Body: Encodable {
            let displayName: String?
            let dmPrivacy: String?
        }
        return try await patch("/api/me", body: Body(displayName: displayName, dmPrivacy: dmPrivacy))
    }

    func blocks() async throws -> [PublicUser] {
        struct Response: Decodable { let blocked: [PublicUser] }
        let response: Response = try await get("/api/blocks")
        return response.blocked
    }

    func setBlocked(userId: String, blocked: Bool) async throws {
        if blocked {
            struct Body: Encodable { let userId: String }
            let _: EmptyResponse = try await post("/api/blocks", body: Body(userId: userId))
        } else {
            let _: EmptyResponse = try await send(
                path: "/api/blocks/\(userId)", method: "DELETE", query: [], body: nil
            )
        }
    }

    func invites(serverId: String) async throws -> [Invite] {
        let response: InvitesResponse = try await get("/api/servers/\(serverId)/invites")
        return response.invites
    }

    func createInvite(serverId: String) async throws -> Invite {
        struct Response: Decodable { let invite: Invite }
        let response: Response = try await post(
            "/api/servers/\(serverId)/invites", body: EmptyBody()
        )
        return response.invite
    }

    func pinnedMessages(channelId: String) async throws -> [Message] {
        let response: PinnedResponse = try await get("/api/channels/\(channelId)/pins")
        return response.messages
    }

    func setPinned(messageId: String, pinned: Bool) async throws -> Message {
        struct Response: Decodable { let message: Message }
        let path = "/api/messages/\(messageId)/pin"
        let response: Response = pinned
            ? try await post(path, body: EmptyBody())
            : try await send(path: path, method: "DELETE", query: [], body: nil)
        return response.message
    }

    func searchMessages(serverId: String, query: String) async throws -> SearchResponse {
        try await get(
            "/api/servers/\(serverId)/search",
            query: [URLQueryItem(name: "q", value: query)]
        )
    }

    func joinInvite(code: String) async throws -> String {
        struct Response: Decodable { let serverId: String }
        let response: Response = try await post("/api/invites/\(code)/join")
        return response.serverId
    }
}
