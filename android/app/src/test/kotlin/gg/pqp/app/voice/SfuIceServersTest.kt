package gg.pqp.app.voice

import gg.pqp.app.core.IceServer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The relay rule for a LiveKit join, pinned.
 *
 * Both wrong answers are silent. Passing the API's list when it has no relay
 * replaces the SFU's own TURN with nothing, and the call still connects on
 * every network but the one that needed a relay. Passing nothing when the list
 * has one is what shipped: the media box's relay and a Cloudflare credential
 * nobody used.
 */
class SfuIceServersTest {
    private val stun = IceServer(urls = JsonPrimitive("stun:stun.l.google.com:19302"))
    private val cloudflare = IceServer(
        urls = JsonArray(
            listOf(
                JsonPrimitive("turn:turn.cloudflare.com:3478?transport=udp"),
                JsonPrimitive("turns:turn.cloudflare.com:5349"),
            ),
        ),
        username = "u",
        credential = "c",
    )

    @Test
    fun `a list with a relay is handed over whole`() {
        assertEquals(listOf(stun, cloudflare), sfuIceServers(listOf(stun, cloudflare)))
    }

    @Test
    fun `a single turns url counts`() {
        val relay = IceServer(urls = JsonPrimitive("TURNS:relay.example:443?transport=tcp"), username = "u", credential = "c")
        assertEquals(listOf(relay), sfuIceServers(listOf(relay)))
    }

    @Test
    fun `a STUN-only list passes nothing so the server's relays stay in play`() {
        assertTrue(sfuIceServers(listOf(stun)).isEmpty())
        val two = IceServer(urls = JsonArray(listOf(JsonPrimitive("stun:a"), JsonPrimitive("stun:b"))))
        assertTrue(sfuIceServers(listOf(stun, two)).isEmpty())
    }

    @Test
    fun `an empty list passes nothing`() {
        assertTrue(sfuIceServers(emptyList()).isEmpty())
    }

    @Test
    fun `turn detection`() {
        assertTrue(isTurnUrl("turn:h:3478"))
        assertTrue(isTurnUrl("turns:h:5349"))
        assertFalse(isTurnUrl("stun:h:3478"))
        assertFalse(isTurnUrl("stuns:h:5349"))
    }
}
