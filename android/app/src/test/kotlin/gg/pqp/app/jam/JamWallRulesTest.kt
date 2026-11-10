package gg.pqp.app.jam

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a tile says, which filter shows it, where it sits, and what a live frame does to the wall. */
class JamWallRulesTest {

    private val channel = "00000000-0000-4000-8000-0000000000c1"

    private fun song(
        id: String = "s1",
        title: String = "Song",
        joinMode: JamJoinMode = JamJoinMode.Open,
        wanted: List<JamInstrument> = emptyList(),
        instruments: List<JamInstrument> = emptyList(),
        trackCount: Int = instruments.size,
        updatedAt: String = "2026-11-01T10:00:00.000Z",
        createdAt: String = updatedAt,
        authorId: String? = "u1",
        authorName: String? = "rafa",
        contributors: Int = 1,
    ) = JamSongSummary(
        id = id,
        channelId = channel,
        serverId = "srv",
        title = title,
        joinMode = joinMode,
        wantedInstruments = wanted,
        authorId = authorId,
        authorName = authorName,
        createdAt = createdAt,
        updatedAt = updatedAt,
        trackCount = trackCount,
        instruments = instruments,
        contributorCount = contributors,
    )

    // --- what it needs ---

    @Test
    fun `a wanted song says what is missing and ready once it is there`() {
        val missing = song(joinMode = JamJoinMode.Wanted, wanted = listOf(JamInstrument.Vocals, JamInstrument.Bass), instruments = listOf(JamInstrument.Guitar))
        assertEquals(JamNeed.Missing(listOf(JamInstrument.Vocals, JamInstrument.Bass)), JamNeed.of(missing))

        val partly = missing.copy(instruments = listOf(JamInstrument.Bass, JamInstrument.Guitar))
        assertEquals(JamNeed.Missing(listOf(JamInstrument.Vocals)), JamNeed.of(partly))

        val done = missing.copy(instruments = listOf(JamInstrument.Bass, JamInstrument.Guitar, JamInstrument.Vocals))
        assertEquals(JamNeed.Ready, JamNeed.of(done))
    }

    @Test
    fun `open is anyone can join, closed is ready, and no track yet is empty`() {
        assertEquals(JamNeed.Open, JamNeed.of(song(instruments = listOf(JamInstrument.Guitar))))
        assertEquals(JamNeed.Ready, JamNeed.of(song(joinMode = JamJoinMode.Closed, instruments = listOf(JamInstrument.Guitar))))
        assertEquals(JamNeed.Empty, JamNeed.of(song(instruments = emptyList(), trackCount = 0)))
    }

    @Test
    fun `the filters`() {
        val missing = song("a", joinMode = JamJoinMode.Wanted, wanted = listOf(JamInstrument.Vocals), instruments = listOf(JamInstrument.Guitar))
        val open = song("b", instruments = listOf(JamInstrument.Guitar))
        val finished = song("c", joinMode = JamJoinMode.Closed, instruments = listOf(JamInstrument.Guitar))
        val empty = song("d", trackCount = 0)
        val all = listOf(missing, open, finished, empty)

        assertEquals(all, all.filter(JamWallFilter.All::matches))
        // An open song counts as "falta alguém": a person looking for where to play wants it too.
        assertEquals(listOf("a", "b", "d"), all.filter(JamWallFilter.Missing::matches).map { it.id })
        assertEquals(listOf("c"), all.filter(JamWallFilter.Finished::matches).map { it.id })
    }

    // --- who is on it ---

    @Test
    fun `the who line, with and without the detail`() {
        val s = song(authorName = "rafa", contributors = 4)
        assertEquals("rafa +3", JamWho.line(s, null))
        assertEquals("rafa, duda", JamWho.line(s, listOf("rafa", "duda")))
        assertEquals("rafa, duda +2", JamWho.line(s, listOf("rafa", "duda", "leo", "bia")))
        assertEquals("rafa", JamWho.line(song(authorName = "rafa", contributors = 1), null))
        assertEquals("+2", JamWho.line(song(authorName = null, authorId = null, contributors = 2), null))
        assertEquals("", JamWho.line(song(authorName = null, authorId = null, contributors = 0), null))
    }

    @Test
    fun `instruments come out in picker order`() {
        val s = song(instruments = listOf(JamInstrument.Vocals, JamInstrument.Guitar))
        assertEquals(listOf(JamInstrument.Guitar, JamInstrument.Vocals), JamWho.instruments(s))
    }

    // --- the mosaic ---

    @Test
    fun `the first song is the only hero, video and big songs are wide, the rest small`() {
        val plain = song(instruments = listOf(JamInstrument.Guitar))
        assertEquals(JamTileSize.Hero, JamMosaic.desiredSize(0, plain, hasVideo = false))
        assertEquals(JamTileSize.Wide, JamMosaic.desiredSize(1, plain, hasVideo = true))
        assertEquals(JamTileSize.Wide, JamMosaic.desiredSize(2, plain.copy(trackCount = 4), hasVideo = false))
        assertEquals(JamTileSize.Wide, JamMosaic.desiredSize(1, plain.copy(trackCount = 3), hasVideo = false))
        assertEquals(JamTileSize.Small, JamMosaic.desiredSize(2, plain.copy(trackCount = 3), hasVideo = false))
        assertEquals(JamTileSize.Small, JamMosaic.desiredSize(3, plain, hasVideo = false))
        // A song with nothing recorded never takes the hero's place, the first or not.
        val empty = song(trackCount = 0)
        assertEquals(JamTileSize.Small, JamMosaic.desiredSize(0, empty, hasVideo = false))
        assertEquals(JamTileSize.Small, JamMosaic.desiredSize(1, empty, hasVideo = true))
    }

    @Test
    fun `the mosaic never leaves a hole and never overlaps`() {
        val kinds = listOf(JamTileSize.Hero, JamTileSize.Small, JamTileSize.Wide, JamTileSize.Small, JamTileSize.Small, JamTileSize.Wide, JamTileSize.Wide, JamTileSize.Small, JamTileSize.Hero, JamTileSize.Small)
        for (columns in listOf(2, 3)) {
            for (count in 1..kinds.size) {
                val sizes = kinds.take(count)
                val cells = JamMosaic.layout(sizes, columns)
                assertEquals(count, cells.size)
                val taken = HashSet<Pair<Int, Int>>()
                cells.forEach { cell ->
                    for (r in cell.row until cell.row + cell.rows) for (c in cell.column until cell.column + cell.columns) {
                        assertTrue("overlap at $r,$c with $columns columns, $count tiles", taken.add(r to c))
                        assertTrue(c < columns)
                    }
                }
                // No hole: every cell above the last tile's start is covered, except in the final row.
                val lastRowStart = cells.maxOf { it.row }
                for (r in 0 until lastRowStart) for (c in 0 until columns) {
                    assertTrue("hole at $r,$c with $columns columns, $count tiles", (r to c) in taken)
                }
            }
        }
    }

    @Test
    fun `a wide tile steps down when only one cell is left in its row`() {
        val cells = JamMosaic.layout(listOf(JamTileSize.Small, JamTileSize.Wide, JamTileSize.Small), 2)
        // small, then the wide one has one cell left beside it and becomes small, then the third starts a row.
        assertEquals(listOf(1, 1, 1), cells.map { it.columns })
        assertEquals(listOf(0, 0, 1), cells.map { it.row })
    }

    @Test
    fun `bands hold the tiles that start on a row, and a hero's band is two rows tall`() {
        val songs = (0 until 5).map { song("s$it", instruments = listOf(JamInstrument.Guitar)) }
        val bands = JamBands.build(songs, hasVideo = { false })
        assertEquals(2, bands[0].rows)
        assertEquals(1, bands[0].tiles.size)
        // After the hero (rows 0 and 1), the rest start on row 2: two small, then two small.
        assertEquals(listOf(2, 3), bands.drop(1).map { it.row })
        assertEquals(songs.map { it.id }, bands.flatMap { it.tiles }.map { it.song.id })
    }

    @Test
    fun `empty songs do not take the hero from the first song with something on it`() {
        val songs = listOf(song("e1", trackCount = 0), song("e2", trackCount = 0), song("a", instruments = listOf(JamInstrument.Guitar)))
        val bands = JamBands.build(songs, hasVideo = { false })
        assertEquals(listOf(listOf("e1", "e2"), listOf("a")), bands.map { band -> band.tiles.map { it.song.id } })
        assertEquals(2, bands[1].rows)
    }

    // --- the list a wall holds, and a live frame ---

    @Test
    fun `a page replaces, the next page appends without repeating`() {
        val first = JamSongListResponse(listOf(song("a"), song("b")), nextCursor = "c1")
        val state = JamWallState().replace(first)
        assertEquals("c1", state.nextCursor)
        val more = state.append(JamSongListResponse(listOf(song("b"), song("c")), nextCursor = null))
        assertEquals(listOf("a", "b", "c"), more.songs.map { it.id })
        assertNull(more.nextCursor)
    }

    @Test
    fun `a song frame is idempotent, new songs are fresh, and the order follows the bump`() {
        val base = JamWallState().replace(
            JamSongListResponse(
                listOf(song("old", updatedAt = "2026-11-01T10:00:00.000Z"), song("older", updatedAt = "2026-10-01T10:00:00.000Z")),
                null,
            ),
        )
        val created = JamFrame.SongCreated(channel, song("new", updatedAt = "2026-11-02T10:00:00.000Z"))
        val once = base.apply(created, channel)
        assertEquals(listOf("new", "old", "older"), once.songs.map { it.id })
        assertEquals(setOf("new"), once.fresh)
        // The writer's own socket gets it twice.
        assertEquals(once, once.apply(created, channel))

        // A bump moves an existing song to the top without marking it fresh.
        val bumped = once.apply(JamFrame.TrackAdded(channel, song("older", updatedAt = "2026-11-03T10:00:00.000Z"), track("t1", "older")), channel)
        assertEquals(listOf("older", "new", "old"), bumped.songs.map { it.id })
        assertFalse("older" in bumped.fresh)
    }

    @Test
    fun `a frame for another channel is ignored and a deleted song goes`() {
        val base = JamWallState().replace(JamSongListResponse(listOf(song("a")), null))
        val foreign = JamFrame.SongCreated("00000000-0000-4000-8000-0000000000c2", song("x"))
        assertEquals(base, base.apply(foreign, channel))
        val removed = base.apply(JamFrame.SongDeleted(channel, "a"), channel)
        assertTrue(removed.isEmpty)
    }

    @Test
    fun `a vote moves a count the wall does not draw`() {
        val base = JamWallState().replace(JamSongListResponse(listOf(song("a")), null))
        assertEquals(base, base.apply(JamFrame.TrackVotes(channel, "a", "t", 3), channel))
    }

    // --- unread ---

    @Test
    fun `unread is somebody else's song since you last looked`() {
        assertFalse(JamUnread.isUnread(null, null, false))
        assertTrue(JamUnread.isUnread(2_000, null, newestBumpIsMine = false))
        assertFalse(JamUnread.isUnread(2_000, null, newestBumpIsMine = true))
        assertTrue(JamUnread.isUnread(2_000, 1_000, false))
        assertFalse(JamUnread.isUnread(2_000, 2_000, false))
        assertFalse(JamUnread.isUnread(2_000, 1_000, newestBumpIsMine = true))
    }

    @Test
    fun `the row says the count, and a full page says plus`() {
        val page = JamSongListResponse((1..3).map { song("s$it") }, nextCursor = null)
        val row = JamRowSummary.of(page, viewerId = "me", lastSeenMs = null)
        assertEquals("3", row.countText)
        assertTrue(row.isUnread)
        val full = JamRowSummary.of(page.copy(nextCursor = "c"), viewerId = "me", lastSeenMs = Long.MAX_VALUE)
        assertEquals("3+", full.countText)
        assertFalse(full.isUnread)
        // A song only the viewer made, untouched since, is not news.
        val mine = JamSongListResponse(listOf(song("m", authorId = "me")), null)
        assertFalse(JamRowSummary.of(mine, viewerId = "me", lastSeenMs = null).isUnread)
        assertEquals("0", JamRowSummary.of(JamSongListResponse(), "me", null).countText)
    }

    // --- peaks ---

    private fun track(id: String, songId: String, offset: Double = 0.0, trimStart: Double = 0.0, trimEnd: Double = 0.0, duration: Double = 1000.0, peaks: List<Double> = listOf(0.1, 0.9), inMix: Boolean = true) =
        JamTrack(id = id, songId = songId, authorId = "u", offsetMs = offset, trimStartMs = trimStart, trimEndMs = trimEnd, durationMs = duration, peaks = peaks, inMix = inMix)

    @Test
    fun `peaks run across the whole recording, so trims and offsets are applied here`() {
        // 1 s recording, two peak values: first half quiet, second half loud. Head trim 500 ms leaves only the loud half.
        val t = track("t", "s", offset = 2000.0, trimStart = 500.0, peaks = listOf(0.1, 0.9))
        assertEquals(2000.0, t.startMs, 0.0)
        assertEquals(2500.0, t.endMs, 0.0)
        assertEquals(0.9, t.peakAt(2100.0), 1e-9)
        assertEquals(0.0, t.peakAt(1999.0), 0.0)
        assertEquals(0.0, t.peakAt(2500.0), 0.0)
    }

    @Test
    fun `the mix envelope takes the loudest in-mix track at each point and ignores the rest`() {
        val a = track("a", "s", peaks = List(10) { 0.2 })
        val b = track("b", "s", offset = 500.0, peaks = List(10) { 0.8 })
        val out = track("c", "s", peaks = List(10) { 1.0 }, inMix = false)
        val envelope = JamPeaks.mixEnvelope(listOf(a, b, out), bars = 3)
        assertEquals(3, envelope.size)
        assertEquals(0.2, envelope[0], 1e-9)
        assertEquals(0.8, envelope[2], 1e-9)
        assertTrue(JamPeaks.mixEnvelope(emptyList(), 4).all { it == 0.0 })
        assertEquals(emptyList<Double>(), JamPeaks.mixEnvelope(listOf(a), 0))
    }
}
