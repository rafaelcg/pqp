import Foundation

// The jam routes this build uses (the REST table in `packages/shared/src/jam.ts`).
// Reads, votes, the mix switch and deletes, and the recorder's three steps:
// create the song, mint an upload ticket and PUT the bytes to the bucket, then
// claim the track.

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

    /// The studio of a song it made cleaning up after itself: the song goes only
    /// while it holds no take (409 `jam_song_not_empty` otherwise), so a claim
    /// that committed unseen is never deleted.
    func deleteJamSongIfEmpty(id: String) async throws {
        let _: EmptyResponse = try await delete(
            "/api/jam-songs/\(id)", query: [URLQueryItem(name: "ifEmpty", value: "true")]
        )
    }

    /// `POST /api/channels/:channelId/jam-songs`. A repeated `nonce` answers the
    /// song the first try made (200), which is what makes a retry after a lost
    /// answer safe: one nonce per attempt, kept across its retries.
    func createJamSong(channelId: String, body: JamCreateSongBody) async throws -> JamSongSummary {
        struct Answer: Decodable { let song: JamSongSummary }
        let answer: Answer = try await post("/api/channels/\(channelId)/jam-songs", body: body)
        return answer.song
    }

    /// Step 1 of adding a track: a presigned PUT for one file.
    func createJamUpload(songId: String, body: JamUploadRequest) async throws -> JamUploadTicket {
        try await post("/api/jam-songs/\(songId)/uploads", body: body)
    }

    /// Step 3: claim the uploaded audio as a track. Idempotent on
    /// `audioUploadId` (the same track comes back), so a retry is safe.
    func addJamTrack(songId: String, body: JamAddTrackBody) async throws -> JamTrackWithSong {
        try await post("/api/jam-songs/\(songId)/tracks", body: body)
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


// MARK: - Bodies and tickets

/// `createJamSongSchema`.
struct JamCreateSongBody: Encodable, Equatable, Sendable {
    var title: String
    var artist: String?
    var joinMode: JamJoinMode
    var wantedInstruments: [JamInstrument]
    var nonce: String

    private enum CodingKeys: String, CodingKey { case title, artist, joinMode, wantedInstruments, nonce }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(title, forKey: .title)
        // `artist: null` is the contract's "none": it is the original.
        try c.encode(artist, forKey: .artist)
        try c.encode(joinMode.rawValue, forKey: .joinMode)
        try c.encode(joinMode == .wanted ? wantedInstruments.map(\.rawValue) : [], forKey: .wantedInstruments)
        try c.encode(nonce, forKey: .nonce)
    }
}

/// `createJamUploadSchema`. `byteSize` is signed into the URL: the PUT must be
/// exactly this long.
struct JamUploadRequest: Encodable, Equatable, Sendable {
    let kind: String
    let contentType: String
    let byteSize: Int

    static func audio(contentType: String, byteSize: Int) -> JamUploadRequest {
        JamUploadRequest(kind: "audio", contentType: contentType, byteSize: byteSize)
    }
}

/// `jamUploadTicketSchema`.
struct JamUploadTicket: Decodable, Equatable, Sendable {
    let uploadId: String
    let uploadUrl: String
    let expiresAt: Date?

    private enum CodingKeys: String, CodingKey { case uploadId, uploadUrl, expiresAt }

    init(uploadId: String, uploadUrl: String, expiresAt: Date? = nil) {
        self.uploadId = uploadId
        self.uploadUrl = uploadUrl
        self.expiresAt = expiresAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        uploadId = try c.decode(String.self, forKey: .uploadId)
        uploadUrl = try c.decode(String.self, forKey: .uploadUrl)
        expiresAt = try? c.decodeIfPresent(Date.self, forKey: .expiresAt)
    }
}

/// `addJamTrackSchema`: the recorder's own numbers. Field for field what the
/// web writes (`client/src/lib/jam/upload.ts`, `postTake`), which is what makes
/// a take recorded here line up on the web and the other way round.
struct JamAddTrackBody: Encodable, Equatable, Sendable {
    var instrument: JamInstrument
    var label: String?
    var audioUploadId: String
    var durationMs: Int
    var offsetMs: Double
    var trimStartMs: Int
    var trimEndMs: Int
    var gain: Double
    var peaks: [Double]

    private enum CodingKeys: String, CodingKey {
        case instrument, label, audioUploadId, videoUploadId, durationMs, offsetMs
        case trimStartMs, trimEndMs, gain, peaks
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(instrument.rawValue, forKey: .instrument)
        try c.encode(label, forKey: .label)
        try c.encode(audioUploadId, forKey: .audioUploadId)
        try c.encodeNil(forKey: .videoUploadId)
        try c.encode(durationMs, forKey: .durationMs)
        try c.encode(offsetMs, forKey: .offsetMs)
        try c.encode(trimStartMs, forKey: .trimStartMs)
        try c.encode(trimEndMs, forKey: .trimEndMs)
        try c.encode(gain, forKey: .gain)
        try c.encode(peaks, forKey: .peaks)
    }
}
