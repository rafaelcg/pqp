package gg.pqp.app.stories

import android.content.Context
import coil3.SingletonImageLoader
import coil3.request.ErrorResult
import gg.pqp.app.core.ServerSummary
import gg.pqp.app.stories.editor.CallFaces
import gg.pqp.app.stories.ui.absolute
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/**
 * Every picture a story is drawn from, so it can be shown as one finished
 * thing: the base, each photo layer, the drawing, and the faces and icon on a
 * call card, plus the author's face in the header.
 *
 * The viewer holds a story back until all of these are decoded ([load]), then
 * draws everything in one frame, so nobody watches a background, then a photo,
 * then the words arrive one by one. The preloader fetches the same list, which
 * is what lets a preloaded story appear at once.
 */
object StoryAssets {

    /** [key] null keeps Coil's own (the link): faces and icons, which are not story media. */
    data class Asset(val url: String, val key: String?)

    fun of(story: Story, servers: List<ServerSummary>): List<Asset> = buildList {
        story.author.avatarUrl?.let { add(Asset(absolute(it), null)) }
        val media = story.media
        val processing = story.own?.status == "processing" || story.own?.status == "pending"
        when {
            media == null || story.kind == "text" || processing -> Unit
            // A clip's picture before its first frame; the clip itself is the player's.
            story.kind == "video" -> media.posterUrl?.let { add(Asset(absolute(it), StoryPreloadRules.posterKey(story.id))) }
            else -> add(Asset(absolute(media.url), StoryPreloadRules.baseKey(story.id)))
        }
        story.layers.forEach { layer ->
            when (layer) {
                is ImageStoryLayer -> add(Asset(absolute(layer.url), StoryPreloadRules.layerKey(story.id, layer.id)))
                is DrawingStoryLayer -> add(Asset(absolute(layer.url), StoryPreloadRules.layerKey(story.id, layer.id)))
                is CallStoryLayer -> {
                    story.call?.takeIf { it.channelId == layer.channelId }?.let { live ->
                        live.participants.take(CallFaces.SHOWN).forEach { person -> person.avatarUrl?.let { add(Asset(absolute(it), null)) } }
                        servers.firstOrNull { it.id == layer.serverId }?.iconUrl?.let { add(Asset(absolute(it), null)) }
                    }
                }
                else -> Unit
            }
        }
        // A story from before layers that has a call sticker draws the same card (see `visibleLayers`).
        story.call?.let { live ->
            if (story.layers.none { it is CallStoryLayer }) {
                live.participants.take(CallFaces.SHOWN).forEach { person -> person.avatarUrl?.let { add(Asset(absolute(it), null)) } }
                servers.firstOrNull { it.id == live.serverId }?.iconUrl?.let { add(Asset(absolute(it), null)) }
            }
        }
    }.distinctBy { it.url }

    /**
     * Fetch and decode all of [assets] into Coil's caches, a few at a time, at the screen's size (the most any is drawn
     * at). One that fails does not hold the others, or the story, back: it simply draws when it can. Returns how many failed.
     */
    suspend fun load(context: Context, assets: List<Asset>): Int {
        if (assets.isEmpty()) return 0
        val screen = context.resources.displayMetrics
        val size = coil3.size.Size(screen.widthPixels, screen.heightPixels)
        val loader = SingletonImageLoader.get(context)
        val gate = Semaphore(AT_ONCE)
        return coroutineScope {
            assets.map { asset ->
                async {
                    gate.withPermit {
                        try {
                            val result = loader.execute(storyImageRequest(context, asset.url, asset.key, size))
                            if (result is ErrorResult) throw result.throwable
                            0
                        } catch (e: CancellationException) {
                            throw e
                        } catch (_: Throwable) {
                            // It will draw (or not) the way it always did; the caller is told how many did not load.
                            1
                        }
                    }
                }
            }.awaitAll().sum()
        }
    }

    private const val AT_ONCE = 4
}
