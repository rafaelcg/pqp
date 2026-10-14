package gg.pqp.app.stories.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import coil3.request.ImageRequest
import coil3.size.Size
import gg.pqp.app.R
import gg.pqp.app.core.SessionStore
import gg.pqp.app.stories.CallStoryLayer
import gg.pqp.app.stories.DrawingStoryLayer
import gg.pqp.app.stories.ImageStoryLayer
import gg.pqp.app.stories.MentionStoryLayer
import gg.pqp.app.stories.Story
import gg.pqp.app.stories.StoryPreloadRules
import gg.pqp.app.stories.storyImageRequest
import gg.pqp.app.stories.StoryAuthor
import gg.pqp.app.stories.StoryCallLive
import gg.pqp.app.stories.StoryLayer
import gg.pqp.app.stories.TextStoryLayer
import gg.pqp.app.stories.editor.BaseFit
import gg.pqp.app.stories.editor.CallFace
import gg.pqp.app.stories.editor.LayerMath
import gg.pqp.app.stories.editor.MentionLayerContent
import gg.pqp.app.stories.editor.PhotoLayerContent
import gg.pqp.app.stories.editor.PlacedLayer
import gg.pqp.app.stories.editor.StoryBaseImage
import gg.pqp.app.stories.editor.StoryCallCard
import gg.pqp.app.stories.editor.TextLayerContent
import gg.pqp.app.stories.editor.callCardState

/**
 * What the viewer draws for a story: the base, then each layer in order, on a
 * 9:16 canvas as wide as the screen allows, clipped at its edge. The same
 * canvas, the same placement and the same layer drawings as the editor
 * (`PlacedLayer`, `TextLayerContent`, ...), so a story reads here as it was
 * made.
 *
 * A story posted before layers (a photo, a text card, a call sticker on a
 * card) has none, and is drawn exactly as it was: its photo, its centred text,
 * its call card where the sticker used to sit.
 *
 * Mentions and the call card are the only things to tap. Text and photos are
 * not; a tap on them is a tap on the story, which steps it.
 */
@Composable
fun StoryCanvas(
    story: Story,
    session: SessionStore,
    active: Boolean,
    paused: Boolean,
    muted: Boolean,
    onVideoProgress: (Float) -> Unit,
    onVideoEnded: () -> Unit,
    onHasAudio: (Boolean) -> Unit = {},
    /** The story's first frame is on screen (a picture decoded, a clip rendering); at once for a story with no media. */
    onReady: () -> Unit = {},
    onJoinCall: (StoryCallLive) -> Unit,
    onOpenMention: (StoryAuthor) -> Unit,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current
    val servers by session.servers.collectAsStateWithLifecycle()
    val spoken = story.altText?.takeIf { it.isNotBlank() } ?: story.caption?.takeIf { it.isNotBlank() }
    // A card of words has nothing to wait for; a picture or a clip says so itself.
    val hasMedia = story.kind != "text" && story.media != null &&
        story.own?.status != "processing" && story.own?.status != "pending"
    if (!hasMedia) androidx.compose.runtime.LaunchedEffect(story.id) { onReady() }

    BoxWithConstraints(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val width = minOf(maxWidth, maxHeight * 9f / 16f)
        val height = width * 16f / 9f
        val canvas = with(density) { LayerMath.Canvas(width.toPx(), height.toPx()) }

        // The author's canvas is never cropped: on a screen taller or wider than 9:16 it is shown whole,
        // and what is left over is the base itself, blurred (or the card's background colour).
        if (width < maxWidth || height < maxHeight) {
            StoryBackdrop(story, ((maxHeight - height) / 2f) / maxHeight, Modifier.fillMaxSize().testTag("stories.viewer.backdrop"))
        }

        Box(Modifier.size(width, height).clipToBounds().testTag("stories.viewer.canvas")) {
            StoryBase(
                story = story,
                spoken = spoken,
                active = active,
                paused = paused,
                muted = muted,
                onVideoProgress = onVideoProgress,
                onVideoEnded = onVideoEnded,
                onHasAudio = onHasAudio,
                onReady = onReady,
            )
            // The words are on the base's description when there are any; reading them
            // again from each text layer would say everything twice.
            val hideText = story.altText?.isNotBlank() == true

            visibleLayers(story).forEach { layer ->
                androidx.compose.runtime.key(layer.id) {
                    when (layer) {
                        is DrawingStoryLayer -> AsyncImage(
                            model = rememberStoryImage(absolute(layer.url), StoryPreloadRules.layerKey(story.id, layer.id)),
                            contentDescription = null,
                            contentScale = ContentScale.FillBounds,
                            modifier = Modifier.fillMaxSize(),
                        )
                        is TextStoryLayer -> PlacedLayer(layer.x, layer.y, layer.scale, layer.rotation, canvas) {
                            Box(if (hideText) Modifier.clearAndSetSemantics { } else Modifier) {
                                TextLayerContent(layer.text, layer.font, layer.color, layer.background, layer.align, layer.size, canvas.width)
                            }
                        }
                        is ImageStoryLayer -> PlacedLayer(layer.x, layer.y, layer.scale, layer.rotation, canvas) {
                            PhotoLayerContent(rememberStoryImage(absolute(layer.url), StoryPreloadRules.layerKey(story.id, layer.id)), layer.shape, layer.width, layer.height, canvas.width, description = null)
                        }
                        is MentionStoryLayer -> {
                            val person = layer.user
                            if (person != null && person.displayName.isNotBlank()) {
                                val label = stringResource(R.string.stories_viewer_mention, person.displayName)
                                PlacedLayer(layer.x, layer.y, layer.scale, layer.rotation, canvas) {
                                    Box(
                                        Modifier
                                            .semantics {
                                                contentDescription = label
                                                role = Role.Button
                                            }
                                            .clickable { onOpenMention(person) }
                                            .testTag("stories.viewer.mention"),
                                    ) { MentionLayerContent(person.displayName, canvas.width) }
                                }
                            }
                        }
                        is CallStoryLayer -> {
                            val live = story.call?.takeIf { it.channelId == layer.channelId }
                            if (live != null) {
                                val server = servers.firstOrNull { it.id == layer.serverId }
                                PlacedLayer(layer.x, layer.y, layer.scale, layer.rotation, canvas) {
                                    StoryCallCard(
                                        state = callCardState(live.state, live.count, live.joinable),
                                        roomName = live.channelName,
                                        serverName = server?.name.orEmpty(),
                                        serverId = layer.serverId,
                                        serverIconUrl = server?.iconUrl,
                                        faces = live.participants.map { CallFace(it.id, it.displayName, it.avatarUrl) },
                                        count = live.count,
                                        canvasWidthPx = canvas.width,
                                        onJoin = if (live.joinable && live.state == "live") ({ onJoinCall(live) }) else null,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** The request for a story's picture, under the key the preloader fills (see [StoryPreloadRules.baseKey]). */
@Composable
internal fun rememberStoryImage(url: String, key: String): ImageRequest {
    val context = LocalContext.current
    return remember(url, key) { storyImageRequest(context, url, key) }
}

/**
 * The layers to draw. A story from before layers that has a call sticker has
 * no call layer; the server synthesises one for the current schema, and this
 * does the same for a server that does not yet, at the spot the sticker always
 * sat, so such a story keeps its call card.
 */
fun visibleLayers(story: Story): List<StoryLayer> {
    val call = story.call
    if (call != null && story.layers.none { it is CallStoryLayer }) {
        return story.layers + CallStoryLayer(story.id, 0.5f, 0.8f, 1f, 0f, call.serverId, call.channelId)
    }
    return story.layers
}

/** The backdrop picture is decoded this wide (pixels) and stretched: a blur that costs nothing. */
private const val BACKDROP_EDGE = 48

/**
 * What fills the screen around a 9:16 canvas: a card's gradient, or the story's
 * own picture (a clip's poster) cropped to fill and blurred, dimmed a little so
 * the canvas stays the thing to look at.
 */
@Composable
private fun StoryBackdrop(story: Story, barShare: Float, modifier: Modifier = Modifier) {
    val media = story.media
    when {
        // The card's gradient runs across the canvas only; the bars carry its end colours, so there is no seam.
        story.kind == "text" -> {
            val (top, bottom) = backgroundColors(story.background)
            val bar = barShare.coerceIn(0f, 0.49f)
            Box(
                modifier.background(
                    Brush.verticalGradient(
                        0f to top, bar to top, (1f - bar) to bottom, 1f to bottom,
                    ),
                ),
            )
        }
        media != null -> {
            val model = if (story.kind == "video") media.posterUrl?.let(::absolute) else absolute(media.url)
            val key = if (story.kind == "video") StoryPreloadRules.posterKey(story.id) else StoryPreloadRules.baseKey(story.id)
            Box(modifier.background(Color.Black)) {
                if (model != null) {
                    // Decoded at thumbnail size and stretched, which is a blur that costs nothing: no
                    // full-screen render effect behind every story, and the same on every Android version.
                    // The same cache key as the picture itself: this is a small decode of what the preload already fetched.
                    val context = LocalContext.current
                    val request = remember(model, key) {
                        ImageRequest.Builder(context)
                            .data(model)
                            .memoryCacheKey(key)
                            .diskCacheKey(key)
                            .size(Size(BACKDROP_EDGE, BACKDROP_EDGE * 16 / 9))
                            .build()
                    }
                    AsyncImage(
                        model = request,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.3f)))
                }
            }
        }
        else -> Box(modifier.background(Color.Black))
    }
}

@Composable
private fun StoryBase(
    story: Story,
    spoken: String?,
    active: Boolean,
    paused: Boolean,
    muted: Boolean,
    onVideoProgress: (Float) -> Unit,
    onVideoEnded: () -> Unit,
    onHasAudio: (Boolean) -> Unit,
    onReady: () -> Unit,
) {
    val media = story.media
    val describe = if (spoken != null) Modifier.semantics { contentDescription = spoken } else Modifier
    when {
        story.kind == "text" -> {
            // A card is a gradient, and its words are layers. One posted before layers has
            // only `text`: drawn centred, as it always was.
            if (story.layers.none { it is TextStoryLayer } && !story.text.isNullOrBlank()) {
                TextCard(story.text, story.background, describe)
            } else {
                Box(Modifier.fillMaxSize().background(backgroundBrush(story.background)).then(describe))
            }
        }
        story.own?.status == "processing" || story.own?.status == "pending" -> Box(Modifier.fillMaxSize().background(Color.Black)) {
            Text(
                stringResource(R.string.stories_own_processing),
                color = Color.White,
                modifier = Modifier.align(Alignment.Center),
            )
        }
        story.kind == "video" && media != null -> Box(Modifier.fillMaxSize().background(Color.Black).then(describe)) {
            StoryVideo(
                storyId = story.id,
                url = absolute(media.url),
                posterUrl = media.posterUrl?.let(::absolute),
                active = active,
                paused = paused,
                muted = muted,
                fill = BaseFit.fills(media.width, media.height),
                onProgress = onVideoProgress,
                onEnded = onVideoEnded,
                onHasAudio = onHasAudio,
                onReady = onReady,
            )
        }
        media != null -> {
            StoryBaseImage(
            model = rememberStoryImage(absolute(media.url), StoryPreloadRules.baseKey(story.id)),
            width = media.width,
            height = media.height,
            description = spoken,
            onFirstFrame = {
                gg.pqp.app.stories.StoryPerf.frameReady(story.id, "image")
                onReady()
            },
            onFailed = onReady,
            )
        }
        else -> Box(Modifier.fillMaxSize().background(Color.Black))
    }
}
