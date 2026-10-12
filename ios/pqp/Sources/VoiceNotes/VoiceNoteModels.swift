import Foundation

/// The `voice` block of an attachment: what makes an `audio/mp4` file a voice
/// note rather than a file somebody uploaded.
///
/// DECODED TOLERANTLY, on purpose and everywhere. The block is the newest part
/// of the attachment contract and the server grows it in separate PRs
/// (`listenedByMe`, `listenedBy`, `playbackUrl`, a transcript), so every field
/// past the duration is optional and an element this build cannot read costs
/// that element, never the message. `Attachment` goes one step further and
/// treats a block that does not decode at all as "not a voice note", which
/// degrades to the plain audio chip every old build already shows.
struct VoiceNote: Codable, Hashable, Sendable {
    /// What the card shows. The recorder's own measurement, which the worker
    /// later checks against the container; the card never re-derives it.
    var durationMs: Int
    /// 64 peaks, one byte each, base64. Empty means "draw a flat bar".
    var waveform: String
    /// Nil on a server that predates the receipts; reads as "unplayed" only
    /// when it is explicitly false, so an old server does not light a dot on
    /// every note in the history.
    var listenedByMe: Bool?
    /// Who has heard it. Present only on the author's own copy, in a
    /// conversation small enough to show receipts.
    var listenedBy: [VoiceListener]?
    /// An AAC copy the worker makes for an Opus note (Chrome and Firefox record
    /// WebM, which AVPlayer cannot play). Presigned like the original.
    var playbackUrl: String?

    init(
        durationMs: Int,
        waveform: String = "",
        listenedByMe: Bool? = nil,
        listenedBy: [VoiceListener]? = nil,
        playbackUrl: String? = nil
    ) {
        self.durationMs = durationMs
        self.waveform = waveform
        self.listenedByMe = listenedByMe
        self.listenedBy = listenedBy
        self.playbackUrl = playbackUrl
    }

    private enum CodingKeys: String, CodingKey {
        case durationMs, waveform, listenedByMe, listenedBy, playbackUrl
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // The one required field. A note with no duration has nothing to draw.
        durationMs = try c.decode(Int.self, forKey: .durationMs)
        waveform = (try? c.decodeIfPresent(String.self, forKey: .waveform)) ?? ""
        listenedByMe = (try? c.decodeIfPresent(Bool.self, forKey: .listenedByMe)) ?? nil
        listenedBy = (try? c.decodeIfPresent([VoiceListener].self, forKey: .listenedBy)) ?? nil
        // An empty string is not a URL; treat it as absent so "pending" holds.
        let playback = (try? c.decodeIfPresent(String.self, forKey: .playbackUrl)) ?? nil
        playbackUrl = (playback?.isEmpty == false) ? playback : nil
    }

    /// Whether this person has NOT heard the note yet. Unknown reads as heard,
    /// so an older server (no receipts at all) never paints a dot on the whole
    /// history.
    var isUnplayedForMe: Bool { listenedByMe == false }

    var heardByAnyone: Bool { !(listenedBy ?? []).isEmpty }
}

/// One entry of `listenedBy`. The contract has moved between a bare user id and
/// `{userId, listenedAt}`, so both decode.
struct VoiceListener: Codable, Hashable, Sendable {
    let userId: String
    let listenedAt: Date?

    init(userId: String, listenedAt: Date? = nil) {
        self.userId = userId
        self.listenedAt = listenedAt
    }

    private enum CodingKeys: String, CodingKey {
        case userId, listenedAt
    }

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(),
           let id = try? single.decode(String.self) {
            userId = id
            listenedAt = nil
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = try c.decode(String.self, forKey: .userId)
        listenedAt = (try? c.decodeIfPresent(Date.self, forKey: .listenedAt)) ?? nil
    }
}

extension Attachment {
    /// A voice note, as opposed to a file that happens to be audio. Only the
    /// server says so, through the `voice` block; the content type alone never
    /// does, because an uploaded `.m4a` is `audio/mp4` too.
    var isVoiceNote: Bool { voice != nil }
}

// MARK: - Which bytes to play

/// What the player does with a note, decided from the data alone.
///
/// AVPlayer plays AAC in MP4 and does not play Opus in WebM or Ogg. The web
/// recorder uses whichever its browser supports, and the worker makes an AAC
/// copy of the Opus ones (`voice.playbackUrl`). So the order is:
///
/// 1. `playbackUrl`, when the server has made the copy (always AAC);
/// 2. the original, when it is already `audio/mp4`;
/// 3. otherwise there is nothing playable *yet*: show "Processando áudio…" and
///    look again when the server says the copy exists.
///
/// Pure, so the order that matters can be pinned in a unit test without a
/// player or a network.
enum VoiceNotePlaybackSource: Equatable, Sendable {
    case play(URL)
    case pending

    static func choose(contentType: String, url: String, playbackUrl: String?) -> VoiceNotePlaybackSource {
        if let playbackUrl, !playbackUrl.isEmpty, let copy = URL(string: playbackUrl) {
            return .play(copy)
        }
        if baseType(contentType) == "audio/mp4", let original = URL(string: url) {
            return .play(original)
        }
        return .pending
    }

    static func choose(for attachment: Attachment) -> VoiceNotePlaybackSource {
        choose(
            contentType: attachment.contentType,
            url: attachment.url,
            playbackUrl: attachment.voice?.playbackUrl
        )
    }

    /// `audio/mp4;codecs=mp4a.40.2` and `Audio/MP4` both mean `audio/mp4`.
    private static func baseType(_ contentType: String) -> String {
        contentType
            .split(separator: ";", maxSplits: 1)
            .first
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
    }
}

/// `0:12`, `4:05`. Whole seconds, never below one: the same rule as
/// `formatNoteDuration` in `@pqp/shared`, so the card and the push say the
/// same number.
func formatNoteDuration(milliseconds: Int) -> String {
    let seconds = max(1, Int((Double(milliseconds) / 1000).rounded()))
    return String(format: "%d:%02d", seconds / 60, seconds % 60)
}
