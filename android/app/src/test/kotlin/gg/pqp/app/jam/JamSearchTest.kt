package gg.pqp.app.jam

import gg.pqp.app.core.RealtimeState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
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

private fun aSong(id: String, title: String = id) = JamSongSummary(
    id = id, channelId = "c", serverId = "srv", title = title, updatedAt = "2026-11-01T10:00:00.000Z", trackCount = 1,
    instruments = listOf(JamInstrument.Guitar), authorId = "u", authorName = "rafa",
)

/** What the wall asks for and when, from what is typed; the rules are the phones' own (title and artist, two letters, a pause). */
class JamSearchRulesTest {
    @Test
    fun `fewer than two letters is not a search`() {
        assertNull(JamSearchRules.effective(""))
        assertNull(JamSearchRules.effective("a"))
        assertNull(JamSearchRules.effective("  a  "))
        assertEquals("lu", JamSearchRules.effective("lu"))
    }

    @Test
    fun `what is sent is trimmed and its whitespace collapsed, capped at the server's limit`() {
        assertEquals("lua cheia", JamSearchRules.effective("  lua    cheia "))
        assertEquals(JamSearchRules.MAX_CHARS, JamSearchRules.effective("x".repeat(500))!!.length)
    }

    @Test
    fun `bidi controls typed into the field are not sent`() {
        assertEquals("lua", JamSearchRules.effective("‮lua"))
        assertNull(JamSearchRules.effective("‮a"))
    }

    @Test
    fun `one letter says what the field waits for, nothing and spaces do not`() {
        assertTrue(JamSearchRules.needsMore("a"))
        assertFalse(JamSearchRules.needsMore(""))
        assertFalse(JamSearchRules.needsMore("   "))
        assertFalse(JamSearchRules.needsMore("ab"))
    }

    @Test
    fun `accents are the server's business, so the query goes as typed`() {
        assertEquals("música", JamSearchRules.effective("música"))
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class JamWallSearchTest {

    private class Backend : JamBackend {
        override val viewerId: String? = "me"
        override val frames = MutableSharedFlow<JamFrame>(extraBufferCapacity = 16)
        override val connection = MutableStateFlow(RealtimeState.Ready)
        val asked = mutableListOf<Pair<String, String?>>()
        val answers = ArrayDeque<() -> JamSongListResponse>()
        val byQuery = HashMap<String, JamSongListResponse>()
        val gates = ArrayDeque<CompletableDeferred<Unit>>()

        override suspend fun config(serverId: String) = JamConfig(enabled = true, uploads = true)
        override suspend fun songs(channelId: String, cursor: String?, limit: Int) = JamSongListResponse(listOf(aSong("wall-a"), aSong("wall-b")), null)
        override suspend fun searchSongs(channelId: String, query: String, cursor: String?, limit: Int): JamSongListResponse {
            asked += query to cursor
            gates.removeFirstOrNull()?.await()
            byQuery[query]?.let { return it }
            return (answers.removeFirstOrNull() ?: { JamSongListResponse() })()
        }
        override suspend fun song(songId: String) = error("not used")
        override suspend fun vote(trackId: String, voted: Boolean) = error("not used")
        override suspend fun setInMix(trackId: String, inMix: Boolean) = error("not used")
        override suspend fun deleteTrack(trackId: String) = Unit
        override suspend fun deleteSong(songId: String) = Unit
        override suspend fun updateTrack(trackId: String, request: UpdateJamTrackRequest) = error("not used")
        override suspend fun updateSong(songId: String, patch: SongPatch) = error("not used")
        override suspend fun uploadCover(songId: String, jpeg: ByteArray, onProgress: (Float) -> Unit) = error("not used")
        override suspend fun setCover(songId: String, uploadId: String) = error("not used")
        override suspend fun removeCover(songId: String) = error("not used")
        override fun join(channelId: String) = Unit
        override fun leave(channelId: String) = Unit
    }

    @Before
    fun setUp() = Dispatchers.setMain(StandardTestDispatcher())

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun TestScope.started(backend: Backend): JamWallViewModel {
        val model = JamWallViewModel(backend, "srv", "c")
        model.start()
        advanceUntilIdle()
        return model
    }

    @Test
    fun `nothing is asked for one letter, and the wall stays the wall`() = runTest {
        val backend = Backend()
        val model = started(backend)
        model.setQuery("l")
        advanceUntilIdle()
        assertTrue(backend.asked.isEmpty())
        assertEquals(JamSearchState.Idle, model.state.value.search)
        assertEquals("l", model.state.value.query)
        assertEquals(listOf("wall-a", "wall-b"), model.state.value.visible.map { it.id })
    }

    @Test
    fun `typing is debounced, so a burst of keys is one request for what was last typed`() = runTest {
        val backend = Backend().apply { answers += { JamSongListResponse(listOf(aSong("hit", "Lua cheia")), null) } }
        val model = started(backend)
        model.setQuery("lu")
        advanceTimeBy(100)
        model.setQuery("lua")
        advanceTimeBy(100)
        model.setQuery("lua ch")
        runCurrent()
        assertTrue("nothing yet: the pause has not passed", backend.asked.isEmpty())
        advanceTimeBy(JamSearchRules.DEBOUNCE_MS + 10)
        runCurrent()
        assertEquals(listOf("lua ch" to null), backend.asked)
        val done = model.state.value.search as JamSearchState.Done
        assertEquals(listOf("hit"), done.songs.map { it.id })
        assertEquals(listOf("hit"), model.state.value.visible.map { it.id })
    }

    @Test
    fun `an answer a newer key overtook is dropped`() = runTest {
        val first = CompletableDeferred<Unit>()
        val backend = Backend().apply {
            gates += first
            byQuery["lu"] = JamSongListResponse(listOf(aSong("old")), null)
            byQuery["lua"] = JamSongListResponse(listOf(aSong("new")), null)
        }
        val model = started(backend)
        model.setQuery("lu")
        advanceTimeBy(JamSearchRules.DEBOUNCE_MS + 10)
        runCurrent()
        model.setQuery("lua")
        advanceTimeBy(JamSearchRules.DEBOUNCE_MS + 10)
        runCurrent()
        first.complete(Unit)
        advanceUntilIdle()
        assertEquals(listOf("new"), (model.state.value.search as JamSearchState.Done).songs.map { it.id })
    }

    @Test
    fun `no results and a failed search are different states`() = runTest {
        val backend = Backend().apply {
            answers += { JamSongListResponse(emptyList(), null) }
            answers += { error("offline") }
        }
        val model = started(backend)
        model.setQuery("zzz")
        advanceUntilIdle()
        val empty = model.state.value.search as JamSearchState.Done
        assertTrue(empty.songs.isEmpty())
        assertTrue(model.state.value.visible.isEmpty())
        model.setQuery("zzzz")
        advanceUntilIdle()
        assertEquals(JamSearchState.Failed("zzzz"), model.state.value.search)
        // Not "no results": the wall's own songs are not shown as a result either.
        assertTrue(model.state.value.visible.isEmpty())
    }

    @Test
    fun `a failed search is tried again on demand, and says it is searching meanwhile`() = runTest {
        var retryGate = CompletableDeferred<Unit>()
        val backend = Backend().apply {
            answers += { error("offline") }
            answers += { JamSongListResponse(listOf(aSong("hit")), null) }
        }
        val model = started(backend)
        model.setQuery("lua")
        advanceUntilIdle()
        assertTrue(model.state.value.search is JamSearchState.Failed)
        backend.gates += CompletableDeferred<Unit>().also { retryGate = it }
        model.retrySearch()
        runCurrent()
        assertTrue(model.state.value.search is JamSearchState.Searching)
        retryGate.complete(Unit)
        advanceUntilIdle()
        assertEquals(listOf("hit"), (model.state.value.search as JamSearchState.Done).songs.map { it.id })
    }

    @Test
    fun `while a newer search is out the old results stay, and clearing the field brings the wall back`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val backend = Backend().apply {
            answers += { JamSongListResponse(listOf(aSong("hit")), null) }
            answers += { JamSongListResponse(listOf(aSong("hit2")), null) }
        }
        val model = started(backend)
        model.setQuery("lua")
        advanceUntilIdle()
        backend.gates += gate
        model.setQuery("luar")
        advanceTimeBy(JamSearchRules.DEBOUNCE_MS + 10)
        runCurrent()
        assertEquals("the list is not blanked on every key", listOf("hit"), model.state.value.visible.map { it.id })
        model.setQuery("")
        gate.complete(Unit)
        advanceUntilIdle()
        assertEquals(JamSearchState.Idle, model.state.value.search)
        assertEquals(listOf("wall-a", "wall-b"), model.state.value.visible.map { it.id })
    }

    @Test
    fun `results page on, kept apart from the wall's own paging`() = runTest {
        val backend = Backend().apply {
            answers += { JamSongListResponse(listOf(aSong("r1"), aSong("r2")), "next") }
            answers += { JamSongListResponse(listOf(aSong("r2"), aSong("r3")), null) }
        }
        val model = started(backend)
        model.setQuery("lua")
        advanceUntilIdle()
        model.loadMore()
        advanceUntilIdle()
        assertEquals(listOf("lua" to null, "lua" to "next"), backend.asked)
        val done = model.state.value.search as JamSearchState.Done
        assertEquals(listOf("r1", "r2", "r3"), done.songs.map { it.id })
        assertNull(done.nextCursor)
    }

    @Test
    fun `the filters apply to the results too`() = runTest {
        val backend = Backend().apply {
            answers += {
                JamSongListResponse(
                    listOf(
                        aSong("open").copy(joinMode = JamJoinMode.Open),
                        aSong("closed").copy(joinMode = JamJoinMode.Closed),
                    ),
                    null,
                )
            }
        }
        val model = started(backend)
        model.setQuery("lua")
        advanceUntilIdle()
        model.setFilter(JamWallFilter.Finished)
        assertEquals(listOf("closed"), model.state.value.visible.map { it.id })
    }
}
