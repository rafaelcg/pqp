import Foundation

// Jam channels, as the wire carries them. The contract is
// `packages/shared/src/jam.ts`; Swift cannot import it, so this mirrors the
// parts the phone reads, decoded leniently: a field a card can live without is
// read with a default, so a server that adds one (or an instrument it invented)
// costs a detail, not the whole list.
//
// THE MODEL, ONCE. A jam is a channel of type `jam` that holds SONGS. A song is
// a pile of TRACKS: one recorded stem each, one instrument, one person,
// optionally with a video. A client plays every track that is `inMix` in sync.
// Nothing is mixed on the server.
//
// THE TIMELINE, ONCE (as the web recorder writes it and the web player plays
// it, `client/src/lib/jam/timeline.ts`). `offsetMs` is the song time of the
// stored file's FIRST sample (which may be negative) and only
// `audio[trimStartMs, durationMs - trimEndMs]` is heard: a trim hides audio and
// never moves it. Trims are applied at play time and never touch the stored
// bytes. `JamAlignment` turns this into frames and says why it is not the
// wording in the header of `jam.ts`.

/// The caps from `jam.ts`. Restated, not imported.
enum JamLimits {
    static let titleMax = 100
    static let pageSize = 25
    static let pageMax = 50
    static let maxTracksPerSong = 32
    static let peaksMax = 400
    static let gainMax = 2.0
    static let trackMaxDurationMs = 10 * 60 * 1000
}

/// The `error` tokens of a jam refusal (`JAM_ERRORS`).
enum JamErrorCode {
    static let off = "jam_channels_off"
    static let closed = "jam_song_closed"
    static let instrumentNotWanted = "jam_instrument_not_wanted"
    static let songFull = "jam_song_full"
    static let authorTrackLimit = "jam_author_track_limit"
    static let rateLimited = "jam_rate_limited"
}

/// Order is the picker's order, and the order `instruments` arrives in.
enum JamInstrument: String, Codable, CaseIterable, Hashable, Sendable {
    case guitar, bass, drums, vocals, keys, other

    /// An instrument a newer server invented reads as `other`, the way the
    /// shared schema's `.catch("other")` does.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = JamInstrument(rawValue: raw) ?? .other
    }
}

enum JamJoinMode: String, Codable, Hashable, Sendable {
    case open, wanted, closed

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        // The most permissive reading of an unknown mode would invite people
        // the server may refuse; the most restrictive one is the safe copy.
        self = JamJoinMode(rawValue: raw) ?? .closed
    }
}

/// `GET /api/jam/config?serverId=`.
struct JamConfig: Decodable, Equatable, Sendable {
    /// Creating and changing is allowed on this server. Off also hides the row
    /// on this build: an unflagged server must look exactly as it did before.
    let enabled: Bool
    /// Object storage is configured, so a track could be added at all.
    let uploads: Bool

    static let off = JamConfig(enabled: false, uploads: false)

    init(enabled: Bool, uploads: Bool) {
        self.enabled = enabled
        self.uploads = uploads
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        uploads = try c.decodeIfPresent(Bool.self, forKey: .uploads) ?? false
    }

    private enum CodingKeys: String, CodingKey { case enabled, uploads }
}

/// A person with a track in a song, as the summary names them (`contributors`).
struct JamContributor: Decodable, Hashable, Sendable {
    let id: String
    /// Nil once the account is gone.
    let name: String?
    let avatarUrl: String?
}

struct JamSongSummary: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let channelId: String
    let serverId: String
    var title: String
    /// The original artist. Nil means the song is an original.
    var artist: String?
    var joinMode: JamJoinMode
    var wantedInstruments: [JamInstrument]
    /// Nil once the account is gone ("Conta excluida").
    let authorId: String?
    let authorName: String?
    let authorAvatarUrl: String?
    let createdAt: Date
    /// The bump: created, edited, a track added, changed or removed.
    var updatedAt: Date
    var trackCount: Int
    /// Distinct instruments among the live tracks, in `JamInstrument` order.
    var instruments: [JamInstrument]
    var contributorCount: Int
    /// Length of the default mix. Nil with no `inMix` track.
    var mixDurationMs: Double?

    // What a tile draws, carried by the summary since server PR #1579. Each is
    // NIL when the server predates it (the key is absent), which is how this
    // build tells "no peaks" (an empty array) from "ask the detail": the old
    // lazy path stays as the fallback and nothing here assumes a new server.
    /// Up to 64 values 0...1: the loudest in-mix stem's peaks.
    var previewPeaks: [Double]?
    /// At least one live track has a video.
    var hasVideo: Bool?
    /// Up to 4 people, in the order of each one's first track.
    var contributors: [JamContributor]?
    /// For a `wanted` song, the wanted instruments with no live track yet.
    var missingInstruments: [JamInstrument]?

    /// The summary answers what a tile draws, so no detail read is needed for
    /// the waveform or the names.
    var answersPreview: Bool { previewPeaks != nil && hasVideo != nil && contributors != nil }

    init(
        id: String, channelId: String, serverId: String, title: String, artist: String? = nil,
        joinMode: JamJoinMode = .open, wantedInstruments: [JamInstrument] = [],
        authorId: String? = nil, authorName: String? = nil, authorAvatarUrl: String? = nil,
        createdAt: Date = Date(), updatedAt: Date = Date(), trackCount: Int = 0,
        instruments: [JamInstrument] = [], contributorCount: Int = 0, mixDurationMs: Double? = nil,
        previewPeaks: [Double]? = nil, hasVideo: Bool? = nil, contributors: [JamContributor]? = nil,
        missingInstruments: [JamInstrument]? = nil
    ) {
        self.id = id
        self.channelId = channelId
        self.serverId = serverId
        self.title = title
        self.artist = artist
        self.joinMode = joinMode
        self.wantedInstruments = wantedInstruments
        self.authorId = authorId
        self.authorName = authorName
        self.authorAvatarUrl = authorAvatarUrl
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.trackCount = trackCount
        self.instruments = instruments
        self.contributorCount = contributorCount
        self.mixDurationMs = mixDurationMs
        self.previewPeaks = previewPeaks
        self.hasVideo = hasVideo
        self.contributors = contributors
        self.missingInstruments = missingInstruments
    }

    private enum CodingKeys: String, CodingKey {
        case id, channelId, serverId, title, artist, joinMode, wantedInstruments, authorId
        case authorName, authorAvatarUrl, createdAt, updatedAt, trackCount, instruments
        case contributorCount, mixDurationMs
        case previewPeaks, hasVideo, contributors, missingInstruments
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        channelId = try c.decode(String.self, forKey: .channelId)
        serverId = try c.decodeIfPresent(String.self, forKey: .serverId) ?? ""
        title = try c.decode(String.self, forKey: .title)
        artist = try c.decodeIfPresent(String.self, forKey: .artist)
        joinMode = try c.decodeIfPresent(JamJoinMode.self, forKey: .joinMode) ?? .open
        wantedInstruments = try c.decodeIfPresent([JamInstrument].self, forKey: .wantedInstruments) ?? []
        authorId = try c.decodeIfPresent(String.self, forKey: .authorId)
        authorName = try c.decodeIfPresent(String.self, forKey: .authorName)
        authorAvatarUrl = try c.decodeIfPresent(String.self, forKey: .authorAvatarUrl)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        trackCount = try c.decodeIfPresent(Int.self, forKey: .trackCount) ?? 0
        instruments = try c.decodeIfPresent([JamInstrument].self, forKey: .instruments) ?? []
        contributorCount = try c.decodeIfPresent(Int.self, forKey: .contributorCount) ?? 0
        mixDurationMs = try c.decodeIfPresent(Double.self, forKey: .mixDurationMs)
        // Lenient: a field this build cannot read is "not answered", which
        // sends the tile down the detail path, not out of the list.
        previewPeaks = (try? c.decodeIfPresent([Double].self, forKey: .previewPeaks)) ?? nil
        hasVideo = (try? c.decodeIfPresent(Bool.self, forKey: .hasVideo)) ?? nil
        contributors = (try? c.decodeIfPresent([JamContributor].self, forKey: .contributors)) ?? nil
        missingInstruments = (try? c.decodeIfPresent([JamInstrument].self, forKey: .missingInstruments)) ?? nil
    }
}

struct JamTrack: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let songId: String
    let authorId: String
    let authorName: String?
    let authorAvatarUrl: String?
    var instrument: JamInstrument
    var label: String?
    var audioUrl: String
    var audioContentType: String
    var audioBytes: Int
    /// Nil when the track has no video.
    var videoUrl: String?
    var videoContentType: String?
    var mediaExpiresAt: Date?
    var offsetMs: Double
    var trimStartMs: Double
    var trimEndMs: Double
    var durationMs: Double
    var gain: Double
    var peaks: [Double]
    var inMix: Bool
    var voteCount: Int
    let createdAt: Date

    init(
        id: String, songId: String, authorId: String, authorName: String? = nil,
        authorAvatarUrl: String? = nil, instrument: JamInstrument = .other, label: String? = nil,
        audioUrl: String = "", audioContentType: String = "audio/mp4", audioBytes: Int = 0,
        videoUrl: String? = nil, videoContentType: String? = nil, mediaExpiresAt: Date? = nil,
        offsetMs: Double = 0, trimStartMs: Double = 0, trimEndMs: Double = 0,
        durationMs: Double = 0, gain: Double = 1, peaks: [Double] = [], inMix: Bool = true,
        voteCount: Int = 0, createdAt: Date = Date()
    ) {
        self.id = id
        self.songId = songId
        self.authorId = authorId
        self.authorName = authorName
        self.authorAvatarUrl = authorAvatarUrl
        self.instrument = instrument
        self.label = label
        self.audioUrl = audioUrl
        self.audioContentType = audioContentType
        self.audioBytes = audioBytes
        self.videoUrl = videoUrl
        self.videoContentType = videoContentType
        self.mediaExpiresAt = mediaExpiresAt
        self.offsetMs = offsetMs
        self.trimStartMs = trimStartMs
        self.trimEndMs = trimEndMs
        self.durationMs = durationMs
        self.gain = gain
        self.peaks = peaks
        self.inMix = inMix
        self.voteCount = voteCount
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, songId, authorId, authorName, authorAvatarUrl, instrument, label, audioUrl
        case audioContentType, audioBytes, videoUrl, videoContentType, mediaExpiresAt, offsetMs
        case trimStartMs, trimEndMs, durationMs, gain, peaks, inMix, voteCount, createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        songId = try c.decode(String.self, forKey: .songId)
        authorId = try c.decode(String.self, forKey: .authorId)
        authorName = try c.decodeIfPresent(String.self, forKey: .authorName)
        authorAvatarUrl = try c.decodeIfPresent(String.self, forKey: .authorAvatarUrl)
        instrument = try c.decodeIfPresent(JamInstrument.self, forKey: .instrument) ?? .other
        label = try c.decodeIfPresent(String.self, forKey: .label)
        audioUrl = try c.decode(String.self, forKey: .audioUrl)
        audioContentType = try c.decodeIfPresent(String.self, forKey: .audioContentType) ?? ""
        audioBytes = try c.decodeIfPresent(Int.self, forKey: .audioBytes) ?? 0
        videoUrl = try c.decodeIfPresent(String.self, forKey: .videoUrl)
        videoContentType = try c.decodeIfPresent(String.self, forKey: .videoContentType)
        mediaExpiresAt = try? c.decodeIfPresent(Date.self, forKey: .mediaExpiresAt)
        offsetMs = try c.decodeIfPresent(Double.self, forKey: .offsetMs) ?? 0
        trimStartMs = try c.decodeIfPresent(Double.self, forKey: .trimStartMs) ?? 0
        trimEndMs = try c.decodeIfPresent(Double.self, forKey: .trimEndMs) ?? 0
        durationMs = try c.decodeIfPresent(Double.self, forKey: .durationMs) ?? 0
        gain = try c.decodeIfPresent(Double.self, forKey: .gain) ?? 1
        peaks = try c.decodeIfPresent([Double].self, forKey: .peaks) ?? []
        inMix = try c.decodeIfPresent(Bool.self, forKey: .inMix) ?? false
        voteCount = try c.decodeIfPresent(Int.self, forKey: .voteCount) ?? 0
        createdAt = (try? c.decode(Date.self, forKey: .createdAt)) ?? Date(timeIntervalSince1970: 0)
    }

    var hasVideo: Bool { videoUrl != nil }

    /// The person (a label is separate: rows show `label ?? displayName`).
    var displayName: String { authorName ?? "?" }

    /// `jamTrackPlayedMs` in the contract: the length it plays for.
    var playedMs: Double { max(0, durationMs - trimStartMs - trimEndMs) }
    /// Where its heard slice starts and ends on the song timeline: the file
    /// starts at `offsetMs` and the head trim hides the first `trimStartMs` of
    /// it (`JamAlignment`).
    var startMs: Double { offsetMs + trimStartMs }
    var endMs: Double { startMs + playedMs }
}

struct JamSongViewer: Decodable, Equatable, Sendable {
    var isAuthor: Bool
    var canModerate: Bool
    /// The instruments the caller may add a track for right now. The one thing
    /// the "add a track" affordance reads.
    var addableInstruments: [JamInstrument]
    var votedTrackIds: Set<String>

    static let none = JamSongViewer(isAuthor: false, canModerate: false, addableInstruments: [], votedTrackIds: [])

    init(isAuthor: Bool, canModerate: Bool, addableInstruments: [JamInstrument], votedTrackIds: Set<String>) {
        self.isAuthor = isAuthor
        self.canModerate = canModerate
        self.addableInstruments = addableInstruments
        self.votedTrackIds = votedTrackIds
    }

    private enum CodingKeys: String, CodingKey { case isAuthor, canModerate, addableInstruments, votedTrackIds }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isAuthor = try c.decodeIfPresent(Bool.self, forKey: .isAuthor) ?? false
        canModerate = try c.decodeIfPresent(Bool.self, forKey: .canModerate) ?? false
        addableInstruments = try c.decodeIfPresent([JamInstrument].self, forKey: .addableInstruments) ?? []
        votedTrackIds = Set(try c.decodeIfPresent([String].self, forKey: .votedTrackIds) ?? [])
    }
}

struct JamSongListResponse: Decodable, Sendable {
    let songs: [JamSongSummary]
    let nextCursor: String?
}

struct JamSongDetail: Decodable, Sendable {
    let song: JamSongSummary
    let tracks: [JamTrack]
    let viewer: JamSongViewer
}

struct JamVoteResponse: Decodable, Sendable {
    let trackId: String
    let songId: String
    let voteCount: Int
    let voted: Bool
}

enum JamSort: String, Sendable {
    case activity, created
}

// MARK: - Live frames

/// The seven jam frames, in one enum. The server sends them to every socket
/// that did `join-channel` on the jam channel, and a change reaches the
/// writer's own socket too, so applying one is idempotent by id.
enum JamFrame: Sendable {
    case songCreated(channelId: String, song: JamSongSummary)
    case songUpdated(channelId: String, song: JamSongSummary)
    case songDeleted(channelId: String, songId: String)
    case trackAdded(channelId: String, song: JamSongSummary, track: JamTrack)
    case trackUpdated(channelId: String, song: JamSongSummary, track: JamTrack)
    case trackDeleted(channelId: String, song: JamSongSummary, trackId: String)
    /// No voter is named, and nothing about the viewer.
    case trackVotes(channelId: String, songId: String, trackId: String, voteCount: Int)

    static let types: Set<String> = [
        "jam-song-created", "jam-song-updated", "jam-song-deleted", "jam-track-added",
        "jam-track-updated", "jam-track-deleted", "jam-track-votes",
    ]

    var channelId: String {
        switch self {
        case .songCreated(let id, _), .songUpdated(let id, _), .songDeleted(let id, _),
             .trackAdded(let id, _, _), .trackUpdated(let id, _, _), .trackDeleted(let id, _, _),
             .trackVotes(let id, _, _, _):
            id
        }
    }

    private struct Envelope: Decodable {
        let type: String
        let channelId: String
        let song: JamSongSummary?
        let songId: String?
        let track: JamTrack?
        let trackId: String?
        let voteCount: Int?
    }

    /// A frame this build cannot read (a missing field, a type it does not
    /// know) is dropped, not guessed at.
    static func parse(_ data: Data) -> JamFrame? {
        guard let e = try? Coding.decoder.decode(Envelope.self, from: data) else { return nil }
        switch e.type {
        case "jam-song-created":
            guard let song = e.song else { return nil }
            return .songCreated(channelId: e.channelId, song: song)
        case "jam-song-updated":
            guard let song = e.song else { return nil }
            return .songUpdated(channelId: e.channelId, song: song)
        case "jam-song-deleted":
            guard let songId = e.songId else { return nil }
            return .songDeleted(channelId: e.channelId, songId: songId)
        case "jam-track-added":
            guard let song = e.song, let track = e.track else { return nil }
            return .trackAdded(channelId: e.channelId, song: song, track: track)
        case "jam-track-updated":
            guard let song = e.song, let track = e.track else { return nil }
            return .trackUpdated(channelId: e.channelId, song: song, track: track)
        case "jam-track-deleted":
            guard let song = e.song, let trackId = e.trackId else { return nil }
            return .trackDeleted(channelId: e.channelId, song: song, trackId: trackId)
        case "jam-track-votes":
            guard let songId = e.songId, let trackId = e.trackId, let count = e.voteCount else { return nil }
            return .trackVotes(channelId: e.channelId, songId: songId, trackId: trackId, voteCount: count)
        default:
            return nil
        }
    }
}
