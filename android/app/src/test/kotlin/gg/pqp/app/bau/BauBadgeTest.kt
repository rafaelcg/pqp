package gg.pqp.app.bau

import gg.pqp.app.core.PqpJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BauBadgeTest {

    @Test
    fun `nothing unread shows no badge`() {
        assertNull(BauBadge.label(0))
        assertNull(BauBadge.label(-3))
    }

    @Test
    fun `counts up to nine are shown as they are`() {
        assertEquals("1", BauBadge.label(1))
        assertEquals("9", BauBadge.label(9))
    }

    @Test
    fun `ten and above stop at 9 plus`() {
        assertEquals("9+", BauBadge.label(10))
        assertEquals("9+", BauBadge.label(250))
    }

    @Test
    fun `a server missing from the aggregate has nothing unread`() {
        val unread = mapOf("a" to 3, "b" to 12)
        assertEquals(3, BauBadge.unreadFor("a", unread))
        assertEquals(12, BauBadge.unreadFor("b", unread))
        assertEquals(0, BauBadge.unreadFor("c", unread))
    }

    @Test
    fun `the aggregate read decodes and ignores the web-only newest times`() {
        val body = """{"servers":{"s1":2,"s2":11},"newest":{"s1":"2026-10-10T10:00:00.000Z"}}"""
        val parsed = PqpJson.decodeFromString(BauUnreadAllResponse.serializer(), body)
        assertEquals(mapOf("s1" to 2, "s2" to 11), parsed.servers)
    }

    @Test
    fun `an older server with no body fields reads as nothing unread`() {
        val parsed = PqpJson.decodeFromString(BauUnreadAllResponse.serializer(), "{}")
        assertEquals(emptyMap<String, Int>(), parsed.servers)
    }
}
