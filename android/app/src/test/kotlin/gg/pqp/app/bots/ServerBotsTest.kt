package gg.pqp.app.bots

import gg.pqp.app.R
import gg.pqp.app.core.PqpJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Server bots, native v1: how one is recognised, and what its frames say. */
class ServerBotsTest {

    private fun frame(json: String): JsonObject = PqpJson.parseToJsonElement(json).jsonObject

    // --- detection ---

    @Test
    fun `a bot face url is a bot`() {
        assertTrue(ServerBots.isFaceAvatar("/api/bot-faces/lime/oi.png?v=1"))
        assertTrue(ServerBots.isFaceAvatar("/api/bot-faces/coral/focado.png"))
        assertTrue(ServerBots.isFaceAvatar("https://api.pqp.gg/api/bot-faces/sky/kkkk.png?v=1"))
        assertTrue(ServerBots.isFaceAvatar("http://10.0.2.2:3001/api/bot-faces/mint/bravo.png?v=2"))
    }

    @Test
    fun `everything else is not`() {
        assertFalse(ServerBots.isFaceAvatar(null))
        assertFalse(ServerBots.isFaceAvatar(""))
        assertFalse(ServerBots.isFaceAvatar("/api/avatars/42"))
        assertFalse(ServerBots.isFaceAvatar("https://cdn.example.com/avatars/me.png"))
        // The marker somewhere other than the start of the path.
        assertFalse(ServerBots.isFaceAvatar("/uploads/api/bot-faces/lime/oi.png"))
        assertFalse(ServerBots.isFaceAvatar("https://elsewhere.example/x?u=/api/bot-faces/lime/oi.png"))
        // The wrong shape under the marker.
        assertFalse(ServerBots.isFaceAvatar("/api/bot-faces/lime"))
        assertFalse(ServerBots.isFaceAvatar("/api/bot-faces/lime/oi.jpg"))
        assertFalse(ServerBots.isFaceAvatar("/api/bot-faces/lime/oi/extra.png"))
        assertFalse(ServerBots.isFaceAvatar("/api/bot-faces//oi.png"))
    }

    // --- notice ---

    private fun notice(reason: String, limit: String = "20", retryAt: String = "null") = frame(
        """{"type":"bot-notice","channelId":"c","botUserId":"b","botName":"Caio",
           "reason":"$reason","limit":$limit,"retryAt":$retryAt}""",
    )

    @Test
    fun `every reason parses and picks its own sentence`() {
        val seen = mutableSetOf<Int>()
        for (reason in listOf("busy", "member-hour", "server-day", "budget")) {
            val parsed = BotNotice.parse(notice(reason))
            assertNotNull(reason, parsed)
            assertEquals("Caio", parsed!!.botName)
            assertEquals("c", parsed.channelId)
            assertEquals("b", parsed.botUserId)
            seen += parsed.textRes()
        }
        assertEquals(4, seen.size)
    }

    @Test
    fun `an unknown reason or a missing field is dropped`() {
        assertNull(BotNotice.parse(notice("full-moon")))
        assertNull(BotNotice.parse(frame("""{"type":"bot-notice","reason":"busy"}""")))
        assertNull(BotNotice.parse(frame("""{"type":"bot-notice","channelId":"c","botUserId":"b","reason":null}""")))
    }

    @Test
    fun `null limit and null retry are the ordinary case`() {
        val parsed = BotNotice.parse(notice("busy", limit = "null"))!!
        assertNull(parsed.limit)
        assertNull(parsed.retryAtMs)
        assertFalse(parsed.isExpired(Long.MAX_VALUE))
        // JsonNull must not read as the text "null".
        assertEquals(R.string.bot_notice_busy, parsed.textRes())
    }

    @Test
    fun `a retry time switches to the until wording and expires`() {
        val parsed = BotNotice.parse(notice("member-hour", retryAt = "\"2026-08-01T10:30:00.000Z\""))!!
        val at = parsed.retryAtMs!!
        assertEquals(R.string.bot_notice_member_hour_until, parsed.textRes())
        assertEquals(20, parsed.limit)
        assertFalse(parsed.isExpired(at - 1))
        assertTrue(parsed.isExpired(at))

        val without = BotNotice.parse(notice("member-hour"))!!
        assertEquals(R.string.bot_notice_member_hour, without.textRes())
        assertNotEquals(parsed.textRes(), without.textRes())
    }

    @Test
    fun `a retry time that is not a date is ignored rather than fatal`() {
        val parsed = BotNotice.parse(notice("budget", retryAt = "\"soon\""))
        assertNotNull(parsed)
        assertNull(parsed!!.retryAtMs)
    }

    // --- activity ---

    @Test
    fun `a typing frame with activity is a bot and one without is a person`() {
        val thinking = ServerBots.activityOf(frame("""{"type":"typing-broadcast","activity":{"tool":null}}"""))
        assertNotNull(thinking)
        assertNull(thinking!!.tool)

        val working = ServerBots.activityOf(frame("""{"type":"typing-broadcast","activity":{"tool":"create_channel"}}"""))
        assertEquals("create_channel", working!!.tool)

        assertNull(ServerBots.activityOf(frame("""{"type":"typing-broadcast","displayName":"Ana"}""")))
        // A shape this build cannot read costs the bot row, never the frame.
        assertNull(ServerBots.activityOf(frame("""{"type":"typing-broadcast","activity":"???"}""")))
    }

    @Test
    fun `thinking has no tool and an unknown tool reads as working`() {
        assertEquals(R.string.bot_activity_thinking, ServerBots.activityRes(null))
        assertEquals(R.string.bot_activity_create_channel, ServerBots.activityRes("create_channel"))
        assertEquals(R.string.bot_activity_working, ServerBots.activityRes("no_such_tool"))
    }
}
