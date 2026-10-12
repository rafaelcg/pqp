import Foundation

/// Stories, as endpoints (`packages/shared/src/stories.ts`). Its own file for
/// the reason `CommunityHomeAPI.swift` is one.
extension APIClient {
    /// Not memoised: `stories` is a runtime flag, per server. Off on any
    /// failure, an older API included.
    func storiesConfig(serverId: String? = nil) async -> StoriesConfig {
        let query = serverId.map { [URLQueryItem(name: "serverId", value: $0)] } ?? []
        return (try? await get("/api/stories/config", query: query)) ?? .off
    }

    /// A server's strip. With the flag off the server answers
    /// `{enabled:false}`, which draws nothing; nil means it could not ask.
    func serverStoryStrip(serverId: String) async -> StoryStrip? {
        try? await get("/api/servers/\(serverId)/stories")
    }

    func friendsStoryStrip() async -> StoryStrip? {
        try? await get("/api/stories/friends")
    }

    /// At most `StoryLimits.idsMax` per call; ids the viewer may not see are
    /// dropped by the server without a word.
    func stories(ids: [String]) async throws -> [Story] {
        guard !ids.isEmpty else { return [] }
        let joined = ids.prefix(StoryLimits.idsMax).joined(separator: ",")
        let response: StoriesResponse = try await get("/api/stories", query: [URLQueryItem(name: "ids", value: joined)])
        return response.stories
    }

    func storyAudiences() async throws -> StoryAudienceOptions {
        try await get("/api/stories/audiences")
    }

    func createStory(_ request: CreateStoryRequest) async throws -> CreateStoryResponse {
        try await post("/api/stories", body: request)
    }

    func publishStory(id: String) async throws -> Story {
        let response: PublishStoryResponse = try await post("/api/stories/\(id)/publish", body: EmptyBody())
        return response.story
    }

    func deleteStory(id: String) async throws {
        let _: EmptyResponse = try await delete("/api/stories/\(id)")
    }

    /// Batched, idempotent; the author's own views never count. More ids
    /// than one request takes go up in as many requests as they need.
    func markStoriesViewed(_ ids: [String]) async throws {
        struct Body: Encodable { let storyIds: [String] }
        var rest = ids[...]
        while !rest.isEmpty {
            let chunk = Array(rest.prefix(StoryLimits.viewsBatchMax))
            rest = rest.dropFirst(chunk.count)
            let _: EmptyResponse = try await post("/api/stories/views", body: Body(storyIds: chunk))
        }
    }

    /// One reaction per viewer per story; nil clears it. Never a message.
    func reactToStory(id: String, reaction: String?) async throws {
        struct Body: Encodable {
            let reaction: String?
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(reaction, forKey: .reaction)
            }
            enum CodingKeys: String, CodingKey { case reaction }
        }
        let _: EmptyResponse = try await send(path: "/api/stories/\(id)/reaction", method: "PUT", body: Body(reaction: reaction))
    }

    /// Becomes a message in the 1:1 with the author, quoting the story.
    /// `nonce` is the chat send's idempotency key: a retry with it answers
    /// the reply that already landed instead of sending the DM twice.
    func replyToStory(id: String, text: String, nonce: String) async throws -> StoryReplyResponse {
        struct Body: Encodable { let text: String; let nonce: String }
        return try await post("/api/stories/\(id)/reply", body: Body(text: text, nonce: nonce))
    }

    func storyViewers(id: String, cursor: String? = nil) async throws -> StoryViewersPage {
        let query = cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? []
        return try await get("/api/stories/\(id)/viewers", query: query)
    }

    func storyCard(id: String) async throws -> StoryCard {
        try await get("/api/stories/\(id)/card")
    }

    /// "Tirar do servidor": MANAGE_MESSAGES there, this server's slice only.
    func removeStoryFromServer(storyId: String, serverId: String, reason: String?) async throws {
        struct Body: Encodable { let reason: String? }
        let _: EmptyResponse = try await send(
            path: "/api/servers/\(serverId)/stories/\(storyId)", method: "DELETE", body: Body(reason: reason)
        )
    }

    func muteStories(of userId: String, muted: Bool) async throws {
        let _: EmptyResponse = try await send(
            path: "/api/stories/mutes/\(userId)", method: muted ? "PUT" : "DELETE", body: EmptyBody()
        )
    }

    func storyNotices() async -> [StoryNotice] {
        let response: StoryNoticesResponse? = try? await get("/api/stories/notices")
        return response?.notices ?? []
    }

    func acknowledgeStoryNotice(id: String) async {
        let _: EmptyResponse? = try? await post("/api/stories/notices/\(id)/ack", body: EmptyBody())
    }

    func saveStoryToBau(storyId: String, serverId: String) async throws {
        struct Body: Encodable { let serverId: String }
        let _: EmptyResponse = try await post("/api/stories/\(storyId)/save-to-bau", body: Body(serverId: serverId))
    }

    /// `subjectType: "story"`. `serverId` is the audience the reporter saw it
    /// through; nil is the friends audience (instance queue). `minor_sexual`
    /// always goes to the instance queue, whatever the audience.
    func reportStory(storyId: String, serverId: String?, reason: String, details: String?) async throws {
        struct Body: Encodable {
            let subjectType = "story"
            let storyId: String
            let serverId: String?
            let reason: String
            let details: String?
        }
        let _: EmptyResponse = try await post(
            "/api/reports",
            body: Body(storyId: storyId, serverId: serverId, reason: reason, details: details)
        )
    }
}
