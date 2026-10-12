import Foundation

// The forum routes (the REST table in `packages/shared/src/forums.ts`).
// Declared beside the models rather than in APIClient.swift, the way the Baú
// and the communities keep theirs.

extension APIClient {
    /// `GET /api/forum/config?serverId=`. Not memoised: the operator flips the
    /// flag per server with no deploy. Off on any failure, which only hides
    /// "Novo post"; reading and replying never depend on it.
    func forumConfig(serverId: String) async -> ForumConfig {
        let query = [URLQueryItem(name: "serverId", value: serverId)]
        return (try? await get("/api/forum/config", query: query) as ForumConfig) ?? .off
    }

    /// One page of posts. `tag` repeats and is AND on the server.
    func forumPosts(
        forumId: String,
        filters: ForumFilters,
        cursor: String? = nil,
        limit: Int = ForumLimits.pageSize
    ) async throws -> ForumPostListResponse {
        var query = [
            URLQueryItem(name: "sort", value: filters.sort.rawValue),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        for tagId in filters.tagIds {
            query.append(URLQueryItem(name: "tag", value: tagId))
        }
        if let status = filters.status {
            query.append(URLQueryItem(name: "status", value: status.rawValue))
        }
        if filters.mine {
            query.append(URLQueryItem(name: "mine", value: "true"))
        }
        let q = filters.trimmedQuery
        if !q.isEmpty {
            query.append(URLQueryItem(name: "q", value: String(q.prefix(ForumLimits.searchMax))))
        }
        if let cursor {
            query.append(URLQueryItem(name: "cursor", value: cursor))
        }
        return try await get("/api/channels/\(forumId)/posts", query: query)
    }

    /// "Posts parecidos" while the composer's title is typed.
    func similarForumPosts(forumId: String, title: String) async throws -> [ForumPostSummary] {
        struct Response: Decodable { let posts: [ForumPostSummary] }
        let trimmed = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(ForumLimits.titleMax))
        let response: Response = try await get(
            "/api/channels/\(forumId)/posts/similar",
            query: [URLQueryItem(name: "title", value: trimmed)]
        )
        return response.posts
    }

    func forumPost(id: String) async throws -> ForumPostDetail {
        try await get("/api/forum-posts/\(id)")
    }

    func forumTags(forumId: String) async throws -> [ForumTag] {
        struct Response: Decodable { let tags: [ForumTag] }
        let response: Response = try await get("/api/channels/\(forumId)/forum-tags")
        return response.tags.sorted { $0.position < $1.position }
    }

    func forumSettings(forumId: String) async throws -> ForumSettings {
        struct Response: Decodable { let settings: ForumSettings }
        let response: Response = try await get("/api/channels/\(forumId)/forum-settings")
        return response.settings
    }

    /// The fields a PATCH may carry. Only what is set travels; `acceptedAnswerId`
    /// is tri-state on the wire (absent, null to unmark, an id), so it has its
    /// own case.
    struct ForumPostPatch: Encodable, Sendable {
        var title: String?
        var tagIds: [String]?
        var resolved: Bool?
        var pinned: Bool?
        var locked: Bool?
        var acceptedAnswer: AcceptedAnswerChange?

        enum AcceptedAnswerChange: Sendable {
            case set(String)
            case clear
        }

        private enum CodingKeys: String, CodingKey {
            case title, tagIds, resolved, pinned, locked, acceptedAnswerId
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encodeIfPresent(title, forKey: .title)
            try c.encodeIfPresent(tagIds, forKey: .tagIds)
            try c.encodeIfPresent(resolved, forKey: .resolved)
            try c.encodeIfPresent(pinned, forKey: .pinned)
            try c.encodeIfPresent(locked, forKey: .locked)
            switch acceptedAnswer {
            case .set(let id): try c.encode(id, forKey: .acceptedAnswerId)
            case .clear: try c.encodeNil(forKey: .acceptedAnswerId)
            case nil: break
            }
        }
    }

    func updateForumPost(id: String, patch: ForumPostPatch) async throws -> ForumPostSummary {
        struct Response: Decodable { let post: ForumPostSummary }
        let response: Response = try await self.patch("/api/forum-posts/\(id)", body: patch)
        return response.post
    }

    func deleteForumPost(id: String) async throws {
        let _: EmptyResponse = try await delete("/api/forum-posts/\(id)")
    }

    /// `PUT /api/forum-posts/:postId/follow`. P2 acts on it (pushes); the row
    /// is stored today.
    func followForumPost(id: String, following: Bool) async throws -> ForumPostViewer {
        struct Body: Encodable { let following: Bool }
        struct Response: Decodable { let viewer: ForumPostViewer }
        let (data, status) = try await rawRequest(
            "/api/forum-posts/\(id)/follow", method: "PUT", body: Body(following: following)
        )
        guard (200..<300).contains(status) else {
            let message = (try? Coding.decoder.decode(ApiErrorBody.self, from: data))?.error
                ?? "Request failed (\(status))"
            throw APIError.server(status: status, message: message)
        }
        do {
            return try Coding.decoder.decode(Response.self, from: data).viewer
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    struct CreateForumPostBody: Encodable, Sendable {
        let title: String
        let body: String
        let tagIds: [String]
        let attachmentIds: [String]
        /// One per attempt, reused on a retry of that attempt: the server
        /// answers a repeat with the post it already made.
        let nonce: String
    }

    struct CreatedForumPost: Decodable, Sendable {
        let post: ForumPostSummary
        let viewer: ForumPostViewer?
    }

    /// `POST /api/channels/:forumId/posts`. Not optimistic (UX §2.5 #37): the
    /// server is the authority, and a post that appears and then vanishes is
    /// worse than a short wait. Attachments were minted against the FORUM id
    /// and are re-homed to the post inside the create.
    func createForumPost(forumId: String, body: CreateForumPostBody) async throws(ForumCreateError) -> CreatedForumPost {
        let data: Data
        let status: Int
        do {
            (data, status) = try await rawRequest("/api/channels/\(forumId)/posts", method: "POST", body: body)
        } catch {
            throw .transport((error as? APIError)?.errorDescription ?? error.localizedDescription)
        }
        if (200..<300).contains(status) {
            do {
                return try Coding.decoder.decode(CreatedForumPost.self, from: data)
            } catch {
                throw .transport(String(localized: "Could not read the server's response. \(String(describing: error))"))
            }
        }
        if let rejection = try? Coding.decoder.decode(ForumPostRejection.self, from: data),
           rejection.reason != nil {
            throw .rejected(rejection)
        }
        let token = (try? Coding.decoder.decode(ApiErrorBody.self, from: data))?.error
            ?? "Request failed (\(status))"
        throw .refused(status: status, error: token)
    }
}
