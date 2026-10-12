import Foundation

/// Conversas, as endpoints: the two switches, closing a conversation, and the
/// Fixadas list. In its own file for the reason `CommunitiesAPI.swift` is.
extension APIClient {
    /// `GET /api/dms/config`.
    ///
    /// NOT memoised, unlike the communities switch: these are runtime flags
    /// (`docs/FEATURE_FLAGS.md`) that an operator flips live, and the shell
    /// asks again whenever the app comes back to the foreground.
    ///
    /// Nil means "could not ask" (no network), so the caller keeps what it
    /// drew. A server that answers anything else, a 404 from an API older
    /// than the route included, is off.
    func dmsConfig() async -> DmsConfig? {
        do {
            let config: DmsConfig = try await get("/api/dms/config")
            return config
        } catch APIError.transport {
            return nil
        } catch {
            return .off
        }
    }

    /// `DELETE /api/dms/:id`: take a conversation off the list. A 1:1 comes
    /// back with the next message; leaving a group is for good.
    func closeConversation(channelId: String) async throws {
        let _: EmptyResponse = try await delete("/api/dms/\(channelId)")
    }

    /// The Fixadas list. One top-level key of the preferences blob, the same
    /// one the web rail pins write, so pinning on the phone pins on the web.
    func setPinnedConversations(_ channelIds: [String]) async throws -> UserPreferences {
        struct Body: Encodable { let pinnedConversations: [String] }
        let response: PreferencesResponse = try await patch(
            "/api/me/preferences",
            body: Body(pinnedConversations: channelIds)
        )
        return response.preferences
    }
}
