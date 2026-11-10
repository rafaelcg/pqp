package gg.pqp.app.jam

import gg.pqp.app.core.RealtimeState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

private const val channel = "00000000-0000-4000-8000-0000000000c1"

private fun aSong(id: String, updatedAt: String = "2026-11-01T10:00:00.000Z", tracks: Int = 1) = JamSongSummary(
    id = id, channelId = channel, serverId = "srv", title = id, createdAt = updatedAt, updatedAt = updatedAt,
    trackCount = tracks, instruments = List(tracks.coerceAtMost(1)) { JamInstrument.Guitar }, authorId = "u", authorName = "rafa",
)

/**
 * The wall's view model against a fake backend: the first page, the frames that
 * arrive while it is being read, paging, filters, the bounded and cancellable
 * detail reads that feed the tiles, and the channel row's one config read.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class JamWallViewModelTest {

    private class FakeBackend : JamBackend {
        override val viewerId: String? = "me"
        val frameFlow = MutableSharedFlow<JamFrame>(extraBufferCapacity = 16)
        override val frames = frameFlow
        override val connection = MutableStateFlow(RealtimeState.Ready)

        var enabled = true
        var configReads = 0
        val pages = ArrayDeque<JamSongListResponse>()
        val pageGate = ArrayDeque<CompletableDeferred<Unit>>()
        val cursors = mutableListOf<String?>()
        val detailReads = mutableListOf<String>()
        var detailsInFlight = 0
        var maxDetailsInFlight = 0
        val detailGates = HashMap<String, CompletableDeferred<Unit>>()
        val joins = mutableListOf<String>()
        val leaves = mutableListOf<String>()
        var failPages = 0
        val failingChannels = HashSet<String>()

        override suspend fun config(serverId: String): JamConfig {
            configReads += 1
            return JamConfig(enabled = enabled, uploads = true)
        }

        override suspend fun songs(channelId: String, cursor: String?, limit: Int): JamSongListResponse {
            cursors += cursor
            pageGate.removeFirstOrNull()?.await()
            if (channelId in failingChannels) error("boom")
            if (failPages > 0) {
                failPages -= 1
                error("offline")
            }
            return pages.removeFirstOrNull() ?: JamSongListResponse()
        }

        override suspend fun song(songId: String): JamSongDetailResponse {
            detailReads += songId
            detailsInFlight += 1
            maxDetailsInFlight = maxOf(maxDetailsInFlight, detailsInFlight)
            try {
                detailGates[songId]?.await()
                return JamSongDetailResponse(
                    song = JamSongSummary(id = songId, channelId = channel, title = songId, updatedAt = "2026-11-01T10:00:00.000Z"),
                    tracks = listOf(JamTrack(id = "t-$songId", songId = songId, authorId = "u", authorName = "rafa", inMix = true, durationMs = 1000.0, peaks = listOf(0.5, 0.5))),
                )
            } finally {
                detailsInFlight -= 1
            }
        }

        override suspend fun vote(trackId: String, voted: Boolean) = error("not used")
        override suspend fun setInMix(trackId: String, inMix: Boolean) = error("not used")
        override suspend fun deleteTrack(trackId: String) = Unit
        override suspend fun deleteSong(songId: String) = Unit
        override fun join(channelId: String) { joins += channelId }
        override fun leave(channelId: String) { leaves += channelId }
    }

    @Before
    fun setUp() = Dispatchers.setMain(StandardTestDispatcher())

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun model(backend: FakeBackend) = JamWallViewModel(backend, "srv", channel)

    @Test
    fun `start joins the channel, reads the first page and the flag`() = runTest {
        val backend = FakeBackend().apply { pages += JamSongListResponse(listOf(aSong("a"), aSong("b")), "c1") }
        val model = model(backend)
        model.start()
        advanceUntilIdle()
        val state = model.state.value
        assertEquals(listOf(channel), backend.joins)
        assertEquals(JamWallUiState.Phase.Ready, state.phase)
        assertEquals(listOf("a", "b"), state.wall.songs.map { it.id })
        assertTrue(state.config.enabled)
    }

    @Test
    fun `a first read that fails says so, and a failed refresh keeps the wall`() = runTest {
        val backend = FakeBackend().apply { failPages = 1 }
        val model = model(backend)
        model.start()
        advanceUntilIdle()
        assertEquals(JamWallUiState.Phase.Failed, model.state.value.phase)

        backend.pages += JamSongListResponse(listOf(aSong("a")), null)
        model.load()
        advanceUntilIdle()
        assertEquals(JamWallUiState.Phase.Ready, model.state.value.phase)

        backend.failPages = 1
        model.refresh()
        advanceUntilIdle()
        assertEquals(JamWallUiState.Phase.Ready, model.state.value.phase)
        assertEquals(listOf("a"), model.state.value.wall.songs.map { it.id })
        assertFalse(model.state.value.refreshing)
    }

    @Test
    fun `a frame that arrives while the page is being read is applied on top of it`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val backend = FakeBackend().apply {
            pageGate += gate
            pages += JamSongListResponse(listOf(aSong("a")), null)
        }
        val model = model(backend)
        model.start()
        runCurrent()
        // The read is out. A song is created now; the answer was produced before it.
        backend.frameFlow.tryEmit(JamFrame.SongCreated(channel, aSong("late", updatedAt = "2026-11-02T10:00:00.000Z")))
        runCurrent()
        gate.complete(Unit)
        advanceUntilIdle()
        assertEquals(listOf("late", "a"), model.state.value.wall.songs.map { it.id })
        assertTrue("late" in model.state.value.wall.fresh)
    }

    @Test
    fun `live frames update the wall, a deleted song goes, and a reconnect reads again`() = runTest {
        val backend = FakeBackend().apply { pages += JamSongListResponse(listOf(aSong("a")), null) }
        val model = model(backend)
        model.start()
        advanceUntilIdle()
        backend.frameFlow.tryEmit(JamFrame.SongCreated(channel, aSong("b", updatedAt = "2026-11-02T10:00:00.000Z")))
        advanceUntilIdle()
        assertEquals(listOf("b", "a"), model.state.value.wall.songs.map { it.id })
        backend.frameFlow.tryEmit(JamFrame.SongDeleted(channel, "a"))
        advanceUntilIdle()
        assertEquals(listOf("b"), model.state.value.wall.songs.map { it.id })

        val before = backend.cursors.size
        backend.pages += JamSongListResponse(listOf(aSong("b"), aSong("c")), null)
        backend.connection.value = RealtimeState.Connecting
        advanceUntilIdle()
        backend.connection.value = RealtimeState.Ready
        advanceUntilIdle()
        assertEquals(before + 1, backend.cursors.size)
        assertEquals(listOf("b", "c"), model.state.value.wall.songs.map { it.id })
    }

    @Test
    fun `paging follows the cursor once, and a refresh overtakes a page in flight`() = runTest {
        val backend = FakeBackend().apply {
            pages += JamSongListResponse(listOf(aSong("a")), "c1")
            pages += JamSongListResponse(listOf(aSong("b")), null)
        }
        val model = model(backend)
        model.start()
        advanceUntilIdle()
        model.loadMore()
        model.loadMore()
        advanceUntilIdle()
        assertEquals(listOf<String?>(null, "c1"), backend.cursors)
        assertEquals(listOf("a", "b"), model.state.value.wall.songs.map { it.id })
        assertNull(model.state.value.wall.nextCursor)

        // A failed page leaves a retry, not the end of the wall.
        val second = FakeBackend().apply { pages += JamSongListResponse(listOf(aSong("a")), "c1") }
        val other = model(second)
        other.start()
        advanceUntilIdle()
        second.failPages = 1
        other.loadMore()
        advanceUntilIdle()
        assertTrue(other.state.value.loadMoreFailed)
        assertEquals("c1", other.state.value.wall.nextCursor)
    }

    @Test
    fun `the filter changes what shows and nothing else`() = runTest {
        val backend = FakeBackend().apply {
            pages += JamSongListResponse(
                listOf(
                    aSong("open"),
                    aSong("closed").copy(joinMode = JamJoinMode.Closed),
                ),
                null,
            )
        }
        val model = model(backend)
        model.start()
        advanceUntilIdle()
        model.setFilter(JamWallFilter.Finished)
        assertEquals(listOf("closed"), model.state.value.visible.map { it.id })
        assertEquals(2, model.state.value.wall.songs.size)
        model.setFilter(JamWallFilter.All)
        assertEquals(2, model.state.value.visible.size)
    }

    @Test
    fun `a filter that a whole page fails keeps asking for pages until something shows or the list ends`() = runTest {
        val backend = FakeBackend().apply {
            pages += JamSongListResponse(listOf(aSong("open1")), "c1")
            pages += JamSongListResponse(listOf(aSong("open2")), "c2")
            pages += JamSongListResponse(listOf(aSong("closed").copy(joinMode = JamJoinMode.Closed)), null)
        }
        val model = model(backend)
        model.start()
        advanceUntilIdle()
        // Page one has nothing finished on it: choosing the filter asks for the next, which has nothing either, and so on.
        model.setFilter(JamWallFilter.Finished)
        advanceUntilIdle()
        assertEquals(listOf<String?>(null, "c1", "c2"), backend.cursors)
        assertEquals(listOf("closed"), model.state.value.visible.map { it.id })
        assertNull(model.state.value.wall.nextCursor)
    }

    @Test
    fun `a refresh while a page is in flight drops that page and its loading, and paging works after it`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val backend = FakeBackend().apply {
            pages += JamSongListResponse(listOf(aSong("a")), "c1")
        }
        val model = model(backend)
        model.start()
        advanceUntilIdle()
        // Page two is out (held), then the person pulls to refresh.
        backend.pageGate += gate
        model.loadMore()
        runCurrent()
        assertTrue(model.state.value.loadingMore)
        backend.pages += JamSongListResponse(listOf(aSong("a2")), "c9")
        model.refresh()
        runCurrent()
        // Not waiting on an answer nobody will use.
        assertFalse(model.state.value.loadingMore)
        gate.complete(Unit)
        advanceUntilIdle()
        // The stale page is not appended to the new wall, and the next page can be asked for.
        assertEquals(listOf("a2"), model.state.value.wall.songs.map { it.id })
        assertEquals("c9", model.state.value.wall.nextCursor)
        backend.pages += JamSongListResponse(listOf(aSong("c")), null)
        model.loadMore()
        advanceUntilIdle()
        assertEquals(listOf("a2", "c"), model.state.value.wall.songs.map { it.id })
    }

    @Test
    fun `the automatic search under a filter nothing passes stops after a few pages and the person decides`() = runTest {
        val backend = FakeBackend().apply {
            repeat(8) { pages += JamSongListResponse(listOf(aSong("open$it")), if (it < 7) "c$it" else null) }
        }
        val model = model(backend)
        model.start()
        advanceUntilIdle()
        model.setFilter(JamWallFilter.Finished)
        advanceUntilIdle()
        // The first page plus AUTO_PAGES more, and then it waits: a channel with nothing under the filter is not read to the end.
        assertEquals(1 + JamWallViewModel.AUTO_PAGES, backend.cursors.size)
        assertTrue(model.state.value.chaseStopped)
        assertTrue(model.state.value.visible.isEmpty())
        assertTrue(model.state.value.wall.nextCursor != null)
        // "Procurar mais": one more round of the same size, and nothing else moves on its own.
        model.loadMore()
        advanceUntilIdle()
        assertEquals(1 + JamWallViewModel.AUTO_PAGES + JamWallViewModel.AUTO_PAGES, backend.cursors.size)
        assertTrue(model.state.value.chaseStopped)
        // Choosing another filter starts over and clears the stop.
        model.setFilter(JamWallFilter.All)
        assertTrue(!model.state.value.chaseStopped)
    }

    @Test
    fun `the preview cache is bounded and drops the oldest`() {
        val previews = (1..JamWallViewModel.PREVIEW_CACHE + 30).associate { "s$it" to JamPreview(0, emptyList(), emptyList(), null, null, false) }
        val kept = JamWallViewModel.boundedPreviews(previews)
        assertEquals(JamWallViewModel.PREVIEW_CACHE, kept.size)
        assertTrue("s1" !in kept)
        assertTrue("s${JamWallViewModel.PREVIEW_CACHE + 30}" in kept)
        val small = previews.entries.take(5).associate { it.toPair() }
        assertEquals(small, JamWallViewModel.boundedPreviews(small))
    }

    @Test
    fun `a config read that throws keeps the row the way it was`() = runTest {
        val backend = FakeBackend()
        val list = JamListModel(object : JamBackend by backend {
            override suspend fun config(serverId: String): JamConfig = error("offline")
        }, seen = { null })
        val before = JamListModel.Rows(JamConfig(enabled = true, uploads = true), mapOf(channel to JamRowSummary(3, false, true)))
        assertEquals(before, list.read("srv", listOf(channel), previous = before))
    }

    @Test
    fun `previews are read at most three at a time, a tile that left the screen is dropped, and a stale one is read again`() = runTest {
        val backend = FakeBackend()
        val songs = (1..8).map { aSong("s$it") }
        songs.forEach { backend.detailGates[it.id] = CompletableDeferred() }
        backend.pages += JamSongListResponse(songs, null)
        val model = model(backend)
        model.start()
        advanceUntilIdle()

        songs.forEach(model::requestPreview)
        runCurrent()
        assertEquals(3, backend.maxDetailsInFlight)
        // Tiles 7 and 8 scrolled away before their turn.
        model.cancelPreview("s7")
        model.cancelPreview("s8")
        backend.detailGates.values.forEach { it.complete(Unit) }
        advanceUntilIdle()
        assertEquals((1..6).map { "s$it" }, backend.detailReads)
        val preview = model.state.value.preview(songs[0])!!
        assertEquals(listOf("rafa"), preview.contributors)
        assertEquals(JamPreview.ENVELOPE_BARS, preview.envelope.size)

        // A second request for a song that has a current preview reads nothing.
        model.requestPreview(songs[0])
        advanceUntilIdle()
        assertEquals(6, backend.detailReads.size)
        // The song was bumped after the preview was read: it is stale and is read again.
        val bumped = songs[0].copy(updatedAt = "2026-11-05T10:00:00.000Z")
        assertNull(model.state.value.preview(bumped))
        assertTrue(model.state.value.anyPreview(bumped) != null)
        backend.detailGates["s1"] = CompletableDeferred<Unit>().also { it.complete(Unit) }
        model.requestPreview(bumped)
        advanceUntilIdle()
        assertEquals(7, backend.detailReads.size)
        // A song with no track has nothing to read.
        model.requestPreview(aSong("empty", tracks = 0))
        advanceUntilIdle()
        assertEquals(7, backend.detailReads.size)
    }

    private fun withPreview(id: String, hasVideo: Boolean) = aSong(id).copy(
        previewPeaks = listOf(0.3, 0.9),
        hasVideo = hasVideo,
        contributors = listOf(JamContributor("u", "rafa", null)),
        missingInstruments = emptyList(),
    )

    @Test
    fun `with the preview on the summaries only a tile with video reads a detail, and an older server still reads them all`() = runTest {
        // A server that sends the preview: five songs, one with video.
        val newer = FakeBackend().apply {
            pages += JamSongListResponse(listOf(withPreview("a", false), withPreview("b", true), withPreview("c", false), withPreview("d", false)), null)
        }
        val model = model(newer)
        model.start()
        advanceUntilIdle()
        model.state.value.wall.songs.forEach(model::requestPreview)
        advanceUntilIdle()
        assertEquals("the poster's URL is the one thing a summary cannot give", listOf("b"), newer.detailReads)
        // The tile's data is on the summary, so it is there with no preview at all.
        val a = model.state.value.wall.songs.first { it.id == "a" }
        assertEquals(listOf(0.3, 0.9), JamTileInfo.envelope(a, model.state.value.anyPreview(a)))

        // An older server: nothing on the summaries, so every tile reads its detail (lazily, three at a time).
        val older = FakeBackend().apply {
            pages += JamSongListResponse(listOf(aSong("a"), aSong("b"), aSong("c"), aSong("d")), null)
        }
        val legacy = model(older)
        legacy.start()
        advanceUntilIdle()
        legacy.state.value.wall.songs.forEach(legacy::requestPreview)
        advanceUntilIdle()
        assertEquals(listOf("a", "b", "c", "d"), older.detailReads)
        val oldA = legacy.state.value.wall.songs.first { it.id == "a" }
        assertEquals(listOf("rafa"), JamTileInfo.contributorNames(oldA, legacy.state.value.anyPreview(oldA)))
    }

    @Test
    fun `a song frame carrying the preview updates the tile with no detail read`() = runTest {
        val backend = FakeBackend().apply { pages += JamSongListResponse(listOf(withPreview("a", false)), null) }
        val model = model(backend)
        model.start()
        advanceUntilIdle()
        val louder = withPreview("a", false).copy(previewPeaks = listOf(1.0), updatedAt = "2026-11-02T10:00:00.000Z")
        backend.frameFlow.tryEmit(JamFrame.TrackAdded(channel, louder, JamTrack(id = "t", songId = "a")))
        advanceUntilIdle()
        val song = model.state.value.wall.songs.single()
        assertEquals(listOf(1.0), JamTileInfo.envelope(song, null))
        model.requestPreview(song)
        advanceUntilIdle()
        assertEquals(emptyList<String>(), backend.detailReads)
    }

    @Test
    fun `the channel row asks nothing for a server with no jam channel, and draws nothing when the flag is off`() = runTest {
        val backend = FakeBackend()
        val list = JamListModel(backend, seen = { null })
        assertEquals(JamListModel.Rows(), list.read("srv", emptyList()))
        assertEquals(0, backend.configReads)
        assertEquals(0, backend.cursors.size)

        backend.enabled = false
        val off = list.read("srv", listOf(channel))
        assertFalse(off.config.enabled)
        assertTrue(off.rows.isEmpty())
        assertEquals(1, backend.configReads)
        assertEquals("no page is read for a flag that is off", 0, backend.cursors.size)
    }

    @Test
    fun `the channel row says the count and the news, and a failed read keeps the last row`() = runTest {
        val backend = FakeBackend().apply {
            pages += JamSongListResponse(listOf(aSong("a"), aSong("b")), null)
        }
        val list = JamListModel(backend, seen = { null })
        val first = list.read("srv", listOf(channel))
        assertEquals("2", first.rows.getValue(channel).countText)
        assertTrue(first.rows.getValue(channel).isUnread)

        backend.failingChannels += channel
        val second = list.read("srv", listOf(channel), previous = first)
        assertEquals(first.rows, second.rows)
    }

    @Test
    fun `stopping gives the channel back`() = runTest {
        val backend = FakeBackend()
        val model = model(backend)
        model.start()
        model.stop()
        assertEquals(listOf(channel), backend.leaves)
    }
}
