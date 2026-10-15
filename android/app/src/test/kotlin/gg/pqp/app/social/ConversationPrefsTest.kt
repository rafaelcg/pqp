package gg.pqp.app.social

import gg.pqp.app.core.ApiException
import gg.pqp.app.core.MeNotificationPreferences
import gg.pqp.app.core.MePreferences
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationPrefsTest {

    private fun dm(id: String) = DmSummary(channelId = id)

    // ---- the pure rules

    @Test
    fun `fixadas come first in pin order, the rest keep their recency order`() {
        val list = listOf(dm("a"), dm("b"), dm("c"), dm("d"))
        val (pinned, recent) = ConversationPins.split(list, pinned = listOf("c", "a"))
        assertEquals(listOf("c", "a"), pinned.map { it.channelId })
        assertEquals(listOf("b", "d"), recent.map { it.channelId })
    }

    @Test
    fun `a pin the list does not hold, or twice, draws nothing`() {
        val list = listOf(dm("a"), dm("b"))
        val (pinned, recent) = ConversationPins.split(list, pinned = listOf("zzz", "b", "b"))
        assertEquals(listOf("b"), pinned.map { it.channelId })
        assertEquals(listOf("a"), recent.map { it.channelId })
    }

    @Test
    fun `a new pin goes to the front, a pinned one comes off, and fifteen is the most`() {
        assertEquals(listOf("c", "a", "b"), ConversationPins.toggled(listOf("a", "b"), "c"))
        assertEquals(listOf("b"), ConversationPins.toggled(listOf("a", "b"), "a"))
        val full = (1..ConversationPins.MAX).map { "p$it" }
        assertNull(ConversationPins.toggled(full, "extra"))
        // Unpinning from a full list still works.
        assertEquals(full.drop(1), ConversationPins.toggled(full, "p1"))
    }

    @Test
    fun `a mute puts none on the channel, an unmute takes only none off`() {
        val levels = mapOf("a" to "mentions", "b" to "none")
        assertEquals(
            mapOf("a" to "none", "b" to "none"),
            ConversationPrefs.applyMutes(levels, mapOf("a" to true)),
        )
        assertEquals(mapOf("a" to "mentions"), ConversationPrefs.applyMutes(levels, mapOf("b" to false)))
        // A level somebody chose that is not a mute stays.
        assertEquals(levels, ConversationPrefs.applyMutes(levels, mapOf("a" to false)))
    }

    @Test
    fun `a muted conversation is not waiting`() {
        val list = listOf(
            dm("a").copy(unread = UnreadCounts(count = 2)),
            dm("b").copy(unread = UnreadCounts(count = 5)),
            dm("c"),
        )
        assertEquals(2, ConversationList.waiting(list))
        assertEquals(1, ConversationList.waiting(list, muted = setOf("b")))
    }

    // ---- the actor

    private class FakeBackend : ConversationPrefsBackend {
        var user: String? = "me"
        var pins: List<String> = emptyList()
        var levels: Map<String, String> = emptyMap()

        /** What the "server" holds. */
        var serverPins: List<String> = emptyList()
        var serverLevels: Map<String, String> = emptyMap()
        var failPins: Throwable? = null
        var failLevels: Throwable? = null
        var freshFails = false
        var gate: CompletableDeferred<Unit>? = null
        val pinSaves = mutableListOf<List<String>>()
        val levelSaves = mutableListOf<Map<String, String>>()

        override fun userId() = user
        override fun pinned() = pins
        override fun channelLevels() = levels
        override fun setPinned(ids: List<String>) {
            pins = ids
        }

        override fun setChannelLevels(levels: Map<String, String>) {
            this.levels = levels
        }

        override suspend fun savePinned(ids: List<String>): MePreferences {
            gate?.await()
            failPins?.let { throw it }
            pinSaves += ids
            serverPins = ids
            return MePreferences(pinnedConversations = serverPins)
        }

        override suspend fun freshChannelLevels(): Map<String, String>? = if (freshFails) null else serverLevels

        override suspend fun saveChannelLevels(levels: Map<String, String>): MePreferences {
            gate?.await()
            failLevels?.let { throw it }
            levelSaves += levels
            serverLevels = levels
            return MePreferences(notifications = MeNotificationPreferences(channels = serverLevels))
        }
    }

    private fun actor(backend: FakeBackend) =
        ConversationPrefs(backend, CoroutineScope(SupervisorJob() + Dispatchers.Unconfined))

    @Test
    fun `a pin lands at once and is saved whole`() {
        val backend = FakeBackend()
        backend.pins = listOf("a")
        backend.serverPins = listOf("a")
        val outcome = actor(backend).togglePin("b") { error("no error expected: $it") }
        assertEquals(PrefOutcome.Done, outcome)
        assertEquals(listOf("b", "a"), backend.pins)
        assertEquals(listOf(listOf("b", "a")), backend.pinSaves)
    }

    @Test
    fun `a sixteenth pin is refused and nothing is sent`() {
        val backend = FakeBackend()
        backend.pins = (1..ConversationPins.MAX).map { "p$it" }
        val outcome = actor(backend).togglePin("extra") { }
        assertEquals(PrefOutcome.PinLimit, outcome)
        assertEquals(ConversationPins.MAX, backend.pins.size)
        assertTrue(backend.pinSaves.isEmpty())
    }

    @Test
    fun `a refused pin goes back to what the server confirmed and says why`() {
        val backend = FakeBackend()
        backend.pins = listOf("a")
        backend.serverPins = listOf("a")
        backend.failPins = ApiException(429, "Slow down")
        var said: String? = null
        actor(backend).togglePin("b") { said = it }
        assertEquals(listOf("a"), backend.pins)
        assertEquals("Slow down", said)
    }

    @Test
    fun `two quick taps save in turn and the last one wins`() {
        val backend = FakeBackend()
        val gate = CompletableDeferred<Unit>()
        backend.gate = gate
        val prefs = actor(backend)
        prefs.togglePin("a") { }
        prefs.togglePin("b") { }
        // Both are on screen at once, the saves are waiting.
        assertEquals(listOf("b", "a"), backend.pins)
        gate.complete(Unit)
        // In turn, never overtaking: the first save was already out with "a" when the
        // second tap came; the second sends what the session holds when its turn comes.
        assertEquals(listOf(listOf("a"), listOf("b", "a")), backend.pinSaves)
        assertEquals(listOf("b", "a"), backend.serverPins)
    }

    @Test
    fun `a mute is saved on top of the levels the server holds now, not the ones from sign in`() {
        val backend = FakeBackend()
        backend.levels = mapOf("old" to "none")
        // Muted on the web a minute ago: the phone has not heard.
        backend.serverLevels = mapOf("old" to "none", "fromWeb" to "none", "mentionsOnly" to "mentions")
        actor(backend).toggleMute("c1", muted = true) { error(it) }
        assertEquals(
            mapOf("old" to "none", "fromWeb" to "none", "mentionsOnly" to "mentions", "c1" to "none"),
            backend.levelSaves.single(),
        )
        assertEquals(backend.serverLevels, backend.levels)
    }

    @Test
    fun `an unmute removes the level and keeps everything else`() {
        val backend = FakeBackend()
        backend.levels = mapOf("c1" to "none", "c2" to "mentions")
        backend.serverLevels = backend.levels
        actor(backend).toggleMute("c1", muted = false) { error(it) }
        assertEquals(mapOf("c2" to "mentions"), backend.levelSaves.single())
    }

    @Test
    fun `a refused mute goes back, and an unreadable server map falls back to what was confirmed`() {
        val backend = FakeBackend()
        backend.levels = mapOf("c2" to "none")
        backend.serverLevels = mapOf("c2" to "none")
        backend.failLevels = ApiException(500, "boom")
        var said: String? = null
        val prefs = actor(backend)
        prefs.toggleMute("c1", muted = true) { said = it }
        assertEquals(mapOf("c2" to "none"), backend.levels)
        assertEquals("boom", said)

        backend.failLevels = null
        backend.freshFails = true
        prefs.toggleMute("c1", muted = true) { error(it) }
        assertEquals(mapOf("c2" to "none", "c1" to "none"), backend.levelSaves.single())
    }

    @Test
    fun `a different account starts the actor over`() {
        val backend = FakeBackend()
        backend.pins = listOf("a")
        backend.serverPins = listOf("a")
        val prefs = actor(backend)
        prefs.togglePin("b") { }

        backend.user = "somebody-else"
        backend.pins = listOf("x")
        backend.serverPins = listOf("x")
        backend.failPins = ApiException(500, "boom")
        prefs.togglePin("y") { }
        // Rolled back to what THIS account had, not to the last account's pins.
        assertEquals(listOf("x"), backend.pins)
    }
}
