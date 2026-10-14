package gg.pqp.app.stories

import android.content.Context
import android.net.ConnectivityManager
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheWriter
import androidx.media3.datasource.cache.ContentMetadata
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import coil3.SingletonImageLoader
import coil3.request.ImageRequest
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.stories.ui.StoryDeck
import gg.pqp.app.stories.ui.absolute
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Having the next story ready before the tap.
 *
 * Two things live here. The first is the story details everybody shares: the
 * viewer asks this for a deck's stories instead of the API, so what was read to
 * decide what to preload is the very answer the viewer then draws, links and
 * all. The second is the preloading itself: [onViewing] while a story is open
 * (the next two of the queue, plus the first of the next author) and [onTray]
 * while the strip shows (the first unseen story of the first three rings).
 *
 * A preload fills the same caches the viewer reads, under the same stable keys
 * (`StoryPreloadRules.baseKey` and friends): pictures go through Coil into its
 * memory and disk caches, decoded; a clip goes through a Media3 cache writer
 * into [StoryVideoCache], from its start and from its end. Nothing is held in
 * a list here: the caches are the preload. At most two stories are fetched at a
 * time, anything that leaves the window is cancelled, and a clip is skipped
 * while Data Saver is on.
 */
@OptIn(UnstableApi::class)
class StoryPreloader(
    private val appContext: Context,
    private val session: SessionStore,
    private val scope: CoroutineScope,
) {
    private class Cached(val story: Story, val at: Long)

    private val details = ConcurrentHashMap<String, Cached>()
    private val detailsLock = Mutex()

    private val running = ConcurrentHashMap<String, Job>()

    /** Stories that finished, so one that is still in the window is not fetched twice. */
    private val done = ConcurrentHashMap.newKeySet<String>()
    private val wanted = ConcurrentHashMap<String, List<String>>()
    private var planning: Job? = null

    /** While a viewer is open it is the only one that decides what is fetched: the tray is behind it. */
    @Volatile
    private var viewerOpen = false

    init {
        scope.launch {
            session.phase.collect { phase ->
                if (phase !is SessionPhase.Ready) forgetEverything()
            }
        }
    }

    /**
     * The stories of one deck, from what is already known and one request for
     * the rest. Order follows [ids]; a story the server dropped is simply
     * absent. [maxAgeMs] is how stale a known story may be: planning what to
     * preload is happy with minutes (the media keys do not change), the viewer
     * wants close to now. A story of mine, or one with a live call on it, is
     * never served from here: its numbers and its room move all the time.
     */
    suspend fun stories(ids: List<String>, maxAgeMs: Long = StoryPreloadRules.DETAILS_FRESH_MS): List<Story> {
        fun usable(id: String, now: Long): Boolean =
            details[id]?.let { now - it.at < maxAgeMs && it.story.own == null && it.story.call == null } == true
        if (ids.all { usable(it, System.currentTimeMillis()) }) return ids.mapNotNull { details[it]?.story }
        detailsLock.withLock {
            val now = System.currentTimeMillis()
            val missing = ids.filterNot { usable(it, now) }
            if (missing.isNotEmpty()) {
                session.api.stories(missing).forEach { details[it.id] = Cached(it, System.currentTimeMillis()) }
            }
        }
        return ids.mapNotNull { details[it]?.story }
    }

    /** The viewer saw it: a deck opened again must start after it, not on it. */
    fun markSeen(storyId: String) {
        details[storyId]?.let { details[storyId] = Cached(it.story.copy(viewer = it.story.viewer.copy(seen = true)), it.at) }
    }

    /** The viewer reacted: the same story opened again shows it. */
    fun setReaction(storyId: String, reaction: String?) {
        details[storyId]?.let { details[storyId] = Cached(it.story.copy(viewer = it.story.viewer.copy(reaction = reaction)), it.at) }
    }

    /** A story was deleted or taken down: it is not worth keeping details for. */
    fun forget(storyId: String) {
        details.remove(storyId)
        done.remove(storyId)
        running.remove(storyId)?.cancel()
    }

    private fun forgetEverything() {
        planning?.cancel()
        running.values.forEach { it.cancel() }
        running.clear()
        details.clear()
        done.clear()
        wanted.clear()
    }

    /** A story is on screen: have the next ones ready. Called again on every story the viewer lands on. */
    fun onViewing(decks: List<StoryDeck>, deck: Int, index: Int) {
        viewerOpen = true
        replan(VIEWER) { computeViewerWindow(decks, deck, index) }
    }

    /**
     * The story on screen is still loading: stop everything else, so the link is all its own.
     * [onViewing] starts the work again once it is showing.
     */
    fun pause() {
        viewerOpen = true
        planning?.cancel()
        running.values.forEach { it.cancel() }
        running.clear()
    }

    /** The viewer closed: nothing it was waiting for matters now. */
    fun onViewerClosed() {
        viewerOpen = false
        wanted.remove(VIEWER)
        replan(VIEWER) { emptyList() }
    }

    /** The tray is on screen: the first unseen story of its first rings. */
    fun onTray(items: List<StoryStripItem>) {
        val rings = StoryPreloadRules.trayRings(items)
        replan(TRAY) {
            rings.mapNotNull { ring ->
                val list = runCatching { stories(ring.storyIds.take(MAX_IDS)) }.getOrNull().orEmpty()
                list.getOrNull(StoriesRules.startIndex(list))?.id
            }
        }
    }

    private suspend fun computeViewerWindow(decks: List<StoryDeck>, deck: Int, index: Int): List<String> {
        val ids = decks.map { it.storyIds }
        // Where the viewer opens a deck depends on what was seen in it, so a deck has to be read to be walked into.
        val startOf = { d: Int ->
            val known = ids.getOrNull(d)?.mapNotNull { details[it]?.story }.orEmpty()
            if (known.size == ids.getOrNull(d)?.size) StoriesRules.startIndex(known) else 0
        }
        var window = StoryPreloadRules.window(ids, deck, index, startOf)
        // The next author is always wanted; the one after only if the queue spills into it.
        var next = deck + 1
        while (next <= minOf(deck + MAX_DECKS_AHEAD, ids.lastIndex)) {
            if (ids[next].any { details[it] == null }) runCatching { stories(ids[next].take(MAX_IDS)) }
            window = StoryPreloadRules.window(ids, deck, index, startOf)
            if (window.size > StoryPreloadRules.NEXT_STORIES) break
            next += 1
        }
        return window
    }

    private fun replan(source: String, compute: suspend () -> List<String>) {
        // Debug builds only: a marker file turns the preload off, to measure the same build without it.
        if (StoryPerf.preloadOff(appContext.filesDir)) return
        planning?.cancel()
        planning = scope.launch {
            val list = compute()
            wanted[source] = list
            apply()
        }
    }

    /** Make what is running match what is wanted by anybody (the tray and the viewer may both want a story). */
    @Synchronized
    private fun apply() {
        val all = (if (viewerOpen) wanted[VIEWER].orEmpty() else wanted[VIEWER].orEmpty() + wanted[TRAY].orEmpty())
            .distinct().filter { it !in done }
        val plan = StoryPreloadRules.plan(all, running.keys)
        plan.cancel.forEach { running.remove(it)?.cancel() }
        plan.start.forEach { id ->
            val story = details[id]?.story ?: return@forEach
            // Registered before it runs, so one that ends at once cannot leave itself behind.
            val job = scope.launch(start = CoroutineStart.LAZY) {
                try {
                    preload(story)
                    done += id
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // A cancelled preload surfaces from the blocking reads as an IO error, not as a cancellation.
                    currentCoroutineContext().ensureActive()
                    Log.w(TAG, "preload $id failed: ${e.message}")
                } finally {
                    // Only if it is still this run: the same story may have been cancelled and started again.
                    running.remove(id, currentCoroutineContext().job)
                    // A slot is free: whoever waited for it goes next.
                    apply()
                }
            }
            running[id] = job
            job.start()
        }
    }

    private suspend fun preload(story: Story) {
        // The face first (it is on the screen at once), then the picture, then the rest.
        story.author.avatarUrl?.let { image(absolute(it), null) }
        val media = story.media
        when {
            story.kind == "video" && media != null -> {
                media.posterUrl?.let { image(absolute(it), StoryPreloadRules.posterKey(story.id)) }
                if (StoryPreloadRules.videoAllowed(restrictBackgroundStatus())) {
                    StoryVideoCache.prefetch(appContext, StoryPreloadRules.videoKey(story.id), absolute(media.url))
                }
            }
            media != null -> image(absolute(media.url), StoryPreloadRules.baseKey(story.id))
        }
        story.layers.forEach { layer ->
            when (layer) {
                is ImageStoryLayer -> image(absolute(layer.url), StoryPreloadRules.layerKey(story.id, layer.id))
                is DrawingStoryLayer -> image(absolute(layer.url), StoryPreloadRules.layerKey(story.id, layer.id))
                else -> Unit
            }
        }
    }

    /** Fetch and decode into Coil's caches, the way the viewer will ask for it. */
    private suspend fun image(url: String, key: String?) {
        SingletonImageLoader.get(appContext).execute(storyImageRequest(appContext, url, key))
    }

    private fun restrictBackgroundStatus(): Int =
        (appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager)
            ?.restrictBackgroundStatus ?: StoryPreloadRules.DATA_SAVER_OFF

    companion object {
        private const val TAG = "pqp.stories"
        private const val VIEWER = "viewer"
        private const val TRAY = "tray"
        private const val MAX_IDS = 20
        private const val MAX_DECKS_AHEAD = 3

        @Volatile
        private var instance: StoryPreloader? = null

        fun of(context: Context, session: SessionStore): StoryPreloader =
            instance ?: synchronized(this) {
                instance ?: StoryPreloader(
                    context.applicationContext,
                    session,
                    CoroutineScope(SupervisorJob() + Dispatchers.Default),
                ).also { instance = it }
            }
    }
}

/**
 * A story's picture as the viewer and the preloader both ask for it: a stable
 * cache key, so the same picture behind a freshly signed link is still a hit.
 * [key] null keeps Coil's own (the link), for things that are not story media.
 */
fun storyImageRequest(context: Context, url: String, key: String?): ImageRequest =
    ImageRequest.Builder(context).data(url).apply {
        if (key != null) {
            memoryCacheKey(key)
            diskCacheKey(key)
        }
    }.build()

/**
 * The clips ahead of the viewer: a Media3 cache on disk, read by the story
 * player and filled by [prefetch]. 128 MB, least recently used out first, in
 * the cache directory, so the system may take it back and nothing here is
 * ever the only copy of anything.
 */
@OptIn(UnstableApi::class)
object StoryVideoCache {
    private const val MAX_BYTES = 128L * 1024 * 1024

    @Volatile
    private var cache: SimpleCache? = null

    private fun cache(context: Context): SimpleCache =
        cache ?: synchronized(this) {
            cache ?: SimpleCache(
                File(context.applicationContext.cacheDir, "story-video"),
                LeastRecentlyUsedCacheEvictor(MAX_BYTES),
                StandaloneDatabaseProvider(context.applicationContext),
            ).also { cache = it }
        }

    /** The factory the story player reads through; what it fetches it also keeps. */
    fun dataSourceFactory(context: Context): CacheDataSource.Factory =
        CacheDataSource.Factory()
            .setCache(cache(context))
            .setUpstreamDataSourceFactory(DefaultDataSource.Factory(context.applicationContext))
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)

    fun mediaItem(url: String, key: String): MediaItem = MediaItem.Builder().setUri(url).setCustomCacheKey(key).build()

    /**
     * Keep the first and the last bytes of a clip: enough to start it at once
     * (a recorder that writes its index at the end needs that end too). A clip
     * smaller than both is kept whole. Cancelling the coroutine stops the read.
     */
    suspend fun prefetch(context: Context, key: String, url: String) {
        val factory = dataSourceFactory(context)
        write(factory, key, url, position = 0, length = StoryPreloadRules.VIDEO_HEAD_BYTES)
        val total = ContentMetadata.getContentLength(cache(context).getContentMetadata(key))
        if (total > StoryPreloadRules.VIDEO_HEAD_BYTES) {
            val tail = minOf(StoryPreloadRules.VIDEO_TAIL_BYTES, total - StoryPreloadRules.VIDEO_HEAD_BYTES)
            write(factory, key, url, position = total - tail, length = tail)
        }
    }

    private suspend fun write(factory: CacheDataSource.Factory, key: String, url: String, position: Long, length: Long) {
        val spec = DataSpec.Builder().setUri(url).setKey(key).setPosition(position).setLength(length).build()
        val writer = CacheWriter(factory.createDataSource(), spec, null, null)
        coroutineScope {
            // The blocking read does not see a coroutine cancel: this does, and stops the writer from the side.
            val watcher = launch {
                try {
                    awaitCancellation()
                } finally {
                    writer.cancel()
                }
            }
            try {
                runInterruptible(Dispatchers.IO) { writer.cache() }
            } finally {
                watcher.cancel()
            }
        }
    }
}
