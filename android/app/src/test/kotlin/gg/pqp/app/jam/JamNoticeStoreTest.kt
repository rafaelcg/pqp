package gg.pqp.app.jam

import gg.pqp.app.core.ApiException
import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.RealtimeState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun track(id: String, songId: String, instrument: JamInstrument = JamInstrument.Bass, at: String = "2026-11-27T10:00:00.000Z") =
    JamTrack(id = id, songId = songId, authorId = "u-$id", authorName = "bob", instrument = instrument, createdAt = at, inMix = false)

private fun item(id: String, songId: String, title: String = "Lua cheia") = JamPublicInboxItem(songId, title, track(id, songId))

private fun notice(id: String, songId: String, kind: JamTakeNoticeKind = JamTakeNoticeKind.Take, count: Int = 1) =
    JamTakeNotice(id, kind, songId, "Lua cheia", listOf(JamInstrument.Bass), count)

/**
 * The state behind "N partes esperando tua resposta": what it reads, when, and what it holds. Against a fake backend,
 * on a test dispatcher, so ordering is exact. The properties that matter:
 *  - OFF MEANS INVISIBLE (`jam_public` off, or an API that predates the routes, holds nothing and asks for nothing more);
 *  - the live frames are only a nudge, and a take frame with no card for its song becomes a toast, never both;
 *  - a read that did not fully arrive is asked again, and never wipes what was there;
 *  - a different account never sees the previous one's lists.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class JamNoticeStoreTest {

    private class Backend : JamNoticeBackend {
        val accountFlow = MutableStateFlow<String?>("me")
        override val accounts = accountFlow
        val frameFlow = MutableSharedFlow<JsonObject>(extraBufferCapacity = 16)
        override val frames = frameFlow
        val connectionFlow = MutableStateFlow(RealtimeState.Ready)
        override val connection: StateFlow<RealtimeState> = connectionFlow

        var config: JamPublicMeConfig = JamPublicMeConfig(enabled = true)
        var configFailure: Exception? = null
        var inbox = JamPublicInboxResponse()
        var notices = JamTakeNoticesResponse()
        var inboxFailures = 0
        var noticesFailures = 0
        var configReads = 0
        var inboxReads = 0
        var noticesReads = 0
        val acked = mutableListOf<String>()
        var ackFailure: Exception? = null

        override suspend fun config(): JamPublicMeConfig {
            configReads += 1
            configFailure?.let { throw it }
            return config
        }

        /** Holds a read after its answer was produced (so it predates what happens meanwhile), like a slow server. */
        val inboxGates = ArrayDeque<kotlinx.coroutines.CompletableDeferred<Unit>>()

        override suspend fun inbox(): JamPublicInboxResponse {
            inboxReads += 1
            if (inboxFailures > 0) {
                inboxFailures -= 1
                error("offline")
            }
            val answer = inbox
            inboxGates.removeFirstOrNull()?.await()
            return answer
        }

        override suspend fun notices(): JamTakeNoticesResponse {
            noticesReads += 1
            if (noticesFailures > 0) {
                noticesFailures -= 1
                error("offline")
            }
            return notices
        }

        override suspend fun ack(id: String) {
            ackFailure?.let { throw it }
            acked += id
            notices = JamTakeNoticesResponse(notices.notices.filterNot { it.id == id })
        }
    }

    private fun TestScope.store(backend: Backend, retryMs: List<Long> = listOf(3_000, 10_000, 30_000)): JamNoticeStore {
        val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
        return JamNoticeStore(backend, scope, retryMs).also { it.start() }
    }

    private fun frame(json: String): JsonObject = PqpJson.parseToJsonElement(json).jsonObject

    private fun takeFrame(songId: String = "s1", admitted: Boolean = false) =
        frame("""{"type":"jam-public-notice","kind":"take","songId":"$songId","title":"Lua cheia","trackId":"t1","reason":null,"admitted":$admitted,"instrument":"bass"}""")

    @Test
    fun `signing in reads the flag and then the inbox and the notices`() = runTest {
        val backend = Backend().apply {
            inbox = JamPublicInboxResponse(listOf(item("t1", "s1")))
            notices = JamTakeNoticesResponse(listOf(notice("n1", "s1")))
        }
        val store = store(backend)
        advanceUntilIdle()
        val state = store.state.value
        assertTrue(state.loaded)
        assertTrue(state.enabled)
        assertEquals(listOf("t1"), state.inbox.map { it.track.id })
        assertEquals(listOf("n1"), state.notices.map { it.id })
        assertEquals(1, state.waitingCount("s1"))
        assertEquals(0, state.waitingCount("s2"))
    }

    @Test
    fun `with the flag off nothing else is read and nothing is held`() = runTest {
        val backend = Backend().apply { config = JamPublicMeConfig(enabled = false) }
        val store = store(backend)
        advanceUntilIdle()
        assertTrue(store.state.value.loaded)
        assertFalse(store.state.value.enabled)
        assertEquals(0, backend.inboxReads)
        assertEquals(0, backend.noticesReads)
        // A frame cannot turn it on by itself: it asks the flag again, hears no, and stays silent.
        backend.frameFlow.tryEmit(takeFrame())
        advanceUntilIdle()
        assertNull(store.state.value.toast)
        assertEquals(0, backend.inboxReads)
    }

    @Test
    fun `an api that predates the routes reads as off, a network failure does not`() = runTest {
        val gone = Backend().apply { configFailure = ApiException(404, "not found") }
        val storeGone = store(gone)
        advanceUntilIdle()
        assertTrue(storeGone.state.value.loaded)
        assertFalse(storeGone.state.value.enabled)

        val offline = Backend().apply { configFailure = java.io.IOException("offline") }
        val storeOffline = store(offline)
        advanceUntilIdle()
        // Nothing is known yet, and nothing is claimed: asked again with the next nudge.
        assertFalse(storeOffline.state.value.loaded)
    }

    @Test
    fun `a take frame reads again and the card it finds is the notice, with no toast`() = runTest {
        val backend = Backend()
        val store = store(backend)
        advanceUntilIdle()
        backend.inbox = JamPublicInboxResponse(listOf(item("t1", "s1")))
        backend.notices = JamTakeNoticesResponse(listOf(notice("n1", "s1")))
        backend.frameFlow.tryEmit(takeFrame())
        advanceUntilIdle()
        assertEquals(listOf("n1"), store.state.value.notices.map { it.id })
        assertNull("the card IS the notice: a person is not told twice", store.state.value.toast)
    }

    @Test
    fun `a take frame with no card for its song is a toast, for a server that wrote no item`() = runTest {
        val backend = Backend()
        val store = store(backend)
        advanceUntilIdle()
        backend.inbox = JamPublicInboxResponse(listOf(item("t1", "s1")))
        backend.frameFlow.tryEmit(takeFrame())
        advanceUntilIdle()
        val toast = store.state.value.toast
        assertEquals("s1", toast?.songId)
        assertEquals("Lua cheia", toast?.title)
        assertFalse(toast!!.admitted)
        store.dismissToast(toast.key)
        assertNull(store.state.value.toast)
    }

    @Test
    fun `dismissing an older toast leaves a newer one`() = runTest {
        val backend = Backend()
        val store = store(backend)
        advanceUntilIdle()
        backend.frameFlow.tryEmit(takeFrame("s1"))
        advanceUntilIdle()
        val first = store.state.value.toast!!
        backend.frameFlow.tryEmit(takeFrame("s2"))
        advanceUntilIdle()
        store.dismissToast(first.key)
        assertEquals("s2", store.state.value.toast?.songId)
    }

    @Test
    fun `a take that auto-accept already put in is a toast that says so, with nothing waiting`() = runTest {
        val backend = Backend()
        val store = store(backend)
        advanceUntilIdle()
        backend.frameFlow.tryEmit(takeFrame(admitted = true))
        advanceUntilIdle()
        assertTrue(store.state.value.toast!!.admitted)
        assertTrue(store.state.value.notices.isEmpty())
    }

    @Test
    fun `the sender's decision frame reads again and draws nothing of its own`() = runTest {
        val backend = Backend()
        val store = store(backend)
        advanceUntilIdle()
        val before = backend.noticesReads
        backend.notices = JamTakeNoticesResponse(listOf(notice("n9", "s9", JamTakeNoticeKind.Accepted)))
        backend.frameFlow.tryEmit(frame("""{"type":"jam-take-decision","decision":"accepted","songId":"s9","title":"Lua cheia","instrument":"bass"}"""))
        advanceUntilIdle()
        assertEquals(before + 1, backend.noticesReads)
        assertEquals(JamTakeNoticeKind.Accepted, store.state.value.notices.single().kind)
        assertNull(store.state.value.toast)
    }

    @Test
    fun `frames of every other kind are not this store's business`() = runTest {
        val backend = Backend()
        val store = store(backend)
        advanceUntilIdle()
        val reads = backend.inboxReads
        backend.frameFlow.tryEmit(frame("""{"type":"jam-track-added","channelId":"c1"}"""))
        backend.frameFlow.tryEmit(frame("""{"type":"jam-public-notice","kind":"approved","songId":"s1","title":"x"}"""))
        advanceUntilIdle()
        assertEquals(reads, backend.inboxReads)
        assertNull(store.state.value.toast)
    }

    @Test
    fun `a burst of frames is one read`() = runTest {
        val backend = Backend()
        val store = store(backend)
        advanceUntilIdle()
        val before = backend.inboxReads
        repeat(5) { backend.frameFlow.tryEmit(frame("""{"type":"jam-take-decision","decision":"accepted","songId":"s1","title":"x","instrument":"bass"}""")) }
        advanceUntilIdle()
        // Each frame waits for the read in flight instead of starting its own: far fewer reads than frames.
        assertTrue("reads: ${backend.inboxReads - before}", backend.inboxReads - before <= 2)
    }

    @Test
    fun `frames that arrive during a read are not lost to it, the count ends right`() = runTest {
        val backend = Backend().apply { inbox = JamPublicInboxResponse(listOf(item("t1", "s1"))) }
        val store = store(backend)
        advanceUntilIdle()
        // A read is out, produced before the next two takes arrived (three at once, as the QA found).
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        backend.inboxGates += gate
        backend.frameFlow.tryEmit(takeFrame())
        runCurrent()
        backend.inbox = JamPublicInboxResponse(listOf(item("t1", "s1"), item("t2", "s1"), item("t3", "s1")))
        backend.notices = JamTakeNoticesResponse(listOf(notice("n1", "s1", count = 3)))
        backend.frameFlow.tryEmit(takeFrame())
        backend.frameFlow.tryEmit(takeFrame())
        runCurrent()
        gate.complete(Unit)
        advanceUntilIdle()
        assertEquals("the strip and the pill read the same 3 as the card", 3, store.state.value.waitingCount("s1"))
        assertEquals(3, store.state.value.notices.single().count)
    }

    @Test
    fun `a failed read keeps what was there and says the list is out of date`() = runTest {
        val backend = Backend().apply {
            inbox = JamPublicInboxResponse(listOf(item("t1", "s1")))
            notices = JamTakeNoticesResponse(listOf(notice("n1", "s1")))
        }
        val store = store(backend, retryMs = emptyList())
        advanceUntilIdle()
        backend.inboxFailures = 1
        backend.notices = JamTakeNoticesResponse(listOf(notice("n1", "s1"), notice("n2", "s2")))
        store.refresh()
        advanceUntilIdle()
        // The inbox read failed: its list is the one from before, the notices read arrived, and the state says so.
        assertEquals(listOf("t1"), store.state.value.inbox.map { it.track.id })
        assertEquals(listOf("n1", "n2"), store.state.value.notices.map { it.id })
        assertTrue(store.state.value.stale)
    }

    @Test
    fun `a stale list is asked again after three seconds`() = runTest {
        val backend = Backend().apply { inbox = JamPublicInboxResponse(listOf(item("t1", "s1"))) }
        val store = store(backend, retryMs = listOf(3_000))
        advanceUntilIdle()
        backend.inboxFailures = 1
        backend.inbox = JamPublicInboxResponse(listOf(item("t1", "s1"), item("t2", "s1")))
        val reads = backend.inboxReads
        store.refresh()
        advanceTimeBy(500)
        assertEquals(1, store.state.value.inbox.size)
        assertTrue(store.state.value.stale)
        advanceTimeBy(3_500)
        assertEquals(reads + 2, backend.inboxReads)
        assertEquals(2, store.state.value.inbox.size)
        assertFalse(store.state.value.stale)
    }

    @Test
    fun `acking spends the item at once and tells the server`() = runTest {
        val backend = Backend().apply { notices = JamTakeNoticesResponse(listOf(notice("n1", "s1"), notice("n2", "s2"))) }
        val store = store(backend)
        advanceUntilIdle()
        store.ack("n1")
        assertEquals(listOf("n2"), store.state.value.notices.map { it.id })
        advanceUntilIdle()
        assertEquals(listOf("n1"), backend.acked)
        backend.ackFailure = java.io.IOException("offline")
        store.ack("n2")
        advanceUntilIdle()
        // The server never spent n2 (the ack was refused), so the read that follows brings it back: what is drawn is what the
        // server holds, not a card that looks spent and returns with some later read.
        assertEquals(listOf("n2"), store.state.value.notices.map { it.id })
    }

    @Test
    fun `a refused ack reads again, so what is drawn is what the server holds`() = runTest {
        val backend = Backend().apply { notices = JamTakeNoticesResponse(listOf(notice("n1", "s1"))) }
        val store = store(backend, retryMs = emptyList())
        advanceUntilIdle()
        backend.ackFailure = java.io.IOException("offline")
        val reads = backend.noticesReads
        store.ack("n1")
        advanceUntilIdle()
        assertTrue("the server never spent it, so it is read again", backend.noticesReads > reads)
        assertEquals(listOf("n1"), store.state.value.notices.map { it.id })
    }

    @Test
    fun `a config read that failed on the network is asked again, and again on reconnect`() = runTest {
        val backend = Backend().apply { configFailure = java.io.IOException("offline") }
        val store = store(backend, retryMs = listOf(3_000))
        runCurrent()
        assertFalse(store.state.value.loaded)
        backend.configFailure = null
        advanceTimeBy(3_500)
        advanceUntilIdle()
        assertTrue(store.state.value.enabled)

        val second = Backend().apply { configFailure = java.io.IOException("offline") }
        val other = store(second, retryMs = emptyList())
        advanceUntilIdle()
        assertFalse(other.state.value.loaded)
        second.configFailure = null
        second.connectionFlow.value = RealtimeState.Reconnecting
        advanceUntilIdle()
        second.connectionFlow.value = RealtimeState.Ready
        advanceUntilIdle()
        assertTrue("a reconnect reads the flag when it is still unknown", other.state.value.enabled)
    }

    @Test
    fun `dropping the last take of a song takes its notice with it, the way the server empties it`() = runTest {
        val backend = Backend().apply {
            inbox = JamPublicInboxResponse(listOf(item("t1", "s1"), item("t2", "s1"), item("t3", "s2")))
            notices = JamTakeNoticesResponse(listOf(notice("n1", "s1", count = 2), notice("n2", "s2")))
        }
        val store = store(backend)
        advanceUntilIdle()
        store.dropInboxTake("t1")
        assertEquals(setOf("n1", "n2"), store.state.value.notices.map { it.id }.toSet())
        store.dropInboxTake("t2")
        assertEquals(listOf("n2"), store.state.value.notices.map { it.id })
        assertEquals(listOf("t3"), store.state.value.inbox.map { it.track.id })
    }

    @Test
    fun `another account never sees the last one's lists`() = runTest {
        val backend = Backend().apply {
            inbox = JamPublicInboxResponse(listOf(item("t1", "s1")))
            notices = JamTakeNoticesResponse(listOf(notice("n1", "s1")))
        }
        val store = store(backend)
        advanceUntilIdle()
        assertEquals(1, store.state.value.inbox.size)
        backend.inbox = JamPublicInboxResponse()
        backend.notices = JamTakeNoticesResponse()
        backend.accountFlow.value = null
        advanceUntilIdle()
        assertEquals(JamNoticeState(), store.state.value)
        backend.accountFlow.value = "someone-else"
        advanceUntilIdle()
        assertTrue(store.state.value.enabled)
        assertTrue(store.state.value.inbox.isEmpty())
        assertTrue(store.state.value.notices.isEmpty())
    }

    @Test
    fun `a socket that comes back reads again`() = runTest {
        val backend = Backend()
        val store = store(backend)
        advanceUntilIdle()
        val before = backend.noticesReads
        backend.connectionFlow.value = RealtimeState.Reconnecting
        advanceUntilIdle()
        assertEquals(before, backend.noticesReads)
        backend.notices = JamTakeNoticesResponse(listOf(notice("n1", "s1")))
        backend.connectionFlow.value = RealtimeState.Ready
        advanceUntilIdle()
        assertEquals(listOf("n1"), store.state.value.notices.map { it.id })
    }

    @Test
    fun `screens hold the notices back and give them back`() = runTest {
        val store = store(Backend())
        assertEquals(0, store.holds.value)
        val song = store.hold()
        val studio = store.hold()
        assertEquals(2, store.holds.value)
        song()
        song()
        assertEquals("releasing twice is releasing once", 1, store.holds.value)
        studio()
        assertEquals(0, store.holds.value)
    }
}
