package gg.pqp.app.unread

import gg.pqp.app.core.ServerSummary
import gg.pqp.app.ui.screens.channels.ChannelUnread
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerUnreadTest {

    private fun server(id: String) =
        ServerSummary(id = id, name = id, ownerId = "o", createdAt = "2026-01-01T00:00:00Z")

    private fun unread(channel: String, count: Int, mentions: Int = 0) = ChannelUnread(channel, count, mentions)

    // ---- the rules

    @Test
    fun `a server adds up its channels, a mute hides a channel's mentions too`() {
        val channels = listOf(unread("a", 3, 1), unread("b", 2, 2), unread("c", 0, 1))
        assertEquals(ServerUnreadSummary(5, 4), ServerUnreadRules.summarize(channels, emptySet()))
        assertEquals(ServerUnreadSummary(3, 2), ServerUnreadRules.summarize(channels, setOf("b")))
        assertEquals(ServerUnreadSummary(0, 0), ServerUnreadRules.summarize(channels, setOf("a", "b", "c")))
    }

    @Test
    fun `a mention with no count is still news`() {
        assertTrue(ServerUnreadRules.summarize(listOf(unread("f", 0, 1)), emptySet()).hasUnread)
        assertFalse(ServerUnreadRules.summarize(emptyList(), emptySet()).hasUnread)
    }

    @Test
    fun `a pass reads the servers in order, skips muted ones and stops at thirty`() {
        val servers = (1..40).map { server("s$it") }
        val targets = ServerUnreadRules.targets(servers, mutedServers = setOf("s2"))
        assertEquals(ServerUnreadRules.MAX_SERVERS, targets.size)
        assertEquals("s1", targets.first())
        assertFalse("s2" in targets)
    }

    @Test
    fun `only none silences a server`() {
        assertEquals(setOf("x"), ServerUnreadRules.mutedServerIds(mapOf("x" to "none", "y" to "mentions", "z" to "all")))
        assertEquals(emptySet<String>(), ServerUnreadRules.mutedServerIds(null))
    }

    @Test
    fun `a frame adds one, and one mention when it was one`() {
        assertEquals(ServerUnreadSummary(1, 0), ServerUnreadRules.bumped(null, mention = false))
        assertEquals(ServerUnreadSummary(3, 1), ServerUnreadRules.bumped(ServerUnreadSummary(2, 0), mention = true))
    }

    // ---- the store

    private class Fixture(
        val answers: MutableMap<String, List<ChannelUnread>> = HashMap(),
        var mutedChannels: Set<String> = emptySet(),
        var mutedServers: Set<String> = emptySet(),
    ) {
        var clock = 1_000L
        val reads = mutableListOf<String>()
        var failing: Set<String> = emptySet()
        var gate: CompletableDeferred<Unit>? = null
        var user: String? = "me"
        private val job: Job = SupervisorJob()

        val store = ServerUnreadStore(
            scope = CoroutineScope(job + Dispatchers.Unconfined),
            readServer = { id ->
                reads += id
                // The answer is what the server held when the request LEFT.
                val answer = answers[id].orEmpty()
                gate?.await()
                if (id in failing) throw IOException("offline")
                answer
            },
            muted = { mutedChannels to mutedServers },
            userId = { user },
            now = { clock },
        )
    }

    @Test
    fun `the list reads every server once and shows what has news`() {
        val f = Fixture()
        f.answers["a"] = listOf(unread("a1", 2, 1))
        f.answers["b"] = emptyList()
        f.store.hydrate(listOf(server("a"), server("b")))
        assertEquals(listOf("a", "b"), f.reads)
        assertEquals(mapOf("a" to ServerUnreadSummary(2, 1)), f.store.unread.value)
    }

    @Test
    fun `it does not read again inside the interval, but does after it`() {
        val f = Fixture()
        f.answers["a"] = listOf(unread("a1", 1))
        val list = listOf(server("a"))
        f.store.hydrate(list)
        f.store.hydrate(list)
        assertEquals(1, f.reads.size)

        f.clock += ServerUnreadRules.REFRESH_AFTER_MS
        f.store.hydrate(list)
        assertEquals(2, f.reads.size)
    }

    @Test
    fun `a server somebody just read in is read again at once, and the others are not`() {
        val f = Fixture()
        f.answers["a"] = listOf(unread("a1", 4))
        f.answers["b"] = listOf(unread("b1", 1))
        val list = listOf(server("a"), server("b"))
        f.store.hydrate(list)
        f.reads.clear()

        f.answers["a"] = emptyList()
        f.store.markStale("a")
        f.store.hydrate(list)
        assertEquals(listOf("a"), f.reads)
        assertEquals(mapOf("b" to ServerUnreadSummary(1, 0)), f.store.unread.value)
    }

    @Test
    fun `pull to refresh ignores the interval`() {
        val f = Fixture()
        f.store.hydrate(listOf(server("a")))
        f.store.hydrate(listOf(server("a")), force = true)
        assertEquals(2, f.reads.size)
    }

    @Test
    fun `a failed read keeps the badge that was on screen and asks again next time`() {
        val f = Fixture()
        f.answers["a"] = listOf(unread("a1", 3))
        val list = listOf(server("a"))
        f.store.hydrate(list)
        f.failing = setOf("a")
        f.store.markStale("a")
        f.store.hydrate(list)
        assertEquals(ServerUnreadSummary(3, 0), f.store.unread.value["a"])

        f.failing = emptySet()
        f.answers["a"] = emptyList()
        f.store.hydrate(list)
        assertTrue("the failed one is retried without waiting for the interval", f.store.unread.value.isEmpty())
    }

    @Test
    fun `a muted server is not read and shows nothing, a muted channel counts for nothing`() {
        val f = Fixture(mutedServers = setOf("quiet"), mutedChannels = setOf("b1"))
        f.answers["quiet"] = listOf(unread("q1", 9))
        f.answers["a"] = listOf(unread("a1", 1), unread("b1", 5, 2))
        f.store.hydrate(listOf(server("quiet"), server("a")))
        assertEquals(listOf("a"), f.reads)
        assertEquals(mapOf("a" to ServerUnreadSummary(1, 0)), f.store.unread.value)
    }

    @Test
    fun `a server the account left stops showing`() {
        val f = Fixture()
        f.answers["a"] = listOf(unread("a1", 1))
        f.answers["b"] = listOf(unread("b1", 1))
        f.store.hydrate(listOf(server("a"), server("b")))
        f.store.hydrate(listOf(server("b")), force = true)
        assertEquals(setOf("b"), f.store.unread.value.keys)
    }

    @Test
    fun `live frames add to a server, unless the channel or the server is muted`() {
        val f = Fixture(mutedChannels = setOf("quiet-channel"))
        f.store.bump("a", "c1", mention = false)
        f.store.bump("a", "c2", mention = true)
        f.store.bump("a", "quiet-channel", mention = true)
        assertEquals(ServerUnreadSummary(2, 1), f.store.unread.value["a"])

        f.mutedServers = setOf("a")
        f.store.bump("a", "c3", mention = true)
        assertEquals(ServerUnreadSummary(2, 1), f.store.unread.value["a"])
    }

    @Test
    fun `a frame that lands while a read is out is not lost to a stale answer`() {
        val f = Fixture()
        f.answers["a"] = listOf(unread("a1", 1))
        f.gate = CompletableDeferred()
        f.store.hydrate(listOf(server("a")))
        f.store.bump("a", "a1", mention = true)
        assertEquals(ServerUnreadSummary(1, 1), f.store.unread.value["a"])

        // The answer predates the frame: it says one unread, no mention.
        f.gate!!.complete(Unit)
        assertEquals(ServerUnreadSummary(1, 1), f.store.unread.value["a"])
    }

    @Test
    fun `another account starts from nothing`() {
        val f = Fixture()
        f.answers["a"] = listOf(unread("a1", 3))
        f.store.hydrate(listOf(server("a")))
        assertEquals(setOf("a"), f.store.unread.value.keys)

        f.user = "somebody-else"
        f.answers["a"] = emptyList()
        f.store.hydrate(listOf(server("z")))
        assertTrue(f.store.unread.value.isEmpty())
    }

    @Test
    fun `the cap limits what is read, not what is kept`() {
        val f = Fixture()
        val servers = (1..35).map { server("s$it") }
        f.store.bump("s35", "c", mention = true)
        f.store.hydrate(servers)
        assertEquals(ServerUnreadRules.MAX_SERVERS, f.reads.size)
        assertEquals(ServerUnreadSummary(1, 1), f.store.unread.value["s35"])
    }

    @Test
    fun `an older read of a server cannot overwrite a newer one`() {
        val f = Fixture()
        f.answers["a"] = listOf(unread("a1", 5))
        val slow = CompletableDeferred<Unit>()
        f.gate = slow
        f.store.hydrate(listOf(server("a")))
        // While that read is out, the person reads a channel and the list asks again:
        // this second read answers at once, with nothing unread.
        f.gate = null
        f.answers["a"] = emptyList()
        f.store.markStale("a")
        f.store.hydrate(listOf(server("a")))
        assertTrue(f.store.unread.value.isEmpty())

        // The first read finally lands with its old answer: dropped.
        slow.complete(Unit)
        assertTrue(f.store.unread.value.isEmpty())
    }
}
