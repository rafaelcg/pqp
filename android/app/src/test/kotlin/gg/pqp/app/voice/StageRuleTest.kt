package gg.pqp.app.voice

import gg.pqp.app.core.PqpJson
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Who may put a screen on the stage, and it is a permission rather than a
 * transport.
 *
 * `screenShareSupported` used to be `transport == mesh`, which hid the share
 * button on exactly the rooms a watch party runs in: a listed community or a
 * server of ten or more is pinned to the SFU by
 * `server/src/voice/transport-policy.ts`, so a host on Android could not
 * present at the one event the feature exists for.
 *
 * The bit is `welcome.canStream`, which the server resolved through
 * `canStartWatchPartyStream`: STREAM in a plain voice channel and
 * START_WATCH_PARTY in a `watch_party` one. This client asks one question and
 * never compares channel types.
 */
class StageRuleTest {

    private fun frame(json: String): JsonObject =
        PqpJson.decodeFromString(JsonObject.serializer(), json)

    private val self = """"self":{"peerId":"p1","userId":"u1","displayName":"Ana""""

    // --- where the bit is read from ---------------------------------------

    @Test
    fun `the top level field wins`() {
        assertTrue(canStreamFrom(frame("""{"canSpeak":true,"canStream":true,$self}}""")))
        assertFalse(canStreamFrom(frame("""{"canSpeak":true,"canStream":false,$self}}""")))
    }

    @Test
    fun `then the participant's own copy`() {
        assertFalse(canStreamFrom(frame("""{"canSpeak":true,$self,"canStream":false}}""")))
        assertTrue(canStreamFrom(frame("""{"canSpeak":true,$self,"canStream":true}}""")))
    }

    /**
     * The shared schema's own rule: "Absent reads as `canSpeak`". A server
     * that predates the stage bit resolved everyone as allowed to present, and
     * refusing there would take the share button away from every self-host.
     */
    @Test
    fun `absent falls back to canSpeak, not to true`() {
        assertTrue(canStreamFrom(frame("""{"canSpeak":true,$self}}""")))
        assertFalse(canStreamFrom(frame("""{"canSpeak":false,$self}}""")))
    }

    @Test
    fun `absent everywhere is a server older than either bit`() {
        assertTrue(canStreamFrom(frame("""{$self}}""")))
    }

    /**
     * The ordinary watch party audience member: SPEAK from `@everyone`, and no
     * START_WATCH_PARTY. Exactly the person who must not be offered a button
     * whose only job is to raise Android's consent dialog.
     */
    @Test
    fun `a member who may talk and not present is refused the stage`() {
        assertTrue(canSpeakFrom(frame("""{"canSpeak":true,"canStream":false,$self}}""")))
        assertFalse(canStreamFrom(frame("""{"canSpeak":true,"canStream":false,$self}}""")))
    }

    // --- what a mid-call change does --------------------------------------

    @Test
    fun `losing SPEAK takes the stage with it`() {
        assertFalse(streamRule(canSpeak = false, next = true, was = true))
    }

    /**
     * `canStream` is optional on `voice-speak-changed`. Reading its absence as
     * false would retire the share button for every self-host the moment a
     * moderator touched anybody's microphone.
     */
    @Test
    fun `an absent canStream leaves the answer alone`() {
        assertTrue(streamRule(canSpeak = true, next = null, was = true))
        assertFalse(streamRule(canSpeak = true, next = null, was = false))
    }

    @Test
    fun `a present canStream is the answer in both directions`() {
        assertFalse(streamRule(canSpeak = true, next = false, was = true))
        assertTrue(streamRule(canSpeak = true, next = true, was = false))
    }

    // --- what the publication costs ---------------------------------------

    /**
     * On the SFU this phone uploads one copy however many people are watching,
     * so the ceiling does not move with the room. In a mesh it uploads a full
     * copy per peer, which is why that one divides. Getting these the same way
     * round is how a ceiling that scales wrongly ships after working fine with
     * two people in the call.
     */
    @Test
    fun `the SFU ceiling does not scale with the room and the mesh one does`() {
        assertEquals(sfuScreenBitrate(), sfuScreenBitrate())
        assertTrue(meshScreenBitrate(1) >= meshScreenBitrate(4))
        assertTrue(meshScreenBitrate(8) < meshScreenBitrate(1))
        assertEquals(meshScreenBitrate(1), sfuScreenBitrate())
    }
}
