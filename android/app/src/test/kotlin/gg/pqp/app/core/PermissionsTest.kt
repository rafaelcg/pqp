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
}
