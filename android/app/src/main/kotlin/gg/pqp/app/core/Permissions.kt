package gg.pqp.app.core

import gg.pqp.app.social.getJson
import kotlinx.serialization.Serializable

/**
 * A member's resolved permission bits for a server and its channels, ported
 * from `packages/shared/src/permissions.ts` only as far as this client needs
 * -- one bit, so far (`Permission.START_WATCH_PARTY`, for the channel list's
 * "Host a watch party" row and `PqpApp.kt`'s `ChatRoute` host gate). Android
 * modelled no permission tree at all before this; add the next bit here the
 * same way rather than growing a parallel copy elsewhere.
 *
 * `GET /api/servers/:serverId/permissions` is the exact route
 * `fetchMemberPermissions` reads on web (`client/src/lib/api.ts`), and this
 * decodes the same three fields: a version this client does not yet act on
 * (no live re-fetch on a `permissions-update` frame -- the list and the host
 * gate simply re-fetch when the screen or the channel they are on changes),
 * the server-wide bitfield, and a per-channel bitfield for every channel this
 * account may see, both already resolved (roles, overwrites and timeout
 * folded in, `computePermissions`'s 8-step algorithm) rather than raw role
 * sums this client would have to resolve itself.
 *
 * BITFIELDS ARE DECIMAL STRINGS ON THE WIRE, because the server holds them as
 * Postgres `BIGINT` and computes them as a JS `bigint` (`permissions.ts`'s own
 * doc: "Never do this math in JS number"). The highest bit defined today is
 * 24 (`MANAGE_MUSIC`), so a signed 64-bit [Long] carries every bit in use
 * with headroom to spare -- no need for `java.math.BigInteger` unless the bit
 * count ever approaches 63.
 *
 * ADMINISTRATOR IS ALREADY RESOLVED, not a special case here. The server's
 * `computePermissions` expands OWNER and ADMINISTRATOR to every bit BEFORE
 * serializing (`PERMISSION_ALL`), so a bitfield this decodes already reads as
 * "has everything" for an admin or the owner. [hasPermission] needs no
 * administrator branch of its own, exactly matching `hasPermission` in
 * `permissions.ts`, which does not have one either.
 */
@Serializable
data class PermissionsSnapshot(
    val version: Int = 0,
    /** The server-wide bitfield, decimal string. */
    val server: String = "0",
    /** channelId -> that channel's resolved bitfield, decimal string. */
    val channels: Map<String, String> = emptyMap(),
)

/** `GET /api/servers/:serverId/permissions`. */
suspend fun ApiClient.serverPermissions(serverId: String): PermissionsSnapshot =
    getJson("/api/servers/$serverId/permissions")

/**
 * The bits this client checks today. Mirrors `Permission` in
 * `packages/shared/src/permissions.ts`; add the next one the same way
 * (`1L shl <n>`), never a locally invented number.
 */
object Permission {
    /**
     * Start the stream in a `watch_party` channel. Everyone else there is
     * the audience -- see the bit's own doc on web for why it is not
     * `STREAM`.
     */
    const val START_WATCH_PARTY: Long = 1L shl 23
}

/**
 * A decimal-string bitfield off the wire, or 0 for anything this client
 * cannot parse -- the same fallback `parsePermissions` uses on web rather
 * than throwing and turning a server hiccup into a crash.
 */
fun parsePermissionBits(value: String): Long = value.toLongOrNull() ?: 0L

/** `(perms & bit) == bit`, exactly `hasPermission` in `permissions.ts`. */
fun hasPermission(perms: Long, bit: Long): Boolean = (perms and bit) == bit

/**
 * This account's resolved bits for one channel: the channel's own entry when
 * the snapshot has one, the server-wide bitfield otherwise -- exactly the
 * `mask` resolution `usePermissions.can` does on web (`use-permissions.ts`).
 * A strict override, never a union: a channel entry of `0` still wins over a
 * permissive server bitfield, because a channel overwrite that denies
 * everything is exactly what that entry means.
 */
fun PermissionsSnapshot.channelBits(channelId: String): Long =
    channels[channelId]?.let(::parsePermissionBits) ?: parsePermissionBits(server)
