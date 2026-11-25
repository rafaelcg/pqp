import Foundation

// EDITING A SONG, PURE. Who may, what the text has to be, what a save sends and
// what each refusal says. The web's `jam-cover.ts`, `jam-text.ts` and the edit
// sheet's rules, restated (`client/src/lib/jam-cover.ts`), against the contract
// in `packages/shared/src/jam.ts`. Nothing here touches the network or a view,
// so each rule has a test.

extension JamPermissions {
    /// The server's own rule for `PATCH /api/jam-songs/:id` and the cover
    /// routes: the song's author or a moderator, and the runtime flag on for the
    /// server (`GET /api/jam/config`). The server decides again on every write.
    static func canEditSong(_ viewer: JamSongViewer, enabled: Bool) -> Bool {
        enabled && (viewer.isAuthor || viewer.canModerate)
    }

    /// `label`, `offsetMs`, the trims and `gain` are the TRACK's author's alone
    /// (the song's author and moderators leave somebody else's take out of the
    /// mix or delete it, they do not nudge it), and the flag has to be on.
    static func canAdjustTrack(_ track: JamTrack, viewerId: String?, enabled: Bool) -> Bool {
        enabled && viewerId != nil && track.authorId == viewerId
    }
}

// MARK: - Text

/// A song's title and artist as the server will store them: `jamTitleSchema`
/// and `jamArtistSchema` in `jam.ts`. Asking the same questions here means Save
/// is never offered for text the server refuses.
enum JamText {
    enum Problem: Error, Equatable, Sendable {
        /// Nothing typed, or only spaces.
        case empty
        /// Something typed that draws nothing (zero-width spaces and the like).
        case invisible
        /// Past the limit.
        case long
    }

    static let titleMax = 100
    static let artistMax = 100

    /// Bidi override, embedding and isolate controls are STRIPPED, whitespace
    /// collapsed, the ends trimmed (`cleanLine`).
    static func cleanLine(_ text: String) -> String {
        let stripped = JamBidi.clean(text)
        return stripped.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    private static func isSpace(_ scalar: Unicode.Scalar) -> Bool {
        scalar.properties.isWhitespace || scalar.properties.generalCategory == .spaceSeparator
    }

    /// The control characters the schema refuses (`CONTROL_CHARS`).
    private static func hasControl(_ text: String) -> Bool {
        text.unicodeScalars.contains { scalar in
            switch scalar.value {
            case 0x00...0x08, 0x0B, 0x0C, 0x0E...0x1F, 0x7F: true
            default: false
            }
        }
    }

    /// What draws nothing: whitespace, format characters, combining marks and
    /// variation selectors on their own, the fillers Unicode files as letters
    /// and the Braille blank (`INVISIBLE`). One visible character anywhere is
    /// enough, so emoji sequences, Arabic and Hebrew and tone marks pass.
    static func hasVisibleText(_ text: String) -> Bool {
        text.unicodeScalars.contains { scalar in
            if isSpace(scalar) { return false }
            switch scalar.properties.generalCategory {
            case .control, .format, .spaceSeparator, .lineSeparator, .paragraphSeparator,
                 .nonspacingMark, .spacingMark, .enclosingMark:
                return false
            default: break
            }
            switch scalar.value {
            case 0x034F, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x2800, 0x3164, 0xFFA0: return false
            case 0xFE00...0xFE0F, 0xE0100...0xE01EF: return false
            default: return true
            }
        }
    }

    /// The title as the server will store it, or why it will not be.
    static func title(_ value: String) -> Result<String, Problem> {
        let line = cleanLine(value)
        if line.isEmpty { return .failure(.empty) }
        if line.utf16.count > titleMax { return .failure(.long) }
        if hasControl(line) || !hasVisibleText(line) { return .failure(.invisible) }
        return .success(line)
    }

    /// The artist as the server will store it: a string, nil for "none" (an
    /// original), or why it will not be. The field's own `maxLength` cuts the
    /// text at the limit first, and so does this.
    static func artist(_ value: String) -> Result<String?, Problem> {
        var line = cleanLine(value)
        if line.utf16.count > artistMax {
            line = String(decoding: Array(line.utf16.prefix(artistMax)), as: UTF16.self)
        }
        if line.isEmpty { return .success(nil) }
        if hasControl(line) || !hasVisibleText(line) { return .failure(.invisible) }
        return .success(line)
    }
}

// MARK: - The edit, as a request

/// The artist half of a PATCH: a name, or "none".
enum JamArtistChange: Equatable, Sendable {
    case set(String)
    /// `artist: null`, which is how an original is written.
    case clear
}

/// `updateJamSongSchema`: only what changed. Nothing here is encoded when it
/// did not change, so an edit that puts a title back to what it was is not a
/// write and does not bump the song.
struct JamSongPatch: Encodable, Equatable, Sendable {
    var title: String?
    var artist: JamArtistChange?

    private enum CodingKeys: String, CodingKey { case title, artist }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(title, forKey: .title)
        switch artist {
        case .set(let name): try c.encode(name, forKey: .artist)
        case .clear: try c.encodeNil(forKey: .artist)
        case nil: break
        }
    }
}

/// What the person did to the cover in the sheet.
enum JamCoverChoice: Equatable, Sendable {
    case keep
    case remove
    /// A picture already uploaded to storage, waiting for Save to claim it.
    case new(uploadId: String)
}

struct JamSongEditDraft: Equatable, Sendable {
    var title: String
    var artist: String
    var cover: JamCoverChoice = .keep
}

struct JamSongEditPlan: Equatable, Sendable {
    enum CoverWrite: Equatable, Sendable {
        case set(uploadId: String)
        case remove
    }

    /// The PATCH, or nil when title and artist are as they were.
    var patch: JamSongPatch?
    var cover: CoverWrite?

    var isEmpty: Bool { patch == nil && cover == nil }

    /// What saving this sheet means (`planJamEdit`). A row from before the
    /// server stripped bidi controls still holds them, so the song's own text is
    /// compared as the server would store it: opening the sheet is not a change.
    /// A cover removed from a song that has none is nothing.
    static func make(song: JamSongSummary, draft: JamSongEditDraft) -> JamSongEditPlan {
        var patch = JamSongPatch()
        if case .success(let title) = JamText.title(draft.title) {
            let was = (try? JamText.title(song.title).get()) ?? song.title
            if title != was { patch.title = title }
        }
        if case .success(let artist) = JamText.artist(draft.artist) {
            let was: String?
            if let stored = song.artist {
                was = (try? JamText.artist(stored).get()) ?? nil
            } else {
                was = nil
            }
            if artist != was { patch.artist = artist.map(JamArtistChange.set) ?? .clear }
        }
        let hasPatch = patch.title != nil || patch.artist != nil
        let cover: CoverWrite?
        switch draft.cover {
        case .new(let uploadId): cover = .set(uploadId: uploadId)
        case .remove: cover = song.cover != nil ? .remove : nil
        case .keep: cover = nil
        }
        return JamSongEditPlan(patch: hasPatch ? patch : nil, cover: cover)
    }
}

// MARK: - The cover picture

/// What a cover may be, from the contract (`JAM_COVER_*`), and the one extra
/// rule the web adds: a side under 400 px is a blur on a big tile.
enum JamCoverRules {
    static let contentTypes = ["image/jpeg", "image/png", "image/webp"]
    static let maxBytes = 4 * 1024 * 1024
    /// The square both clients send.
    static let size = 1024
    static let minSide = 400

    enum Problem: Error, Equatable, Sendable {
        /// Not a picture at all (the picker was asked for images, so this is a
        /// rare one).
        case type
        /// A side under `minSide`.
        case small(width: Int, height: Int)
        /// A picture this phone cannot decode.
        case unreadable
        /// What was encoded came out over the ceiling.
        case tooLarge
        /// The upload itself did not go.
        case failed
    }

    /// Whether a picture of this many pixels is big enough to be a cover.
    static func check(width: Int, height: Int) -> Problem? {
        if width <= 0 || height <= 0 { return .unreadable }
        if min(width, height) < minSide { return .small(width: width, height: height) }
        return nil
    }

    /// The encoded size is checked against the ceiling the server signs: the
    /// ticket request would be refused (413) past it.
    static func fits(byteCount: Int) -> Bool { byteCount > 0 && byteCount <= maxBytes }
}

// MARK: - What a refusal says

/// A failed edit, in the person's terms (`jamErrorKind` and the edit sheet's
/// `save`). The permission 403 carries a sentence and not a token
/// ("You cannot edit this song"), so it is told apart the way the web does:
/// a 403 that is not the flag. The reader of the song is then asked for its
/// permissions again, because they were wrong.
enum JamEditFailure: Equatable, Sendable {
    case denied
    case invalid
    case kind(JamErrorKind)

    static func of(_ error: Error) -> JamEditFailure {
        if let api = error as? APIError, case .server(let status, let message) = api {
            if status == 403 {
                return JamErrorKind.of(token: message, status: status) == .off ? .kind(.off) : .denied
            }
            // The text is checked with the server's own rule before it is sent,
            // so a 400 is a build or a draft that rule did not see.
            if status == 400 { return .invalid }
        }
        return .kind(JamErrorKind.of(error))
    }

    /// True for a refusal that retrying cannot fix, so the screen stops
    /// offering the same write again.
    var isDenied: Bool { self == .denied }
}
