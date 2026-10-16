package gg.pqp.app.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/**
 * Custom server emoji (`packages/shared/src/server-emoji.ts`): a small picture a server's staff upload
 * under a name, used by members as `:name:`.
 *
 * WIRE FORMAT. A message body stores `<:name:id>`, never a bare `:name:`. The id is what resolves; the
 * name is only the fallback text a reader sees when the emoji is gone or belongs to another server (and
 * in a conversation, which has no server to own one).
 */
@Serializable
data class ServerEmoji(
    val id: String,
    val serverId: String = "",
    val name: String,
    /** Root-relative (`/api/emoji/:id?v=...`); [Backend.absolute] prefixes the API origin. */
    val url: String,
)

/** `GET /api/servers/:id/emoji`. Only what a reader needs; the rest is the settings screen's. */
@Serializable
data class ServerEmojiList(
    val emoji: List<ServerEmoji> = emptyList(),
    val limit: Int = 0,
    val uploadEnabled: Boolean = false,
)

object CustomEmoji {
    private const val UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

    /** `CUSTOM_EMOJI_TOKEN_PATTERN`: `<:name:id>` anywhere in a body. Pinned to the shared source by a test. */
    val TOKEN: Regex = Regex("<:([a-z0-9_]{2,32}):($UUID)>")

    /** The same pattern anchored at the start, for a scanner walking a string. */
    val TOKEN_AT: Regex = Regex("^<:([a-z0-9_]{2,32}):($UUID)>")

    /** Every `<:name:id>` as the `:name:` a person typed, for surfaces that draw plain text (`customEmojiTokensAsText`). */
    fun asText(body: String): String = if ("<:" in body) TOKEN.replace(body, ":$1:") else body
}

/**
 * Every server's emoji list as this phone holds it: one fetch per server, kept until something says
 * it changed (`client/src/lib/server-emoji.ts`). A message carrying an id this phone has never seen
 * (somebody added one since) refreshes the list, at most every [MISS_REFRESH_MS], which is what keeps
 * other members current without a socket frame. A failed read leaves whatever was there: tokens fall
 * back to `:name:`.
 */
class ServerEmojiStore(
    private val scope: CoroutineScope,
    private val fetch: suspend (serverId: String) -> ServerEmojiList,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val lock = Any()
    private val _lists = MutableStateFlow<Map<String, List<ServerEmoji>>>(emptyMap())

    /** Server id to its emoji. A server that has not been read, or could not be, is absent. */
    val lists: StateFlow<Map<String, List<ServerEmoji>>> = _lists.asStateFlow()

    private val inFlight = HashMap<String, Job>()
    private val lastMissRefreshAt = HashMap<String, Long>()

    /** The first use of a server's emoji reads them. A conversation has no server: nothing to read. */
    fun load(serverId: String?, force: Boolean = false) {
        if (serverId == null) return
        synchronized(lock) {
            if (serverId in inFlight) return
            if (serverId in _lists.value && !force) return
            val job = scope.launch(start = kotlinx.coroutines.CoroutineStart.LAZY) {
                try {
                    val list = fetch(serverId)
                    // Merged into the latest map, atomically: two servers answering at once must not
                    // overwrite each other's entry.
                    val sorted = list.emoji.sortedBy { it.name }
                    _lists.update { it + (serverId to sorted) }
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // Whatever was there stays; tokens read as `:name:`.
                } finally {
                    synchronized(lock) { inFlight.remove(serverId) }
                }
            }
            inFlight[serverId] = job
            job.start()
        }
    }

    /** A message named an emoji id this phone does not know: read again, at most every [MISS_REFRESH_MS]. */
    fun noteUnknown(serverId: String?) {
        if (serverId == null) return
        val due = synchronized(lock) {
            val at = now()
            if (serverId in inFlight || at - (lastMissRefreshAt[serverId] ?: Long.MIN_VALUE / 2) < MISS_REFRESH_MS) {
                false
            } else {
                lastMissRefreshAt[serverId] = at
                true
            }
        }
        if (due) load(serverId, force = true)
    }

    companion object {
        const val MISS_REFRESH_MS = 30_000L
    }
}
