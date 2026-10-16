package gg.pqp.app.follow

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.Permission
import gg.pqp.app.core.PermissionsSnapshot
import gg.pqp.app.core.TokenProvider
import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class FollowPermissionsTest {

    @Before
    @After
    fun clear() = FollowPermissions.clear()

    private val api = ApiClient(TokenProvider { "t0" })

    private fun snapshot(server: Long, channels: Map<String, Long> = emptyMap()) = PermissionsSnapshot(
        server = server.toString(),
        channels = channels.mapValues { it.value.toString() },
    )

    @Test
    fun `manage webhooks or manage channels on the channel is the rule`() {
        assertTrue(FollowPermissions.mayManage(snapshot(Permission.MANAGE_WEBHOOKS), "c"))
        assertTrue(FollowPermissions.mayManage(snapshot(Permission.MANAGE_CHANNELS), "c"))
        assertFalse(FollowPermissions.mayManage(snapshot(Permission.SEND_MESSAGES), "c"))
    }

    @Test
    fun `a channel entry wins over the server's bits, in both directions`() {
        val denied = snapshot(Permission.MANAGE_CHANNELS, mapOf("c" to Permission.SEND_MESSAGES))
        assertFalse(FollowPermissions.mayManage(denied, "c"))
        assertTrue(FollowPermissions.mayManage(denied, "other"))
        val granted = snapshot(Permission.SEND_MESSAGES, mapOf("c" to Permission.MANAGE_WEBHOOKS))
        assertTrue(FollowPermissions.mayManage(granted, "c"))
    }

    @Test
    fun `one snapshot answers every channel of the server for a minute`() = runBlocking {
        var fetches = 0
        var clock = 1_000L
        val fetch: suspend () -> PermissionsSnapshot = {
            fetches += 1
            snapshot(Permission.SEND_MESSAGES, mapOf("a" to Permission.MANAGE_CHANNELS))
        }
        assertTrue(FollowPermissions.mayManage(api, "s", "a", { clock }, fetch))
        assertFalse(FollowPermissions.mayManage(api, "s", "b", { clock }, fetch))
        assertFalse(FollowPermissions.mayManage(api, "s", "c", { clock }, fetch))
        assertEquals(1, fetches)

        clock += FollowPermissions.TTL_MS
        assertTrue(FollowPermissions.mayManage(api, "s", "a", { clock }, fetch))
        assertEquals(2, fetches)
    }

    @Test
    fun `servers do not share a snapshot, and a failure is asked again`() = runBlocking {
        var fetches = 0
        var failing = true
        val fetch: suspend () -> PermissionsSnapshot = {
            fetches += 1
            if (failing) throw IOException("offline")
            snapshot(Permission.MANAGE_CHANNELS)
        }
        assertFalse(FollowPermissions.mayManage(api, "s1", "a", { 0L }, fetch))
        failing = false
        assertTrue(FollowPermissions.mayManage(api, "s1", "a", { 0L }, fetch))
        assertTrue(FollowPermissions.mayManage(api, "s2", "a", { 0L }, fetch))
        assertEquals(3, fetches)
    }

    @Test
    fun `expired snapshots are dropped when a new one is kept, and the cache is bounded`() = runBlocking {
        var clock = 0L
        val fetch: suspend () -> PermissionsSnapshot = { snapshot(Permission.MANAGE_CHANNELS) }
        FollowPermissions.mayManage(api, "old", "a", { clock }, fetch)
        assertEquals(1, FollowPermissions.held(api))

        clock += FollowPermissions.TTL_MS
        FollowPermissions.mayManage(api, "new", "a", { clock }, fetch)
        assertEquals("the expired one went", 1, FollowPermissions.held(api))

        for (i in 1..(FollowPermissions.MAX_SERVERS * 2)) {
            FollowPermissions.mayManage(api, "s$i", "a", { clock }, fetch)
        }
        assertEquals(FollowPermissions.MAX_SERVERS, FollowPermissions.held(api))
    }

    @Test
    fun `a snapshot the channel list already read answers without a request`() = runBlocking {
        var fetches = 0
        FollowPermissions.offer(api, "s", snapshot(Permission.SEND_MESSAGES, mapOf("a" to Permission.MANAGE_CHANNELS)), { 0L })
        val fetch: suspend () -> PermissionsSnapshot = {
            fetches += 1
            snapshot(Permission.SEND_MESSAGES)
        }
        assertTrue(FollowPermissions.mayManage(api, "s", "a", { 1L }, fetch))
        assertEquals(0, fetches)
    }
}
