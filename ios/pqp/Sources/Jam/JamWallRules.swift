import Foundation

// THE WALL'S RULES, PURE. What a tile says it needs, which filter shows it,
// where it sits in the mosaic, what a live frame does to the list, and what
// "unread" means for a channel that carries no messages. None of it touches
// the network or a view, so each is a test.

// MARK: - What a song needs

/// The one line a tile carries about the song's state. The wire gives a join
/// mode, a wanted list and the instruments present; this is what a person
/// reads off them ("falta voz", "qualquer um entra", "pronta").
enum JamNeed: Equatable, Sendable {
    /// The author is looking for these, and nobody has played them yet.
    case missing([JamInstrument])
    /// Anybody may add any instrument.
    case open
    /// Nothing more is being asked for.
    case ready
    /// No track yet.
    case empty

    static func of(_ song: JamSongSummary) -> JamNeed {
        if song.trackCount == 0 { return .empty }
        switch song.joinMode {
        case .open:
            return .open
        case .closed:
            return .ready
        case .wanted:
            let present = Set(song.instruments)
            let missing = song.wantedInstruments.filter { !present.contains($0) }
            return missing.isEmpty ? .ready : .missing(missing)
        }
    }

    /// Whether somebody could still step in: the "Falta alguem" filter. An open
    /// song counts, because a person browsing for where to play wants it too.
    var wantsSomeone: Bool {
        switch self {
        case .missing, .open, .empty: true
        case .ready: false
        }
    }
}

enum JamWallFilter: String, CaseIterable, Identifiable, Sendable {
    case all
    case missing
    case finished

    var id: String { rawValue }

    func matches(_ song: JamSongSummary) -> Bool {
        switch self {
        case .all: true
        case .missing: JamNeed.of(song).wantsSomeone
        case .finished: JamNeed.of(song) == .ready
        }
    }
}

// MARK: - Who is on it

enum JamWho {
    /// "rafa, duda, leo" or "rafa, duda +2". `contributors` is the list of
    /// people with a track when the detail has been read; before that the
    /// author stands in for the rest, with the count the summary carries.
    static func line(song: JamSongSummary, contributors: [String]?, maxNames: Int = 3) -> String {
        let names = (contributors ?? []).filter { !$0.isEmpty }
        if names.isEmpty {
            let author = song.authorName ?? ""
            let rest = max(0, song.contributorCount - (song.authorName == nil ? 0 : 1))
            if author.isEmpty { return rest > 0 ? "+\(rest)" : "" }
            return rest > 0 ? "\(author) +\(rest)" : author
        }
        if names.count <= maxNames { return names.joined(separator: ", ") }
        let shown = names.prefix(maxNames - 1)
        return shown.joined(separator: ", ") + " +\(names.count - shown.count)"
    }

    /// One instrument per person is the common case: "so baixo", "voz e violao"
    /// reads off the instrument list. Returns the instruments in picker order.
    static func instruments(of song: JamSongSummary) -> [JamInstrument] {
        JamInstrument.allCases.filter { song.instruments.contains($0) }
    }
}

// MARK: - The mosaic

/// One tile's cell: a column, a row and a span, on a grid `columns` wide.
struct JamPlacement: Equatable, Sendable {
    let index: Int
    let column: Int
    let row: Int
    let columns: Int
    let rows: Int
}

enum JamTileSize: Equatable, Sendable {
    case small  // 1 x 1
    case wide   // 2 x 1
    case hero   // 2 x 2

    var columns: Int { self == .small ? 1 : 2 }
    var rows: Int { self == .hero ? 2 : 1 }
}

enum JamMosaic {
    /// What a song would like to be, before the grid says what fits: the first
    /// (the newest or most active, the list is sorted that way) is the only
    /// hero; a song with video or four or more tracks wants a wide tile; a
    /// three-track one is wide on alternate places; everything else is a small
    /// one. The mix of sizes keeps a column of identical squares from reading
    /// as a settings list, and the grid steps a wide tile down when only one
    /// cell is left in its row.
    static func desiredSize(index: Int, song: JamSongSummary, hasVideo: Bool) -> JamTileSize {
        if index == 0 { return .hero }
        if hasVideo || song.trackCount >= 4 { return .wide }
        if song.trackCount >= 3 && index % 2 == 1 { return .wide }
        return .small
    }

    /// Dense first-fit. Every tile goes in the first free cell in reading
    /// order, at the largest size up to what it wants that fits there, so a
    /// hole is never left behind a tile that was placed later: 1 x 1 always
    /// fits, and the first free cell is always where the next tile goes.
    static func layout(sizes: [JamTileSize], columns: Int) -> [JamPlacement] {
        let columns = max(1, columns)
        var occupied: [[Bool]] = []

        func free(_ row: Int, _ column: Int) -> Bool {
            row >= occupied.count || !occupied[row][column]
        }
        func fits(_ row: Int, _ column: Int, _ w: Int, _ h: Int) -> Bool {
            guard column + w <= columns else { return false }
            for r in row..<(row + h) {
                for c in column..<(column + w) where !free(r, c) { return false }
            }
            return true
        }
        func occupy(_ row: Int, _ column: Int, _ w: Int, _ h: Int) {
            while occupied.count < row + h { occupied.append(Array(repeating: false, count: columns)) }
            for r in row..<(row + h) {
                for c in column..<(column + w) { occupied[r][c] = true }
            }
        }

        var placements: [JamPlacement] = []
        var cursorRow = 0
        for (index, size) in sizes.enumerated() {
            // The first free cell in reading order.
            var row = cursorRow
            var column = 0
            search: while true {
                for c in 0..<columns where free(row, c) {
                    column = c
                    break search
                }
                row += 1
            }
            cursorRow = row
            var w = min(size.columns, columns)
            var h = size.rows
            // Step down until it fits where it is: hero, then wide, then small.
            while !fits(row, column, w, h) {
                if h > 1 { h = 1; w = min(2, columns) } else if w > 1 { w = 1 } else { break }
            }
            occupy(row, column, w, h)
            placements.append(JamPlacement(index: index, column: column, row: row, columns: w, rows: h))
        }
        return placements
    }

    /// The height of the grid in rows.
    static func rowCount(_ placements: [JamPlacement]) -> Int {
        placements.map { $0.row + $0.rows }.max() ?? 0
    }
}

// MARK: - The list a wall holds

/// The wall's songs, kept in the order the server sorts them (activity: the
/// newest bump first), and what a live frame does to them. Applying a frame is
/// idempotent by id, because a change reaches the writer's own socket too.
struct JamWallState: Equatable, Sendable {
    private(set) var songs: [JamSongSummary] = []
    /// Ids that arrived after the first page (live), so the tile can say "novo"
    /// once and animate in.
    private(set) var fresh: Set<String> = []
    private(set) var nextCursor: String?

    init(songs: [JamSongSummary] = [], nextCursor: String? = nil) {
        self.songs = songs
        self.nextCursor = nextCursor
    }

    var isEmpty: Bool { songs.isEmpty }

    mutating func replace(with page: JamSongListResponse) {
        songs = page.songs
        nextCursor = page.nextCursor
        fresh = []
    }

    mutating func append(page: JamSongListResponse) {
        let known = Set(songs.map(\.id))
        songs.append(contentsOf: page.songs.filter { !known.contains($0.id) })
        nextCursor = page.nextCursor
    }

    mutating func clearFresh(_ id: String) { fresh.remove(id) }

    /// Insert or replace one song, then put it where its bump says. A song the
    /// list did not hold is `fresh`.
    mutating func upsert(_ song: JamSongSummary, markFresh: Bool = true) {
        if let index = songs.firstIndex(where: { $0.id == song.id }) {
            songs[index] = song
        } else {
            songs.append(song)
            if markFresh { fresh.insert(song.id) }
        }
        songs.sort { a, b in
            if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt }
            return a.id < b.id
        }
    }

    mutating func remove(songId: String) {
        songs.removeAll { $0.id == songId }
        fresh.remove(songId)
    }

    /// One frame. Returns whether the list changed, so a caller can tell a
    /// frame for another channel from one it used.
    @discardableResult
    mutating func apply(_ frame: JamFrame, channelId: String) -> Bool {
        guard frame.channelId == channelId else { return false }
        switch frame {
        case .songCreated(_, let song), .songUpdated(_, let song),
             .trackAdded(_, let song, _), .trackUpdated(_, let song, _),
             .trackDeleted(_, let song, _):
            upsert(song)
        case .songDeleted(_, let songId):
            remove(songId: songId)
        case .trackVotes:
            // A vote moves a count the wall does not draw.
            return false
        }
        return true
    }
}

// MARK: - Unread, for a channel with no messages

/// A jam channel carries no messages, so the sidebar's ordinary unread cursor
/// does not exist for it. What a person means by "something new in there" is a
/// song, or a track on one, that somebody ELSE made since they last looked. The
/// server has no per-person cursor for that yet (docs/JAM.md lists the sidebar
/// dot as not built), so this keeps one on the device: the newest bump seen
/// when the wall was last opened.
enum JamUnread {
    static func isUnread(newestBump: Date?, lastSeen: Date?, newestBumpIsMine: Bool) -> Bool {
        guard let newestBump else { return false }
        guard let lastSeen else {
            // Never opened: new to this person, unless it is only theirs.
            return !newestBumpIsMine
        }
        return newestBump > lastSeen && !newestBumpIsMine
    }
}

/// The newest bump this device saw per jam channel. Plain UserDefaults, a
/// per-device convenience: losing it costs one dot.
struct JamSeenStore {
    private let defaults: UserDefaults
    private let prefix = "pqp.jam.seen."

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func lastSeen(channelId: String) -> Date? {
        let value = defaults.double(forKey: prefix + channelId)
        return value > 0 ? Date(timeIntervalSince1970: value) : nil
    }

    func markSeen(channelId: String, at date: Date) {
        defaults.set(date.timeIntervalSince1970, forKey: prefix + channelId)
    }
}

/// What the channel row shows: the song count and whether there is news.
struct JamRowSummary: Equatable, Sendable {
    /// Songs on the first page. A full page reads "50+", because the list has
    /// no total and a made-up one would be a lie.
    let songCount: Int
    let hasMore: Bool
    let isUnread: Bool

    var countText: String { hasMore ? "\(songCount)+" : "\(songCount)" }
}

// MARK: - Peaks

enum JamPeaks {
    /// `bars` values in 0...1 across the SONG's mix, for a tile's waveform.
    /// Each in-mix track contributes its own envelope where it plays (peaks
    /// cover the whole recording, trims and offset are applied here), and the
    /// louder one wins, so a song reads as the loudest thing anyone does.
    static func mixEnvelope(tracks: [JamTrack], bars: Int) -> [Double] {
        let active = tracks.filter { $0.inMix && !$0.peaks.isEmpty && $0.playedMs > 0 }
        guard bars > 0 else { return [] }
        guard !active.isEmpty else { return Array(repeating: 0, count: bars) }
        let start = active.map(\.startMs).min() ?? 0
        let end = active.map(\.endMs).max() ?? start
        let span = max(1, end - start)
        return (0..<bars).map { i in
            let t = start + (Double(i) + 0.5) / Double(bars) * span
            return active.reduce(0.0) { loudest, track in
                max(loudest, track.peak(atSongTimeMs: t))
            }
        }
    }

    /// `bars` values across one track's PLAYED slice, for its own row.
    static func trackBars(_ track: JamTrack, bars: Int) -> [Double] {
        guard bars > 0 else { return [] }
        return (0..<bars).map { i in
            let t = track.startMs + (Double(i) + 0.5) / Double(bars) * track.playedMs
            return track.peak(atSongTimeMs: t)
        }
    }
}

extension JamTrack {
    /// The envelope at a song time, 0 outside the played slice. `peaks` run
    /// across the whole stored recording, so the position in them is the file
    /// time: `t - offset + trimStart`.
    func peak(atSongTimeMs t: Double) -> Double {
        guard !peaks.isEmpty, durationMs > 0, t >= startMs, t < endMs else { return 0 }
        let fileMs = t - offsetMs + trimStartMs
        let position = fileMs / durationMs * Double(peaks.count)
        let index = min(peaks.count - 1, max(0, Int(position)))
        return min(1, max(0, peaks[index]))
    }
}
