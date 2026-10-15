package gg.pqp.app.forward

import gg.pqp.app.core.ApiException
import gg.pqp.app.core.Channel
import gg.pqp.app.core.Permission
import gg.pqp.app.core.PermissionsSnapshot
import gg.pqp.app.core.ServerSummary
import gg.pqp.app.social.DmSummary
import gg.pqp.app.social.Friend
import gg.pqp.app.social.PublicUser
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The picker's view model, constructed and driven for real.
 *
 * The first test is the regression for the crash that shipped in an earlier push:
 * `init` ran `load()` (on `Main.immediate`, so right there in the constructor)
 * before the fields it uses were initialised, and opening the sheet killed the
 * app with a NullPointerException. Every other test in this module only ever
 * called pure functions, so nothing could see it. An unconfined Main reproduces
 * the same eager start.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ForwardViewModelTest {

    @Before
    fun main() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After
    fun reset() = Dispatchers.resetMain()

    private val write = Permission.SEND_MESSAGES.toString()

    private fun server(id: String) =
        ServerSummary(id = id, name = "Server $id", ownerId = "o", createdAt = "2026-01-01T00:00:00.000Z")

    private fun channel(id: String, server: String) =
        Channel(id = id, serverId = server, name = "chan-$id", type = "text")

    private class FakeBackend(override val servers: List<ServerSummary>) : ForwardBackend {
        val channelsByServer = HashMap<String, List<Channel>>()
        val failChannels = HashSet<String>()
        val requests = mutableListOf<CreateForwardRequest>()
        var refreshed = 0
        var send: suspend (CreateForwardRequest) -> CreateForwardResponse = { CreateForwardResponse() }
        override val conversations = MutableStateFlow<List<DmSummary>>(emptyList())
        override val friends = MutableStateFlow<List<Friend>>(emptyList())
        override var selfId: String? = "me"

        override fun refreshPeople() {
            refreshed += 1
        }

        override suspend fun channels(serverId: String): List<Channel> {
            if (serverId in failChannels) throw IOException("offline")
            return channelsByServer[serverId].orEmpty()
        }

        override suspend fun permissions(serverId: String) =
            PermissionsSnapshot(server = Permission.SEND_MESSAGES.toString())

        override suspend fun createForward(request: CreateForwardRequest): CreateForwardResponse {
            requests += request
            return send(request)
        }
    }

    private object NoRecents : ForwardRecentsStore {
        var saved: List<String> = emptyList()
        override fun load(): List<String> = emptyList()
        override fun save(keys: List<String>) {
            saved = keys
        }
    }

    private val input = ForwardInput(
        source = ForwardSource(FORWARD_KIND_MESSAGE, "m1"),
        preview = "preview",
    )

    private fun ok(channelId: String, serverId: String? = "s1") = ForwardResult(
        ok = true, target = ForwardTargetRef(channelId = channelId), channelId = channelId, serverId = serverId,
    )

    private fun viewModel(backend: FakeBackend) = ForwardViewModel(backend, input, NoRecents)

    private fun backendWith(vararg servers: String): FakeBackend {
        val backend = FakeBackend(servers.map(::server))
        servers.forEach { backend.channelsByServer[it] = listOf(channel("$it-a", it), channel("$it-b", it)) }
        return backend
    }

    // ---- construction

    @Test
    fun `opening the picker constructs the view model and lists every server`() {
        val backend = backendWith("s1", "s2", "s3")
        val model = viewModel(backend)

        val state = model.state.value
        assertFalse(state.loading)
        assertEquals(listOf("s1", "s2", "s3"), state.groups.map { it.serverId })
        assertEquals(6, state.groups.sumOf { it.channels.size })
        assertEquals(1, backend.refreshed)
    }

    @Test
    fun `a member of no server still opens`() {
        val model = viewModel(FakeBackend(emptyList()))
        assertFalse(model.state.value.loading)
        assertTrue(model.state.value.groups.isEmpty())
    }

    @Test
    fun `friends and conversations appear as people`() {
        val backend = backendWith("s1")
        backend.friends.value = listOf(Friend(id = "u9", displayName = "Carol"))
        backend.conversations.value = listOf(
            DmSummary(channelId = "d1", participants = listOf(PublicUser(id = "u1", displayName = "Bob"))),
        )
        val keys = viewModel(backend).state.value.people.map { it.key }
        assertEquals(listOf("c:d1", "u:u9"), keys)
    }

    // ---- a server that fails to load

    @Test
    fun `a server whose channels fail is kept as failed and a retry loads it`() {
        val backend = backendWith("s1", "s2")
        backend.failChannels += "s2"
        val model = viewModel(backend)

        assertEquals(listOf("s1"), model.state.value.groups.map { it.serverId })
        assertEquals(listOf("s2"), model.state.value.failedServers.map { it.serverId })

        backend.failChannels.clear()
        model.retryServer("s2")
        assertEquals(listOf("s1", "s2"), model.state.value.groups.map { it.serverId })
        assertTrue(model.state.value.failedServers.isEmpty())
    }

    @Test
    fun `retrying a server that is still loading does nothing`() {
        val backend = backendWith("s1")
        val gate = CompletableDeferred<Unit>()
        val slow = object : ForwardBackend by backend {
            var calls = 0
            override suspend fun channels(serverId: String): List<Channel> {
                calls += 1
                if (calls > 1) gate.await()
                return backend.channels(serverId)
            }
        }
        val model = ForwardViewModel(slow, input, NoRecents)
        model.retryServer("s1")
        model.retryServer("s1")
        // The first retry is parked on the gate; the second never started a read.
        assertEquals(2, slow.calls)
        gate.complete(Unit)
    }

    // ---- sending

    @Test
    fun `a send reports who took it and finishes when nothing was refused`() {
        val backend = backendWith("s1")
        backend.send = { CreateForwardResponse(listOf(ok("s1-a"), ok("s1-b"))) }
        val model = viewModel(backend)
        model.toggle("c:s1-a")
        model.toggle("c:s1-b")
        model.setComment("  oi  ")
        model.send()

        assertEquals("oi", backend.requests.single().comment)
        assertEquals(2, backend.requests.single().targets.size)
        val done = model.done.value
        assertNotNull(done)
        assertEquals(listOf("#chan-s1-a", "#chan-s1-b"), done!!.sent.map { it.label })
        assertEquals(listOf("c:s1-a", "c:s1-b"), NoRecents.saved)
    }

    @Test
    fun `a refused target keeps the sheet open with its reason and the others sent`() {
        val backend = backendWith("s1")
        backend.send = {
            CreateForwardResponse(
                listOf(
                    ok("s1-a"),
                    ForwardResult(
                        ok = false, target = ForwardTargetRef(channelId = "s1-b"),
                        reason = "slow_mode", retryAfterMs = 1200,
                    ),
                ),
            )
        }
        val model = viewModel(backend)
        model.toggle("c:s1-a")
        model.toggle("c:s1-b")
        model.send()

        val state = model.state.value
        assertEquals(setOf("c:s1-a"), state.sentKeys)
        assertEquals(ForwardRefusal.SlowMode, state.refusals.getValue("c:s1-b").refusal)
        assertEquals(2, state.refusals.getValue("c:s1-b").waitSeconds)
        assertNull(model.done.value)
        // What went is not offered again.
        model.toggle("c:s1-a")
        assertFalse("c:s1-a" in model.state.value.selected)
    }

    @Test
    fun `after a lost connection the retry is the same request and the selection is frozen`() {
        val backend = backendWith("s1")
        var attempts = 0
        backend.send = {
            attempts += 1
            if (attempts == 1) throw IOException("offline")
            CreateForwardResponse(listOf(ok("s1-a"), ok("s1-b")))
        }
        val model = viewModel(backend)
        model.toggle("c:s1-a")
        model.toggle("c:s1-b")
        model.setComment("primeira")
        model.send()

        assertTrue(model.state.value.retryLocked)
        assertTrue(model.state.value.failure is ForwardFailure.Other)

        // Changing the targets or the words would be a different request under a new nonce.
        model.toggle("c:s1-b")
        model.setComment("outra")
        assertEquals(listOf("c:s1-a", "c:s1-b"), model.state.value.selected)
        assertEquals("primeira", model.state.value.comment)

        model.send()
        assertEquals(2, backend.requests.size)
        assertEquals(backend.requests[0], backend.requests[1])
        assertNotNull(backend.requests[0].nonce)
        assertFalse(model.state.value.retryLocked)
        assertNotNull(model.done.value)
    }

    @Test
    fun `an answered failure never freezes the selection`() {
        for (status in listOf(400, 403, 404, 422, 429)) {
            val backend = backendWith("s1")
            backend.send = { throw ApiException(status, "no") }
            val model = viewModel(backend)
            model.toggle("c:s1-a")
            model.send()

            assertFalse("$status", model.state.value.retryLocked)
            // The person can change the target and send a fresh request.
            model.toggle("c:s1-a")
            model.toggle("c:s1-b")
            assertEquals("$status", listOf("c:s1-b"), model.state.value.selected)
        }
    }

    @Test
    fun `a server error is an unknown outcome and freezes the selection`() {
        val backend = backendWith("s1")
        backend.send = { throw ApiException(502, "bad gateway") }
        val model = viewModel(backend)
        model.toggle("c:s1-a")
        model.send()
        assertTrue(model.state.value.retryLocked)
    }

    @Test
    fun `no more than five targets can be picked`() {
        val backend = backendWith("s1", "s2", "s3")
        val model = viewModel(backend)
        listOf("s1-a", "s1-b", "s2-a", "s2-b", "s3-a").forEach { model.toggle("c:$it") }
        model.toggle("c:s3-b")
        assertEquals(5, model.state.value.selected.size)
        assertTrue(model.state.value.capHit)
    }

    @Test
    fun `leaving with nothing sent reports nothing`() {
        val model = viewModel(backendWith("s1"))
        model.finish()
        assertNull(model.done.value)
    }
}
