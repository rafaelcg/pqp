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
            String(localized: "Your session expired. Sign in again.")
        case .notFound(let what):
            what
        case .rateLimited(let retryAfter):
            retryAfter.map { String(localized: "Too many requests. Try again in \($0)s.") }
                ?? String(localized: "Too many requests. Try again shortly.")
        case .server(_, let message):
            message
        case .transport(let message):
            message
        case .decoding(let detail):
            // Surfaced rather than swallowed: a decode failure means the client
            // and server disagree about a shape, and a silent empty list makes
            // that look like "no data" for weeks.
            String(localized: "Could not read the server's response. \(detail)")
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
        apiBaseURL: URL(string: "https://api.pqp.gg")!,
        webSocketURL: URL(string: "wss://api.pqp.gg/ws")!
    )

    static var current: Backend {
        #if DEBUG
        // Lets a UI test point the app at a dead port to prove launch survives
        // an unreachable server. Debug-only, so it cannot affect a release.
        if let override = ProcessInfo.processInfo.environment["PQP_API_OVERRIDE"],
           let url = URL(string: override) {
            // The socket is DERIVED from the override rather than hardcoded at a
            // dead port. The unreachable-server test points this at
            // `127.0.0.1:9`, which derives to exactly the dead socket it used to
            // hardcode — so that case is unchanged — while pointing the app at a
            // *working* server on another port now moves both halves. Hardcoding
            // meant a live API with a dead socket, which is the one combination
            // that strands the app on the splash.
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            components?.scheme = url.scheme == "https" ? "wss" : "ws"
            components?.path = "/ws"
            return Backend(
                apiBaseURL: url,
                webSocketURL: components?.url ?? URL(string: "ws://127.0.0.1:9/ws")!
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
    func currentToken() async -> String? {
        #if DEBUG
        // `dev-local-token:<suffix>` is a *different* dev account, minted by
        // the same bypass (`devBypassIdentity` in server/src/auth/clerk.ts).
        //
        // Exists for one test that cannot be written without it: deleting your
        // account, which on the shared `dev-local-token` identity would destroy
        // the servers, conversations and handle every other UI test in the
        // suite reads. Debug-only, like `PQP_API_OVERRIDE` above, so a release
        // build has no such branch. The alphabet matches the server's, which
        // refuses anything else rather than minting a surprise account.
        if let suffix = ProcessInfo.processInfo.environment["PQP_DEV_USER"],
           !suffix.isEmpty,
           suffix.range(of: "^[a-z0-9_-]{1,32}$", options: .regularExpression) != nil {
            return "dev-local-token:\(suffix)"
        }
        #endif
        return "dev-local-token"
    }
}

actor APIClient {
    private let backend: Backend
    private let tokenProvider: any TokenProviding
    private let session: URLSession
    /// The on-disk copy of the reads that happen on every screen change. Held
    /// here rather than at the call sites so every existing caller gets the
    /// conditional request and the cache write-through for free.
    private let cache: ReadCache

    /// Deployment-wide switches that cannot change while the app is running.
    /// Re-asking on every channel open cost two round trips *before* the first
    /// message was even requested.
    /// Not `private`: `attachmentConfig()` is declared in AttachmentUploader.swift,
    /// beside the upload dance it belongs to, and memoising it there is better
    /// than moving the endpoint here to satisfy an access level.
    var attachmentConfigCache: AttachmentConfig?
    /// Same arrangement, declared beside its uploader in AvatarUploader.swift.
    var avatarConfigCache: AvatarConfig?
    private var gifConfigCache: GifConfig?
    /// Whether this deployment has a communities directory. Same arrangement as
    /// the two above — declared here, memoised beside its own endpoints in
    /// CommunitiesAPI.swift. A feature flag cannot change while the app runs, and
    /// this one gates a button that is on screen every time the hub is.
    var communityConfigCache: CommunityConfig?
    /// The Baú's instance flags, memoised beside its endpoints in
    /// CommunityHomeAPI.swift. Gates a row on every server's channel list.
    var communityHomeConfigCache: CommunityHomeConfig?

    init(
        backend: Backend = .current,
        tokenProvider: any TokenProviding,
        cache: ReadCache = .shared
    ) {
        self.backend = backend
        self.tokenProvider = tokenProvider
        self.cache = cache
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        // No URL cache. Revalidation is done explicitly against the ETags this
        // app persists itself, and every API response is `no-store` anyway —
        // leaving URLCache in place would only add a second, invisible layer
        // with its own opinions about the same responses.
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
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

    /// Bodyless DELETE. `send` is fileprivate, so endpoints declared in other
    /// files (see SocialAPI.swift) need this to reach the verb at all.
    @discardableResult
    func delete<T: Decodable>(_ path: String) async throws -> T {
        try await send(path: path, method: "DELETE", query: [], body: nil)
    }

    fileprivate func send<T: Decodable>(
        path: String,
        method: String,
        query: [URLQueryItem],
        body: Data?
    ) async throws -> T {
        let (data, _) = try await perform(
            path: path, method: method, query: query, body: body, ifNoneMatch: nil
        )

        if T.self == EmptyResponse.self, let empty = EmptyResponse() as? T {
            return empty
        }

        do {
            return try Coding.decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    /// The transport, minus decoding.
    ///
    /// Split out so a conditional GET can see the status code: a `304` is a
    /// *success* with no body, and the error mapping below would otherwise turn
    /// it into `APIError.server(304)`. It is only accepted when this call
    /// actually asked a question with `If-None-Match`; an unsolicited 304 is a
    /// broken server, not a cache hit.
    private func perform(
        path: String,
        method: String,
        query: [URLQueryItem],
        body: Data?,
        ifNoneMatch: String?
    ) async throws -> (Data, HTTPURLResponse) {
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
        if let ifNoneMatch {
            request.setValue(ifNoneMatch, forHTTPHeaderField: "If-None-Match")
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

        if http.statusCode == 304, ifNoneMatch != nil {
            return (data, http)
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

        return (data, http)
    }

    /// A conditional GET. Returns `nil` when the server answered `304`, meaning
    /// the validator we sent still describes the current representation.
    ///
    /// The 304 is only ever *reachable* for a caller the server has already
    /// authenticated and authorized — it compares validators after the route's
    /// own access check, never instead of it — so this is a bandwidth
    /// optimisation, not a permission shortcut.
    private func conditionalGet<T: Decodable>(
        _ path: String,
        query: [URLQueryItem] = [],
        ifNoneMatch: String?
    ) async throws -> (value: T?, etag: String?) {
        let (data, http) = try await perform(
            path: path, method: "GET", query: query, body: nil, ifNoneMatch: ifNoneMatch
        )
        let etag = http.value(forHTTPHeaderField: "ETag")
        if http.statusCode == 304 {
            return (nil, etag ?? ifNoneMatch)
        }
        do {
            return (try Coding.decoder.decode(T.self, from: data), etag)
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

    // MARK: The cached reads
    //
    // Four endpoints, one shape: ask conditionally with whatever validator is
    // on disk, treat a 304 as "what you already have is current", and write
    // through on a 200. Every existing caller keeps its signature — the only
    // visible difference is that a warm read costs a header exchange instead of
    // a page of JSON.
    //
    // The `cached…` variants beside them return the disk copy with no network
    // at all, for screens that want to paint before they ask.

    func servers() async throws -> [Server] {
        let stored = await cache.list(Server.self, for: .servers)
        let (response, etag): (ServersResponse?, String?) = try await conditionalGet(
            "/api/servers", ifNoneMatch: stored?.etag
        )
        guard let response else { return stored?.items ?? [] }
        await cache.setList(
            CachedList(items: response.servers, etag: etag), for: .servers
        )
        return response.servers
    }

    func cachedServers() async -> [Server]? {
        await cache.list(Server.self, for: .servers)?.items
    }

    func channels(serverId: String) async throws -> [Channel] {
        let key = CacheKey.channels(serverId: serverId)
        let stored = await cache.list(Channel.self, for: key)
        let (response, etag): (ChannelsResponse?, String?) = try await conditionalGet(
            "/api/servers/\(serverId)/channels", ifNoneMatch: stored?.etag
        )
        guard let response else { return stored?.items ?? [] }
        await cache.setList(CachedList(items: response.channels, etag: etag), for: key)
        return response.channels
    }

    func cachedChannels(serverId: String) async -> [Channel]? {
        await cache.list(Channel.self, for: .channels(serverId: serverId))?.items
    }

    /// `before` is a **message id**, not a timestamp or an offset.
    ///
    /// Only the newest page (no cursor) is cached. A page from halfway up the
    /// scrollback is not what reopening the channel should show, and keeping
    /// every page anyone ever scrolled to would be an unbounded transcript on
    /// a phone.
    func messages(channelId: String, before: String? = nil, limit: Int = 50) async throws -> MessagesResponse {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        let path = "/api/channels/\(channelId)/messages"

        guard before == nil else {
            return try await get(path, query: query)
        }

        let stored = await cache.page(for: channelId)
        let (response, etag): (MessagesResponse?, String?) = try await conditionalGet(
            path, query: query, ifNoneMatch: stored?.etag
        )
        guard let response else {
            // 304. The disk copy is what the server would have sent; the
            // validator can only have come from a page we still hold, so this
            // fallback is defensive rather than expected.
            guard let stored else { return try await get(path, query: query) }
            return MessagesResponse(
                messages: stored.messages, hasMore: stored.hasMore, hasNewer: false
            )
        }
        await cache.store(
            CachedPage(messages: response.messages, hasMore: response.hasMore, etag: etag),
            for: channelId
        )
        return response
    }

    func cachedMessages(channelId: String) async -> CachedPage? {
        await cache.page(for: channelId)
    }

    func conversations() async throws -> [DmSummary] {
        let stored = await cache.list(DmSummary.self, for: .conversations)
        let (response, etag): (DmsResponse?, String?) = try await conditionalGet(
            "/api/dms", ifNoneMatch: stored?.etag
        )
        guard let response else { return stored?.items ?? [] }
        await cache.setList(
            CachedList(items: response.conversations, etag: etag), for: .conversations
        )
        return response.conversations
    }

    func cachedConversations() async -> [DmSummary]? {
        await cache.list(DmSummary.self, for: .conversations)?.items
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

    /// Manual status. A top-level key of the same preferences blob, so a
    /// one-key patch is safe — the merge keeps everything else.
    func setStatus(_ status: String) async throws -> UserPreferences {
        struct Body: Encodable { let status: String }
        let response: PreferencesResponse = try await patch("/api/me/preferences", body: Body(status: status))
        return response.preferences
    }

    /// Put the hub's first-run checklist away, on this account and every device.
    ///
    /// A one-key patch for the same reason `setStatus` is one: the server merges
    /// the blob one level deep, so naming a single top-level key leaves the rest
    /// alone. Sending a whole `UserPreferences` here would be actively wrong —
    /// every field this client does not model (`compactPeers`, `inputMode`,
    /// `micProcessing`) would encode as absent and the merge would leave them
    /// stale while the round-trip claimed success.
    func dismissFirstRun(at stamp: String) async throws -> UserPreferences {
        struct Body: Encodable { let firstRunDismissedAt: String }
        let response: PreferencesResponse = try await patch(
            "/api/me/preferences",
            body: Body(firstRunDismissedAt: stamp)
        )
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
        try await rawGet("/api/servers/\(id)/export")
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

    /// Memoised: whether the deployment has a GIF provider configured cannot
    /// change while the app is running, and this was one of two round trips
    /// standing between opening a channel and asking for its messages.
    func gifConfig() async throws -> GifConfig {
        if let gifConfigCache { return gifConfigCache }
        let config: GifConfig = try await get("/api/gifs/config")
        gifConfigCache = config
        return config
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

    /// Ban, WITH a reason.
    ///
    /// A different route from `removeMember(ban:)` on purpose: the members route
    /// takes a `ban` flag and nothing else, so a ban placed through it can never
    /// carry why. `POST /bans` does — and it is the reason the ban list can show
    /// one later, which is the difference between a ban somebody can reconstruct
    /// in six months and a name with a date beside it. Also the route that works
    /// on somebody who is not a member yet, though no screen offers that today.
    func banMember(serverId: String, userId: String, reason: String?) async throws {
        struct Body: Encodable {
            let userId: String
            let reason: String?
        }
        let _: EmptyResponse = try await post(
            "/api/servers/\(serverId)/bans",
            body: Body(userId: userId, reason: reason)
        )
    }

    func unban(serverId: String, userId: String) async throws {
        let _: EmptyResponse = try await send(
            path: "/api/servers/\(serverId)/bans/\(userId)",
            method: "DELETE", query: [], body: nil
        )
    }

    // MARK: Timeouts

    /// Issue a timeout. Minutes, not an expiry instant — the server anchors
    /// the end time to its own clock, the one every read compares against.
    ///
    /// Returns the server's own sentence. It names the end time and what the
    /// sanction takes away, it is written by `describeTimeout` in shared, and it
    /// is the SAME string the sanctioned person is shown — so a moderator who
    /// reads it back knows exactly what the other side was told. Discardable for
    /// the caller that only wants the side effect.
    @discardableResult
    func issueTimeout(
        serverId: String, userId: String, minutes: Int, reason: String?
    ) async throws -> IssuedTimeout {
        struct Body: Encodable {
            let userId: String
            let minutes: Int
            let reason: String?
        }
        return try await post(
            "/api/servers/\(serverId)/timeouts",
            body: Body(userId: userId, minutes: minutes, reason: reason)
        )
    }

    func activeTimeouts(serverId: String) async throws -> [MemberTimeout] {
        struct Response: Decodable { let timeouts: [MemberTimeout] }
        let response: Response = try await get("/api/servers/\(serverId)/timeouts")
        return response.timeouts
    }

    func liftTimeout(serverId: String, userId: String) async throws {
        let _: EmptyResponse = try await send(
            path: "/api/servers/\(serverId)/timeouts/\(userId)",
            method: "DELETE", query: [], body: nil
        )
    }

    // MARK: Reports

    /// Report a message. 201 first time, 200 for a duplicate — both succeed.
    func reportMessage(messageId: String, reason: String, details: String?) async throws {
        struct Body: Encodable {
            let subjectType = "message"
            let messageId: String
            let reason: String
            let details: String?
        }
        let _: EmptyResponse = try await post(
            "/api/reports", body: Body(messageId: messageId, reason: reason, details: details)
        )
    }

    func reportUser(userId: String, serverId: String?, reason: String, details: String?) async throws {
        struct Body: Encodable {
            let subjectType = "user"
            let userId: String
            let serverId: String?
            let reason: String
            let details: String?
        }
        let _: EmptyResponse = try await post(
            "/api/reports",
            body: Body(userId: userId, serverId: serverId, reason: reason, details: details)
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
        let response: Response = try await post(
            "/api/invites/\(pathEscaped(code))/join"
        )
        return response.serverId
    }

    /// What an invite points at, without joining it. Readable by any signed-in
    /// user by design — that is the point of an invite link.
    func invitePreview(code: String) async throws -> Invite {
        struct Response: Decodable { let invite: Invite }
        let response: Response = try await get("/api/invites/\(pathEscaped(code))")
        return response.invite
    }

    // MARK: Push

    /// Whether this deployment can send notifications, per transport. `apns` is
    /// the one this app cares about; `enabled` is the browser's VAPID answer and
    /// is carried only so the shape matches the server's.
    func pushConfig() async throws -> PushConfig {
        try await get("/api/push/config")
    }

    /// Register this device's APNs token. Idempotent server-side — the row is
    /// upserted on the token — which is what makes re-posting on every launch
    /// the right thing rather than a waste.
    func registerApnsToken(_ token: String) async throws {
        struct Body: Encodable {
            let platform = "apns"
            let token: String
        }
        let _: EmptyResponse = try await post(
            "/api/push/subscriptions", body: Body(token: token)
        )
    }

    func unregisterApnsToken(_ token: String) async throws {
        let _: EmptyResponse = try await send(
            path: "/api/push/subscriptions",
            method: "DELETE",
            query: [URLQueryItem(name: "token", value: token)],
            body: nil
        )
    }

    /// Invite codes are base64url, which includes `-` and `_` but never `/` or
    /// `+` — so in practice nothing needs escaping. Applied anyway because the
    /// code here came from a URL somebody else wrote, and a code containing a
    /// slash would otherwise silently address a different route.
    private func pathEscaped(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
    }

    // MARK: - Your own data (LGPD art. 18)

    /// A GET whose body is a **file**, not a shape the app reads.
    ///
    /// Deliberately not `get()`: the two exports answer with
    /// `Content-Disposition: attachment` and a body that is only ever written to
    /// disk and handed to the share sheet. Decoding it would mean modelling
    /// every table in the product for the sake of throwing the model away.
    ///
    /// It still maps refusals the way `perform` does — an export is behind a
    /// rate limiter, and "Export failed" in place of "Slow down. Try again in
    /// 47s." is the difference between a user who waits and one who taps the
    /// button forever.
    private func rawGet(_ path: String) async throws -> Data {
        var request = URLRequest(url: backend.apiBaseURL.appendingPathComponent(path))
        if let token = await tokenProvider.currentToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

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
            throw Self.refusal(status: http.statusCode, body: data, response: http)
        }
        return data
    }

    /// Everything the service holds about you, as a file (art. 18, II and V).
    ///
    /// The web client's counterpart mints a blob URL and clicks an invisible
    /// link. A phone has nowhere to "download" to, so the caller writes this to
    /// a temp file and hands it to the share sheet — the same arrangement
    /// `exportServer` already uses, which is how a file leaves an iOS app.
    func exportMyData() async throws -> Data {
        try await rawGet("/api/me/export")
    }

    /// Delete your own account (art. 18, IV and VI). Irreversible, and real:
    /// there is no soft-delete flag anywhere behind this.
    ///
    /// `confirm` is the account's own tag, typed by hand. `AccountDeletion`
    /// decides whether it matches before this is ever called, using the same
    /// rule the server refuses on.
    ///
    /// HAND-BUILT rather than driven through `send`, for the one reason the web
    /// client hand-builds its own: the refusal this screen has to *act* on is a
    /// 409 carrying a list of communities, and the shared path reduces every
    /// error to its `error` string. There is no 401 retry here, unlike the web
    /// version, because `ClerkTokenProvider` already reads a fresh token per
    /// request rather than caching one.
    func deleteMyAccount(confirm: String) async throws {
        struct Body: Encodable { let confirm: String }
        struct Refusal: Decodable {
            let error: String?
            let code: String?
            let servers: [BlockingOwnedServer]?
        }

        var request = URLRequest(url: backend.apiBaseURL.appendingPathComponent("/api/me"))
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = await tokenProvider.currentToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try Coding.encoder.encode(Body(confirm: confirm))

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
        if (200..<300).contains(http.statusCode) {
            return
        }

        let refusal = try? Coding.decoder.decode(Refusal.self, from: data)
        if http.statusCode == 409, refusal?.code == "owned_servers" {
            throw AccountDeletionBlocked(
                message: refusal?.error
                    ?? String(localized: "Communities you own are in the way."),
                servers: refusal?.servers ?? []
            )
        }
        throw Self.refusal(status: http.statusCode, body: data, response: http)
    }

    /// A non-2xx, mapped the way `perform` maps one. Shared by the two calls
    /// above, which build their own requests and would otherwise each have to
    /// remember that a 429 carries `Retry-After`.
    private static func refusal(
        status: Int, body: Data, response: HTTPURLResponse
    ) -> APIError {
        let message = (try? Coding.decoder.decode(ApiErrorBody.self, from: body))?.error
            ?? "Request failed (\(status))"
        switch status {
        case 401: return .unauthorized
        case 404: return .notFound(message)
        case 429:
            let retry = response.value(forHTTPHeaderField: "Retry-After").flatMap(Int.init)
            return .rateLimited(retryAfter: retry)
        default: return .server(status: status, message: message)
        }
    }
}

struct PushConfig: Decodable, Sendable {
    /// Web Push (VAPID). Present for shape parity with the browser; unused here.
    let enabled: Bool
    /// Whether the server holds an APNs key. False means never ask for
    /// permission — a prompt for notifications that cannot arrive is worse than
    /// no prompt, and permission refused is refused for good.
    let apns: Bool
}

// MARK: - Call ratings

extension APIClient {
    /// How the last call went, one number, written and never read back.
    ///
    /// `POST /api/voice/ratings` answers `{ ok: true }` and there is
    /// deliberately no route to read an individual rating: the operator sees
    /// only the aggregate on `GET /api/admin/metrics`. So this returns nothing,
    /// and the prompt has already thanked the user by the time it resolves.
    ///
    /// `channelId` is omitted rather than sent as null when there is none. The
    /// server's schema is `z.string().uuid().optional()`, which refuses an
    /// explicit null, and losing the whole rating over the one field that is
    /// merely nice to have would be the wrong trade.
    func submitCallRating(_ call: RatableCall, rating: Int, note: String?) async throws {
        struct Body: Encodable {
            let rating: Int
            let note: String?
            let durationSeconds: Int
            let peerCount: Int
            let transport: String
            let hadScreenShare: Bool
            let channelId: String?
        }
        let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        let _: EmptyResponse = try await post(
            "/api/voice/ratings",
            body: Body(
                rating: rating,
                note: (trimmed?.isEmpty ?? true) ? nil : trimmed,
                durationSeconds: call.durationSeconds,
                peerCount: call.peerCount,
                transport: call.transport.rawValue,
                hadScreenShare: call.hadScreenShare,
                channelId: call.channelId
            )
        )
    }
}
