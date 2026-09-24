import Foundation

/// The server an invite opens, as a signed-out person may see it.
///
/// `GET /api/public/invites/:code` answers `{ invite: PublicInvitePreview }`:
/// a name, a picture and a head count, and nothing that names a member. It is
/// what lets the welcome screen say "You're invited to {server}" before there
/// is an account, and what the first-run "you" step shows as the room waiting.
struct PublicInvitePreview: Codable, Equatable, Sendable {
    let serverName: String
    let iconUrl: String?
    let memberCount: Int
}

/// What a Discord template turns into, trimmed to what a phone shows before
/// creating it. The server sends a much larger plan (`DiscordImportPlan` in
/// `packages/shared/src/discord-import.ts`); decoding only these fields keeps a
/// server-side addition from ever breaking the preview.
struct DiscordImportPreview: Decodable, Equatable, Sendable {
    struct Channel: Decodable, Equatable, Sendable {
        let name: String
        /// `"text" | "voice" | "category"`.
        let type: String
        let isPrivate: Bool
    }

    struct Role: Decodable, Equatable, Sendable {
        let name: String
    }

    let serverName: String
    let isDirty: Bool
    let channels: [Channel]
    let roles: [Role]

    var textCount: Int { channels.filter { $0.type == "text" }.count }
    var voiceCount: Int { channels.filter { $0.type == "voice" }.count }
    var categoryCount: Int { channels.filter { $0.type == "category" }.count }
}

/// `POST /api/import/discord/apply`: the server it made and the invite it
/// minted in the same transaction, so the ready step never has to ask twice.
struct DiscordImportResult: Decodable, Sendable {
    let server: Server
    let invite: Invite
}

extension APIClient {
    /// The invite preview, with NO Authorization header on purpose.
    ///
    /// The route is public and sits before the Bearer resolution on the server;
    /// a stale token must not be able to turn a preview into a 401 (pitfall 16
    /// in CLAUDE.md is exactly that shape). Every failure is "no preview", never
    /// an error: 404 (unknown, revoked, expired, or an API without the route
    /// yet), 429 (the anonymous limiter), a dropped network, or a body of the
    /// wrong shape. The screen then shows its generic copy and the flow still
    /// works, because the code itself is stashed in `PendingInvite`.
    nonisolated static func publicInvitePreview(
        code: String,
        backend: Backend = .current
    ) async -> PublicInvitePreview? {
        guard !code.isEmpty else { return nil }
        let url = backend.apiBaseURL
            .appendingPathComponent("api/public/invites")
            .appendingPathComponent(code)
        var request = URLRequest(url: url, timeoutInterval: 8)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode)
        else { return nil }
        return parsePublicInvitePreview(data)
    }

    /// `{ invite: { serverName, iconUrl, memberCount } }`, or nil. A blank name
    /// is no preview: "You're invited to " with nothing after it is worse than
    /// the generic welcome.
    nonisolated static func parsePublicInvitePreview(_ data: Data) -> PublicInvitePreview? {
        struct Envelope: Decodable { let invite: PublicInvitePreview }
        guard let preview = try? JSONDecoder().decode(Envelope.self, from: data).invite,
              !preview.serverName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return preview
    }

    /// One field of `PATCH /api/me` at a time, so a rename can be told apart
    /// from a failed avatar. Absent keys are left alone server-side.
    func updateMe(displayName: String? = nil, username: String? = nil) async throws -> CurrentUser {
        struct Body: Encodable {
            let displayName: String?
            let username: String?
        }
        return try await patch("/api/me", body: Body(displayName: displayName, username: username))
    }

    /// A preset picture. The server accepts any http(s) URL here, which is how
    /// the web's presets are stored too, so a preset chosen on a phone reads
    /// the same in a browser.
    func setAvatarURL(_ url: String) async throws -> CurrentUser {
        struct Body: Encodable { let avatarUrl: String }
        return try await patch("/api/me", body: Body(avatarUrl: url))
    }

    /// An invite with an explicit lifetime. The ready step asks for a week
    /// with no use cap, the same invite the web wizard mints, so the note under
    /// the link ("Good for 7 days, unlimited uses") is true on both.
    func createInvite(serverId: String, expiresInHours: Int) async throws -> Invite {
        struct Body: Encodable { let expiresInHours: Int }
        struct Response: Decodable { let invite: Invite }
        let response: Response = try await post(
            "/api/servers/\(serverId)/invites", body: Body(expiresInHours: expiresInHours)
        )
        return response.invite
    }

    /// Close the first-run wizard for good, on every device. A one-key patch,
    /// for the same reason `dismissFirstRun` is one: the server merges the
    /// preferences blob one level deep, so naming a single key leaves the rest.
    func markOnboarded(at stamp: String) async throws -> UserPreferences {
        struct Body: Encodable { let onboardedAt: String }
        let response: PreferencesResponse = try await patch(
            "/api/me/preferences", body: Body(onboardedAt: stamp)
        )
        return response.preferences
    }

    /// The ids of every room this account is in, before it makes a new one.
    /// Nil when the list cannot be read, which switches recovery off rather
    /// than guessing.
    func serverIdsSnapshot() async -> Set<String>? {
        guard let servers = try? await servers() else { return nil }
        return Set(servers.map(\.id))
    }

    /// The room a create made, when the create's response was lost.
    ///
    /// The request may have reached the server and only the answer gone
    /// missing, and trying again would make a second room. So the caller takes
    /// a snapshot of its rooms BEFORE creating and, on a transport failure,
    /// asks for one it owns, with exactly that name, that was not there
    /// before. No clock is involved, so a phone whose time is off cannot make
    /// an old room look new, and an old room of the same name is excluded by
    /// construction.
    func serverCreatedSince(
        _ before: Set<String>,
        named name: String,
        ownerId: String
    ) async -> Server? {
        guard let servers = try? await servers() else { return nil }
        let fresh = servers.filter {
            !before.contains($0.id) && $0.ownerId == ownerId && $0.name == name
        }
        // Exactly one, or it is not ours to guess between.
        return fresh.count == 1 ? fresh[0] : nil
    }

    func previewDiscordImport(source: String) async throws -> DiscordImportPreview {
        struct Body: Encodable { let source: String }
        return try await post("/api/import/discord/preview", body: Body(source: source))
    }

    func applyDiscordImport(source: String) async throws -> DiscordImportResult {
        struct Body: Encodable { let source: String }
        return try await post("/api/import/discord/apply", body: Body(source: source))
    }
}
