package gg.pqp.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Bit parsing and the channel/server fallback, ported from
 * `packages/shared/src/permissions.ts` (`hasPermission`, `parsePermissions`)
 * and `use-permissions.ts` (`can`'s `mask` resolution). No network here --
 * `PermissionsSnapshot.channelBits` is a pure function over decimal strings
 * already on the object.
 */
class PermissionsTest {

    @Test
    fun `a decimal string parses to the same bits`() {
        assertEquals(1L shl 23, parsePermissionBits((1L shl 23).toString()))
    }

    @Test
    fun `garbage parses to zero, never a throw`() {
        assertEquals(0L, parsePermissionBits("not-a-number"))
        assertEquals(0L, parsePermissionBits(""))
    }

    @Test
    fun `hasPermission is an exact bit match`() {
        val perms = Permission.START_WATCH_PARTY or (1L shl 7)
        assertTrue(hasPermission(perms, Permission.START_WATCH_PARTY))
        assertFalse(hasPermission(1L shl 7, Permission.START_WATCH_PARTY))
    }

    @Test
    fun `a channel with its own entry uses it, never the server bitfield`() {
        val snapshot = PermissionsSnapshot(
            server = Permission.START_WATCH_PARTY.toString(),
            channels = mapOf("c1" to "0"),
        )
        // The channel overwrite denies everything, and it wins even though
        // the server-wide bitfield alone would say yes -- a strict override,
        // not a union, exactly `usePermissions.can`'s `mask` on web.
        assertFalse(hasPermission(snapshot.channelBits("c1"), Permission.START_WATCH_PARTY))
    }

    @Test
    fun `a channel with no entry falls back to the server bitfield`() {
        val snapshot = PermissionsSnapshot(
            server = Permission.START_WATCH_PARTY.toString(),
            channels = emptyMap(),
        )
        assertTrue(hasPermission(snapshot.channelBits("c1"), Permission.START_WATCH_PARTY))
    }

    @Test
    fun `an admin's bitfield already carries every bit, no special-casing needed here`() {
        // The server expands ADMINISTRATOR to PERMISSION_ALL before ever
        // serializing it (`computePermissions`'s 8-step algorithm), so this
        // client's own `hasPermission` needs no administrator branch --
        // exactly the same shape as `hasPermission` on web.
        val allBits = (1L shl 25) - 1
        val snapshot = PermissionsSnapshot(server = allBits.toString())
        assertTrue(hasPermission(snapshot.channelBits("any-channel"), Permission.START_WATCH_PARTY))
    }

    @Test
    fun `an unknown snapshot still offers the composer, the server is the gate`() {
        assertTrue(SendGate.canSend(null, "forum"))
    }

    @Test
    fun `server bits answer when the channel has no entry`() {
        assertTrue(SendGate.canSend(PermissionsSnapshot(server = Permission.SEND_MESSAGES.toString()), "forum"))
        assertFalse(SendGate.canSend(PermissionsSnapshot(server = "0"), "forum"))
    }

    @Test
    fun `a channel overwrite denying send wins over the server bits, only there`() {
        val snapshot = PermissionsSnapshot(
            server = Permission.SEND_MESSAGES.toString(),
            channels = mapOf("forum" to "0"),
        )
        assertFalse(SendGate.canSend(snapshot, "forum"))
        assertTrue(SendGate.canSend(snapshot, "general"))
    }

    @Test
    fun `the cache hands a snapshot back within its time, never to another account or server`() {
        val snapshot = PermissionsSnapshot(server = "0")
        PermissionsCache.put("me", "srv", snapshot, now = 1_000L)
        assertEquals(snapshot, PermissionsCache.fresh("me", "srv", now = 1_000L + PermissionsCache.TTL_MS - 1))
        assertEquals(null, PermissionsCache.fresh("me", "srv", now = 1_000L + PermissionsCache.TTL_MS))
        assertEquals(null, PermissionsCache.fresh("somebody-else", "srv", now = 1_500L))
        assertEquals(null, PermissionsCache.fresh("me", "other-server", now = 1_500L))
        // A clock that went backwards is not a hit.
        assertEquals(null, PermissionsCache.fresh("me", "srv", now = 500L))
        // A later write evicts what has expired, so the map does not keep every server ever opened.
        val later = 1_000L + PermissionsCache.TTL_MS + 5
        PermissionsCache.put("me", "second", snapshot, now = later)
        assertEquals(null, PermissionsCache.fresh("me", "srv", now = later))
        assertEquals(snapshot, PermissionsCache.fresh("me", "second", now = later))
    }

    @Test
    fun `invalidate drops one server for every account, clear drops all`() {
        val snapshot = PermissionsSnapshot(server = "0")
        PermissionsCache.put("me", "a", snapshot, now = 10L)
        PermissionsCache.put("you", "a", snapshot, now = 10L)
        PermissionsCache.put("me", "b", snapshot, now = 10L)
        PermissionsCache.invalidate("a")
        assertEquals(null, PermissionsCache.fresh("me", "a", now = 11L))
        assertEquals(null, PermissionsCache.fresh("you", "a", now = 11L))
        assertEquals(snapshot, PermissionsCache.fresh("me", "b", now = 11L))
        // A server id that merely ends the same way is not the same server.
        PermissionsCache.put("me", "xa", snapshot, now = 10L)
        PermissionsCache.invalidate("a")
        assertEquals(snapshot, PermissionsCache.fresh("me", "xa", now = 11L))
        PermissionsCache.clear()
        assertEquals(null, PermissionsCache.fresh("me", "b", now = 11L))
    }

    @Test
    fun `a channel overwrite granting send wins over the server bits`() {
        val snapshot = PermissionsSnapshot(server = "0", channels = mapOf("forum" to Permission.SEND_MESSAGES.toString()))
        assertTrue(SendGate.canSend(snapshot, "forum"))
    }
}
