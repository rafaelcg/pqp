package gg.pqp.app.jam

import gg.pqp.app.core.ApiException
import gg.pqp.app.core.RealtimeState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The starter's answer to a part from outside: accept (with an undo), decline (confirmed first, no undo). What matters
 * is what happens when the server says no: the failure is kept next to the part, the part stays where it was, and
 * nothing about the inbox changes until the server has said yes.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class JamRequestsTest {

    private val song = JamSongSummary(id = "s1", channelId = "c1", serverId = "srv", title = "Lua", updatedAt = "2026-11-27T10:00:00.000Z", trackCount = 3)
    private val take = JamTrack(id = "t1", songId = "s1", authorId = "u2", authorName = "bob", instrument = JamInstrument.Bass, inMix = false)

    private class Backend : JamBackend {
        override val viewerId: String? = "me"
        override val frames = MutableSharedFlow<JamFrame>()
        override val connection = MutableStateFlow(RealtimeState.Ready)
        val calls = mutableListOf<String>()
        var setInMixFailure: Exception? = null
        var deleteFailure: Exception? = null
        var gate: CompletableDeferred<Unit>? = null
        var after = JamSongSummary(id = "s1", channelId = "c1", title = "Lua", updatedAt = "2026-11-27T10:00:05.000Z", trackCount = 3)

        override suspend fun config(serverId: String) = JamConfig(enabled = true, uploads = true)
        override suspend fun songs(channelId: String, cursor: String?, limit: Int) = JamSongListResponse()
        override suspend fun song(songId: String) = error("not used")
        override suspend fun vote(trackId: String, voted: Boolean) = error("not used")
        override suspend fun setInMix(trackId: String, inMix: Boolean): JamTrackWithSong {
            calls += "inMix $trackId $inMix"
            gate?.await()
            setInMixFailure?.let { throw it }
            return JamTrackWithSong(JamTrack(id = trackId, songId = "s1", instrument = JamInstrument.Bass, inMix = inMix), after)
        }
        override suspend fun deleteTrack(trackId: String) {
            calls += "delete $trackId"
            gate?.await()
            deleteFailure?.let { throw it }
        }
        override suspend fun deleteSong(songId: String) = Unit
        override suspend fun updateTrack(trackId: String, request: UpdateJamTrackRequest) = error("not used")
        override suspend fun updateSong(songId: String, patch: SongPatch) = error("not used")
        override suspend fun uploadCover(songId: String, jpeg: ByteArray, onProgress: (Float) -> Unit) = error("not used")
        override suspend fun setCover(songId: String, uploadId: String) = error("not used")
        override suspend fun removeCover(songId: String) = error("not used")
        override fun join(channelId: String) = Unit
        override fun leave(channelId: String) = Unit
    }

    private class Hook : JamRequestsHook {
        val dropped = mutableListOf<String>()
        var changed = 0
        override fun dropped(trackId: String) { dropped += trackId }
        override fun changed() { changed += 1 }
    }

    private class World(val backend: Backend, val hook: Hook, val requests: JamRequests) {
        val applied = mutableListOf<JamFrame>()
        val ended = mutableListOf<String>()
        var permissionsRead = 0
    }

    private fun TestScope.world(backend: Backend = Backend()): World {
        val hook = Hook()
        lateinit var world: World
        val requests = JamRequests(
            backend = backend,
            scope = CoroutineScope(StandardTestDispatcher(testScheduler)),
            channelId = "c1",
            song = { song },
            apply = { world.applied += it },
            accepts = { true },
            endAudition = { world.ended += it.id },
            permissionsChanged = { world.permissionsRead += 1 },
            hook = hook,
        )
        world = World(backend, hook, requests)
        return world
    }

    @Test
    fun `accepting puts the take in the mix, takes it off the inbox and says what the public sees, with an undo`() = runTest {
        val w = world()
        w.requests.accept(take)
        advanceUntilIdle()
        assertEquals(listOf("inMix t1 true"), w.backend.calls)
        assertTrue(w.applied.single() is JamFrame.TrackUpdated)
        assertEquals(listOf("t1"), w.hook.dropped)
        assertTrue(w.hook.changed >= 1)
        assertEquals(listOf("t1"), w.ended)
        val answer = w.requests.ui.value.answer!!
        assertEquals(JamAnswerKind.Accepted, answer.kind)
        assertEquals(JamInstrument.Bass, answer.instrument)
        assertEquals("bob", answer.name)
        assertNull(w.requests.ui.value.busy)
    }

    @Test
    fun `a refused accept leaves the part waiting, and says why next to it`() = runTest {
        val w = world(Backend().apply { setInMixFailure = ApiException(500, "boom") })
        w.requests.accept(take)
        advanceUntilIdle()
        val ui = w.requests.ui.value
        assertEquals(JamRequestFailure("t1", JamRequestAction.Accept, JamWriteFailure.Other), ui.failure)
        assertNull("no answer for something that did not happen", ui.answer)
        assertTrue("the part is still in the inbox", w.hook.dropped.isEmpty())
        assertTrue(w.applied.isEmpty())
        assertNull(ui.busy)
    }

    @Test
    fun `a failure is told in the shared words for the flag, the network and the rate limit`() = runTest {
        val off = world(Backend().apply { setInMixFailure = ApiException(403, JamErrors.OFF) })
        off.requests.accept(take)
        advanceUntilIdle()
        assertEquals(JamWriteFailure.Off, off.requests.ui.value.failure?.failure)

        val offline = world(Backend().apply { setInMixFailure = java.io.IOException("no route") })
        offline.requests.accept(take)
        advanceUntilIdle()
        assertEquals(JamWriteFailure.Network, offline.requests.ui.value.failure?.failure)

        val limited = world(Backend().apply { setInMixFailure = ApiException(429, null) })
        limited.requests.accept(take)
        advanceUntilIdle()
        assertEquals(JamWriteFailure.RateLimited, limited.requests.ui.value.failure?.failure)
    }

    @Test
    fun `a 403 that is not the flag reads what this person may do again`() = runTest {
        val w = world(Backend().apply { setInMixFailure = ApiException(403, null) })
        w.requests.accept(take)
        advanceUntilIdle()
        assertEquals(JamWriteFailure.Denied, w.requests.ui.value.failure?.failure)
        assertEquals(1, w.permissionsRead)
    }

    @Test
    fun `a part that is already gone asks the lists to be read again`() = runTest {
        val w = world(Backend().apply { setInMixFailure = ApiException(404, null) })
        w.requests.accept(take)
        advanceUntilIdle()
        assertEquals(JamWriteFailure.Gone, w.requests.ui.value.failure?.failure)
        assertEquals(1, w.hook.changed)
    }

    @Test
    fun `a second tap while an answer is out waits for it`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val w = world(Backend().apply { this.gate = gate })
        w.requests.accept(take)
        advanceUntilIdle()
        assertEquals("t1", w.requests.ui.value.busy)
        w.requests.accept(take.copy(id = "t2"))
        w.requests.askDecline(take.copy(id = "t3"))
        w.requests.confirmDecline()
        advanceUntilIdle()
        assertEquals(listOf("inMix t1 true"), w.backend.calls)
        gate.complete(Unit)
        advanceUntilIdle()
        assertNull(w.requests.ui.value.busy)
    }

    @Test
    fun `declining asks first, and nothing is deleted until it is confirmed`() = runTest {
        val w = world()
        w.requests.askDecline(take)
        advanceUntilIdle()
        assertEquals(take, w.requests.ui.value.confirmDecline)
        assertTrue(w.backend.calls.isEmpty())
        w.requests.cancelDecline()
        advanceUntilIdle()
        assertNull(w.requests.ui.value.confirmDecline)
        assertTrue(w.backend.calls.isEmpty())
    }

    @Test
    fun `a confirmed decline deletes the take, counts the song down and says it was refused with no undo`() = runTest {
        val w = world()
        w.requests.askDecline(take)
        w.requests.confirmDecline()
        advanceUntilIdle()
        assertEquals(listOf("delete t1"), w.backend.calls)
        val frame = w.applied.single() as JamFrame.TrackDeleted
        assertEquals("t1", frame.trackId)
        assertEquals(2, frame.song.trackCount)
        assertEquals(listOf("t1"), w.hook.dropped)
        val answer = w.requests.ui.value.answer!!
        assertEquals(JamAnswerKind.Refused, answer.kind)
        // "Desfazer" is for an accept only: a declined take is deleted and the API cannot bring it back.
        w.requests.undo()
        advanceUntilIdle()
        assertEquals(listOf("delete t1"), w.backend.calls)
    }

    @Test
    fun `a refused decline leaves the part, the box says so beside it and nothing is dropped`() = runTest {
        val w = world(Backend().apply { deleteFailure = ApiException(500, null) })
        w.requests.askDecline(take)
        w.requests.confirmDecline()
        advanceUntilIdle()
        assertEquals(JamRequestFailure("t1", JamRequestAction.Decline, JamWriteFailure.Other), w.requests.ui.value.failure)
        assertTrue(w.hook.dropped.isEmpty())
        assertTrue(w.applied.isEmpty())
        assertNull(w.requests.ui.value.answer)
        assertNull(w.requests.ui.value.confirmDecline)
    }

    @Test
    fun `undo takes the same part back out of the mix and says it is back in the queue`() = runTest {
        val w = world()
        w.requests.accept(take)
        advanceUntilIdle()
        w.requests.undo()
        advanceUntilIdle()
        assertEquals(listOf("inMix t1 true", "inMix t1 false"), w.backend.calls)
        assertEquals(JamAnswerKind.Undone, w.requests.ui.value.answer?.kind)
        assertEquals(2, w.applied.size)
        // The part returns to the inbox by the read the hook asks for: it is not dropped twice.
        assertEquals(listOf("t1"), w.hook.dropped)
        assertTrue(w.hook.changed >= 2)
    }

    @Test
    fun `an undo the server refuses says so inside the box and keeps the part in the song`() = runTest {
        val w = world()
        w.requests.accept(take)
        advanceUntilIdle()
        w.backend.setInMixFailure = ApiException(500, null)
        w.requests.undo()
        advanceUntilIdle()
        val ui = w.requests.ui.value
        assertEquals(JamRequestFailure("t1", JamRequestAction.Undo, JamWriteFailure.Other), ui.failure)
        assertEquals("the box stays so it can be tried again", JamAnswerKind.Accepted, ui.answer?.kind)
    }

    @Test
    fun `the box leaves only for the answer it was drawn for`() = runTest {
        val w = world()
        w.requests.accept(take)
        advanceUntilIdle()
        w.requests.dismissAnswer("someone-else", JamAnswerKind.Accepted)
        w.requests.dismissAnswer("t1", JamAnswerKind.Refused)
        assertEquals(JamAnswerKind.Accepted, w.requests.ui.value.answer?.kind)
        w.requests.dismissAnswer("t1", JamAnswerKind.Accepted)
        assertNull(w.requests.ui.value.answer)
    }

    @Test
    fun `a new answer clears the old failure, dismissing clears it too`() = runTest {
        val w = world(Backend().apply { setInMixFailure = ApiException(500, null) })
        w.requests.accept(take)
        advanceUntilIdle()
        assertTrue(w.requests.ui.value.failure != null)
        w.backend.setInMixFailure = null
        w.requests.accept(take)
        advanceUntilIdle()
        assertNull(w.requests.ui.value.failure)
        assertFalse(w.requests.ui.value.answer == null)
        w.requests.askDecline(take)
        w.requests.dismissFailure()
        assertNull(w.requests.ui.value.failure)
    }
}
