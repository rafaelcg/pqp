package gg.pqp.app.ui.screens.channels

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.core.Channel
import gg.pqp.app.social.ui.CountBadge
import gg.pqp.app.ui.theme.Motion
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing

/** A row of the live list. 40dp, no card: the web sidebar's row on a phone. */
val ChannelRowHeight = 40.dp

/** Where a row's name starts, so the people under a voice room line up with it. */
val ChannelNameInset = Spacing.railInset + Spacing.md + Sizes.iconInline + Spacing.sm + 2.dp

/**
 * One channel.
 *
 * Quiet rows are the muted ink; something unread lifts the name to full ink
 * in semibold and puts a short tick on the screen's left edge (the web
 * sidebar's pill, without a number). A mention adds the lime "@N", the same
 * lime the iOS badge uses for a mention. A channel this person silenced is
 * drawn at 40% with a crossed bell and is never bold and never ticked,
 * whatever arrives in it.
 *
 * The call this device is in is the one lime row: soft lime fill, lime name.
 */
@Composable
fun ChannelRow(
    channel: Channel,
    badge: RowBadge,
    inCall: Boolean,
    live: Boolean,
    /** People in a voice room; 0 for text and for an empty room. */
    occupants: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val interactions = remember { MutableInteractionSource() }
    val pressed by interactions.collectIsPressedAsState()
    val colors = MaterialTheme.colorScheme

    // Selected and pressed share a fill on purpose: pressing a row previews
    // where the finger is about to land.
    val fill by animateColorAsState(
        targetValue = when {
            pressed -> colors.surfaceContainerHigh
            inCall -> colors.primary.copy(alpha = 0.14f)
            else -> Color.Transparent
        },
        animationSpec = if (pressed) snap() else tween(Motion.QUICK_MILLIS),
        label = "channel-row-fill",
    )

    val muted = badge.emphasis == RowEmphasis.Muted
    val unread = badge.emphasis == RowEmphasis.Unread
    // An empty voice room steps back a little: there is nobody to go and see.
    val emptyRoom = channel.isVoice && occupants == 0 && !inCall && !live
    val content = when {
        inCall -> colors.primary
        unread -> colors.onSurface
        else -> colors.onSurfaceVariant
    }
    val rowAlpha by animateFloatAsState(
        targetValue = when {
            muted -> 0.4f
            emptyRoom -> 0.72f
            else -> 1f
        },
        animationSpec = spring(stiffness = 600f),
        label = "channel-row-alpha",
    )

    val unreadLabel = stringResource(R.string.channels_unread)
    val mutedLabel = stringResource(R.string.channels_muted)
    val mentionsLabel = if (badge.mentions > 0) {
        pluralStringResource(R.plurals.channels_mentions, badge.mentions, badge.mentions)
    } else {
        null
    }
    val state = listOfNotNull(
        unreadLabel.takeIf { unread },
        mentionsLabel,
        mutedLabel.takeIf { muted },
    ).joinToString(", ")

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(ChannelRowHeight)
            .semantics { if (state.isNotEmpty()) stateDescription = state },
    ) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = Spacing.railInset)
                .clip(MaterialTheme.shapes.small)
                .background(fill)
                .clickable(interactionSource = interactions, indication = null, onClick = onClick)
                .padding(horizontal = Spacing.md)
                .alpha(rowAlpha)
                .testTag("channels.row.${channel.id}"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ChannelGlyph(channel = channel, tint = if (inCall) colors.primary else colors.onSurfaceVariant)
            Spacer(Modifier.width(Spacing.sm + 2.dp))
            Text(
                text = channel.name,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (unread || inCall) FontWeight.SemiBold else FontWeight.Normal,
                color = content,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (live) {
                Spacer(Modifier.width(Spacing.sm))
                LiveChip()
            }
            AnimatedVisibility(
                visible = badge.mentions > 0,
                enter = scaleIn(spring(dampingRatio = 0.55f, stiffness = 700f)) + fadeIn(),
                exit = scaleOut() + fadeOut(),
            ) {
                CountBadge(
                    count = badge.mentions,
                    loud = true,
                    label = "@" + if (badge.mentions > 99) "99+" else badge.mentions.toString(),
                    modifier = Modifier.padding(start = Spacing.sm).testTag("channels.mentions"),
                )
            }
            if (muted) {
                Spacer(Modifier.width(Spacing.sm))
                Icon(
                    imageVector = PqpIcons.ChannelMuted,
                    contentDescription = null,
                    tint = colors.onSurfaceVariant,
                    modifier = Modifier.size(16.dp).testTag("channels.muted"),
                )
            } else if (channel.isVoice && occupants > 0 && !inCall) {
                Spacer(Modifier.width(Spacing.sm))
                Text(
                    text = occupants.toString(),
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.onSurfaceVariant,
                )
            } else if (inCall) {
                Spacer(Modifier.width(Spacing.sm))
                Icon(
                    imageVector = PqpIcons.Listening,
                    contentDescription = null,
                    tint = colors.primary,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
        // The tick: on the screen's edge, outside the inset, where the web
        // sidebar puts its pill. Pops in on a spring when something arrives.
        AnimatedVisibility(
            visible = unread,
            enter = scaleIn(spring(dampingRatio = 0.5f, stiffness = 800f)) + fadeIn(),
            exit = scaleOut() + fadeOut(),
            modifier = Modifier.align(Alignment.CenterStart),
        ) {
            Box(
                Modifier
                    .offset(x = (-2).dp)
                    .width(5.dp)
                    .height(8.dp)
                    .clip(RoundedCornerShape(topEnd = 4.dp, bottomEnd = 4.dp))
                    .background(colors.onSurface)
                    .testTag("channels.unread"),
            )
        }
    }
}

/**
 * The channel's glyph in a fixed box, so names start at one x whatever the
 * glyph's width. A private channel keeps its own glyph and gets a small lock
 * in the corner, instead of a padlock replacing the hash.
 */
@Composable
internal fun ChannelGlyph(channel: Channel, tint: Color) {
    Box(Modifier.size(Sizes.iconInline)) {
        Icon(
            imageVector = when {
                channel.isVoice -> PqpIcons.VoiceChannel
                channel.isForum -> PqpIcons.ForumChannel
                else -> PqpIcons.TextChannel
            },
            contentDescription = null,
            tint = tint,
            modifier = Modifier.size(Sizes.iconInline),
        )
        if (channel.isPrivate) {
            Box(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .offset(x = 3.dp, y = 3.dp)
                    .size(11.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.background)
                    .testTag("channels.private"),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = PqpIcons.PrivateChannel,
                    contentDescription = null,
                    tint = tint,
                    modifier = Modifier.size(9.dp),
                )
            }
        }
    }
}

/** Red because that is what a live badge is everywhere; it never competes with the lime. */
@Composable
private fun LiveChip() {
    Text(
        text = stringResource(R.string.watch_live),
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.onError,
        modifier = Modifier
            .clip(MaterialTheme.shapes.extraSmall)
            .background(MaterialTheme.colorScheme.error)
            .padding(horizontal = Spacing.xs, vertical = 1.dp)
            .testTag("channels.live"),
    )
}

/**
 * A category's heading, which folds it.
 *
 * Folded, it says how many channels are inside and shows a dot when one of
 * them has something unread, so folding never hides that there is news. The
 * chevron turns on a spring; the rows themselves leave and return through the
 * list's own item animation.
 */
@Composable
fun CategoryHeader(
    title: String,
    folded: Boolean,
    summary: FoldedSummary,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
    /** The category's menu (Organizar canais), for whoever may manage channels. */
    onLongClick: (() -> Unit)? = null,
    onLongClickLabel: String? = null,
    /** The "+" that creates a channel in this category, managers only. */
    trailing: (@Composable () -> Unit)? = null,
) {
    val colors = MaterialTheme.colorScheme
    val turn by animateFloatAsState(
        targetValue = if (folded) -90f else 0f,
        animationSpec = spring(dampingRatio = 0.75f, stiffness = 500f),
        label = "category-chevron",
    )
    val action = stringResource(
        if (folded) R.string.channels_category_unfold else R.string.channels_category_fold,
        title,
    )
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = Spacing.md)
            .height(32.dp)
            .combinedClickable(onClick = onToggle, onLongClick = onLongClick, onLongClickLabel = onLongClickLabel)
            .semantics { contentDescription = action }
            .padding(start = Spacing.gutter, end = if (trailing != null) Spacing.xs else Spacing.railInset + Spacing.md)
            .testTag("channels.category"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = PqpIcons.Expand,
            contentDescription = null,
            tint = colors.onSurfaceVariant,
            modifier = Modifier.size(12.dp).rotate(turn),
        )
        Spacer(Modifier.width(Spacing.xs + 2.dp))
        Text(
            text = title.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            color = colors.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        AnimatedVisibility(visible = folded, enter = fadeIn(), exit = fadeOut()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = pluralStringResource(
                        R.plurals.channels_folded_count,
                        summary.channelCount,
                        summary.channelCount,
                    ),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.onSurfaceVariant,
                )
                AnimatedVisibility(
                    visible = summary.hasUnread,
                    enter = scaleIn(spring(dampingRatio = 0.5f, stiffness = 800f)),
                    exit = scaleOut(),
                ) {
                    Box(
                        Modifier
                            .padding(start = Spacing.sm)
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(colors.onSurface)
                            .testTag("channels.category.unread"),
                    )
                }
            }
        }
        trailing?.invoke()
    }
}

/** The gap a heading-less group (the top-level channels) keeps instead of a heading. */
@Composable
fun SectionGap() {
    Spacer(Modifier.height(Spacing.sm))
}

