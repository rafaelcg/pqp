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
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
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

    /** Bumped when the account leaves: a request that started before it answers into nothing. */
    @Volatile
    private var generation = 0

    /** Pictures in flight at once, across stories: a story can carry many layers. */
    private val imageGate = Semaphore(IMAGES_AT_ONCE)

    private val running = ConcurrentHashMap<String, Job>()

    /** Stories that finished, so one that is still in the window is not fetched twice. */
    private val done = ConcurrentHashMap.newKeySet<String>()
    private val wanted = ConcurrentHashMap<String, List<String>>()

    /** One plan being worked out per source, so the tray replanning cannot cancel the viewer's. */
    private val planning = ConcurrentHashMap<String, Job>()

    /** Stories whose preload failed, and when: not tried again for a while, so a bad link is not a hot loop. */
    private val failedAt = ConcurrentHashMap<String, Long>()

    /** Set while the story on screen is still loading: nothing is started until the viewer says it is showing. */
    @Volatile
    private var paused = false

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
                // What the server no longer returns (deleted, expired) must not be answered from an old copy.
                missing.forEach { details.remove(it) }
                val epoch = generation
                val fetched = session.api.stories(missing)
                // The account may have left while the request was out: its stories are not kept for the next one.
                if (epoch == generation) {
                    fetched.forEach { details[it.id] = Cached(it, System.currentTimeMillis()) }
                    prune(now)
                }
            }
        }
        return ids.mapNotNull { details[it]?.story }
    }

    /** Details nobody has looked at for a while are dropped, and the bookkeeping that names them with them. */
    private fun prune(now: Long) {
        details.entries.removeAll { now - it.value.at > DETAILS_KEEP_MS }
        done.retainAll(details.keys)
        failedAt.entries.removeAll { now - it.value > FAILED_RETRY_MS }
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
        failedAt.remove(storyId)
        running.remove(storyId)?.cancel()
    }

    private fun forgetEverything() {
        generation += 1
        planning.values.forEach { it.cancel() }
        running.values.forEach { it.cancel() }
        running.clear()
        details.clear()
        done.clear()
        failedAt.clear()
        wanted.clear()
    }

    /** A story is on screen: have the next ones ready. Called again on every story the viewer lands on. */
    fun onViewing(decks: List<StoryDeck>, deck: Int, index: Int) {
        viewerOpen = true
        paused = false
        replan(VIEWER) { computeViewerWindow(decks, deck, index) }
    }

    /**
     * The story on screen is still loading: stop everything else, so the link is all its own.
     * [onViewing] starts the work again once it is showing.
     */
    fun pause() {
        viewerOpen = true
        paused = true
        planning.values.forEach { it.cancel() }
        running.values.forEach { it.cancel() }
        running.clear()
    }

    /** The viewer closed: nothing it was waiting for matters now. */
    fun onViewerClosed() {
        viewerOpen = false
        paused = false
        wanted.remove(VIEWER)
        replan(VIEWER) { emptyList() }
    }

    /** The tray is on screen: the first unseen story of its first rings. */
    fun onTray(items: List<StoryStripItem>) {
        val rings = StoryPreloadRules.trayRings(items)
        replan(TRAY) {
            // One request for every ring's first few stories (the API takes up to 20 ids), not a round trip per ring.
            val byId = runCatching { stories(rings.flatMap { it.storyIds.take(TRAY_IDS_PER_RING) }) }
                .getOrNull().orEmpty().associateBy { it.id }
            rings.mapNotNull { ring ->
                val list = ring.storyIds.take(TRAY_IDS_PER_RING).mapNotNull { byId[it] }
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
        // While a viewer is open the tray is behind it and has no say.
        if (source == TRAY && viewerOpen) return
        planning[source]?.cancel()
        planning[source] = scope.launch {
            val list = compute()
            // A plan that was replaced while it was being worked out must not commit.
            ensureActive()
            wanted[source] = list
            apply()
        }
    }

    /** Make what is running match what is wanted by anybody (the tray and the viewer may both want a story). */
    @Synchronized
    private fun apply() {
        if (paused) return
        val now = System.currentTimeMillis()
        val all = (if (viewerOpen) wanted[VIEWER].orEmpty() else wanted[VIEWER].orEmpty() + wanted[TRAY].orEmpty())
            .distinct().filter { it !in done && failedAt[it]?.let { at -> now - at < FAILED_RETRY_MS } != true }
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
                    failedAt[id] = System.currentTimeMillis()
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
        // A story's layer pictures are independent: fetched together, not one round trip after another.
        coroutineScope {
            story.layers.forEach { layer ->
                when (layer) {
                    is ImageStoryLayer -> launch { image(absolute(layer.url), StoryPreloadRules.layerKey(story.id, layer.id)) }
                    is DrawingStoryLayer -> launch { image(absolute(layer.url), StoryPreloadRules.layerKey(story.id, layer.id)) }
                    else -> Unit
                }
            }
        }
    }

    /** Fetch and decode into Coil's caches, the way the viewer will ask for it. */
    private suspend fun image(url: String, key: String?) {
        val screen = appContext.resources.displayMetrics
        val size = coil3.size.Size(screen.widthPixels, screen.heightPixels)
        // `execute` answers an error as a value, not an exception: a failed fetch must not count as a finished preload.
        val result = imageGate.withPermit {
            SingletonImageLoader.get(appContext).execute(storyImageRequest(appContext, url, key, size))
        }
        if (result is coil3.request.ErrorResult) throw result.throwable
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

        /** Three rings of this many make the 18 ids one request may carry. */
        private const val TRAY_IDS_PER_RING = 6
        private const val FAILED_RETRY_MS = 30_000L
        private const val IMAGES_AT_ONCE = 3
        private const val DETAILS_KEEP_MS = 30 * 60 * 1000L

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
fun storyImageRequest(context: Context, url: String, key: String?, size: coil3.size.Size? = null): ImageRequest =
    ImageRequest.Builder(context).data(url).apply {
        if (key != null) {
            memoryCacheKey(key)
            diskCacheKey(key)
        }
        // A preload has no view to measure: the screen is the most any story is drawn at.
        if (size != null) size(size)
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

    /** How much of a clip's start is read to find where its index is. */
    private const val HEAD_PEEK = 4096L

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
        // A clip whose index is up front starts from its first megabyte alone: its end is not fetched against whatever
        // is on screen. Only one that keeps its index last needs it.
        if (StoryPreloadRules.indexFirst(readHead(factory, key, url))) return
        val total = ContentMetadata.getContentLength(cache(context).getContentMetadata(key))
        if (total > StoryPreloadRules.VIDEO_HEAD_BYTES) {
            val tail = minOf(StoryPreloadRules.VIDEO_TAIL_BYTES, total - StoryPreloadRules.VIDEO_HEAD_BYTES)
            write(factory, key, url, position = total - tail, length = tail)
        }
    }

    /** The first bytes of the clip, from the cache the head was just written to. */
    private suspend fun readHead(factory: CacheDataSource.Factory, key: String, url: String): ByteArray = withContext(Dispatchers.IO) {
        val source = factory.createDataSource()
        try {
            source.open(DataSpec.Builder().setUri(url).setKey(key).setPosition(0).setLength(HEAD_PEEK).build())
            val buffer = ByteArray(HEAD_PEEK.toInt())
            var filled = 0
            while (filled < buffer.size) {
                val read = source.read(buffer, filled, buffer.size - filled)
                if (read < 0) break
                filled += read
            }
            buffer.copyOf(filled)
        } catch (_: java.io.IOException) {
            ByteArray(0)
        } finally {
            runCatching { source.close() }
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
