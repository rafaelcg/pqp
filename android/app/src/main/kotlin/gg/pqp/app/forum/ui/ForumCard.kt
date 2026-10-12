package gg.pqp.app.forum.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import gg.pqp.app.R
import gg.pqp.app.forum.ForumPostSummary
import gg.pqp.app.forum.ForumTag
import gg.pqp.app.forum.ForumUnread
import gg.pqp.app.ui.theme.Motion
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.ui.theme.TabularFigures

/** The card's corner, the web's `--radius-card`. */
private val CardShape = RoundedCornerShape(14.dp)

/** UX §5: 56dp on a phone. */
private val Thumbnail = 56.dp

/**
 * One post in the list (UX §2.3): status badges then the title, the author
 * and the start of the question, then tags on the left and numbers on the
 * right. The whole card is the target; status is never truncated and tags
 * collapse into "+N" when they run out of room.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ForumPostCard(
    post: ForumPostSummary,
    unread: ForumUnread,
    tagsById: Map<String, ForumTag>,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val interactions = remember { MutableInteractionSource() }
    val pressed by interactions.collectIsPressedAsState()
    val fill by animateColorAsState(
        targetValue = if (pressed) colors.surfaceContainerHigh else colors.surfaceContainer,
        animationSpec = if (pressed) snap() else tween(Motion.QUICK_MILLIS),
        label = "forum-card-fill",
    )
    val isNew = unread is ForumUnread.New
    val newReplies = (unread as? ForumUnread.Unread)?.count ?: 0
    val bold = unread !is ForumUnread.Read

    val author = post.authorName ?: stringResource(R.string.forum_deleted_author)
    val replies = repliesText(post.replyCount)
    val time = agoText(post.lastActivityAt)
    val status = listOfNotNull(
        stringResource(R.string.forum_badge_pinned).takeIf { post.pinned },
        stringResource(R.string.forum_badge_resolved).takeIf { post.resolved },
        stringResource(R.string.forum_badge_locked).takeIf { post.locked },
    ).ifEmpty { listOf(stringResource(R.string.forum_card_open)) }.joinToString(", ")
    val unreadSr = when {
        isNew -> stringResource(R.string.forum_card_sr_new)
        newReplies > 0 -> pluralStringResource(R.plurals.forum_card_sr_unread, newReplies, newReplies)
        else -> null
    }
    val description = listOfNotNull(
        stringResource(R.string.forum_card_sr, post.title, status, author, replies, time),
        unreadSr,
    ).joinToString(", ")

    Box(modifier.fillMaxWidth()) {
        Surface(
            onClick = onClick,
            interactionSource = interactions,
            shape = CardShape,
            color = fill,
            border = androidx.compose.foundation.BorderStroke(Sizes.hairline, colors.outline),
            modifier = Modifier
                .fillMaxWidth()
                .clearAndSetSemantics {
                    contentDescription = description
                    role = Role.Button
                    onClick { onClick(); true }
                }
                .testTag("forum.card.${post.id}"),
        ) {
            Row(Modifier.padding(start = 14.dp, end = 12.dp, top = 12.dp, bottom = 10.dp)) {
                Column(Modifier.weight(1f)) {
                    if (isNew || post.pinned || post.resolved || post.locked || post.authorIsWebhook) {
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                            modifier = Modifier.padding(bottom = 6.dp),
                        ) {
                            if (isNew) ForumBadge(BadgeKind.New)
                            if (post.resolved) ForumBadge(BadgeKind.Resolved)
                            if (post.locked) ForumBadge(BadgeKind.Locked)
                            if (post.authorIsWebhook) ForumBadge(BadgeKind.Feed)
                        }
                    }
                    Text(
                        text = post.title,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Medium,
                        color = if (bold) colors.onSurface else colors.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    val preview = when {
                        post.openingDeleted -> stringResource(R.string.forum_preview_deleted)
                        post.openingKind == "voice" -> stringResource(R.string.forum_preview_voice)
                        !post.preview.isNullOrBlank() -> previewText(post.preview)
                        post.attachmentCount > 0 ->
                            pluralStringResource(R.plurals.forum_preview_files, post.attachmentCount, post.attachmentCount)
                        else -> null
                    }
                    Spacer(Modifier.height(2.dp))
                    Text(
                        text = buildAnnotatedString {
                            withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = colors.onSurfaceVariant)) {
                                append(author)
                            }
                            if (preview != null) {
                                append(": ")
                                append(preview)
                            }
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.onSurfaceVariant.copy(alpha = 0.82f),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.height(Spacing.sm))
                    CardFooter(post, tagsById, newReplies, time)
                }
                post.thumbnailUrl?.let { url ->
                    Spacer(Modifier.width(Spacing.md))
                    AsyncImage(
                        model = url,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier
                            .size(Thumbnail)
                            .clip(MaterialTheme.shapes.small)
                            .background(colors.surfaceContainerHigh)
                            .border(Sizes.hairline, colors.outline, MaterialTheme.shapes.small),
                    )
                }
            }
        }
        // The pip: on the card's left edge, the sidebar's unread tick at
        // card scale. Novo already says it in words.
        if (bold && !isNew) {
            Box(
                Modifier
                    .align(Alignment.TopStart)
                    .offset(x = (-2).dp, y = 14.dp)
                    .width(4.dp)
                    .height(18.dp)
                    .clip(RoundedCornerShape(topEnd = 3.dp, bottomEnd = 3.dp))
                    .background(colors.onSurface)
                    .testTag("forum.card.pip"),
            )
        }
    }
}

@Composable
private fun CardFooter(
    post: ForumPostSummary,
    tagsById: Map<String, ForumTag>,
    newReplies: Int,
    time: String,
) {
    val colors = MaterialTheme.colorScheme
    val numbers = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = TabularFigures)
    Row(verticalAlignment = Alignment.CenterVertically) {
        val tags = post.tagIds.mapNotNull(tagsById::get)
        Row(
            modifier = Modifier.weight(1f),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Two chips fit beside the numbers on a 360dp phone; the rest is "+N".
            tags.take(MAX_CARD_TAGS).forEach { ForumTagChip(it) }
            if (tags.size > MAX_CARD_TAGS) {
                Text(
                    text = "+${tags.size - MAX_CARD_TAGS}",
                    style = numbers,
                    color = colors.onSurfaceVariant,
                )
            }
        }
        Spacer(Modifier.width(Spacing.sm))
        post.topReaction?.let { top ->
            Text(text = "${top.emoji} ${top.count}", style = numbers, color = colors.onSurfaceVariant)
            Spacer(Modifier.width(Spacing.md))
        }
        if (post.replyCount > 0) {
            Icon(
                imageVector = PqpIcons.Replies,
                contentDescription = null,
                tint = colors.onSurfaceVariant,
                modifier = Modifier.size(14.dp),
            )
            Spacer(Modifier.width(4.dp))
            Text(text = post.replyCount.toString(), style = numbers, color = colors.onSurfaceVariant)
            if (newReplies > 0) {
                Spacer(Modifier.width(4.dp))
                Text(
                    text = pluralStringResource(R.plurals.forum_new_replies, newReplies, newReplies),
                    style = numbers,
                    color = ForumColors.onAccentSoft(),
                    modifier = Modifier.testTag("forum.card.newReplies"),
                )
            }
        } else {
            Text(text = stringResource(R.string.forum_replies_zero), style = numbers, color = colors.onSurfaceVariant)
        }
        Spacer(Modifier.width(Spacing.md))
        Text(text = time, style = numbers, color = colors.onSurfaceVariant)
    }
}

private const val MAX_CARD_TAGS = 2

@Composable
fun repliesText(count: Int): String =
    if (count == 0) {
        stringResource(R.string.forum_replies_zero)
    } else {
        pluralStringResource(R.plurals.forum_replies, count, count)
    }

/**
 * A pinned post on page 1, compact: one line with the pin, the way the mock
 * draws "Leia antes de postar". Pins are guidelines and announcements, and
 * three full cards of them would push the list off the first screen.
 */
@Composable
fun ForumPinnedRow(post: ForumPostSummary, bold: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        shape = CardShape,
        color = colors.surfaceContainer,
        border = androidx.compose.foundation.BorderStroke(Sizes.hairline, colors.outline),
        modifier = modifier
            .fillMaxWidth()
            .testTag("forum.pinned.${post.id}"),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(22.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(ForumColors.accentSoft()),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = PqpIcons.Pin,
                    contentDescription = stringResource(R.string.forum_badge_pinned),
                    tint = ForumColors.onAccentSoft(),
                    modifier = Modifier.size(13.dp),
                )
            }
            Spacer(Modifier.width(Spacing.md))
            Text(
                text = post.title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal,
                color = colors.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (post.locked) {
                Spacer(Modifier.width(Spacing.sm))
                Icon(PqpIcons.Lock, contentDescription = null, tint = colors.onSurfaceVariant, modifier = Modifier.size(14.dp))
            }
        }
    }
}

/** Three cards of the real card's shape while page 1 loads (UX §3.2). */
@Composable
fun ForumCardSkeleton(modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    val bar = colors.surfaceContainerHigh
    Surface(
        shape = CardShape,
        color = colors.surfaceContainer,
        border = androidx.compose.foundation.BorderStroke(Sizes.hairline, colors.outline),
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp)) {
            Box(Modifier.fillMaxWidth(0.8f).height(14.dp).clip(RoundedCornerShape(4.dp)).background(bar))
            Spacer(Modifier.height(10.dp))
            Box(Modifier.fillMaxWidth(0.95f).height(10.dp).clip(RoundedCornerShape(4.dp)).background(bar))
            Spacer(Modifier.height(6.dp))
            Box(Modifier.fillMaxWidth(0.6f).height(10.dp).clip(RoundedCornerShape(4.dp)).background(bar))
            Spacer(Modifier.height(12.dp))
            Row {
                Box(Modifier.width(64.dp).height(18.dp).clip(RoundedCornerShape(9.dp)).background(bar))
                Spacer(Modifier.weight(1f))
                Box(Modifier.width(48.dp).height(12.dp).clip(RoundedCornerShape(4.dp)).background(bar))
            }
        }
    }
}
