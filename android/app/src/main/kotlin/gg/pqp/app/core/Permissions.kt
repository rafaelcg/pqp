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
 * 28 (`MANAGE_EMOJI`), so a signed 64-bit [Long] carries every bit in use
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
     * Manage the server. In the Baú it is the one bit that publishes: every
     * write route under `/home` asks the server for it, and the phone's
     * compose button asks the same question of the same snapshot.
     */
    const val MANAGE_SERVER: Long = 1L shl 5

    /**
     * Forum staff, with [MANAGE_MESSAGES]: either bit on a forum pins, locks,
     * deletes and edits other people's posts there (`forumPerms` on the
     * server), and sees the staff-only tags in the composer.
     */
    const val MANAGE_CHANNELS: Long = 1L shl 4

    /** Writing in a channel; on a forum, starting a post. */
    const val SEND_MESSAGES: Long = 1L shl 7

    const val MANAGE_MESSAGES: Long = 1L shl 8

    /**
     * Outgoing channel webhooks. With [MANAGE_CHANNELS] it is what lets
     * somebody point a followed Baú at a channel (Seguir), which is what the
     * server checks (`FOLLOW_MANAGE_BITS`).
     */
    const val MANAGE_WEBHOOKS: Long = 1L shl 20

    /**
     * Start the stream in a `watch_party` channel. Everyone else there is
     * the audience -- see the bit's own doc on web for why it is not
     * `STREAM`.
     */
    const val START_WATCH_PARTY: Long = 1L shl 23

    /**
     * Post a story to this server. On for @everyone by default; staff can take
     * it away per role. The strip's `canPost` already answers it, this is for
     * the composer's audience rows and tests.
     */
    const val POST_STORIES: Long = 1L shl 25
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

/**
 * Whether a composer is offered at all: the snapshot's SEND_MESSAGES bit for
 * [channelId], the channel's own entry winning over the server-wide bits.
 * UNKNOWN IS ALLOWED. Taking the box away from somebody who may type in it is
 * the worse mistake (every channel would lose its composer for a moment on each
 * open, or for good when the read fails), and the server stays the gate for the
 * other case. Web's `canSendHere` and iOS's `SendGate` follow the same rule.
 */
object SendGate {
    fun canSend(snapshot: PermissionsSnapshot?, channelId: String): Boolean =
        snapshot == null || hasPermission(snapshot.channelBits(channelId), Permission.SEND_MESSAGES)
}

/**
 * A server's snapshot kept for a short while, for the screens that only need
 * one bit of it as they open (the chat composer's SEND_MESSAGES): opening
 * channel after channel on one server reads it once, not once per channel.
 * Keyed by account as well as server, so a second account on the same phone
 * never reads the first one's bits. Short on purpose, a role change shows up
 * the next time the channel list resumes (which always re-reads) or within
 * [TTL_MS] of opening a chat.
 */
object PermissionsCache {
    const val TTL_MS = 30_000L

    private class Entry(val at: Long, val snapshot: PermissionsSnapshot)

    private val entries = java.util.concurrent.ConcurrentHashMap<String, Entry>()

    private fun key(userId: String?, serverId: String) = "${userId.orEmpty()}:$serverId"

    fun fresh(userId: String?, serverId: String, now: Long): PermissionsSnapshot? =
        entries[key(userId, serverId)]?.takeIf { now - it.at in 0 until TTL_MS }?.snapshot

    fun put(userId: String?, serverId: String, snapshot: PermissionsSnapshot, now: Long) {
        entries[key(userId, serverId)] = Entry(now, snapshot)
    }
}
