package gg.pqp.app.watch

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** [decodeWatchPartyPayload], the host's own read of the same frame [WatchPartySeatTest] covers for the seat rule. */
class WatchPartyModelsTest {

    private fun frame(party: String?): JsonObject = Json.parseToJsonElement(
        """{"type":"watch-party-update","channelId":"c1","party":${party ?: "null"}}""",
    ) as JsonObject

    private val partyJson = """
        {
          "id":"11111111-1111-1111-1111-111111111111","channelId":"c1","name":"Sessão de sábado",
          "state":"live","hostUserId":"22222222-2222-2222-2222-222222222222",
          "hostDisplayName":"Rafa","viewerRole":"host",
          "options":{"voiceEnabled":false,"stageMode":"hosts_only"},
          "stage":{"invited":[],"hands":[],"handRaised":false},
          "cohosts":[],"description":null,"startsAt":null
        }
    """.trimIndent()

    @Test
    fun `reads the fields the host UI needs, and ignores everything else on the object`() {
        val party = decodeWatchPartyPayload(frame(partyJson))!!
        assertEquals("11111111-1111-1111-1111-111111111111", party.id)
        assertEquals("c1", party.channelId)
        assertEquals("Sessão de sábado", party.name)
        assertEquals("live", party.state)
        assertEquals("22222222-2222-2222-2222-222222222222", party.hostUserId)
        assertEquals("Rafa", party.hostDisplayName)
        assertEquals("host", party.viewerRole)
    }

    @Test
    fun `party null means nothing running here any more`() {
        assertNull(decodeWatchPartyPayload(frame(null)))
    }

    @Test
    fun `a frame this build cannot make sense of does not throw`() {
        val junk = Json.parseToJsonElement(
            """{"type":"watch-party-update","channelId":"c1","party":"nonsense"}""",
        ) as JsonObject
        assertNull(decodeWatchPartyPayload(junk))
    }

    @Test
    fun `a party missing a required field is unreadable rather than half-decoded`() {
        val missingHost = frame(
            """{"id":"p1","channelId":"c1","name":"x","state":"draft"}""",
        )
        assertNull(decodeWatchPartyPayload(missingHost))
    }
}
