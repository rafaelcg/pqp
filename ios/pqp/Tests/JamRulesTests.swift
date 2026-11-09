import XCTest
@testable import pqp

/// What a tile says it needs, which filter shows it, where it sits in the
/// mosaic, what a frame does to the wall and to an open song, and who may do
/// what. All pure.
final class JamRulesTests: XCTestCase {
    private func song(
        _ id: String = "s", mode: JamJoinMode = .open, wanted: [JamInstrument] = [],
        instruments: [JamInstrument] = [.guitar], tracks: Int = 1, updated: TimeInterval = 100,
        author: String? = "a1", contributors: Int = 1
    ) -> JamSongSummary {
        JamSongSummary(
            id: id, channelId: "c", serverId: "sv", title: "T \(id)", joinMode: mode,
            wantedInstruments: wanted, authorId: author, authorName: "rafa",
            createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: updated),
            trackCount: tracks, instruments: instruments, contributorCount: contributors
        )
    }

    private func track(
        _ id: String, _ instrument: JamInstrument = .guitar, offset: Double = 0, start: Double = 0,
        end: Double = 0, duration: Double = 1000, inMix: Bool = true, author: String = "a1",
        peaks: [Double] = [], created: TimeInterval = 0, votes: Int = 0, gain: Double = 1
    ) -> JamTrack {
        JamTrack(
            id: id, songId: "s", authorId: author, authorName: "n", instrument: instrument,
            offsetMs: offset, trimStartMs: start, trimEndMs: end, durationMs: duration, gain: gain,
            peaks: peaks, inMix: inMix, voteCount: votes, createdAt: Date(timeIntervalSince1970: created)
        )
    }

    // MARK: What it needs

    func testNeedsReadsTheJoinModeTheWantedListAndWhoIsThere() {
        XCTAssertEqual(JamNeed.of(song(tracks: 0)), .empty)
        XCTAssertEqual(JamNeed.of(song(mode: .open)), .open)
        XCTAssertEqual(JamNeed.of(song(mode: .closed)), .ready)
        XCTAssertEqual(
            JamNeed.of(song(mode: .wanted, wanted: [.vocals, .bass], instruments: [.guitar, .bass])),
            .missing([.vocals])
        )
        XCTAssertEqual(
            JamNeed.of(song(mode: .wanted, wanted: [.vocals], instruments: [.guitar, .vocals])), .ready,
            "what was asked for has arrived"
        )
    }

    func testTheFiltersAreWhatTheChipsSay() {
        let missing = song("m", mode: .wanted, wanted: [.vocals])
        let open = song("o", mode: .open)
        let done = song("d", mode: .closed)
        let empty = song("e", tracks: 0)
        let all = [missing, open, done, empty]
        XCTAssertEqual(all.filter(JamWallFilter.all.matches).count, 4)
        XCTAssertEqual(all.filter(JamWallFilter.missing.matches).map(\.id), ["m", "o", "e"])
        XCTAssertEqual(all.filter(JamWallFilter.finished.matches).map(\.id), ["d"])
    }

    func testTheWhoLineNamesPeopleThenCounts() {
        let s = song(contributors: 5)
        XCTAssertEqual(JamWho.line(song: s, contributors: ["rafa", "duda", "leo"]), "rafa, duda, leo")
        XCTAssertEqual(JamWho.line(song: s, contributors: ["a", "b", "c", "d", "e"]), "a, b +3")
        XCTAssertEqual(JamWho.line(song: s, contributors: nil), "rafa +4", "before the detail is read, the author stands in")
        XCTAssertEqual(JamWho.line(song: song(contributors: 1), contributors: nil), "rafa")
    }

    // MARK: The mosaic

    func testTheMosaicNeverLeavesAHoleBeforeItsLastRow() {
        let sizes: [JamTileSize] = [.hero, .small, .wide, .small, .hero, .wide, .small, .small, .small, .wide]
        for columns in [2, 4] {
            let placements = JamMosaic.layout(sizes: sizes, columns: columns)
            XCTAssertEqual(placements.count, sizes.count)
            var occupied = Set<[Int]>()
            for p in placements {
                for r in p.row..<(p.row + p.rows) {
                    for c in p.column..<(p.column + p.columns) {
                        XCTAssertTrue(occupied.insert([r, c]).inserted, "overlap at \(r),\(c) with \(columns) columns")
                        XCTAssertLessThan(c, columns)
                    }
                }
            }
            let rows = JamMosaic.rowCount(placements)
            for r in 0..<max(0, rows - 1) {
                for c in 0..<columns {
                    XCTAssertTrue(occupied.contains([r, c]), "hole at \(r),\(c) with \(columns) columns")
                }
            }
        }
    }

    func testTheFirstSongIsTheHeroAndAWideTileStepsDownBesideAnother() {
        XCTAssertEqual(JamMosaic.desiredSize(index: 0, song: song(), hasVideo: false), .hero)
        let placements = JamMosaic.layout(sizes: [.small, .wide, .small], columns: 2)
        // The wide one does not fit beside the first small tile, so it is
        // placed as a small one and the row is completed.
        XCTAssertEqual(placements[1].columns, 1)
        XCTAssertEqual(placements[1].row, 0)
    }

    func testOnlyTheFirstTileIsEverTheHero() {
        for index in 1..<12 {
            XCTAssertNotEqual(JamMosaic.desiredSize(index: index, song: song(tracks: 6), hasVideo: true), .hero)
        }
    }

    // MARK: The wall under live frames

    func testAFrameUpsertsByIdAndTheBumpMovesTheTileToTheFront() {
        var state = JamWallState(songs: [song("a", updated: 50), song("b", updated: 10)])
        XCTAssertTrue(state.apply(.songUpdated(channelId: "c", song: song("b", updated: 99)), channelId: "c"))
        XCTAssertEqual(state.songs.map(\.id), ["b", "a"])
        // The same frame again changes nothing: the writer hears its own write.
        let before = state
        state.apply(.songUpdated(channelId: "c", song: song("b", updated: 99)), channelId: "c")
        XCTAssertEqual(state, before)
    }

    func testASongThatArrivesLiveIsFreshAndADeletedOneIsGone() {
        var state = JamWallState(songs: [song("a", updated: 50)])
        state.apply(.songCreated(channelId: "c", song: song("n", updated: 60)), channelId: "c")
        XCTAssertEqual(state.songs.first?.id, "n")
        XCTAssertTrue(state.fresh.contains("n"))
        state.apply(.songDeleted(channelId: "c", songId: "a"), channelId: "c")
        XCTAssertEqual(state.songs.map(\.id), ["n"])
    }

    func testAFrameForAnotherChannelAndAVoteDoNotTouchTheWall() {
        var state = JamWallState(songs: [song("a")])
        XCTAssertFalse(state.apply(.songDeleted(channelId: "other", songId: "a"), channelId: "c"))
        XCTAssertFalse(state.apply(.trackVotes(channelId: "c", songId: "a", trackId: "t", voteCount: 3), channelId: "c"))
        XCTAssertEqual(state.songs.count, 1)
    }

    func testPagesAppendWithoutDuplicates() {
        var state = JamWallState()
        state.replace(with: JamSongListResponse(songs: [song("a"), song("b")], nextCursor: "n"))
        state.append(page: JamSongListResponse(songs: [song("b"), song("c")], nextCursor: nil))
        XCTAssertEqual(state.songs.map(\.id), ["a", "b", "c"])
        XCTAssertNil(state.nextCursor)
    }

    // MARK: Unread

    func testUnreadIsSomebodyElsesBumpSinceYouLooked() {
        let seen = Date(timeIntervalSince1970: 100)
        let newer = Date(timeIntervalSince1970: 200)
        XCTAssertTrue(JamUnread.isUnread(newestBump: newer, lastSeen: seen, newestBumpIsMine: false))
        XCTAssertFalse(JamUnread.isUnread(newestBump: seen, lastSeen: seen, newestBumpIsMine: false))
        XCTAssertFalse(JamUnread.isUnread(newestBump: newer, lastSeen: seen, newestBumpIsMine: true))
        XCTAssertFalse(JamUnread.isUnread(newestBump: nil, lastSeen: nil, newestBumpIsMine: false))
        XCTAssertTrue(JamUnread.isUnread(newestBump: newer, lastSeen: nil, newestBumpIsMine: false), "never opened")
    }

    func testTheSeenStoreRoundTrips() {
        let defaults = UserDefaults(suiteName: "jam-test-\(UUID().uuidString)")!
        let store = JamSeenStore(defaults: defaults)
        XCTAssertNil(store.lastSeen(channelId: "c"))
        store.markSeen(channelId: "c", at: Date(timeIntervalSince1970: 1234))
        XCTAssertEqual(store.lastSeen(channelId: "c"), Date(timeIntervalSince1970: 1234))
    }

    func testTheRowCountIsHonestAboutAFullPage() {
        XCTAssertEqual(JamRowSummary(songCount: 6, hasMore: false, isUnread: false).countText, "6")
        XCTAssertEqual(JamRowSummary(songCount: 50, hasMore: true, isUnread: false).countText, "50+")
    }

    // MARK: Peaks

    func testThePeakAtASongTimeFollowsOffsetAndTrims() {
        // 1000 ms recording, ten peaks (100 ms each), first 200 ms trimmed,
        // starting at song time 500: song time 500 is file time 200 (peak 2).
        let t = track("t", offset: 500, start: 200, end: 0, duration: 1000,
                      peaks: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9])
        XCTAssertEqual(t.peak(atSongTimeMs: 500), 0.2, accuracy: 1e-9)
        XCTAssertEqual(t.peak(atSongTimeMs: 499), 0, "before the played slice")
        XCTAssertEqual(t.peak(atSongTimeMs: 1300), 0, "after it (800 ms played)")
        XCTAssertEqual(t.peak(atSongTimeMs: 1299), 0.9, accuracy: 1e-9)
    }

    func testTheMixEnvelopeTakesTheLouderStemAndIgnoresOutOfMixTakes() {
        let loud = track("a", duration: 1000, peaks: Array(repeating: 0.9, count: 10))
        let quiet = track("b", duration: 1000, peaks: Array(repeating: 0.2, count: 10))
        let out = track("c", duration: 1000, inMix: false, peaks: Array(repeating: 1, count: 10))
        let env = JamPeaks.mixEnvelope(tracks: [loud, quiet, out], bars: 8)
        XCTAssertEqual(env.count, 8)
        XCTAssertTrue(env.allSatisfy { abs($0 - 0.9) < 1e-9 })
        XCTAssertEqual(JamPeaks.mixEnvelope(tracks: [], bars: 4), [0, 0, 0, 0])
    }

    // MARK: The song screen

    func testAnAuditionedTakeReplacesTheInMixTakeOfItsInstrumentOnly() {
        let bass1 = track("b1", .bass)
        let bass2 = track("b2", .bass, inMix: false)
        let guitar = track("g", .guitar)
        let all = [bass1, bass2, guitar]
        XCTAssertEqual(JamMixRules.activeTracks(all, auditioning: [:]).map(\.id), ["b1", "g"])
        XCTAssertEqual(JamMixRules.activeTracks(all, auditioning: [.bass: "b2"]).map(\.id), ["b2", "g"])
        XCTAssertEqual(JamMixRules.otherTakes(all, auditioning: [.bass: "b2"]).map(\.id), ["b1"])
        XCTAssertEqual(
            JamMixRules.activeTracks(all, auditioning: [.bass: "gone"]).map(\.id), ["b1", "g"],
            "an auditioned take that left is not an audition"
        )
    }

    func testSoloWinsOverMuteAndAnySoloSilencesTheRest() {
        XCTAssertTrue(JamMixRules.isAudible(trackId: "a", soloed: [], muted: []))
        XCTAssertFalse(JamMixRules.isAudible(trackId: "a", soloed: [], muted: ["a"]))
        XCTAssertTrue(JamMixRules.isAudible(trackId: "a", soloed: ["a"], muted: ["a"]))
        XCTAssertFalse(JamMixRules.isAudible(trackId: "b", soloed: ["a"], muted: []))
    }

    func testTheStackIsInPickerOrderThenOldestFirst() {
        let ordered = JamMixRules.stack([
            track("d", .drums, created: 1), track("g2", .guitar, created: 5),
            track("g1", .guitar, created: 2), track("v", .vocals, created: 0),
        ], auditioning: [:])
        XCTAssertEqual(ordered.map(\.id), ["g1", "g2", "d", "v"])
    }

    func testTheTimelineStartsAtTheEarliestStemAndEndsAtTheLatestEnd() {
        let early = track("a", offset: -500, duration: 10_000)           // -500 ... 9500
        let late = track("b", offset: 40, start: 120, end: 200, duration: 10_000) // 40 ... 9720
        let tl = JamMixRules.timeline(of: [early, late])
        XCTAssertEqual(tl.originMs, -500)
        XCTAssertEqual(tl.durationMs, 10_220)
        let f = JamMixRules.fractions(of: late, originMs: tl.originMs, durationMs: tl.durationMs)
        XCTAssertEqual(f.start, 540 / 10_220, accuracy: 1e-9)
        XCTAssertEqual(f.end, 1, accuracy: 1e-9)
    }

    func testPlayheadMapsBothWaysAndClamps() {
        XCTAssertEqual(JamPlayhead.position(forX: 50, width: 200, durationMs: 8000), 2000)
        XCTAssertEqual(JamPlayhead.position(forX: -5, width: 200, durationMs: 8000), 0)
        XCTAssertEqual(JamPlayhead.position(forX: 900, width: 200, durationMs: 8000), 8000)
        XCTAssertEqual(JamPlayhead.x(forPositionMs: 2000, width: 200, durationMs: 8000), 50)
        XCTAssertEqual(JamPlayhead.x(forPositionMs: 1, width: 200, durationMs: 0), 0)
    }

    // MARK: A frame on an open song

    private func openSong() -> JamSongState {
        JamSongState(
            song: song("s"), tracks: [track("t1", .guitar), track("t2", .bass, inMix: false)],
            viewer: JamSongViewer(isAuthor: true, canModerate: false, addableInstruments: [], votedTrackIds: ["t2"])
        )
    }

    func testATrackAddedLiveIsFreshAndReloadsTheEngineOnlyWhenItIsInTheMix() {
        var state = openSong()
        XCTAssertEqual(state.apply(.trackAdded(channelId: "c", song: song("s"), track: track("t3", .drums))), .reloadStems)
        XCTAssertTrue(state.fresh.contains("t3"))
        XCTAssertEqual(
            state.apply(.trackAdded(channelId: "c", song: song("s"), track: track("t4", .drums, inMix: false))), .none
        )
        // Idempotent by id: the writer's own socket delivers it again.
        XCTAssertEqual(state.apply(.trackAdded(channelId: "c", song: song("s"), track: track("t3", .drums))), .reloadStems)
        XCTAssertEqual(state.tracks.filter { $0.id == "t3" }.count, 1)
    }

    func testATrackUpdateSaysWhatTheEngineMustFollow() {
        var state = openSong()
        XCTAssertEqual(state.apply(.trackUpdated(channelId: "c", song: song("s"), track: track("t1", .guitar, offset: 20))), .reloadStems)
        XCTAssertEqual(state.apply(.trackUpdated(channelId: "c", song: song("s"), track: track("t1", .guitar, offset: 20, gain: 1.4))), .levels)
        XCTAssertEqual(state.apply(.trackUpdated(channelId: "c", song: song("s"), track: track("t2", .bass, inMix: true))), .reloadStems)
        XCTAssertEqual(state.apply(.trackUpdated(channelId: "c", song: song("s"), track: track("t1", .guitar, offset: 20, gain: 1.4))), .none)
    }

    func testAVoteFrameMovesTheCountAndNeverTheViewersOwnVote() {
        var state = openSong()
        XCTAssertEqual(state.apply(.trackVotes(channelId: "c", songId: "s", trackId: "t1", voteCount: 4)), .none)
        XCTAssertEqual(state.tracks[0].voteCount, 4)
        XCTAssertEqual(state.viewer.votedTrackIds, ["t2"], "no frame names a voter")
        state.apply(vote: JamVoteResponse(trackId: "t1", songId: "s", voteCount: 5, voted: true))
        XCTAssertEqual(state.viewer.votedTrackIds, ["t1", "t2"])
        state.apply(vote: JamVoteResponse(trackId: "t2", songId: "s", voteCount: 0, voted: false))
        XCTAssertEqual(state.viewer.votedTrackIds, ["t1"])
    }

    func testADeletedTrackLeavesTheStateAndTheViewersVote() {
        var state = openSong()
        XCTAssertEqual(state.apply(.trackDeleted(channelId: "c", song: song("s"), trackId: "t2")), .none, "it was not in the mix")
        XCTAssertEqual(state.tracks.map(\.id), ["t1"])
        XCTAssertTrue(state.viewer.votedTrackIds.isEmpty)
        XCTAssertEqual(state.apply(.trackDeleted(channelId: "c", song: song("s"), trackId: "t1")), .reloadStems)
    }

    func testDeletingAnAuditionedTakeReloadsTheStemsEvenThoughItWasNeverInTheMix() {
        var state = openSong()
        XCTAssertEqual(
            state.apply(.trackDeleted(channelId: "c", song: song("s"), trackId: "t2"), auditioned: ["t2"]),
            .reloadStems
        )
    }

    func testADeletedSongIsFlaggedAndAFrameForAnotherSongIsIgnored() {
        var state = openSong()
        state.apply(.songDeleted(channelId: "c", songId: "other"))
        XCTAssertFalse(state.wasDeleted)
        state.apply(.songDeleted(channelId: "c", songId: "s"))
        XCTAssertTrue(state.wasDeleted)
    }

    // MARK: Who may do what

    func testPermissionsFollowTheContract() {
        let author = JamSongViewer(isAuthor: true, canModerate: false, addableInstruments: [], votedTrackIds: [])
        let mod = JamSongViewer(isAuthor: false, canModerate: true, addableInstruments: [], votedTrackIds: [])
        let other = JamSongViewer.none
        XCTAssertTrue(JamPermissions.canSetMix(author))
        XCTAssertTrue(JamPermissions.canSetMix(mod))
        XCTAssertFalse(JamPermissions.canSetMix(other))
        let mine = track("t", author: "me")
        let theirs = track("t", author: "them")
        XCTAssertTrue(JamPermissions.canDeleteTrack(mine, viewer: other, viewerId: "me"))
        XCTAssertFalse(JamPermissions.canDeleteTrack(theirs, viewer: other, viewerId: "me"))
        XCTAssertTrue(JamPermissions.canDeleteTrack(theirs, viewer: mod, viewerId: "me"))
        XCTAssertTrue(JamPermissions.canDeleteSong(author))
        XCTAssertFalse(JamPermissions.canDeleteSong(other))
        XCTAssertFalse(JamPermissions.canRecordHere, "recording is on the computer for now")
    }

    func testTheAudioPolicyNeverTakesTheSessionUnderACall() {
        // The same interlock the watch party, the Bau's video and the voice
        // notes use: a call, or a recording category, is left alone.
        XCTAssertEqual(BauPlaybackPolicy.audioPlan(callActive: true, category: .ambient), .leaveSessionAlone)
        XCTAssertEqual(BauPlaybackPolicy.audioPlan(callActive: false, category: .playAndRecord), .leaveSessionAlone)
        XCTAssertEqual(BauPlaybackPolicy.audioPlan(callActive: false, category: .playback), .takePlayback)
    }
}
