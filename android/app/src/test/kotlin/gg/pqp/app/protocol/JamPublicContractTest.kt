package gg.pqp.app.protocol

import gg.pqp.app.core.PqpJson
import gg.pqp.app.jam.AckJamTakeNoticeRequest
import gg.pqp.app.jam.JamInstrument
import gg.pqp.app.jam.JamPublicFrame
import gg.pqp.app.jam.JamPublicInboxItem
import gg.pqp.app.jam.JamPublicInboxResponse
import gg.pqp.app.jam.JamPublicMeConfig
import gg.pqp.app.jam.JamPublicNoticeKind
import gg.pqp.app.jam.JamPublication
import gg.pqp.app.jam.JamTakeNotice
import gg.pqp.app.jam.JamTakeNoticeKind
import gg.pqp.app.jam.JamTakeNoticesResponse
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.elementNames
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The take notices against `packages/shared/src/jam-public.ts`, field by field, the way `JamContractTest` holds the
 * private model: a rename on the server must fail here, not decode to a default on a phone.
 *
 * The two frames (`jam-public-notice`, `jam-take-decision`) are not members of `chatServerMessageSchema`, so
 * `WireProtocolTest`'s scan cannot see them on its own: they are named in its floor and held here against the
 * schemas.
 */
class JamPublicContractTest {

    private val shared = "packages/shared/src/jam-public.ts"

    private fun assertSubset(serializer: KSerializer<*>, schema: String) {
        val schemaKeys = RepoSources.objectKeys(shared, schema).toSet()
        val kotlinKeys = serializer.descriptor.elementNames.toSet()
        assertEquals(
            "${serializer.descriptor.serialName} names fields $schema does not have",
            emptySet<String>(),
            kotlinKeys - schemaKeys,
        )
    }

    @Test
    fun `the models match the shared schemas`() {
        assertSubset(JamTakeNotice.serializer(), "jamTakeNoticeSchema")
        assertSubset(JamTakeNoticesResponse.serializer(), "jamTakeNoticesResponseSchema")
        assertSubset(JamPublicInboxItem.serializer(), "jamPublicInboxItemSchema")
        assertSubset(JamPublicInboxResponse.serializer(), "jamPublicInboxResponseSchema")
        assertSubset(JamPublicMeConfig.serializer(), "jamPublicMeConfigSchema")
        assertSubset(JamPublication.serializer(), "jamPublicationSchema")
    }

    /** What the phone WRITES to spend an item: exactly the schema's one field. */
    @Test
    fun `the ack names the one field the schema has`() {
        assertEquals(setOf("id"), RepoSources.objectKeys(shared, "ackJamTakeNoticeSchema").toSet())
        assertEquals(
            """{"id":"n1"}""",
            PqpJson.encodeToString(AckJamTakeNoticeRequest.serializer(), AckJamTakeNoticeRequest("n1")),
        )
    }

    @Test
    fun `a notice item reads every field the server sends`() {
        // Fields of the shared item this build reads: all of them (a count and an instrument list are what the card says).
        val read = JamTakeNotice.serializer().descriptor.elementNames.toSet()
        assertEquals(emptySet<String>(), RepoSources.objectKeys(shared, "jamTakeNoticeSchema").toSet() - read)
    }

    @Test
    fun `the kinds are the shared enums`() {
        assertEquals(literals("JAM_TAKE_NOTICE_KINDS"), JamTakeNoticeKind.entries.map { it.wire })
        assertEquals(literals("JAM_PUBLIC_NOTICE_KINDS"), JamPublicNoticeKind.entries.map { it.wire })
    }

    private fun literals(name: String): List<String> =
        Regex("\"([a-z-]+)\"").findAll(RepoSources.read(shared).substringAfter("export const $name = [").substringBefore("]"))
            .map { it.groupValues[1] }
            .toList()

    // --- decoding what the server sends ---

    private fun frame(json: String): JsonObject = PqpJson.parseToJsonElement(json).jsonObject

    @Test
    fun `a list of items decodes, an unknown kind reads as take and an unknown instrument as other`() {
        val answer = PqpJson.decodeFromString(
            JamTakeNoticesResponse.serializer(),
            """{"notices":[
              {"id":"n1","kind":"take","songId":"s1","title":"Lua cheia","instruments":["bass","drums"],"count":2,
               "createdAt":"2026-11-27T10:00:00.000Z","updatedAt":"2026-11-27T10:05:00.000Z","somethingNew":1},
              {"id":"n2","kind":"accepted","songId":"s2","title":"Outra","instruments":["theremin"],"count":1,
               "createdAt":"2026-11-27T10:00:00.000Z","updatedAt":"2026-11-27T10:00:00.000Z"},
              {"id":"n3","kind":"from-the-future","songId":"s3","title":"x","instruments":[],"count":1,
               "createdAt":"2026-11-27T10:00:00.000Z","updatedAt":"2026-11-27T10:00:00.000Z"}]}""",
        )
        assertEquals(listOf(JamTakeNoticeKind.Take, JamTakeNoticeKind.Accepted, JamTakeNoticeKind.Take), answer.notices.map { it.kind })
        assertEquals(listOf(JamInstrument.Bass, JamInstrument.Drums), answer.notices[0].instruments)
        assertEquals(2, answer.notices[0].count)
        assertEquals(listOf(JamInstrument.Other), answer.notices[1].instruments)
        assertTrue(answer.notices[0].updatedAtMs > 0)
    }

    @Test
    fun `an inbox item carries the private track shape`() {
        val answer = PqpJson.decodeFromString(
            JamPublicInboxResponse.serializer(),
            """{"takes":[{"songId":"s1","songTitle":"Lua cheia","track":{"id":"t1","songId":"s1","authorId":"u2",
              "authorName":"bob","instrument":"bass","audioUrl":"https://b/a.flac","audioContentType":"audio/flac",
              "audioBytes":10,"mediaExpiresAt":"2026-11-27T11:00:00.000Z","offsetMs":0,"trimStartMs":0,"trimEndMs":0,
              "durationMs":8000,"gain":1,"peaks":[],"inMix":false,"voteCount":0,"createdAt":"2026-11-27T10:00:00.000Z"}}]}""",
        )
        val item = answer.takes.single()
        assertEquals("s1", item.songId)
        assertEquals(JamInstrument.Bass, item.track.instrument)
        assertFalse(item.track.inMix)
    }

    @Test
    fun `the take frame decodes with and without the instrument`() {
        val notice = JamPublicFrame.decode(
            frame("""{"type":"jam-public-notice","kind":"take","songId":"s1","title":"Lua cheia","trackId":"t1","reason":null,"admitted":false,"instrument":"bass"}"""),
        ) as JamPublicFrame.Notice
        assertEquals(JamPublicNoticeKind.Take, notice.kind)
        assertEquals("s1", notice.songId)
        assertEquals("Lua cheia", notice.title)
        assertEquals("t1", notice.trackId)
        assertNull(notice.reason)
        assertFalse(notice.admitted)
        assertEquals(JamInstrument.Bass, notice.instrument)

        // A server that predates `instrument` and `admitted` sends neither: additive, so nothing is lost.
        val old = JamPublicFrame.decode(frame("""{"type":"jam-public-notice","kind":"take","songId":"s1","title":"x"}""")) as JamPublicFrame.Notice
        assertNull(old.instrument)
        assertFalse(old.admitted)

        val admitted = JamPublicFrame.decode(
            frame("""{"type":"jam-public-notice","kind":"take","songId":"s1","title":"x","admitted":true}"""),
        ) as JamPublicFrame.Notice
        assertTrue(admitted.admitted)
    }

    @Test
    fun `an unknown notice kind reads as consent, the schema's own catch`() {
        val notice = JamPublicFrame.decode(frame("""{"type":"jam-public-notice","kind":"from-the-future","songId":"s1","title":"x"}"""))
            as JamPublicFrame.Notice
        assertEquals(JamPublicNoticeKind.Consent, notice.kind)
    }

    @Test
    fun `the sender's frame is its own type and decodes both decisions`() {
        val accepted = JamPublicFrame.decode(
            frame("""{"type":"jam-take-decision","decision":"accepted","songId":"s1","title":"Lua cheia","instrument":"drums"}"""),
        )
        assertEquals(JamPublicFrame.Decision(true, "s1", "Lua cheia", JamInstrument.Drums), accepted)
        val refused = JamPublicFrame.decode(
            frame("""{"type":"jam-take-decision","decision":"refused","songId":"s1","title":"Lua cheia","instrument":"theremin"}"""),
        )
        assertEquals(JamPublicFrame.Decision(false, "s1", "Lua cheia", JamInstrument.Other), refused)
    }

    @Test
    fun `a frame that does not decode, or is not one of these, is dropped quietly`() {
        assertNull(JamPublicFrame.decode(frame("""{"type":"jam-public-notice","kind":"take"}""")))
        assertNull(JamPublicFrame.decode(frame("""{"type":"jam-take-decision","decision":"maybe","songId":"s1","title":"x","instrument":"bass"}""")))
        assertNull(JamPublicFrame.decode(frame("""{"type":"jam-song-created","channelId":"c1"}""")))
        assertTrue(JamPublicFrame.isPublic(frame("""{"type":"jam-take-decision"}""")))
        assertTrue(JamPublicFrame.isPublic(frame("""{"type":"jam-public-notice"}""")))
        assertFalse(JamPublicFrame.isPublic(frame("""{"type":"jam-track-added"}""")))
    }

    /** Both frames are declared by the shared package and have a `when` branch the handled-frames scan finds. */
    @Test
    fun `both public frames are declared in shared and handled by the app`() {
        val frames = setOf("jam-public-notice", "jam-take-decision")
        assertEquals(emptySet<String>(), frames - RepoSources.sharedFrameTypeLiterals())
        assertEquals(emptySet<String>(), frames - RepoSources.frameTypesHandled())
    }
}
