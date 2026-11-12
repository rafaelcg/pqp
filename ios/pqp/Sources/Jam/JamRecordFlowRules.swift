import Foundation

// WHO MAY RECORD, WHAT THE STUDIO PRE-SELECTS, AND WHAT A REFUSAL SAYS. Pure.
// The web's `jam-record.ts` and `jam-api.ts`, restated.

enum JamRecordEligibility {
    /// Why a viewer who may not record sees no record button, in the order the
    /// reasons are checked.
    enum Reason: Equatable, Sendable {
        case off, uploadsOff, closed, other
    }

    /// Nil when the viewer may record. `addable` is `viewer.addableInstruments`:
    /// the one thing the button reads (it is empty too when the flag is off, the
    /// song is full or the viewer hit their own limit).
    static func cannotRecord(
        config: JamConfig, addable: [JamInstrument], joinMode: JamJoinMode
    ) -> Reason? {
        if !config.enabled { return .off }
        if !config.uploads { return .uploadsOff }
        if addable.isEmpty { return joinMode == .closed ? .closed : .other }
        return nil
    }

    /// What the studio pre-selects: the instrument the song is asking for, so
    /// the common case is no choice at all. Never one the viewer may not add,
    /// never one they already have a take of if something else is open to them.
    static func pickInstrument(
        song: JamSongSummary, addable: [JamInstrument], mine: [JamTrack] = []
    ) -> JamInstrument? {
        guard !addable.isEmpty else { return nil }
        let allowed = Set(addable)
        if case .missing(let wanted) = JamNeed.of(song), let first = wanted.first(where: allowed.contains) {
            return first
        }
        let mineSet = Set(mine.map(\.instrument))
        let onSong = Set(song.instruments)
        let ordered = JamInstrument.allCases.filter(allowed.contains)
        return ordered.first { !onSong.contains($0) && !mineSet.contains($0) }
            ?? ordered.first { !mineSet.contains($0) }
            ?? ordered.first
    }
}

/// What went wrong with a send, in the person's terms. The server's `error`
/// token rides in the message of an `APIError.server` / `.notFound`.
enum JamErrorKind: Equatable, Sendable {
    case off, closed, instrumentNotWanted, songFull, authorTrackLimit, tooLarge, storageOff
    case rateLimited, network, gone, other

    static func of(_ error: Error) -> JamErrorKind {
        if error is URLError { return .network }
        if let api = error as? APIError {
            switch api {
            case .rateLimited: return .rateLimited
            case .transport: return .network
            case .notFound: return .gone
            case .server(let status, let message):
                return of(token: message, status: status)
            case .unauthorized, .decoding: return .other
            }
        }
        return .other
    }

    static func of(token: String, status: Int = 0) -> JamErrorKind {
        switch token {
        case "jam_channels_off": return .off
        case "jam_song_closed": return .closed
        case "jam_instrument_not_wanted": return .instrumentNotWanted
        case "jam_song_full": return .songFull
        case "jam_author_track_limit": return .authorTrackLimit
        case "jam_upload_too_large": return .tooLarge
        case "jam_storage_off": return .storageOff
        case "jam_rate_limited": return .rateLimited
        default: break
        }
        if status == 413 { return .tooLarge }
        if status == 429 { return .rateLimited }
        return .other
    }

    /// A send that cannot succeed however often it is retried.
    var isFinal: Bool {
        switch self {
        case .off, .closed, .instrumentNotWanted, .songFull, .authorTrackLimit, .tooLarge, .storageOff, .gone: true
        case .rateLimited, .network, .other: false
        }
    }
}

/// The studio's lanes while recording share one timeline, and it must not
/// jump about as the take grows: it is the band's length (or twenty seconds
/// when there is no band yet) and widens in whole ten second steps when the
/// take runs past it.
enum JamStudioTimeline {
    static let minimumMs = 20_000.0
    static let stepMs = 10_000.0

    static func recordingSpanMs(bandMs: Double, elapsedMs: Double) -> Double {
        let base = max(bandMs, minimumMs)
        let needed = elapsedMs + 1000
        if needed <= base { return base }
        return (needed / stepMs).rounded(.up) * stepMs
    }
}

/// A new song's draft: what `POST /api/channels/:id/jam-songs` needs, and the
/// nonce that makes a retry return the same song.
struct JamSongDraft: Equatable, Sendable {
    var title = ""
    var artist = ""
    var joinMode: JamJoinMode = .open
    var wantedInstruments: [JamInstrument] = []
    /// One per attempt, kept across its retries, never reused: a second song
    /// made with the first one's nonce is never created, its take lands in the
    /// first.
    var nonce = UUID().uuidString

    var cleanTitle: String { Self.oneLine(title) }
    var cleanArtist: String? {
        let artist = Self.oneLine(artist)
        return artist.isEmpty ? nil : artist
    }

    static func oneLine(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    enum Problem: Equatable, Sendable { case needTitle, titleTooLong, needWanted }

    var problem: Problem? {
        if cleanTitle.isEmpty { return .needTitle }
        if cleanTitle.count > JamLimits.titleMax { return .titleTooLong }
        if joinMode == .wanted, wantedInstruments.isEmpty { return .needWanted }
        return nil
    }

    var body: JamCreateSongBody {
        JamCreateSongBody(
            title: cleanTitle, artist: cleanArtist, joinMode: joinMode,
            wantedInstruments: joinMode == .wanted ? wantedInstruments : [], nonce: nonce
        )
    }
}
