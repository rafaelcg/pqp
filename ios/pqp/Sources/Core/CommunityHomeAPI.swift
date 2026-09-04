import Foundation

/// The Baú (Community Home), as endpoints.
///
/// Kept in its own file for the reason `CommunitiesAPI.swift` is: the feature
/// is additive, and a file nobody else has to open is a file nobody else has
/// to merge. Every `/home/…` route answers 404 while the instance flag is off,
/// so a caller asks `communityHomeConfig()` first and never draws the surface
/// on a server that would 404 it.
extension APIClient {
    /// The instance flags, asked once per session.
    ///
    /// MEMOISED, like `communitiesEnabled`: a flag cannot change while the app
    /// is running, and this answer gates a row on every server's channel list.
    ///
    /// OFF ON ANY FAILURE, deliberately. A 404 is what production answers until
    /// the Community Home branch is merged, a decode failure is a server this
    /// build does not understand, and a network blip is a network blip; all
    /// three have to render identically as "nothing here". Only a real answer
    /// is remembered, so a phone that opened its first server in a tunnel gets
    /// the true one on the next.
    func communityHomeConfig() async -> CommunityHomeConfig {
        if let communityHomeConfigCache { return communityHomeConfigCache }
        guard let config: CommunityHomeConfig = try? await get("/api/community-home/config") else {
            return .off
        }
        communityHomeConfigCache = config
        return config
    }

    /// Published posts, newest first, already stripped for this viewer.
    func communityHomePosts(serverId: String) async throws -> [CommunityHomePost] {
        let response: CommunityHomePostsResponse = try await get("/api/servers/\(serverId)/home/posts")
        return response.posts
    }

    /// Posts published since this account last opened the Baú, for the badge
    /// on its row. The web has drawn this count since the Baú shipped; this
    /// app never asked, so the row sat unmarked next to badged channels.
    func communityHomeUnread(serverId: String) async throws -> Int {
        let response: CommunityHomeUnreadResponse = try await get("/api/servers/\(serverId)/home/unread")
        return response.count
    }

    /// "I have seen the Baú", recorded server-side, which is what the badge on
    /// every device counts from. Without this call a person who read the Baú
    /// on their phone kept a permanent unread badge on the web, because the
    /// server only ever heard the web say it had been read.
    func markCommunityHomeRead(serverId: String) async throws {
        struct Ack: Decodable { let ok: Bool }
        let _: Ack = try await post("/api/servers/\(serverId)/home/read", body: EmptyBody())
    }

    /// Toggle. The response carries the new state; nothing is broadcast.
    func toggleCommunityHomeLike(serverId: String, postId: String) async throws -> CommunityHomeLikeResponse {
        try await post("/api/servers/\(serverId)/home/posts/\(postId)/likes", body: EmptyBody())
    }

    /// The whole list, oldest first, for "see all". The card only carries two.
    func communityHomeComments(serverId: String, postId: String) async throws -> [CommunityHomeComment] {
        let response: CommunityHomeCommentsResponse = try await get(
            "/api/servers/\(serverId)/home/posts/\(postId)/comments"
        )
        return response.comments
    }

    @discardableResult
    func addCommunityHomeComment(serverId: String, postId: String, body: String) async throws -> CommunityHomeComment {
        struct Body: Encodable { let body: String }
        let response: CommunityHomeCommentResponse = try await post(
            "/api/servers/\(serverId)/home/posts/\(postId)/comments", body: Body(body: body)
        )
        return response.comment
    }
}
