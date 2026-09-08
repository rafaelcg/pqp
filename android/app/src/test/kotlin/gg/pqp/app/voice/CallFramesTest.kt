package gg.pqp.app.voice

import gg.pqp.app.core.PqpJson
import gg.pqp.app.protocol.RepoSources
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The ring frames, against `packages/shared/src/signaling.ts`.
 *
 * Read `RepoSources` for why these compare against the shared schemas rather
 * than against constants in this module. A ring is the one part of the
 * protocol with no visible failure when it is wrong: a renamed frame is
 * dropped in silence by a `when`, and the symptom is a phone that never rings,
 * which is indistinguishable from nobody calling.
 */
class CallFramesTest {

    private val signaling = "packages/shared/src/signaling.ts"

    private fun frame(json: String): JsonObject =
        PqpJson.decodeFromString(JsonObject.serializer(), json)

    @Test
    fun `the five call frames are still named what this client calls them`() {
        val declared = RepoSources.frameTypeLiterals(signaling)
        listOf(
            "call-ring",
            "call-decline",
            "call-incoming",
            "call-ring-cancelled",
            "call-declined",
        ).forEach { type ->
            assertTrue("$type is no longer declared in $signaling", type in declared)
        }
    }

    @Test
    fun `the two frames this client sends match the shared schemas`() {
        assertEquals(
            listOf("type", "conversationId"),
            RepoSources.objectKeys(signaling, "callRingMessageSchema"),
        )
        assertEquals(
            listOf("type", "conversationId"),
            RepoSources.objectKeys(signaling, "callDeclineMessageSchema"),
        )
        assertEquals(
            """{"type":"call-ring","conversationId":"c1"}""",
            PqpJson.encodeToString(JsonObject.serializer(), callRingFrame("c1")),
        )
        assertEquals(
            """{"type":"call-decline","conversationId":"c1"}""",
            PqpJson.encodeToString(JsonObject.serializer(), callDeclineFrame("c1")),
        )
    }

    /**
     * The caller summary is what the incoming card draws. A field renamed here
     * leaves a nameless, faceless ring rather than an error.
     */
    @Test
    fun `the caller summary fields match the shared schema`() {
        assertEquals(
            listOf("userId", "displayName", "avatarUrl"),
            RepoSources.objectKeys(signaling, "callerSummarySchema"),
        )
    }

    @Test
    fun `every ring-cancelled reason the server can send is understood`() {
        // Anchored on the schema by name. An unanchored `reason: z.enum([`
        // matched whichever schema came first in the file, which since
        // `voiceJoinRefusedMessageSchema` gained a reason is not this one.
        val source = RepoSources.stripComments(RepoSources.read(signaling))
        val block = source.substringAfter("callRingCancelledMessageSchema = z.object({", "")
            .substringBefore("});")
        val reasons = Regex("""reason:\s*z\.enum\(\[([^\]]*)]""")
            .find(block)
            ?.groupValues
            ?.get(1)
            ?.let { Regex(""""([^"]+)"""").findAll(it).map { m -> m.groupValues[1] }.toList() }
            ?: error("No reason enum on callRingCancelledMessageSchema")

        assertEquals(listOf("answered", "declined", "cancelled", "timeout"), reasons)
        reasons.forEach { reason ->
            assertTrue("No RingEnd for $reason", ringEndOf(reason) != null)
        }
    }

    @Test
    fun `both conversation kinds are understood`() {
        assertEquals(CallKind.Dm, callKindOf("dm"))
        assertEquals(CallKind.Group, callKindOf("group"))
        assertNull(callKindOf("server"))
    }

    @Test
    fun `an incoming ring decodes into the card's three facts`() {
        val decoded = decodeCallFrame(
            frame(
                """
                {"type":"call-incoming","conversationId":"c1","kind":"group",
                 "caller":{"userId":"u1","displayName":"Rafa","avatarUrl":null}}
                """.trimIndent(),
            ),
        )
        assertEquals(
            CallFrame.Incoming(
                IncomingCall("c1", CallKind.Group, CallerSummary("u1", "Rafa", null)),
            ),
            decoded,
        )
    }

    @Test
    fun `a cancel and a decline decode`() {
        assertEquals(
            CallFrame.RingCancelled("c1", RingEnd.Timeout),
            decodeCallFrame(frame("""{"type":"call-ring-cancelled","conversationId":"c1","reason":"timeout"}""")),
        )
        assertEquals(
            CallFrame.Declined("c1", "u2"),
            decodeCallFrame(frame("""{"type":"call-declined","conversationId":"c1","userId":"u2"}""")),
        )
    }

    /**
     * A frame missing something the surface cannot do without is dropped, not
     * thrown on. The socket carries chat as well as calls, and a throw in this
     * decoder would take the whole `frames` collector down with it.
     */
    @Test
    fun `a malformed or unrelated frame is ignored rather than thrown on`() {
        assertNull(decodeCallFrame(frame("""{"type":"message-create","channelId":"c1"}""")))
        assertNull(decodeCallFrame(frame("""{"type":"call-incoming","conversationId":"c1","kind":"dm"}""")))
        assertNull(
            decodeCallFrame(
                frame("""{"type":"call-incoming","kind":"dm","caller":{"userId":"u1","displayName":"R"}}"""),
            ),
        )
        assertNull(decodeCallFrame(frame("""{"type":"call-ring-cancelled","conversationId":"c1","reason":"nope"}""")))
        assertNull(decodeCallFrame(frame("""{"type":"call-declined","conversationId":"c1"}""")))
    }

    /**
     * The ring's clock, against the server that owns it. Ours only decides
     * when the caller's bar stops saying "Calling…"; a copy that outlives the
     * server's would leave it saying so after the missed call was recorded.
     */
    @Test
    fun `the ring timeout matches the server`() {
        val server = RepoSources.read("server/src/ws/voice.ts")
        val declared = Regex("""CALL_RING_TIMEOUT_MS\s*=\s*([\d_]+)""")
            .find(RepoSources.stripComments(server))
            ?.groupValues
            ?.get(1)
            ?.replace("_", "")
            ?.toLong()
            ?: error("No CALL_RING_TIMEOUT_MS in server/src/ws/voice.ts")
        assertEquals(declared, CALL_RING_TIMEOUT_MS)
    }

    /**
     * Accepting a ring is joining the room. If the server ever grows a real
     * accept frame this test is where that shows up, because the client's
     * whole answer path depends on there not being one.
     */
    @Test
    fun `accepting is still a join and not a frame of its own`() {
        val declared = RepoSources.frameTypeLiterals(signaling)
        assertTrue(
            "A call-accept frame now exists; CallMachine answers by joining the room instead",
            "call-accept" !in declared && "call-answer" !in declared,
        )
    }
}
