import Foundation

// The REST half of activities (`server/src/api/app-routes.ts`, docs/APPS.md
// "Sessions"). Reads answer off on any failure: a server without the platform,
// or one that is down, must look exactly like a server that never had it.

/// What a start was refused with, in the server's own tokens.
enum AppStartRefusal: Equatable, Sendable {
    /// 403 `cannot_start`: the person does not hold the permission in this channel.
    case cannotStart
    /// 403 `app_unavailable`, with the first gate that failed.
    case unavailable(AppUnavailableReason?)
    /// 409 `session_live`: somebody else started one first.
    case sessionLive(AppSessionSummary?)
    /// 429.
    case rateLimited
    /// 404: the channel is not visible, or the flag is off.
    case notFound
    /// Anything else, including a transport failure.
    case failed

    static func == (a: AppStartRefusal, b: AppStartRefusal) -> Bool {
        switch (a, b) {
        case (.cannotStart, .cannotStart), (.rateLimited, .rateLimited), (.notFound, .notFound), (.failed, .failed):
            true
        case (.unavailable(let x), .unavailable(let y)): x == y
        case (.sessionLive(let x), .sessionLive(let y)): x?.id == y?.id
        default: false
        }
    }
}

enum AppStartOutcome: Sendable {
    case started(AppSessionSummary)
    case refused(AppStartRefusal)
}

/// One row of `GET /api/me/app-consents`: what the person accepted, per app.
struct AppConsentRecord: Decodable, Hashable, Sendable {
    let appId: String
    let acceptedVersion: String
    let identityGranted: Bool
    /// The app's current version asks for something the accepted one did not:
    /// the join sheet shows again.
    let stale: Bool

    private enum CodingKeys: String, CodingKey { case appId, acceptedVersion, identityGranted, stale }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        appId = try c.decode(String.self, forKey: .appId)
        acceptedVersion = try c.decodeIfPresent(String.self, forKey: .acceptedVersion) ?? ""
        identityGranted = try c.decodeIfPresent(Bool.self, forKey: .identityGranted) ?? false
        stale = try c.decodeIfPresent(Bool.self, forKey: .stale) ?? false
    }
}

extension APIClient {
    /// `GET /api/apps/config?serverId=`. Off on any failure.
    func appsConfig(serverId: String) async -> AppsConfig {
        let query = [URLQueryItem(name: "serverId", value: serverId)]
        return (try? await get("/api/apps/config", query: query) as AppsConfig) ?? .off
    }

    private struct SessionRows: Decodable {
        struct Row: Decodable {
            let channelId: String
            let session: AppSessionSummary
        }
        let sessions: [Row]
    }

    /// `GET /api/servers/:id/app-sessions`: every live activity of the server, for
    /// the channels the caller can view. THROWS on anything unreadable: a catch-up
    /// treats every session missing from the answer as ended, so a partial list
    /// must never reach it.
    func serverAppSessions(serverId: String) async throws -> [(channelId: String, session: AppSessionSummary)] {
        let rows: SessionRows = try await get("/api/servers/\(serverId)/app-sessions")
        return rows.sessions.map { ($0.channelId, $0.session) }
    }

    /// `POST /api/channels/:id/app-sessions`.
    func startAppSession(channelId: String, appId: String) async -> AppStartOutcome {
        struct Body: Encodable { let appId: String }
        struct Refusal: Decodable {
            let error: String?
            let reason: String?
            let session: AppSessionSummary?
        }
        guard let (data, status) = try? await rawRequest(
            "/api/channels/\(channelId)/app-sessions", method: "POST", body: Body(appId: appId)
        ) else {
            // The answer may have been lost after the server committed: ask what is live.
            return await reconcileStart(channelId: channelId, appId: appId)
        }
        if status == 201 {
            if let session = try? Coding.decoder.decode(AppSessionSummary.self, from: data) { return .started(session) }
            return await reconcileStart(channelId: channelId, appId: appId)
        }
        let refusal = try? Coding.decoder.decode(Refusal.self, from: data)
        switch (status, refusal?.error) {
        case (403, "cannot_start"): return .refused(.cannotStart)
        case (403, "app_unavailable"):
            return .refused(.unavailable(refusal?.reason.map { AppUnavailableReason(rawValue: $0) ?? .other }))
        case (409, _): return .refused(.sessionLive(refusal?.session))
        case (429, _): return .refused(.rateLimited)
        case (404, _): return .refused(.notFound)
        default: return .refused(.failed)
        }
    }

    /// An ambiguous start (the response was lost or unreadable): the channel's own
    /// live session settles it: the same app live there is taken as the start that
    /// went through (the person joins it either way); anything else is a failure.
    private func reconcileStart(channelId: String, appId: String) async -> AppStartOutcome {
        // `GET /api/channels/:id/app-session` answers the summary itself, or null.
        guard let live = try? await get("/api/channels/\(channelId)/app-session") as AppSessionSummary?,
              live.appId == appId else { return .refused(.failed) }
        return .started(live)
    }

    /// `POST /api/app-sessions/:id/end`. `false` means it was already over.
    func endAppSession(id: String) async throws -> Bool {
        struct Answer: Decodable { let ended: Bool? }
        let answer: Answer = try await post("/api/app-sessions/\(id)/end", body: EmptyBody())
        return answer.ended == true
    }

    /// `GET /api/me/app-consents`. Empty on any failure, which reads as "nothing
    /// accepted": the sheet shows, and asking twice is the safe way to be wrong.
    func appConsents() async -> [AppConsentRecord] {
        struct Rows: Decodable { let consents: [Lossy<AppConsentRecord>]? }
        let rows = try? await get("/api/me/app-consents") as Rows
        return (rows?.consents ?? []).compactMap(\.value)
    }

    /// `POST /api/apps/:app/consent`: the join sheet's Entrar.
    func acceptAppConsent(appId: String, identityGranted: Bool) async throws {
        struct Body: Encodable { let identityGranted: Bool }
        let _: EmptyResponse = try await post("/api/apps/\(appId)/consent", body: Body(identityGranted: identityGranted))
    }
}
