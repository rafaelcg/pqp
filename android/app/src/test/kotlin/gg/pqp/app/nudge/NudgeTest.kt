package gg.pqp.app.nudge

import gg.pqp.app.core.Message
import gg.pqp.app.core.PqpJson
import gg.pqp.app.protocol.RepoSources
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import kotlinx.coroutines.async
import org.junit.Test

/**
 * Chamar a atenção on Android against `packages/shared/src/nudge.ts`: the same
 * freshness table every client pins, the refusal tokens, the constants, and
 * the two routes the phone reads.
 */
class NudgeTest {

    private val shared = "packages/shared/src/nudge.ts"
    private val now = Instant.parse("2026-10-12T21:00:00.000Z").toEpochMilli()

    private fun message(
        author: String = "them",
        kind: String? = "nudge",
        createdAt: String = "2026-10-12T20:59:55.000Z",
    ) = Message(
        id = "m",
        channelId = "c",
        authorId = author,
        authorName = "Gabi",
        body = "📳",
        createdAt = createdAt,
        systemKind = kind,
    )

    @Test
    fun `a fresh nudge from somebody else shakes`() {
        assertTrue(Nudge.isFresh(message(), "me", now))
    }

    @Test
    fun `my own nudge never shakes my screen`() {
        assertFalse(Nudge.isFresh(message(author = "me"), "me", now))
    }

    @Test
    fun `an ordinary message or an unknown kind is not a nudge`() {
        assertFalse(Nudge.isFresh(message(kind = null), "me", now))
        assertFalse(Nudge.isFresh(message(kind = "something-later"), "me", now))
    }

    @Test
    fun `history older than fifteen seconds is a line only`() {
        assertFalse(Nudge.isFresh(message(createdAt = "2026-10-12T20:59:45.000Z"), "me", now))
        assertTrue(Nudge.isFresh(message(createdAt = "2026-10-12T20:59:45.001Z"), "me", now))
    }

    @Test
    fun `a server clock a little ahead still shakes, a broken date does not`() {
        assertTrue(Nudge.isFresh(message(createdAt = "2026-10-12T21:00:10.000Z"), "me", now))
        assertFalse(Nudge.isFresh(message(createdAt = "2026-10-12T21:00:16.000Z"), "me", now))
        assertFalse(Nudge.isFresh(message(createdAt = "yesterday"), "me", now))
    }

    @Test
    fun `quick taps reach the server in the order they were made, the last one staying`() = kotlinx.coroutines.test.runTest {
        val writer = AllowNudgesWriter()
        val written = mutableListOf<Boolean>()
        val firstGate = kotlinx.coroutines.CompletableDeferred<Unit>()
        // The first write is slow; the second must still go out after it.
        val first = async {
            writer.set(false) {
                firstGate.await()
                written += it
            }
        }
        val second = async { writer.set(true) { written += it } }
        testScheduler.runCurrent()
        assertEquals(emptyList<Boolean>(), written)
        firstGate.complete(Unit)
        assertTrue(first.await())
        assertTrue(second.await())
        assertEquals(listOf(false, true), written)
    }

    @Test
    fun `only the newest write failing is a failure the switch has to undo`() = kotlinx.coroutines.test.runTest {
        val writer = AllowNudgesWriter()
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        val older = async {
            writer.set(false) {
                gate.await()
                error("network")
            }
        }
        val newer = async { writer.set(true) { } }
        testScheduler.runCurrent()
        gate.complete(Unit)
        // The older one failed, but a newer value was already queued behind it.
        assertTrue(older.await())
        assertTrue(newer.await())
        assertFalse(writer.set(false) { error("network") })
    }

    @Test
    fun `two quick taps that both fail leave the switch where the server is`() = kotlinx.coroutines.test.runTest {
        val writer = AllowNudgesWriter()
        writer.confirmed = true // what /api/me said
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        val off = async {
            writer.set(false) {
                gate.await()
                error("network")
            }
        }
        val on = async { writer.set(true) { error("network") } }
        testScheduler.runCurrent()
        gate.complete(Unit)
        assertTrue(off.await())
        assertFalse(on.await())
        // Roll back to the server's value, not to "off", the optimistic value
        // the second tap replaced.
        assertEquals(true, writer.confirmed)
        // A success moves the confirmed value.
        assertTrue(writer.set(false) { })
        assertEquals(false, writer.confirmed)
    }

    @Test
    fun `the button rests for the cooldown after a send that left, not after one that did not`() {
        assertEquals(1_000L + Nudge.COOLDOWN_MS, Nudge.holdAfterSend(left = true, nowMs = 1_000L))
        assertEquals(0L, Nudge.holdAfterSend(left = false, nowMs = 1_000L))
    }

    @Test
    fun `a cooldown refusal says when, any other refusal frees the button`() {
        assertEquals(4_000L, Nudge.holdAfterRefusal(retryAfterMs = 3_000L, nowMs = 1_000L))
        assertEquals(0L, Nudge.holdAfterRefusal(retryAfterMs = 0L, nowMs = 1_000L))
    }

    @Test
    fun `refusal tokens are the shared ones, and anything else reads as unavailable`() {
        val source = RepoSources.stripComments(RepoSources.read(shared))
        val list = Regex("""NUDGE_REFUSAL_REASONS\s*=\s*\[([^\]]*)]""").find(source)!!.groupValues[1]
        val declared = Regex(""""([^"]+)"""").findAll(list).map { it.groupValues[1] }.toList()
        assertEquals(declared, NudgeRefusalReason.entries.map { it.wire })
        assertEquals(NudgeRefusalReason.Unavailable, NudgeRefusalReason.fromWire("a-new-reason"))
        assertEquals(NudgeRefusalReason.SelfOff, NudgeRefusalReason.fromWire("self-off"))
    }

    @Test
    fun `the timings match the shared contract`() {
        val source = RepoSources.stripComments(RepoSources.read(shared))
        fun constant(name: String) =
            Regex("""const\s+$name\s*=\s*([\d_]+)""").find(source)!!.groupValues[1].replace("_", "").toLong()
        assertEquals(constant("NUDGE_FRESH_MS"), Nudge.FRESH_MS)
        assertEquals(constant("NUDGE_COOLDOWN_MS"), Nudge.COOLDOWN_MS)
        assertTrue(source.contains("\"${Nudge.SYSTEM_KIND}\""))
    }

    @Test
    fun `a message carries its system kind, and an older API omits it`() {
        val nudge = PqpJson.decodeFromString(
            Message.serializer(),
            """{"id":"m","channelId":"c","authorId":"a","authorName":"Gabi","body":"📳",
               "createdAt":"2026-10-12T20:59:55.000Z","systemKind":"nudge"}""",
        )
        assertTrue(Nudge.isNudge(nudge))
        val plain = PqpJson.decodeFromString(
            Message.serializer(),
            """{"id":"m","channelId":"c","authorId":"a","authorName":"Gabi","body":"oi",
               "createdAt":"2026-10-12T20:59:55.000Z"}""",
        )
        assertNull(plain.systemKind)
    }

    @Test
    fun `the fun config route still answers nudge, and preferences still take allowNudges`() {
        val api = RepoSources.read("server/src/api/index.ts")
        val route = api.substringAfter("router.get(\"/api/fun/config\"").substringBefore("}));")
        assertTrue("GET /api/fun/config no longer sends nudge", route.contains("nudge:"))
        val shapes = RepoSources.stripComments(RepoSources.read("packages/shared/src/api.ts"))
        assertTrue(shapes.substringAfter("userPreferencesSchema").contains("allowNudges:"))
    }
}
