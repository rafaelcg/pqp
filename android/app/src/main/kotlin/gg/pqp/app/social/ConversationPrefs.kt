package gg.pqp.app.social

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.MeNotificationPreferences
import gg.pqp.app.core.MePreferences
import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import java.util.LinkedHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Fixadas and the mute of a conversation: the two per-person choices the web
 * list offers on a row's menu and iOS offers (pin) on a swipe.
 *
 * Both live in the account's preferences, so they follow the person across
 * devices: the pin is the same `pinnedConversations` the web rail writes, and
 * a mute is the same per-channel notification level (`none`) the web's
 * notification menu writes, a conversation being a channel as far as that map
 * is concerned.
 */
object ConversationPins {

    /** The web's `PINNED_CONVERSATIONS_MAX`: past it the faces stop being a shortcut. */
    const val MAX = 15

    /**
     * Fixadas first, in pin order, then everything else in the list's own
     * (recency) order. An id the list does not hold, or a repeated one, draws
     * nothing. The web keeps the same rule (`splitPinned`).
     */
    fun split(list: List<DmSummary>, pinned: List<String>): Pair<List<DmSummary>, List<DmSummary>> {
        val byId = list.associateBy { it.channelId }
        val seen = LinkedHashSet<String>()
        val first = pinned.mapNotNull { id -> byId[id]?.takeIf { seen.add(id) } }
        return first to list.filter { it.channelId !in seen }
    }

    /**
     * The pins after toggling [channelId]: removed if it is pinned, otherwise
     * put at the FRONT (iOS does the same, so the newest pin is the first
     * under Fixadas). Null when pinning would pass [MAX].
     */
    fun toggled(ids: List<String>, channelId: String): List<String>? = when {
        channelId in ids -> ids - channelId
        ids.size >= MAX -> null
        else -> listOf(channelId) + ids
    }
}

/** What a toggle did, for the screen to say something about. */
sealed interface PrefOutcome {
    data object Done : PrefOutcome

    /** Fifteen are pinned already. Nothing changed. */
    data object PinLimit : PrefOutcome
}

/** `{ preferences }` as `PATCH /api/me/preferences` answers: the merged result. */
@Serializable
data class PreferencesResponse(val preferences: MePreferences = MePreferences())

@Serializable
private data class PinnedPatch(val pinnedConversations: List<String>)

@Serializable
private data class ChannelLevelsPatch(val channels: Map<String, String>)

@Serializable
private data class NotificationsPatch(val notifications: ChannelLevelsPatch)

/**
 * The Fixadas list, written whole (the server replaces the array). Answers the
 * merged preferences so the session adopts what the server holds.
 */
suspend fun ApiClient.setPinnedConversations(ids: List<String>): MePreferences {
    val body = PqpJson.encodeToString(PinnedPatch.serializer(), PinnedPatch(ids))
    return decode<PreferencesResponse>(
        execute(
            Request.Builder()
                .url(url("/api/me/preferences"))
                .patch(body.toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
        ),
    ).preferences
}

/**
 * The per-channel notification levels, written whole. The server merges
 * `notifications` one level deep, so the OTHER notification keys (desktop,
 * the account-wide levels) are kept, and `channels` is replaced: this must be
 * the complete map, read fresh, or a level set on the web a minute ago is lost.
 */
suspend fun ApiClient.setChannelNotificationLevels(channels: Map<String, String>): MePreferences {
    val body = PqpJson.encodeToString(
        NotificationsPatch.serializer(),
        NotificationsPatch(ChannelLevelsPatch(channels)),
    )
    return decode<PreferencesResponse>(
        execute(
            Request.Builder()
                .url(url("/api/me/preferences"))
                .patch(body.toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
        ),
    ).preferences
}

/** Everything the actor reads and writes, so it can be driven in a JVM test. */
interface ConversationPrefsBackend {
    /** Who is signed in; a different one starts the actor over. */
    fun userId(): String?

    /** The pins and the channel levels as the session holds them now (optimistic state included). */
    fun pinned(): List<String>
    fun channelLevels(): Map<String, String>

    /** Reflect a change into the session at once. */
    fun setPinned(ids: List<String>)
    fun setChannelLevels(levels: Map<String, String>)

    suspend fun savePinned(ids: List<String>): MePreferences

    /** The levels the server holds right now, or null when it could not be read. */
    suspend fun freshChannelLevels(): Map<String, String>?
    suspend fun saveChannelLevels(levels: Map<String, String>): MePreferences
}

class SessionConversationPrefsBackend(private val session: SessionStore) : ConversationPrefsBackend {
    private val me get() = (session.phase.value as? SessionPhase.Ready)?.me

    override fun userId(): String? = me?.id
    override fun pinned(): List<String> = me?.preferences?.pinnedConversations.orEmpty()
    override fun channelLevels(): Map<String, String> = me?.preferences?.notifications?.channels.orEmpty()

    override fun setPinned(ids: List<String>) = session.updatePreferences { it.copy(pinnedConversations = ids) }

    override fun setChannelLevels(levels: Map<String, String>) = session.updatePreferences {
        it.copy(notifications = (it.notifications ?: MeNotificationPreferences()).copy(channels = levels))
    }

    override suspend fun savePinned(ids: List<String>) = session.api.setPinnedConversations(ids)

    override suspend fun freshChannelLevels(): Map<String, String>? =
        runCatching { session.api.me().preferences?.notifications?.channels.orEmpty() }.getOrNull()

    override suspend fun saveChannelLevels(levels: Map<String, String>) =
        session.api.setChannelNotificationLevels(levels)
}

/**
 * Optimistic writes of the two choices, one at a time.
 *
 * The session moves FIRST (a pin lands under Fixadas on the tap, not after the
 * round trip) and the save follows, serialised so two quick taps cannot
 * overtake each other. A save sends what the session holds when its turn
 * comes, so the last tap wins, and a refused one puts back what the server
 * last confirmed and says why through [onError], in the server's own sentence.
 */
class ConversationPrefs(
    private val backend: ConversationPrefsBackend,
    private val scope: CoroutineScope,
) {
    private val mutex = Mutex()
    private var owner: String? = null

    /** The pins the server last confirmed. */
    private var confirmedPins: List<String>? = null

    /** Mutes asked for and not yet saved: channel id to muted. */
    private val pendingMutes = LinkedHashMap<String, Boolean>()

    /** What the server last confirmed of the levels. Null until a save or read. */
    private var confirmedLevels: Map<String, String>? = null

    /** Fixar / Desafixar. */
    fun togglePin(channelId: String, onError: (String) -> Unit): PrefOutcome {
        adoptAccount()
        val before = backend.pinned()
        val next = ConversationPins.toggled(before, channelId) ?: return PrefOutcome.PinLimit
        if (confirmedPins == null) confirmedPins = before
        backend.setPinned(next)
        scope.launch {
            mutex.withLock {
                val wanted = backend.pinned()
                if (wanted == confirmedPins) return@withLock
                try {
                    val saved = backend.savePinned(wanted)
                    val held = saved.pinnedConversations.orEmpty()
                    confirmedPins = held
                    if (held != wanted) backend.setPinned(held)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Exception) {
                    backend.setPinned(confirmedPins.orEmpty())
                    onError(readable(failure))
                }
            }
        }
        return PrefOutcome.Done
    }

    /** Silenciar / Reativar: the channel's level is `none`, or not there at all. */
    fun toggleMute(channelId: String, muted: Boolean, onError: (String) -> Unit) {
        adoptAccount()
        val before = backend.channelLevels()
        if (confirmedLevels == null) confirmedLevels = before
        synchronized(pendingMutes) { pendingMutes[channelId] = muted }
        backend.setChannelLevels(applyMutes(before, mapOf(channelId to muted)))
        scope.launch {
            mutex.withLock {
                val batch = synchronized(pendingMutes) { LinkedHashMap(pendingMutes) }
                if (batch.isEmpty()) return@withLock
                try {
                    // The whole map, read fresh: the server replaces `channels`.
                    val fresh = backend.freshChannelLevels() ?: confirmedLevels ?: backend.channelLevels()
                    val saved = backend.saveChannelLevels(applyMutes(fresh, batch))
                    val held = saved.notifications?.channels.orEmpty()
                    confirmedLevels = held
                    synchronized(pendingMutes) { batch.forEach { (id, wanted) -> if (pendingMutes[id] == wanted) pendingMutes.remove(id) } }
                    // Whatever else is still pending sits on top of what the server holds.
                    backend.setChannelLevels(applyMutes(held, synchronized(pendingMutes) { HashMap(pendingMutes) }))
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Exception) {
                    synchronized(pendingMutes) { batch.forEach { (id, wanted) -> if (pendingMutes[id] == wanted) pendingMutes.remove(id) } }
                    backend.setChannelLevels(
                        applyMutes(confirmedLevels ?: backend.channelLevels(), synchronized(pendingMutes) { HashMap(pendingMutes) }),
                    )
                    onError(readable(failure))
                }
            }
        }
    }

    /** A different account signed in: nothing of the last one's confirmed state applies. */
    private fun adoptAccount() {
        val now = backend.userId()
        if (now != owner) {
            owner = now
            confirmedPins = null
            confirmedLevels = null
            synchronized(pendingMutes) { pendingMutes.clear() }
        }
    }

    private fun readable(failure: Exception): String =
        (failure as? ApiException)?.serverMessage?.takeIf { it.isNotBlank() } ?: failure.message.orEmpty()

    companion object {
        /** `muted` true puts `none` on the channel, false takes the level off. */
        fun applyMutes(levels: Map<String, String>, mutes: Map<String, Boolean>): Map<String, String> {
            val out = LinkedHashMap(levels)
            for ((id, muted) in mutes) {
                if (muted) out[id] = "none" else if (out[id] == "none") out.remove(id)
            }
            return out
        }

        @Volatile
        private var instance: ConversationPrefs? = null

        fun of(session: SessionStore): ConversationPrefs =
            instance ?: synchronized(this) {
                instance ?: ConversationPrefs(
                    SessionConversationPrefsBackend(session),
                    CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
                ).also { instance = it }
            }
    }
}
