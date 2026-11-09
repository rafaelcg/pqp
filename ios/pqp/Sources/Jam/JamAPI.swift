import Foundation

// The jam routes this build uses (the REST table in `packages/shared/src/jam.ts`).
// Reads, votes, the mix switch and deletes. Recording, uploads and creating a
// song are on the computer for now, so no upload route is declared here.

extension APIClient {
    /// `GET /api/jam/config?serverId=`. Not memoised: the operator flips the
    /// flag per server with no deploy. Off on any failure, which keeps the row
    /// out of the list, exactly what a server without jam looks like.
    func jamConfig(serverId: String) async -> JamConfig {
        let query = [URLQueryItem(name: "serverId", value: serverId)]
        return (try? await get("/api/jam/config", query: query) as JamConfig) ?? .off
    }

    func jamSongs(
        channelId: String,
        sort: JamSort = .activity,
        cursor: String? = nil,
        limit: Int = JamLimits.pageSize
    ) async throws -> JamSongListResponse {
        var query = [
            URLQueryItem(name: "sort", value: sort.rawValue),
            URLQueryItem(name: "limit", value: String(min(limit, JamLimits.pageMax))),
        ]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await get("/api/channels/\(channelId)/jam-songs", query: query)
    }

    func jamSong(id: String) async throws -> JamSongDetail {
        try await get("/api/jam-songs/\(id)")
    }

    func deleteJamSong(id: String) async throws {
        let _: EmptyResponse = try await delete("/api/jam-songs/\(id)")
    }

    struct JamTrackPatch: Encodable, Sendable {
        var inMix: Bool?
    }

    func updateJamTrack(id: String, patch: JamTrackPatch) async throws -> JamTrackWithSong {
        try await self.patch("/api/jam-tracks/\(id)", body: patch)
    }

    func deleteJamTrack(id: String) async throws {
        let _: EmptyResponse = try await delete("/api/jam-tracks/\(id)")
    }

    /// `PUT` votes, `DELETE` takes it back. Both answer the new count and where
    /// the caller stands.
    func setJamVote(trackId: String, voted: Bool) async throws -> JamVoteResponse {
        let path = "/api/jam-tracks/\(trackId)/vote"
        if voted {
            return try await send(path: path, method: "PUT", body: EmptyBody())
        }
        return try await delete(path)
    }
}

struct JamTrackWithSong: Decodable, Sendable {
    let track: JamTrack
    let song: JamSongSummary
}
