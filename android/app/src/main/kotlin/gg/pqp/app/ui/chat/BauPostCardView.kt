package gg.pqp.app.ui.chat

import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import gg.pqp.app.R
import gg.pqp.app.bau.BauCardCache
import gg.pqp.app.bau.BauCardPoster
import gg.pqp.app.bau.BauCardSelection
import gg.pqp.app.bau.BauCards
import gg.pqp.app.bau.BauPostCard
import gg.pqp.app.bau.BauPostRef
import gg.pqp.app.core.ApiClient
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext

/**
 * A Baú post pasted into chat, drawn as a card: the poster, a play badge for
 * anything that plays, the title, a two-line teaser, who wrote it, and a
 * button that opens the post inside the app.
 *
 * Twin of `client/src/components/chat/bau-post-card.tsx`. The data is the
 * server's `…/card` answer, which runs the feed's own authorization; a reader
 * who may not see the post gets [BauCardState.Unavailable] and the message
 * keeps its plain link, so a card is never a way to learn that a post exists.
 */
sealed interface BauCardState {
    data object Loading : BauCardState
    data object Unavailable : BauCardState
    data class Ready(val card: BauPostCard) : BauCardState
}

private const val RETRIES = 2

/** Where a tap on a post address goes. Provided once, above the nav graph. */
data class BauPostTarget(val ref: BauPostRef, val serverName: String = "")

val LocalOpenBauPost = androidx.compose.runtime.staticCompositionLocalOf<(BauPostTarget) -> Unit> { {} }

/** Loads the card for a message's selected link. Null when the message has none. */
@Composable
fun rememberBauCardState(api: ApiClient, selection: BauCardSelection?): BauCardState? {
    if (selection == null) return null
    val serverId = selection.link.serverId
    val postId = selection.link.postId
    val lang = remember { Locale.getDefault().language }
    val cache: BauCardCache = remember(api) { BauCards.of(api) }
    val state by produceState<BauCardState>(BauCardState.Loading, cache, serverId, postId, lang) {
        // A miss is a 404 or a network failure and looks the same from here, so
        // a row that stays on screen asks again, twice, after the cache's miss
        // window. Otherwise a phone that was offline when the row appeared
        // would show the plain link until the row is recomposed from scratch.
        var attempt = 0
        while (true) {
            val card = cache.load(serverId, postId, lang)
            if (card != null) {
                value = BauCardState.Ready(card)
                return@produceState
            }
            value = BauCardState.Unavailable
            if (++attempt > RETRIES) return@produceState
            delay(BauCardCache.MISS_TTL_MS + 1_000)
        }
    }
    return state
}

@Composable
fun BauPostCardView(
    card: BauPostCard,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val poster = card.poster
    val title = card.title?.trim().takeUnless { it.isNullOrEmpty() } ?: stringResource(R.string.bau_card_untitled)
    val a11y = stringResource(R.string.bau_card_aria, title)
    val shape = RoundedCornerShape(12.dp)
    val colors = MaterialTheme.colorScheme

    Column(
        modifier = modifier
            .widthIn(max = 420.dp)
            .fillMaxWidth()
            .clip(shape)
            .background(colors.surfaceContainer)
            .border(Sizes.hairline, colors.outline, shape)
            .clickable(role = Role.Button, onClick = onOpen)
            .semantics { contentDescription = a11y }
            .testTag("bau.card"),
    ) {
        // Poster, or the short lime plate a text-only post gets.
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .then(if (poster == BauCardPoster.None) Modifier.height(64.dp) else Modifier.aspectRatio(16f / 9f))
                .background(colors.surfaceContainerHigh),
        ) {
            val blurred = if (card.locked) Modifier.blur(12.dp) else Modifier
            when (poster) {
                BauCardPoster.Image -> AsyncImage(
                    model = card.mediaUrl,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize().then(blurred),
                )

                BauCardPoster.VideoFrame -> {
                    val frame = rememberVideoFirstFrame(card.mediaUrl)
                    if (frame != null) {
                        Image(
                            bitmap = frame,
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }

                BauCardPoster.Plate, BauCardPoster.None -> Unit
            }

            // The brand wash: a bottom scrim over a poster, a lime glow on a plate.
            Box(
                Modifier
                    .fillMaxSize()
                    .background(
                        if (poster == BauCardPoster.None || poster == BauCardPoster.Plate) {
                            Brush.horizontalGradient(
                                listOf(colors.primary.copy(alpha = 0.22f), Color.Transparent),
                            )
                        } else {
                            Brush.verticalGradient(
                                listOf(Color.Transparent, colors.background.copy(alpha = 0.85f)),
                            )
                        },
                    ),
            )

            Chip(
                text = stringResource(R.string.bau_title),
                accent = true,
                modifier = Modifier.align(Alignment.TopStart).padding(Spacing.sm),
                withIcon = true,
            )
            if (card.pinned) {
                Chip(
                    text = stringResource(R.string.bau_card_pinned),
                    accent = false,
                    modifier = Modifier.align(Alignment.TopEnd).padding(Spacing.sm),
                )
            }
            if (card.showsPlayBadge) {
                Box(
                    modifier = Modifier
                        .align(Alignment.Center)
                        .size(48.dp)
                        .clip(CircleShape)
                        .background(colors.primary)
                        .testTag("bau.card.play")
                        .semantics { contentDescription = "" },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = PqpIcons.Play,
                        contentDescription = stringResource(R.string.bau_card_video),
                        tint = colors.onPrimary,
                        modifier = Modifier.size(22.dp),
                    )
                }
            }
            if (card.locked) {
                Chip(
                    text = stringResource(R.string.bau_card_locked),
                    accent = false,
                    modifier = Modifier.align(Alignment.BottomEnd).padding(Spacing.sm),
                    icon = PqpIcons.PrivateChannel,
                )
            }
        }

        Column(
            modifier = Modifier.padding(Spacing.md),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            card.teaser?.takeIf { it.isNotBlank() }?.let { teaser ->
                Text(
                    text = teaser,
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                val author = card.author
                if (author != null) {
                    Avatar(
                        name = author.displayName,
                        url = author.avatarUrl,
                        size = 20.dp,
                        seed = author.id.ifEmpty { author.displayName },
                    )
                    Spacer(Modifier.size(Spacing.sm))
                }
                Text(
                    // A locked post names the server instead of its author.
                    text = stringResource(R.string.bau_card_by, author?.displayName ?: card.serverName),
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Spacer(Modifier.weight(1f))
                if (card.likeCount > 0) {
                    Counter(
                        icon = PqpIcons.Like,
                        count = card.likeCount,
                        description = pluralStringResource(R.plurals.bau_card_likes, card.likeCount, card.likeCount),
                    )
                }
                if (card.commentCount > 0) {
                    Spacer(Modifier.size(Spacing.md))
                    Counter(
                        icon = PqpIcons.Messages,
                        count = card.commentCount,
                        description = pluralStringResource(
                            R.plurals.bau_card_comments, card.commentCount, card.commentCount,
                        ),
                    )
                }
            }

            // Looks like a button; the whole card is the hit target, so the
            // button is not a second one for TalkBack to announce.
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(40.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(colors.primary),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResource(R.string.bau_card_cta),
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.onPrimary,
                )
                Spacer(Modifier.size(Spacing.xs))
                Icon(
                    imageVector = PqpIcons.Forward,
                    contentDescription = null,
                    tint = colors.onPrimary,
                    modifier = Modifier.size(Sizes.iconInline),
                )
            }
        }
    }
}

/** The loading stand-in: the same footprint, so the transcript does not jump when the card lands. */
@Composable
fun BauPostCardSkeleton(modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(12.dp)
    val colors = MaterialTheme.colorScheme
    Column(
        modifier = modifier
            .widthIn(max = 420.dp)
            .fillMaxWidth()
            .clip(shape)
            .background(colors.surfaceContainer)
            .border(Sizes.hairline, colors.outline, shape)
            .testTag("bau.card.loading"),
    ) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(colors.surfaceContainerHigh))
        Column(Modifier.padding(Spacing.md), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            Box(Modifier.fillMaxWidth(0.7f).height(16.dp).clip(RoundedCornerShape(4.dp)).background(colors.surfaceContainerHigh))
            Box(Modifier.fillMaxWidth().height(12.dp).clip(RoundedCornerShape(4.dp)).background(colors.surfaceContainerHigh))
            Box(Modifier.fillMaxWidth().height(40.dp).clip(RoundedCornerShape(10.dp)).background(colors.surfaceContainerHigh))
        }
    }
}

@Composable
private fun Chip(
    text: String,
    accent: Boolean,
    modifier: Modifier = Modifier,
    withIcon: Boolean = false,
    icon: androidx.compose.ui.graphics.vector.ImageVector? = null,
) {
    val colors = MaterialTheme.colorScheme
    val glyph = icon ?: if (withIcon) PqpIcons.Bau else null
    val fg = if (accent) colors.onPrimary else colors.onSurface
    Row(
        modifier = modifier
            .clip(CircleShape)
            .background(if (accent) colors.primary else colors.background.copy(alpha = 0.72f))
            .padding(horizontal = Spacing.sm, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (glyph != null) {
            Icon(glyph, contentDescription = null, tint = fg, modifier = Modifier.size(12.dp))
            Spacer(Modifier.size(Spacing.xs))
        }
        Text(
            text = text.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            color = fg,
        )
    }
}

@Composable
private fun Counter(icon: androidx.compose.ui.graphics.vector.ImageVector, count: Int, description: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.semantics { contentDescription = description },
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(Sizes.iconInline),
        )
        Spacer(Modifier.size(Spacing.xs))
        Text(
            text = count.toString(),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// ----------------------------------------------------------- video frame

/** Poster size: a card is at most ~420dp wide, so a frame is never decoded larger than this. */
private const val FRAME_WIDTH = 640
private const val FRAME_HEIGHT = 360

/** Remote frame extraction is network and decode; two at a time is plenty for a chat. */
private val frameLoads = Semaphore(2)

/** Bounded by bytes, not entries: a handful of posters is the working set. */
private val frameCache = object : LruCache<String, Bitmap>(12 * 1024 * 1024) {
    override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
}

/**
 * The first frame of a signed video file, decoded off the main thread. Never
 * plays: the card is a poster, and playing is the Baú's job. Null while it
 * loads and when the file will not give one, in which case the surface colour
 * and the play badge still say "video".
 */
@Composable
private fun rememberVideoFirstFrame(url: String?): androidx.compose.ui.graphics.ImageBitmap? {
    if (url == null) return null
    val frame by produceState<androidx.compose.ui.graphics.ImageBitmap?>(
        initialValue = frameCache.get(url)?.asImageBitmap(),
        url,
    ) {
        if (value != null) return@produceState
        // Below API 27 there is no scaled decode, and a full 1080p frame is
        // too much to hold per poster. Those phones get the plate and the play
        // badge, which still say "video".
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O_MR1) return@produceState
        val bitmap = frameLoads.withPermit {
            withContext(Dispatchers.IO) {
                val retriever = MediaMetadataRetriever()
                try {
                    retriever.setDataSource(url, HashMap())
                    retriever.getScaledFrameAtTime(
                        0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, FRAME_WIDTH, FRAME_HEIGHT,
                    )
                } catch (_: Exception) {
                    null
                } finally {
                    runCatching { retriever.release() }
                }
            }
        }
        if (bitmap != null) {
            frameCache.put(url, bitmap)
            value = bitmap.asImageBitmap()
        }
    }
    return frame
}
