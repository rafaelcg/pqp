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
