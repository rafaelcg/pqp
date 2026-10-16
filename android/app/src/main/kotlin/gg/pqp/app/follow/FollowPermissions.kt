package gg.pqp.app.follow

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.Permission
import gg.pqp.app.core.PermissionsSnapshot
import gg.pqp.app.core.channelBits
import gg.pqp.app.core.hasPermission
import gg.pqp.app.core.serverPermissions
import java.util.WeakHashMap
import kotlinx.coroutines.CancellationException

/**
 * Whether somebody may see "Seguindo" on a channel: the server's own rule,
 * `mayManageFollow` (`server/src/services/bau-follow.ts`), is MANAGE_WEBHOOKS or
 * MANAGE_CHANNELS on that channel, and the snapshot's channel entry already
 * folds roles and overwrites in.
 *
 * ONE SNAPSHOT PER SERVER, NOT ONE PER CHANNEL. The check runs on every text
 * channel somebody opens, and the snapshot is the whole server's answer (the
 * channel entries ride in it), so switching between channels would otherwise
 * ask the same question again each time. It is kept for [TTL_MS]; only a real
 * answer is kept, so a failure asks again on the next channel. It only decides
 * whether the icon is worth a request, and the server refuses a follows read
 * from anybody who may not manage the channel anyway.
 */
object FollowPermissions {

    const val TTL_MS = 60_000L
    const val MAX_SERVERS = 16

    private data class Entry(val snapshot: PermissionsSnapshot, val at: Long)

    private val cache = WeakHashMap<ApiClient, MutableMap<String, Entry>>()

    /** The rule, with no I/O. */
    fun mayManage(snapshot: PermissionsSnapshot, channelId: String): Boolean {
        val bits = snapshot.channelBits(channelId)
        return hasPermission(bits, Permission.MANAGE_WEBHOOKS) || hasPermission(bits, Permission.MANAGE_CHANNELS)
    }

    suspend fun mayManage(
        api: ApiClient,
        serverId: String,
        channelId: String,
        now: () -> Long = System::currentTimeMillis,
        fetch: suspend () -> PermissionsSnapshot = { api.serverPermissions(serverId) },
    ): Boolean {
        val fresh = synchronized(cache) { cache[api]?.get(serverId) }?.takeIf { now() - it.at < TTL_MS }
        if (fresh != null) return mayManage(fresh.snapshot, channelId)
        val snapshot = try {
            fetch()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return false
        }
        offer(api, serverId, snapshot, now)
        return mayManage(snapshot, channelId)
    }

    /**
     * Keep a snapshot somebody already read. The channel list reads the server's permissions to
     * decide its own buttons and offers them here, so opening a channel from it asks nothing.
     * Expired entries are dropped whenever one is kept, and no more than [MAX_SERVERS] are held.
     */
    fun offer(
        api: ApiClient,
        serverId: String,
        snapshot: PermissionsSnapshot,
        now: () -> Long = System::currentTimeMillis,
    ) {
        synchronized(cache) {
            val at = now()
            val perServer = cache.getOrPut(api) { HashMap() }
            perServer.values.removeAll { at - it.at >= TTL_MS }
            if (perServer.size >= MAX_SERVERS && serverId !in perServer) {
                perServer.entries.minByOrNull { it.value.at }?.let { perServer.remove(it.key) }
            }
            perServer[serverId] = Entry(snapshot, at)
        }
    }

    /** Tests only: how many snapshots are held for [api]. */
    internal fun held(api: ApiClient): Int = synchronized(cache) { cache[api]?.size ?: 0 }

    /** Tests only. */
    internal fun clear() = synchronized(cache) { cache.clear() }
}
