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

    /**
     * [base] with the asked-for changes on top, in the order they were asked:
     * `true` pins (to the front), `false` unpins. What is shown is always what
     * the server last confirmed plus what is still waiting to be saved, so a
     * refused change takes back only itself.
     */
    fun applyOps(base: List<String>, ops: Map<String, Boolean>): List<String> {
        var out = base
        for ((id, wantPinned) in ops) {
            out = if (wantPinned) {
                if (id in out) out else listOf(id) + out
            } else {
                out - id
            }
        }
        return out
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
    /** Who is signed in. Work started for one account never lands on another. */
    fun userId(): String?

    /** The pins and the channel levels as the session holds them now (optimistic state included). */
    fun pinned(): List<String>
    fun channelLevels(): Map<String, String>

    /** Reflect a change into the session at once. */
    fun setPinned(ids: List<String>)
    fun setChannelLevels(levels: Map<String, String>)

    suspend fun savePinned(ids: List<String>): MePreferences

    /** What the server holds right now, or null when it could not be read. */
    suspend fun freshPinned(): List<String>?

    /** The levels the server holds right now. Throws when they cannot be read. */
    suspend fun freshChannelLevels(): Map<String, String>
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

    override suspend fun freshPinned(): List<String>? =
        runCatching { session.api.me().preferences?.pinnedConversations.orEmpty() }.getOrNull()

    override suspend fun freshChannelLevels(): Map<String, String> =
        session.api.me().preferences?.notifications?.channels.orEmpty()

    override suspend fun saveChannelLevels(levels: Map<String, String>) =
        session.api.setChannelNotificationLevels(levels)
}

/**
 * Optimistic writes of the two choices, one at a time.
 *
 * The session moves FIRST (a pin lands under Fixadas on the tap, not after the
 * round trip) and the save follows, serialised so two quick taps cannot
 * overtake each other. What is on screen is always what the server last
 * confirmed with the still-unsaved asks on top, so a refused save takes back
 * only itself: a tap made while it was in flight survives and is sent next.
 *
 * AN ANSWER THAT NEVER CAME is not "it did not save": the write may have
 * committed and lost its response, so a failure reads the server's truth before
 * rolling anything back, and only says something when the server does not hold
 * what was asked.
 *
 * ONE ACCOUNT. Every save is tied to the account that asked: a response that
 * comes back after somebody else signed in changes nothing.
 */
class ConversationPrefs(
    private val backend: ConversationPrefsBackend,
    private val scope: CoroutineScope,
) {
    private val mutex = Mutex()
    private var owner: String? = null

    /** The pins the server last confirmed, and the changes still waiting to be saved. */
    private var confirmedPins: List<String>? = null
    private val pendingPins = LinkedHashMap<String, Boolean>()

    /** The same for the channel levels; a pending mute is `true`, an unmute `false`. */
    private var confirmedLevels: Map<String, String>? = null
    private val pendingMutes = LinkedHashMap<String, Boolean>()

    /** Fixar / Desafixar. */
    fun togglePin(channelId: String, onError: (String) -> Unit): PrefOutcome {
        adoptAccount()
        val local = backend.pinned()
        val next = ConversationPins.toggled(local, channelId) ?: return PrefOutcome.PinLimit
        synchronized(pendingPins) {
            if (confirmedPins == null && pendingPins.isEmpty()) confirmedPins = local
            pendingPins[channelId] = channelId in next
        }
        backend.setPinned(next)
        val account = backend.userId()
        scope.launch { mutex.withLock { savePins(account, onError) } }
        return PrefOutcome.Done
    }

    private suspend fun savePins(account: String?, onError: (String) -> Unit) {
        if (backend.userId() != account) return
        val batch = synchronized(pendingPins) { LinkedHashMap(pendingPins) }
        val base = confirmedPins ?: return
        if (batch.isEmpty()) return
        val wanted = ConversationPins.applyOps(base, batch)
        if (wanted == base) {
            settlePins(batch)
            backend.setPinned(ConversationPins.applyOps(base, pendingSnapshot()))
            return
        }
        try {
            val saved = backend.savePinned(wanted)
            if (backend.userId() != account) return
            confirmedPins = saved.pinnedConversations.orEmpty()
            settlePins(batch)
            backend.setPinned(ConversationPins.applyOps(confirmedPins.orEmpty(), pendingSnapshot()))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            // The write may have landed with its answer lost: ask before rolling back.
            val truth = backend.freshPinned()
            if (backend.userId() != account) return
            if (truth != null) confirmedPins = truth
            settlePins(batch)
            backend.setPinned(ConversationPins.applyOps(confirmedPins.orEmpty(), pendingSnapshot()))
            if (truth == null || truth != wanted) onError(readable(failure))
        }
    }

    private fun pendingSnapshot(): Map<String, Boolean> = synchronized(pendingPins) { LinkedHashMap(pendingPins) }

    private fun settlePins(batch: Map<String, Boolean>) = synchronized(pendingPins) {
        batch.forEach { (id, wanted) -> if (pendingPins[id] == wanted) pendingPins.remove(id) }
    }

    /** Silenciar / Reativar: the channel's level is `none`, or not there at all. */
    fun toggleMute(channelId: String, muted: Boolean, onError: (String) -> Unit) {
        adoptAccount()
        val local = backend.channelLevels()
        synchronized(pendingMutes) {
            if (confirmedLevels == null && pendingMutes.isEmpty()) confirmedLevels = local
            pendingMutes[channelId] = muted
        }
        backend.setChannelLevels(applyMutes(local, mapOf(channelId to muted)))
        val account = backend.userId()
        scope.launch { mutex.withLock { saveMutes(account, onError) } }
    }

    private suspend fun saveMutes(account: String?, onError: (String) -> Unit) {
        if (backend.userId() != account) return
        val batch = synchronized(pendingMutes) { LinkedHashMap(pendingMutes) }
        if (batch.isEmpty()) return
        // The server replaces the whole `channels` map, so what is sent is built on what it
        // holds NOW. If that cannot be read, nothing is sent: a stale copy would erase a mute
        // set on another device since.
        val fresh = try {
            backend.freshChannelLevels()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            if (backend.userId() != account) return
            settleMutes(batch)
            backend.setChannelLevels(applyMutes(confirmedLevels ?: backend.channelLevels(), pendingMutesSnapshot()))
            onError(readable(failure))
            return
        }
        if (backend.userId() != account) return
        val wanted = applyMutes(fresh, batch)
        try {
            val saved = backend.saveChannelLevels(wanted)
            if (backend.userId() != account) return
            confirmedLevels = saved.notifications?.channels.orEmpty()
            settleMutes(batch)
            backend.setChannelLevels(applyMutes(confirmedLevels.orEmpty(), pendingMutesSnapshot()))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            val truth = try {
                backend.freshChannelLevels()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                null
            }
            if (backend.userId() != account) return
            confirmedLevels = truth ?: confirmedLevels ?: fresh
            settleMutes(batch)
            backend.setChannelLevels(applyMutes(confirmedLevels.orEmpty(), pendingMutesSnapshot()))
            if (truth == null || truth != wanted) onError(readable(failure))
        }
    }

    private fun pendingMutesSnapshot(): Map<String, Boolean> = synchronized(pendingMutes) { LinkedHashMap(pendingMutes) }

    private fun settleMutes(batch: Map<String, Boolean>) = synchronized(pendingMutes) {
        batch.forEach { (id, wanted) -> if (pendingMutes[id] == wanted) pendingMutes.remove(id) }
    }

    /** A different account signed in: nothing of the last one's confirmed state applies. */
    private fun adoptAccount() {
        val now = backend.userId()
        if (now != owner) {
            owner = now
            synchronized(pendingPins) {
                confirmedPins = null
                pendingPins.clear()
            }
            synchronized(pendingMutes) {
                confirmedLevels = null
                pendingMutes.clear()
            }
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
