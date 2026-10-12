package gg.pqp.app.bau.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import gg.pqp.app.R
import gg.pqp.app.bau.BauPostCard
import gg.pqp.app.bau.BauPreviewState
import gg.pqp.app.bau.BauThumb
import gg.pqp.app.bau.bauThumb
import gg.pqp.app.bau.bauThumbSource
import gg.pqp.app.bau.bauThumbUrl
import gg.pqp.app.core.Backend
import gg.pqp.app.social.ui.relativeTime
import gg.pqp.app.social.ui.CountBadge
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.components.monogramColor
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing

/** The slim row's height, the same whether it shows a post or the old hint. */
private val SlimRowHeight = 56.dp

/**
 * The Baú on the channel list.
 *
 * A card while there is something new (the newest post, with its cover,
 * who posted it and how it is doing), and a slim row with a thumbnail once it
 * has been seen. Opening the Baú marks it read, so coming back to this screen
 * is what shrinks the card: the two shapes trade places on a spring, never by
 * jumping.
 *
 * Empty, the staff get an invitation to post the first thing and members get
 * a quiet row. An API without `/home/latest` gets the row this screen always
 * had.
 */
@Composable
fun BauPreview(
    state: BauPreviewState,
    serverId: String,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    AnimatedContent(
        targetState = state,
        contentKey = { it::class },
        transitionSpec = {
            fadeIn(spring(stiffness = 400f)) togetherWith fadeOut(spring(stiffness = 600f)) using
                SizeTransform(clip = true) { _, _ -> spring(dampingRatio = 0.85f, stiffness = 380f) }
        },
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.railInset)
            .testTag("channels.bau"),
        label = "bau-preview",
    ) { current ->
        when (current) {
            BauPreviewState.Loading -> PlainRow(unread = 0, onOpen = onOpen)
            is BauPreviewState.Plain -> PlainRow(unread = current.unread, onOpen = onOpen)
            is BauPreviewState.Fresh -> FreshCard(current, serverId, onOpen)
            is BauPreviewState.Seen -> SeenRow(current.post, serverId, onOpen)
            is BauPreviewState.Empty -> if (current.canPost) StaffEmpty(onOpen) else MemberEmpty(onOpen)
        }
    }
}

/** Today's row: icon, title, the hint, and the unread count. */
@Composable
private fun PlainRow(unread: Int, onOpen: () -> Unit) {
    SlimRow(
        onOpen = onOpen,
        leading = { IconTile(PqpIcons.Bau) },
        title = stringResource(R.string.bau_title),
        subtitle = stringResource(R.string.bau_row_hint),
        trailing = {
            if (unread > 0) {
                CountBadge(count = unread, loud = true, modifier = Modifier.testTag("channels.bau.unread"))
            }
        },
    )
}

@Composable
private fun SeenRow(post: BauPostCard, serverId: String, onOpen: () -> Unit) {
    val title = post.title?.trim().takeUnless { it.isNullOrEmpty() } ?: stringResource(R.string.bau_card_untitled)
    val byline = post.author?.displayName
    SlimRow(
        onOpen = onOpen,
        leading = { Thumb(post, serverId, 36.dp) },
        title = stringResource(R.string.bau_title),
        subtitle = stringResource(R.string.bau_preview_latest, title) + (byline?.let { " · $it" } ?: ""),
        trailing = {
            Icon(
                imageVector = PqpIcons.Forward,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(Sizes.iconInline),
            )
        },
        modifier = Modifier.testTag("channels.bau.seen"),
    )
}

@Composable
private fun MemberEmpty(onOpen: () -> Unit) {
    SlimRow(
        onOpen = onOpen,
        leading = { IconTile(PqpIcons.Bau) },
        title = stringResource(R.string.bau_title),
        subtitle = stringResource(R.string.bau_preview_empty_member),
        trailing = {},
        modifier = Modifier.testTag("channels.bau.empty"),
    )
}

@Composable
private fun SlimRow(
    onOpen: () -> Unit,
    leading: @Composable () -> Unit,
    title: String,
    subtitle: String,
    trailing: @Composable () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = SlimRowHeight)
            .clip(MaterialTheme.shapes.small)
            .clickable(onClick = onOpen)
            .padding(horizontal = Spacing.sm, vertical = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Spacer(Modifier.width(Spacing.md))
        Column(Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(Spacing.sm))
        trailing()
    }
}

@Composable
private fun IconTile(icon: ImageVector) {
    Box(
        Modifier
            .size(36.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerHigh),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(Sizes.iconInline),
        )
    }
}

/**
 * The post's cover. A picture loads; anything that plays and has no picture
 * we may fetch gets the server-coloured plate with a play mark, and a text
 * post gets the plate without one. Never a frame pulled out of a video file.
 */
@Composable
private fun Thumb(post: BauPostCard, serverId: String, size: Dp, width: Dp = size) {
    val shape = RoundedCornerShape(if (size > 48.dp) 10.dp else 8.dp)
    Box(
        Modifier
            .size(width = width, height = size)
            .clip(shape)
            .background(
                Brush.linearGradient(
                    listOf(monogramColor(serverId).copy(alpha = 0.6f), MaterialTheme.colorScheme.surfaceContainerHigh),
                ),
            ),
        contentAlignment = Alignment.Center,
    ) {
        val imageUrl = if (bauThumb(post) == BauThumb.Image) bauThumbUrl(bauThumbSource(post), Backend.apiUrl) else null
        if (imageUrl != null) {
            AsyncImage(
                model = imageUrl,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
        if (post.mediaKind in BauPostCard.PLAYABLE && !post.locked) {
            Box(
                Modifier
                    .size(if (size > 48.dp) 24.dp else 18.dp)
                    .clip(CircleShape)
                    .background(Color.Black.copy(alpha = 0.55f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = PqpIcons.Play,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(if (size > 48.dp) 12.dp else 10.dp),
                )
            }
        } else if (bauThumb(post) == BauThumb.Text) {
            Icon(
                imageVector = PqpIcons.Bau,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                modifier = Modifier.size(if (size > 48.dp) 22.dp else 16.dp),
            )
        }
    }
}

@Composable
private fun FreshCard(state: BauPreviewState.Fresh, serverId: String, onOpen: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val post = state.post
    val title = post.title?.trim().takeUnless { it.isNullOrEmpty() } ?: stringResource(R.string.bau_card_untitled)
    val shape = RoundedCornerShape(12.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = Spacing.xs)
            .clip(shape)
            .background(colors.surfaceContainer)
            .border(Sizes.hairline, colors.outline, shape)
            .clickable(onClick = onOpen)
            .testTag("channels.bau.fresh"),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = Spacing.md, end = Spacing.md, top = Spacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = PqpIcons.Bau,
                contentDescription = null,
                tint = colors.onSurfaceVariant,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(Spacing.xs + 2.dp))
            Text(
                text = stringResource(R.string.bau_title),
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                color = colors.onSurface,
            )
            Spacer(Modifier.width(Spacing.sm))
            Text(
                text = stringResource(R.string.bau_preview_new),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                color = colors.onPrimary,
                modifier = Modifier
                    .clip(RoundedCornerShape(4.dp))
                    .background(colors.primary)
                    .padding(horizontal = 5.dp, vertical = 1.dp),
            )
            Spacer(Modifier.weight(1f))
            Text(
                text = stringResource(R.string.bau_preview_open),
                style = MaterialTheme.typography.labelMedium,
                color = colors.onSurfaceVariant,
            )
            Icon(
                imageVector = PqpIcons.Forward,
                contentDescription = null,
                tint = colors.onSurfaceVariant,
                modifier = Modifier.size(14.dp),
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(Spacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Thumb(post, serverId, size = 84.dp, width = 116.dp)
            Spacer(Modifier.width(Spacing.md))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color = colors.onSurface,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                val author = post.author
                // "há 5 min" mid-sentence, not "Há 5 min." as the system
                // capitalises it for a line of its own.
                val ago = relativeTime(post.publishedAt)?.toString()?.replaceFirstChar { it.lowercase() }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (author != null) {
                        Avatar(
                            name = author.displayName,
                            url = author.avatarUrl,
                            size = 16.dp,
                            seed = author.id.ifEmpty { author.displayName },
                        )
                        Spacer(Modifier.width(Spacing.xs + 2.dp))
                    }
                    Text(
                        text = listOfNotNull(author?.displayName, ago).joinToString(" · "),
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Counter(PqpIcons.Like, post.likeCount)
                    Spacer(Modifier.width(Spacing.md))
                    Counter(PqpIcons.Messages, post.commentCount)
                }
            }
        }
        if (state.moreCount > 0) {
            HorizontalDivider(thickness = Sizes.hairline, color = colors.outline)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(40.dp)
                    .padding(horizontal = Spacing.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val next = state.next
                if (next != null) {
                    Thumb(next, serverId, 20.dp)
                    Spacer(Modifier.width(Spacing.sm))
                }
                val nextTitle = next?.title?.trim()?.takeIf { it.isNotEmpty() }
                Text(
                    text = if (nextTitle != null) {
                        pluralStringResource(R.plurals.bau_preview_more_named, state.moreCount, state.moreCount, nextTitle)
                    } else {
                        pluralStringResource(R.plurals.bau_preview_more, state.moreCount, state.moreCount)
                    },
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun Counter(icon: ImageVector, count: Int) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(14.dp),
        )
        Spacer(Modifier.width(Spacing.xs))
        Text(
            text = count.toString(),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** The staff's empty Baú: an invitation, and the button that goes and posts. */
@Composable
private fun StaffEmpty(onOpen: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.fillMaxWidth().padding(vertical = Spacing.xs).testTag("channels.bau.invite")) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(shape)
                .border(Sizes.hairline, colors.outline, shape)
                .clickable(onClick = onOpen)
                .padding(Spacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(colors.primary.copy(alpha = 0.14f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(PqpIcons.Bau, contentDescription = null, tint = colors.primary, modifier = Modifier.size(Sizes.iconInline))
            }
            Spacer(Modifier.width(Spacing.md))
            Column(Modifier.weight(1f)) {
                Text(
                    text = stringResource(R.string.bau_preview_empty_staff_title),
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.onSurface,
                )
                Text(
                    text = stringResource(R.string.bau_preview_empty_staff_body),
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.onSurfaceVariant,
                )
            }
        }
        Spacer(Modifier.height(Spacing.sm))
        Row(
            modifier = Modifier
                .align(Alignment.End)
                .clip(RoundedCornerShape(50))
                .background(colors.primary)
                .clickable(onClick = onOpen)
                .padding(horizontal = Spacing.md, vertical = Spacing.xs + 2.dp)
                .testTag("channels.bau.post"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(PqpIcons.Edit, contentDescription = null, tint = colors.onPrimary, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(Spacing.xs + 2.dp))
            Text(
                text = stringResource(R.string.bau_preview_post),
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                color = colors.onPrimary,
            )
        }
    }
}
