package gg.pqp.app.stories.ui

import android.provider.Settings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.core.Me
import gg.pqp.app.stories.StoryAuthor
import gg.pqp.app.stories.StoryOutboxRules
import gg.pqp.app.stories.StoryStrip
import gg.pqp.app.stories.StoryStripItem
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.theme.Motion
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlin.math.roundToInt

/**
 * The ring around somebody who has a story. A lime-to-amber sweep while there
 * is something new (never solid lime: solid lime already means "speaking" and
 * "in the call"), a thin neutral outline once it is all seen. The two are
 * stacked and cross-faded rather than one gradient being animated, which is
 * the design's rule and the cheap way to do it.
 */
@Composable
fun StoryRing(
    unseen: Boolean,
    modifier: Modifier = Modifier,
    size: Dp = 64.dp,
    /** The quiet ring's colour: yours is brighter than somebody else's seen one, so a story you posted still reads as there. */
    seenColor: Color = MaterialTheme.colorScheme.outline,
    seenWidth: Dp = 1.5.dp,
    content: @Composable () -> Unit,
) {
    val fresh by animateFloatAsState(
        targetValue = if (unseen) 1f else 0f,
        animationSpec = tween(Motion.SETTLE_MILLIS),
        label = "story-ring",
    )
    val sweep = Brush.sweepGradient(listOf(Palette.Signal, Palette.Warning, Palette.Signal))
    Box(modifier = modifier.size(size), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val freshWidth = 2.5.dp.toPx()
            val seenPx = seenWidth.toPx()
            drawCircle(
                color = seenColor,
                radius = (this.size.minDimension - seenPx) / 2,
                style = Stroke(seenPx),
                alpha = 1f - fresh,
            )
            drawCircle(
                brush = sweep,
                radius = (this.size.minDimension - freshWidth) / 2,
                style = Stroke(freshWidth),
                alpha = fresh,
            )
        }
        Box(
            Modifier
                .size(size - 8.dp)
                .clip(CircleShape),
        ) { content() }
    }
}

/**
 * A strip of stories: "Teu story" first, then whoever has something new, then
 * the already seen, in the order the server sent (it ranks; the phone never
 * reorders under a finger). Each ring scales and fades in when it arrives;
 * Compose scales that by the animator duration scale, so "remove animations"
 * makes it appear.
 */
@Composable
fun StoryStripRow(
    strip: StoryStrip,
    me: Me?,
    onOpenAuthor: (Int) -> Unit,
    onOpenOwn: () -> Unit,
    onCompose: () -> Unit,
    modifier: Modifier = Modifier,
    /** A story of mine on its way (or that did not make it): drawn on my own ring. */
    bubble: StoryOutboxRules.Bubble = StoryOutboxRules.Bubble.Idle,
    onFailedTap: (String) -> Unit = {},
    onPostingTap: (String) -> Unit = {},
    onWaitingTap: (String) -> Unit = {},
) {
    LazyRow(
        contentPadding = PaddingValues(horizontal = Spacing.gutter),
        horizontalArrangement = Arrangement.spacedBy(Spacing.md),
        modifier = modifier
            .fillMaxWidth()
            .testTag("stories.strip"),
    ) {
        if (strip.canPost || strip.own != null) {
            item(key = "own") {
                OwnBubble(
                    me = me,
                    own = strip.own,
                    canPost = strip.canPost,
                    bubble = bubble,
                    onOpen = onOpenOwn,
                    onCompose = onCompose,
                    onFailedTap = onFailedTap,
                    onPostingTap = onPostingTap,
                    onWaitingTap = onWaitingTap,
                    modifier = Modifier.animateItem(),
                )
            }
        }
        itemsIndexed(strip.items, key = { _, item -> item.author.id }) { index, item ->
            AuthorBubble(item = item, onClick = { onOpenAuthor(index) }, modifier = Modifier.animateItem())
        }
    }
}

@Composable
private fun OwnBubble(
    me: Me?,
    own: StoryStripItem?,
    canPost: Boolean,
    bubble: StoryOutboxRules.Bubble,
    onOpen: () -> Unit,
    onCompose: () -> Unit,
    onFailedTap: (String) -> Unit,
    onPostingTap: (String) -> Unit,
    onWaitingTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val yours = stringResource(R.string.stories_yours)
    val posting = bubble as? StoryOutboxRules.Bubble.Posting
    val failed = bubble as? StoryOutboxRules.Bubble.Failed
    val waiting = bubble as? StoryOutboxRules.Bubble.Waiting
    val label = when {
        waiting != null -> stringResource(R.string.stories_outbox_waiting_label)
        posting != null -> stringResource(R.string.stories_upload_posting)
        failed != null -> stringResource(R.string.stories_outbox_failed_label)
        else -> yours
    }
    val percent = posting?.fraction?.let { (it * 100).roundToInt() }
    val spoken = when {
        percent != null -> stringResource(R.string.stories_outbox_progress_desc, percent)
        posting != null -> stringResource(R.string.stories_upload_posting)
        waiting != null -> stringResource(R.string.stories_outbox_waiting_label)
        failed != null -> stringResource(R.string.stories_outbox_failed_title)
        else -> yours
    }
    val primary: () -> Unit = when {
        failed != null -> ({ onFailedTap(failed.id) })
        waiting != null -> ({ onWaitingTap(waiting.id) })
        // Mid-post there is nothing to compose: a tap is the way to stop it.
        posting != null -> ({ onPostingTap(posting.id) })
        own != null -> onOpen
        else -> onCompose
    }
    // The "+" is drawn small, but it is a 48 dp target: a tap in it makes a story, wherever the ring would have opened one.
    val showsBadge = canPost && posting == null && waiting == null && failed == null
    val newStory = stringResource(R.string.stories_compose_title)
    val density = LocalDensity.current
    val haptics = LocalHapticFeedback.current
    val latestPrimary by rememberUpdatedState(primary)
    val latestCompose by rememberUpdatedState(onCompose)
    val latestBadge by rememberUpdatedState(showsBadge)
    val latestCanPost by rememberUpdatedState(canPost)
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier
            .width(68.dp)
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = { at ->
                        val x = at.x / density.density
                        val y = at.y / density.density
                        if (latestBadge && StoryStripRules.inBadge(x, y)) latestCompose() else latestPrimary()
                    },
                    // Holding the ring is the other way to a new story, whatever the ring is showing.
                    onLongPress = {
                        if (latestCanPost) {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            latestCompose()
                        }
                    },
                )
            }
            .semantics(mergeDescendants = true) {
                contentDescription = spoken
                role = Role.Button
                onClick { primary(); true }
                if (canPost) onLongClick(label = newStory) { onCompose(); true }
            }
            .testTag("stories.own"),
    ) {
        Box {
            when {
                posting != null || failed != null || waiting != null -> PostingRing(
                    fraction = posting?.fraction,
                    failed = failed != null,
                    waiting = waiting != null,
                ) {
                    Avatar(name = me?.displayName.orEmpty(), url = me?.avatarUrl, size = 56.dp, seed = me?.id ?: "")
                    // A veil while it is on its way, so the ring is the thing to read.
                    if (posting != null || waiting != null) Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f)))
                }
                own != null -> StoryRing(unseen = false, seenColor = MaterialTheme.colorScheme.onSurfaceVariant, seenWidth = 2.dp) {
                    Avatar(name = me?.displayName.orEmpty(), url = me?.avatarUrl, size = 56.dp, seed = me?.id ?: "")
                }
                else -> Box(Modifier.size(64.dp), contentAlignment = Alignment.Center) {
                    Avatar(name = me?.displayName.orEmpty(), url = me?.avatarUrl, size = 56.dp, seed = me?.id ?: "")
                }
            }
            if (failed != null) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .offset(x = 2.dp, y = 2.dp)
                        .size(22.dp)
                        .clip(CircleShape)
                        .background(Palette.Danger)
                        .border(2.dp, MaterialTheme.colorScheme.background, CircleShape),
                ) {
                    Icon(PqpIcons.Warning, contentDescription = null, tint = Color.White, modifier = Modifier.size(14.dp))
                }
            } else if (waiting != null) {
                // Grey and quiet: it is not broken, it is waiting.
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .offset(x = 2.dp, y = 2.dp)
                        .size(22.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.surfaceContainerHighest)
                        .border(2.dp, MaterialTheme.colorScheme.background, CircleShape),
                ) {
                    Icon(PqpIcons.Pause, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(12.dp))
                }
            } else if (canPost && posting == null) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .offset(x = 2.dp, y = 2.dp)
                        .size(22.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primary)
                        .border(2.dp, MaterialTheme.colorScheme.background, CircleShape)
                        .testTag("stories.compose"),
                ) {
                    Icon(
                        PqpIcons.Add,
                        contentDescription = stringResource(R.string.stories_compose_title),
                        tint = MaterialTheme.colorScheme.onPrimary,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
        }
        Spacer(Modifier.size(4.dp))
        BubbleLabel(label, strong = failed != null, maxLines = if (waiting != null) 2 else 1)
    }
}

/**
 * The ring of a story still being posted: a track, and an arc over it for the
 * bytes that have gone out. [fraction] null is "no number yet" (a card with
 * only words, or the files still being made ready): a short arc turns around
 * the avatar. With "Remove animations" on, nothing turns: the arc is a fixed
 * quarter, and the determinate one still grows (it is a number changing, not
 * a motion). Failed is the whole ring in the danger colour, no arc.
 */
@Composable
fun PostingRing(
    fraction: Float?,
    failed: Boolean,
    modifier: Modifier = Modifier,
    /** No connection: the whole ring in the quiet colour, no arc, nothing turning. */
    waiting: Boolean = false,
    size: Dp = 64.dp,
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val animationsOn = remember {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f
    }
    val track = MaterialTheme.colorScheme.outline
    val shown by animateFloatAsState(
        targetValue = fraction ?: 0f,
        animationSpec = tween(Motion.SETTLE_MILLIS),
        label = "posting-ring",
    )
    val spin = if (fraction == null && !failed && animationsOn) {
        val transition = rememberInfiniteTransition(label = "posting-spin")
        transition.animateFloat(
            initialValue = 0f,
            targetValue = 360f,
            animationSpec = infiniteRepeatable(tween(1_100, easing = LinearEasing), RepeatMode.Restart),
            label = "posting-spin-angle",
        ).value
    } else {
        0f
    }
    Box(modifier = modifier.size(size), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val width = 3.dp.toPx()
            val inset = width / 2
            val arcSize = androidx.compose.ui.geometry.Size(this.size.width - width, this.size.height - width)
            val topLeft = Offset(inset, inset)
            if (failed) {
                drawArc(Palette.Danger, 0f, 360f, false, topLeft, arcSize, style = Stroke(width))
            } else if (waiting) {
                drawArc(track, 0f, 360f, false, topLeft, arcSize, style = Stroke(width))
            } else {
                drawArc(track, 0f, 360f, false, topLeft, arcSize, style = Stroke(width))
                val sweep = if (fraction == null) 90f else 360f * shown
                drawArc(Palette.Signal, -90f + spin, sweep, false, topLeft, arcSize, style = Stroke(width, cap = StrokeCap.Round))
            }
        }
        Box(
            Modifier
                .size(size - 8.dp)
                .clip(CircleShape),
        ) { content() }
    }
}

@Composable
private fun AuthorBubble(item: StoryStripItem, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val open = stringResource(R.string.stories_open, item.author.displayName)
    val fresh = stringResource(R.string.stories_unseen)
    val call = stringResource(R.string.stories_call_badge)
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier
            .width(68.dp)
            .clickable(onClick = onClick)
            .semantics {
                contentDescription = listOfNotNull(open, fresh.takeIf { item.unseen }, call.takeIf { item.hasCall })
                    .joinToString(", ")
            }
            .testTag("stories.author"),
    ) {
        Box {
            StoryRing(unseen = item.unseen) { AuthorAvatar(item.author, 56.dp) }
            if (item.hasCall) {
                // The call badge: joinable before the story is even opened.
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .offset(x = 2.dp, y = 2.dp)
                        .size(22.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.surfaceContainerHighest)
                        .border(2.dp, MaterialTheme.colorScheme.background, CircleShape),
                ) {
                    Icon(
                        PqpIcons.Listening,
                        contentDescription = null,
                        tint = Palette.Signal,
                        modifier = Modifier.size(12.dp),
                    )
                }
            }
        }
        Spacer(Modifier.size(4.dp))
        BubbleLabel(item.author.displayName.substringBefore(' '), strong = item.unseen)
    }
}

@Composable
fun AuthorAvatar(author: StoryAuthor, size: Dp) {
    Avatar(name = author.displayName, url = author.avatarUrl, size = size, seed = author.id)
}

@Composable
private fun BubbleLabel(text: String, strong: Boolean, maxLines: Int = 1) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelMedium,
        color = if (strong) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        textAlign = TextAlign.Center,
    )
}

/**
 * The one-off row for a server where nobody has posted yet, in the first days
 * after the flag goes on. After that the strip is simply absent.
 */
@Composable
fun StoryFirstRunRow(me: Me?, onPost: () -> Unit, modifier: Modifier = Modifier) {
    val dash = MaterialTheme.colorScheme.outline
    Surface(
        color = Color.Transparent,
        shape = MaterialTheme.shapes.medium,
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.gutter)
            .testTag("stories.firstRun"),
    ) {
        Box {
            Canvas(Modifier.matchParentSize()) {
                drawRoundRect(
                    color = dash,
                    style = Stroke(width = 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(12f, 10f))),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(16.dp.toPx()),
                    topLeft = Offset.Zero,
                )
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(Spacing.md),
            ) {
                Avatar(name = me?.displayName.orEmpty(), url = me?.avatarUrl, size = 44.dp, seed = me?.id ?: "")
                Spacer(Modifier.width(Spacing.md))
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.stories_empty_title), style = MaterialTheme.typography.titleSmall)
                    Text(
                        stringResource(R.string.stories_empty_body),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.width(Spacing.sm))
                Button(
                    onClick = onPost,
                    shape = MaterialTheme.shapes.small,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary,
                    ),
                    contentPadding = PaddingValues(horizontal = Spacing.md, vertical = Spacing.xs),
                ) { Text(stringResource(R.string.stories_empty_cta)) }
            }
        }
    }
}


/**
 * One quiet line on a server where nobody has posted and the first-run row is
 * gone: the way in to the composer, without a bubble's worth of height.
 */
@Composable
fun StoryComposeLink(onPost: () -> Unit, modifier: Modifier = Modifier) {
    androidx.compose.material3.TextButton(
        onClick = onPost,
        modifier = modifier
            .padding(horizontal = Spacing.sm)
            .testTag("stories.composeLink"),
    ) {
        Icon(PqpIcons.Add, contentDescription = null, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(Spacing.xs))
        Text(stringResource(R.string.stories_empty_compact_cta))
    }
}

/** Where the own bubble is touched, in dp from its top-left corner (the bubble is 68 dp wide, its ring 64 dp tall). */
object StoryStripRules {
    /** The "+" badge sits at the ring's bottom-right: its 48 dp target is the square around it, kept inside the bubble. */
    const val BADGE_LEFT = 20f
    const val BADGE_RIGHT = 68f
    const val BADGE_TOP = 31f
    const val BADGE_BOTTOM = 79f

    fun inBadge(xDp: Float, yDp: Float): Boolean = xDp in BADGE_LEFT..BADGE_RIGHT && yDp in BADGE_TOP..BADGE_BOTTOM
}
