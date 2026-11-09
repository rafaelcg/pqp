import Foundation

// THE SONG SCREEN'S RULES, PURE: which tracks play, which are heard, how the
// stack is ordered, how a live frame changes it, and where the playhead is on
// the stacked waveforms. A test for each, no engine and no view.

enum JamMixRules {
    /// The tracks that play right now: everything `inMix`, except that a take
    /// the listener is AUDITIONING replaces the in-mix take(s) of its own
    /// instrument. Local to this phone (it is how a person hears a competing
    /// take before voting for it) and it never reaches the server.
    static func activeTracks(_ tracks: [JamTrack], auditioning: [JamInstrument: String]) -> [JamTrack] {
        tracks.filter { track in
            if let chosen = auditioning[track.instrument], tracks.contains(where: { $0.id == chosen }) {
                return track.id == chosen
            }
            return track.inMix
        }
    }

    /// Whether a stem is heard: with any solo on, only the soloed ones; with
    /// none, everything that is not muted. Solo wins over mute, as on a
    /// console: soloing a muted track is asking to hear it.
    static func isAudible(trackId: String, soloed: Set<String>, muted: Set<String>) -> Bool {
        if !soloed.isEmpty { return soloed.contains(trackId) }
        return !muted.contains(trackId)
    }

    /// The stack's rows: in-mix tracks (or the auditioned ones) in picker order
    /// of instrument, oldest first within an instrument.
    static func stack(_ tracks: [JamTrack], auditioning: [JamInstrument: String]) -> [JamTrack] {
        ordered(activeTracks(tracks, auditioning: auditioning))
    }

    /// Takes that are not playing: competing versions waiting for a vote.
    static func otherTakes(_ tracks: [JamTrack], auditioning: [JamInstrument: String]) -> [JamTrack] {
        let active = Set(activeTracks(tracks, auditioning: auditioning).map(\.id))
        return ordered(tracks.filter { !active.contains($0.id) })
    }

    static func ordered(_ tracks: [JamTrack]) -> [JamTrack] {
        tracks.sorted { a, b in
            let ia = JamInstrument.allCases.firstIndex(of: a.instrument) ?? 0
            let ib = JamInstrument.allCases.firstIndex(of: b.instrument) ?? 0
            if ia != ib { return ia < ib }
            if a.createdAt != b.createdAt { return a.createdAt < b.createdAt }
            return a.id < b.id
        }
    }

    /// The timeline of what plays: where it starts and how long it is, from
    /// the tracks' own numbers (the engine's own come from the files, within a
    /// millisecond, once they are loaded).
    static func timeline(of tracks: [JamTrack]) -> (originMs: Double, durationMs: Double) {
        let playable = tracks.filter { $0.playedMs > 0 }
        guard let start = playable.map(\.startMs).min(), let end = playable.map(\.endMs).max() else {
            return (0, 0)
        }
        return (start, max(0, end - start))
    }

    /// A track's slice as fractions of the timeline, for drawing its row.
    static func fractions(of track: JamTrack, originMs: Double, durationMs: Double) -> (start: Double, end: Double) {
        guard durationMs > 0 else { return (0, 0) }
        let start = (track.startMs - originMs) / durationMs
        let end = (track.endMs - originMs) / durationMs
        return (min(1, max(0, start)), min(1, max(0, end)))
    }

    /// The stems the engine should hold, from the playing tracks and the files
    /// they were downloaded to. A track with no file yet is not a stem yet.
    static func stems(_ active: [JamTrack], files: [String: URL]) -> [JamEngine.Stem] {
        active.compactMap { track in
            guard let url = files[track.id] else { return nil }
            return JamEngine.Stem(
                id: track.id, url: url, offsetMs: track.offsetMs,
                trimStartMs: track.trimStartMs, trimEndMs: track.trimEndMs
            )
        }
    }
}

// MARK: - The playhead

enum JamPlayhead {
    /// Position (ms from the origin) for a touch at `x` across a row of `width`.
    static func position(forX x: Double, width: Double, durationMs: Double) -> Double {
        guard width > 0, durationMs > 0 else { return 0 }
        return min(durationMs, max(0, x / width * durationMs))
    }

    /// The reverse: where to draw the line.
    static func x(forPositionMs position: Double, width: Double, durationMs: Double) -> Double {
        guard durationMs > 0 else { return 0 }
        return min(width, max(0, position / durationMs * width))
    }
}

// MARK: - A live frame on an open song

/// The song as the screen holds it, and what the seven frames do to it. Applied
/// by id and idempotent, because a change reaches the writer's own socket too.
struct JamSongState: Equatable, Sendable {
    var song: JamSongSummary
    var tracks: [JamTrack]
    var viewer: JamSongViewer
    /// Track ids that arrived live, for the entrance and the "new" mark.
    var fresh: Set<String> = []
    var wasDeleted = false

    /// What a frame changed that the ENGINE has to follow: a stem that came or
    /// went, or moved in time. A vote, a label or a gain tweak is not a reload.
    enum Effect: Equatable, Sendable {
        case none
        /// The set of stems or where they sit changed: reload the engine.
        case reloadStems
        /// Only a level changed.
        case levels
    }

    @discardableResult
    mutating func apply(_ frame: JamFrame) -> Effect {
        switch frame {
        case .songCreated:
            return .none
        case .songUpdated(_, let updated):
            guard updated.id == song.id else { return .none }
            song = updated
            return .none
        case .songDeleted(_, let songId):
            guard songId == song.id else { return .none }
            wasDeleted = true
            return .none
        case .trackAdded(_, let updated, let track):
            guard updated.id == song.id, track.songId == song.id else { return .none }
            song = updated
            if let i = tracks.firstIndex(where: { $0.id == track.id }) {
                tracks[i] = track
            } else {
                tracks.append(track)
                fresh.insert(track.id)
            }
            return track.inMix ? .reloadStems : .none
        case .trackUpdated(_, let updated, let track):
            guard updated.id == song.id, track.songId == song.id else { return .none }
            song = updated
            guard let i = tracks.firstIndex(where: { $0.id == track.id }) else {
                tracks.append(track)
                fresh.insert(track.id)
                return track.inMix ? .reloadStems : .none
            }
            let before = tracks[i]
            tracks[i] = track
            let moved = before.inMix != track.inMix || before.offsetMs != track.offsetMs
                || before.trimStartMs != track.trimStartMs || before.trimEndMs != track.trimEndMs
            if moved { return .reloadStems }
            return before.gain != track.gain ? .levels : .none
        case .trackDeleted(_, let updated, let trackId):
            guard updated.id == song.id else { return .none }
            song = updated
            guard let i = tracks.firstIndex(where: { $0.id == trackId }) else { return .none }
            let wasInMix = tracks[i].inMix
            tracks.remove(at: i)
            fresh.remove(trackId)
            viewer.votedTrackIds.remove(trackId)
            return wasInMix ? .reloadStems : .none
        case .trackVotes(_, let songId, let trackId, let count):
            guard songId == song.id, let i = tracks.firstIndex(where: { $0.id == trackId }) else { return .none }
            tracks[i].voteCount = count
            return .none
        }
    }

    /// The answer to the viewer's own vote: the count and where they stand.
    mutating func apply(vote: JamVoteResponse) {
        guard vote.songId == song.id, let i = tracks.firstIndex(where: { $0.id == vote.trackId }) else { return }
        tracks[i].voteCount = vote.voteCount
        if vote.voted { viewer.votedTrackIds.insert(vote.trackId) } else { viewer.votedTrackIds.remove(vote.trackId) }
    }
}

// MARK: - Who may do what

enum JamPermissions {
    /// `inMix` is the song's author's or a moderator's alone.
    static func canSetMix(_ viewer: JamSongViewer) -> Bool { viewer.isAuthor || viewer.canModerate }

    /// A track goes away by its author, the song's author or a moderator.
    static func canDeleteTrack(_ track: JamTrack, viewer: JamSongViewer, viewerId: String?) -> Bool {
        viewer.isAuthor || viewer.canModerate || (viewerId != nil && track.authorId == viewerId)
    }

    /// A song goes away by its author or a moderator.
    static func canDeleteSong(_ viewer: JamSongViewer) -> Bool { viewer.isAuthor || viewer.canModerate }

    /// Whether this build says "recording is on the computer" or offers a
    /// record button. Today there is none, so it never records; the seam is
    /// here so the real button replaces the sheet and not a screen.
    static let canRecordHere = false
}
