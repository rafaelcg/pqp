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
