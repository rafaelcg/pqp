import Foundation

// BAÚ VIDEO SUBTITLES on the phone.
//
// With `community_home_video_captions` on (the QG has it), an uploaded Baú video
// has automatic subtitles: `post.captions` says there are some, and
// `GET /api/servers/:id/home/posts/:postId/captions?lang=` answers WebVTT
// tracks (the source and, when current, a translation into the reader's
// language). The web draws them; this is the phone's version, from
// `client/src/lib/community-home/captions.ts` and
// `packages/shared/src/community-home.ts`.
//
// AVPlayer only takes external WebVTT through an HLS wrapper or a composition,
// and neither is worth it for a line of text: the cues are parsed here and the
// current one is drawn over the video (inline and in the system's full screen,
// through the controller's content overlay) by a clock on the player.
// Everything that decides something is in this file, where a test can see it.

/// `post.captions`: there are subtitles, in these languages. Absent for a locked
/// viewer, for anything but an uploaded video, and with the flag off.
struct BauPostCaptions: Codable, Hashable, Sendable {
    let sourceLang: String
    let langs: [String]
    /// Length of the sound that was transcribed. A player showing another file
    /// of the same post (the phone cut) uses it to check the subtitles still fit.
    let durationMs: Int?

    private enum CodingKeys: String, CodingKey { case sourceLang, langs, durationMs }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sourceLang = try c.decode(String.self, forKey: .sourceLang)
        langs = (try? c.decodeIfPresent([String].self, forKey: .langs)) ?? []
        durationMs = (try? c.decodeIfPresent(Int.self, forKey: .durationMs)) ?? nil
    }

    init(sourceLang: String, langs: [String] = [], durationMs: Int? = nil) {
        self.sourceLang = sourceLang
        self.langs = langs
        self.durationMs = durationMs
    }
}

struct BauCaptionTrack: Decodable, Hashable, Sendable {
    let lang: String
    /// True for the transcription itself, false for a translation of it.
    let source: Bool
    /// A complete WebVTT file.
    let vtt: String
}

struct BauCaptionsResponse: Decodable, Sendable { let tracks: [BauCaptionTrack] }

struct BauCaptionCue: Equatable, Sendable {
    let start: Double
    let end: Double
    let text: String
}

enum BauCaptionRules {
    /// A cut whose length is within this of what was transcribed still fits.
    static let durationToleranceSeconds = 1.5

    /// `pt-BR` and `pt` are one language here, like the post translations.
    static func baseLang(_ lang: String?) -> String? {
        guard let lang else { return nil }
        let base = lang.trimmingCharacters(in: .whitespaces).lowercased().split(whereSeparator: { $0 == "-" || $0 == "_" }).first
        return base.map(String.init).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The reader's own language when there is a track in it, else what was said.
    static func pick(_ tracks: [BauCaptionTrack], readerLocale: String) -> BauCaptionTrack? {
        let reader = baseLang(readerLocale)
        return tracks.first { baseLang($0.lang) == reader } ?? tracks.first { $0.source } ?? tracks.first
    }

    /// Subtitles start ON when the video is in another language than the
    /// reader's (that is who they are for), OFF when it is the reader's own. A
    /// choice made with the CC button wins on every video after it.
    static func onByDefault(sourceLang: String, readerLocale: String, stored: Bool?) -> Bool {
        if let stored { return stored }
        // A track whose language Whisper could not tell is not assumed to be ours.
        guard let source = baseLang(sourceLang), source != "und" else { return true }
        return source != baseLang(readerLocale)
    }

    /// Whether the subtitles still fit the file being played: the phone cut can
    /// differ from the video that was transcribed, and lines at the wrong moment
    /// are worse than none. Unknown on either side fits.
    static func fits(transcribedMs: Int?, playedSeconds: Double?) -> Bool {
        guard let transcribedMs, let playedSeconds, playedSeconds > 0 else { return true }
        return abs(Double(transcribedMs) / 1000 - playedSeconds) <= durationToleranceSeconds
    }

    /// The line to draw at `time`, if any. Cues are in order and rarely overlap.
    static func text(at time: Double, in cues: [BauCaptionCue]) -> String? {
        cues.last { $0.start <= time && time < $0.end }?.text
    }
}

/// A WebVTT file as cues. Lenient: a block it cannot read is skipped, never a
/// reason to lose the rest; styling tags are removed (the overlay has one style).
enum WebVTT {
    static func cues(from vtt: String) -> [BauCaptionCue] {
        let normalized = vtt.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        var cues: [BauCaptionCue] = []
        for block in normalized.components(separatedBy: "\n\n") {
            let lines = block.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            guard let timing = lines.firstIndex(where: { $0.contains("-->") }) else { continue }
            let parts = lines[timing].components(separatedBy: "-->")
            guard parts.count == 2,
                  let start = seconds(parts[0]),
                  // Cue settings (`align:center`) may follow the end time.
                  let end = seconds(parts[1].split(separator: " ").first.map(String.init) ?? "")
            else { continue }
            let text = lines[(timing + 1)...]
                .joined(separator: "\n")
                .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
                .replacingOccurrences(of: "&lt;", with: "<")
                .replacingOccurrences(of: "&gt;", with: ">")
                .replacingOccurrences(of: "&nbsp;", with: " ")
                .replacingOccurrences(of: "&amp;", with: "&")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, end > start else { continue }
            cues.append(BauCaptionCue(start: start, end: end, text: text))
        }
        return cues
    }

    /// `00:01:02.500`, `01:02.500`, `1:02,500`.
    static func seconds(_ raw: String) -> Double? {
        let clean = raw.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        let parts = clean.split(separator: ":").map(String.init)
        guard (2...3).contains(parts.count) else { return nil }
        var total = 0.0
        for part in parts {
            guard let value = Double(part), value >= 0 else { return nil }
            total = total * 60 + value
        }
        return total
    }
}

extension APIClient {
    /// The tracks for one post: the source and, when one exists, its translation
    /// into `lang`. Authorised like the video itself; empty when there are none.
    func communityHomeCaptions(serverId: String, postId: String, lang: String) async throws -> [BauCaptionTrack] {
        let response: BauCaptionsResponse = try await get(
            "/api/servers/\(serverId)/home/posts/\(postId)/captions",
            query: [URLQueryItem(name: "lang", value: lang)]
        )
        return response.tracks
    }
}

/// What the phone holds about subtitles, per post, and the one choice a person
/// makes with the CC button (remembered on this device for every video after).
@MainActor
@Observable
final class BauCaptions {
    static let shared = BauCaptions()

    struct Entry: Equatable {
        var cues: [BauCaptionCue]
        var sourceLang: String
        var transcribedMs: Int?
        /// The file being played is not the one that was transcribed.
        var misfit = false
    }

    private(set) var entries: [String: Entry] = [:]
    /// The reader's choice, nil until they press CC.
    private(set) var stored: Bool?
    @ObservationIgnored private var loading: Set<String> = []
    @ObservationIgnored private let defaults: UserDefaults
    private static let key = "pqp.communityHome.captions"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        stored = defaults.object(forKey: Self.key) as? Bool
    }

    static var readerLocale: String { Bundle.main.preferredLocalizations.first ?? "en" }

    func hasCaptions(for postID: String) -> Bool {
        guard let entry = entries[postID] else { return false }
        return !entry.cues.isEmpty && !entry.misfit
    }

    func isOn(_ postID: String, readerLocale: String = BauCaptions.readerLocale) -> Bool {
        guard let entry = entries[postID] else { return false }
        return BauCaptionRules.onByDefault(sourceLang: entry.sourceLang, readerLocale: readerLocale, stored: stored)
    }

    /// The CC button: flips what this video shows and is remembered for the next.
    func toggle(_ postID: String, readerLocale: String = BauCaptions.readerLocale) {
        let next = !isOn(postID, readerLocale: readerLocale)
        stored = next
        defaults.set(next, forKey: Self.key)
    }

    /// The line to draw now, if subtitles are on and fit.
    func text(postID: String, at time: Double) -> String? {
        guard let entry = entries[postID], !entry.misfit, isOn(postID) else { return nil }
        return BauCaptionRules.text(at: time, in: entry.cues)
    }

    /// The length of the file the player actually has: a cut that differs from
    /// what was transcribed shows no subtitles rather than lines at the wrong moment.
    func noteVideoDuration(postID: String, seconds: Double) {
        guard var entry = entries[postID] else { return }
        let misfit = !BauCaptionRules.fits(transcribedMs: entry.transcribedMs, playedSeconds: seconds)
        guard entry.misfit != misfit else { return }
        entry.misfit = misfit
        entries[postID] = entry
    }

    /// Read the tracks once for a post that says it has them. Silent on any
    /// failure: subtitles are an extra, and the video plays without them.
    func prepare(_ post: CommunityHomePost, api: APIClient) async {
        guard let captions = post.captions, !post.locked, post.media?.isVideo == true,
              entries[post.id] == nil, !loading.contains(post.id) else { return }
        loading.insert(post.id)
        defer { loading.remove(post.id) }
        guard let tracks = try? await api.communityHomeCaptions(
            serverId: post.serverId, postId: post.id, lang: Self.readerLocale
        ), let track = BauCaptionRules.pick(tracks, readerLocale: Self.readerLocale)
        else { return }
        let cues = WebVTT.cues(from: track.vtt)
        guard !cues.isEmpty else { return }
        seed(postID: post.id, cues: cues, sourceLang: captions.sourceLang, transcribedMs: captions.durationMs)
    }

    func seed(postID: String, cues: [BauCaptionCue], sourceLang: String, transcribedMs: Int?) {
        entries[postID] = Entry(cues: cues, sourceLang: sourceLang, transcribedMs: transcribedMs)
    }
}
