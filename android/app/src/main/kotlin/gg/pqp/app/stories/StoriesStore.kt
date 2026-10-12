package gg.pqp.app.stories

import android.util.Log
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * The story strips this phone has open, for the whole process, the way
 * `SocialRepository` holds the conversation list: a `stories-update` frame
 * has to land whichever screen is up.
 *
 * The frame is content-free ("re-read this strip"), so the rule is simple:
 * re-read the strip it names if this phone holds it, and drop any story it
 * says was removed. Expiry sends nothing at all; a timer here drops a ring the
 * moment its last story runs out.
 *
 * Views are batched: a story counts as seen after one second on screen, and
 * the ids go to `POST /api/stories/views` together, at most every couple of
 * seconds, so swiping through ten stories is one request and not ten.
 */
class StoriesStore(
    private val session: SessionStore,
    private val scope: CoroutineScope,
) {
    /** "server:<id>" or [FRIENDS]. */
    private val raw = mutableMapOf<String, StoryStrip>()
    private val _strips = MutableStateFlow<Map<String, StoryStrip>>(emptyMap())
    val strips: StateFlow<Map<String, StoryStrip>> = _strips.asStateFlow()

    private val _config = MutableStateFlow(StoriesConfig())
    val config: StateFlow<StoriesConfig> = _config.asStateFlow()

    /** Bumped when the author's own counts changed: an open viewers sheet re-reads. */
    private val _ownVersion = MutableStateFlow(0)
    val ownVersion: StateFlow<Int> = _ownVersion.asStateFlow()

    /** Stories a frame said are gone; an open viewer skips them. */
    private val _removed = MutableStateFlow<Set<String>>(emptySet())
    val removed: StateFlow<Set<String>> = _removed.asStateFlow()

    /** A staff removal to tell the author about once. */
    private val _notice = MutableStateFlow<StoryNotice?>(null)
    val notice: StateFlow<StoryNotice?> = _notice.asStateFlow()
    private var noticesAsked = false

    private val seenLocally = mutableSetOf<String>()
    private val pendingViews = linkedSetOf<String>()
    private var flushJob: Job? = null
    private var expiryJob: Job? = null

    init {
        scope.launch { listen() }
        scope.launch { followSession() }
    }

    fun serverKey(serverId: String) = "server:$serverId"

    suspend fun refreshConfig() {
        runCatching { session.api.storiesConfig() }
            .onSuccess { _config.value = it }
            .onFailure { Log.w(TAG, "config failed: ${it.message}") }
    }

    /** Re-read one strip. A failure keeps what is on screen. */
    fun refresh(key: String) {
        scope.launch {
            val strip = runCatching {
                if (key == FRIENDS) {
                    session.api.friendsStoryStrip()
                } else {
                    session.api.serverStoryStrip(key.removePrefix("server:"))
                }
            }.getOrElse {
                // 404: the friends routes while the global flag is off. A
                // closed door, not an error worth a log line every refetch.
                Log.w(TAG, "strip $key failed: ${it.message}")
                return@launch
            }
            raw[key] = strip
            publish()
            if (strip.enabled && !noticesAsked) askNotices()
        }
    }

    private suspend fun askNotices() {
        noticesAsked = true
        runCatching { session.api.storyNotices() }
            .onSuccess { _notice.value = it.firstOrNull() }
    }

    fun dismissNotice() {
        val notice = _notice.value ?: return
        _notice.value = null
        scope.launch { runCatching { session.api.ackStoryNotice(notice.id) } }
    }

    /**
     * A story was on screen long enough. Marks the ring seen locally at once
     * (the ring turns grey when the viewer closes, not on the next fetch) and
     * queues the id for the batch.
     */
    fun markSeen(storyId: String, ownId: String?) {
        if (!seenLocally.add(storyId)) return
        publish()
        // The author never counts as their own viewer; do not ask.
        if (ownId != null && (raw.values.mapNotNull { it.own }.any { storyId in it.storyIds })) return
        pendingViews += storyId
        if (pendingViews.size >= 50) flush() else scheduleFlush()
    }

    private fun scheduleFlush() {
        if (flushJob?.isActive == true) return
        flushJob = scope.launch {
            delay(FLUSH_MS)
            flush()
        }
    }

    private fun flush() {
        val ids = pendingViews.toList()
        pendingViews.clear()
        if (ids.isEmpty()) return
        scope.launch {
            runCatching { session.api.markStoriesViewed(ids) }
                .onFailure { Log.w(TAG, "views failed: ${it.message}") }
        }
    }

    /** Forget one story everywhere: deleted by its author or taken down. */
    fun forget(storyId: String) {
        _removed.value = _removed.value + storyId
        raw.keys.toList().forEach { key ->
            val strip = raw[key] ?: return@forEach
            raw[key] = strip.copy(
                own = strip.own?.withoutStory(storyId),
                items = strip.items.mapNotNull { it.withoutStory(storyId) },
            )
        }
        publish()
    }

    private fun StoryStripItem.withoutStory(storyId: String): StoryStripItem? {
        if (storyId !in storyIds) return this
        val left = storyIds - storyId
        return if (left.isEmpty()) null else copy(storyIds = left)
    }

    /** Recompute what every strip shows now: expiry, and what was seen here. */
    private fun publish() {
        val now = System.currentTimeMillis()
        _strips.value = raw.mapValues { (_, strip) ->
            val live = StoriesRules.live(strip, now)
            live.copy(
                items = live.items.map { item ->
                    if (item.unseen && item.storyIds.all { it in seenLocally }) item.copy(unseen = false) else item
                },
            )
        }
        scheduleExpiry(now)
    }

    private fun scheduleExpiry(now: Long) {
        expiryJob?.cancel()
        val next = raw.values.mapNotNull { StoriesRules.nextExpiry(it, now) }.minOrNull() ?: return
        expiryJob = scope.launch {
            delay((next - now).coerceAtLeast(500))
            publish()
        }
    }

    private suspend fun listen() {
        session.realtime.frames.collect { frame ->
            when (frame.string("type")) {
                "stories-update" -> onUpdate(frame)
            }
        }
    }

    private fun onUpdate(frame: JsonObject) {
        (frame["removedStoryIds"] as? JsonArray)
            ?.mapNotNull { it.jsonPrimitive.contentOrNull }
            ?.forEach(::forget)
        when (frame.string("scope")) {
            "server" -> frame.string("serverId")?.let { serverId ->
                val key = serverKey(serverId)
                if (key in raw) refresh(key)
            }
            "friends" -> if (FRIENDS in raw) refresh(FRIENDS)
            // Somebody viewed or reacted to one of mine.
            "own" -> {
                _ownVersion.value += 1
                raw.keys.toList().forEach(::refresh)
            }
        }
    }

    private suspend fun followSession() {
        session.phase.collect { phase ->
            if (phase !is SessionPhase.Ready) {
                raw.clear()
                seenLocally.clear()
                pendingViews.clear()
                noticesAsked = false
                _notice.value = null
                _removed.value = emptySet()
                _strips.value = emptyMap()
                _config.value = StoriesConfig()
            }
        }
    }

    private fun JsonObject.string(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull

    companion object {
        const val FRIENDS = "friends"
        private const val TAG = "pqp.stories"
        private const val FLUSH_MS = 2_000L

        @Volatile
        private var instance: StoriesStore? = null

        fun of(session: SessionStore): StoriesStore =
            instance ?: synchronized(this) {
                instance ?: StoriesStore(
                    session,
                    CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
                ).also { instance = it }
            }
    }
}
