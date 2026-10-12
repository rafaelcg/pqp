package gg.pqp.app.stories.ui

import androidx.compose.animation.core.animateFloatAsState
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.core.Me
import gg.pqp.app.stories.StoryAuthor
import gg.pqp.app.stories.StoryStrip
import gg.pqp.app.stories.StoryStripItem
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.theme.Motion
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing

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
    content: @Composable () -> Unit,
) {
    val fresh by animateFloatAsState(
        targetValue = if (unseen) 1f else 0f,
        animationSpec = tween(Motion.SETTLE_MILLIS),
        label = "story-ring",
    )
    val seenColor = MaterialTheme.colorScheme.outline
    val sweep = Brush.sweepGradient(listOf(Palette.Signal, Palette.Warning, Palette.Signal))
    Box(modifier = modifier.size(size), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val freshWidth = 2.5.dp.toPx()
            val seenWidth = 1.5.dp.toPx()
            drawCircle(
                color = seenColor,
                radius = (this.size.minDimension - seenWidth) / 2,
                style = Stroke(seenWidth),
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
                    onOpen = onOpenOwn,
                    onCompose = onCompose,
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
    onOpen: () -> Unit,
    onCompose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val label = stringResource(R.string.stories_yours)
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier
            .width(68.dp)
            .clickable(onClick = if (own != null) onOpen else onCompose)
            .semantics { contentDescription = label }
            .testTag("stories.own"),
    ) {
        Box {
            if (own != null) {
                StoryRing(unseen = false) {
                    Avatar(name = me?.displayName.orEmpty(), url = me?.avatarUrl, size = 56.dp, seed = me?.id ?: "")
                }
            } else {
                Box(Modifier.size(64.dp), contentAlignment = Alignment.Center) {
                    Avatar(name = me?.displayName.orEmpty(), url = me?.avatarUrl, size = 56.dp, seed = me?.id ?: "")
                }
            }
            if (canPost) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .offset(x = 2.dp, y = 2.dp)
                        .size(22.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primary)
                        .border(2.dp, MaterialTheme.colorScheme.background, CircleShape)
                        .clickable(onClick = onCompose)
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
        BubbleLabel(label, strong = false)
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
private fun BubbleLabel(text: String, strong: Boolean) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelMedium,
        color = if (strong) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
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

