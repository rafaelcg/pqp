package gg.pqp.app.forum.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.forum.Ago
import gg.pqp.app.forum.ForumTag
import gg.pqp.app.forum.ForumTime
import gg.pqp.app.ui.components.ChromeDivider
import gg.pqp.app.ui.theme.LocalIsDark
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing

/*
 * The small pieces every forum surface shares: the status badges, the tag
 * chip, the filter chip, the section rule and the short "2 h". Built on the
 * app's own roles (`MaterialTheme.colorScheme`, `Spacing`, `Sizes`), with the
 * two soft pairs the forum mocks add (success soft, accent soft) derived here
 * rather than written as literals at each call site.
 */

/** The soft fills and their ink, per theme. */
object ForumColors {
    @Composable
    fun success(): Color = if (LocalIsDark.current) Palette.Success else Color(0xFF2E8A3C)

    @Composable
    fun successSoft(): Color = success().copy(alpha = if (LocalIsDark.current) 0.16f else 0.12f)

    @Composable
    fun accentSoft(): Color = MaterialTheme.colorScheme.primary.copy(alpha = if (LocalIsDark.current) 0.16f else 0.14f)

    @Composable
    fun onAccentSoft(): Color = if (LocalIsDark.current) MaterialTheme.colorScheme.primary else Palette.LightSignalDim

    @Composable
    fun warning(): Color = if (LocalIsDark.current) Palette.Warning else Color(0xFF9A6A00)
}

enum class BadgeKind { New, Resolved, Locked, Pinned, Feed }

/** 18dp, uppercase, never truncated: status comes before the title and never collapses into "+N". */
@Composable
fun ForumBadge(kind: BadgeKind, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    val (fill, ink, label) = when (kind) {
        BadgeKind.New -> Triple(colors.primary, colors.onPrimary, R.string.forum_badge_new)
        BadgeKind.Resolved -> Triple(ForumColors.successSoft(), ForumColors.success(), R.string.forum_badge_resolved)
        BadgeKind.Locked -> Triple(colors.surfaceContainerHigh, colors.onSurfaceVariant, R.string.forum_badge_locked)
        BadgeKind.Pinned -> Triple(ForumColors.accentSoft(), ForumColors.onAccentSoft(), R.string.forum_badge_pinned)
        BadgeKind.Feed -> Triple(ForumColors.accentSoft(), ForumColors.onAccentSoft(), R.string.forum_badge_feed)
    }
    Box(
        modifier = modifier
            .heightIn(min = 18.dp)
            .clip(RoundedCornerShape(4.dp))
            .background(fill)
            .padding(horizontal = 6.dp, vertical = 2.dp)
            .testTag("forum.badge.${kind.name.lowercase()}"),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = stringResource(label).uppercase(),
            style = MaterialTheme.typography.labelSmall.copy(letterSpacing = MaterialTheme.typography.labelSmall.letterSpacing * 0.6f),
            color = ink,
            maxLines = 1,
        )
    }
}

/**
 * A post's tag: icon and name, 20dp, fully round. A staff-only tag gets the
 * inset ring so it reads as official on every card.
 */
@Composable
fun ForumTagChip(tag: ForumTag, modifier: Modifier = Modifier, raised: Boolean = false) {
    val colors = MaterialTheme.colorScheme
    Row(
        modifier = modifier
            .heightIn(min = 20.dp)
            .clip(CircleShape)
            .background(if (raised) colors.surfaceContainerHighest else colors.surfaceContainerHigh)
            .then(
                if (tag.moderated) {
                    Modifier.border(Sizes.hairline, colors.outline, CircleShape)
                } else {
                    Modifier
                },
            )
            .padding(horizontal = 8.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (tag.hasGlyph()) {
            ForumTagGlyph(tag, size = 12.dp)
            Spacer(Modifier.width(4.dp))
        }
        Text(
            text = tag.displayName(),
            style = MaterialTheme.typography.labelMedium.copy(letterSpacing = MaterialTheme.typography.bodySmall.letterSpacing),
            color = colors.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * A filter or a tag toggle: 44dp of touch, a 32dp pill drawn inside it. On,
 * it is the accent soft fill (and, for a filter, an X that says how to take it
 * off); off, a hairline.
 */
@Composable
fun ForumFilterChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    leading: (@Composable () -> Unit)? = null,
    trailingIcon: ImageVector? = null,
    showClose: Boolean = selected,
    testTag: String? = null,
) {
    val colors = MaterialTheme.colorScheme
    val fill = if (selected) ForumColors.accentSoft() else Color.Transparent
    val ink = if (selected) ForumColors.onAccentSoft() else colors.onSurface
    Surface(
        onClick = onClick,
        shape = CircleShape,
        color = fill,
        contentColor = ink,
        border = if (selected) {
            androidx.compose.foundation.BorderStroke(Sizes.hairline, ForumColors.onAccentSoft().copy(alpha = 0.45f))
        } else {
            androidx.compose.foundation.BorderStroke(Sizes.hairline, colors.outline)
        },
        modifier = modifier
            .padding(vertical = 6.dp)
            .heightIn(min = 32.dp)
            .semantics {
                role = Role.Checkbox
                this.selected = selected
            }
            .then(if (testTag != null) Modifier.testTag(testTag) else Modifier),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            leading?.invoke()
            Text(
                text = label,
                style = MaterialTheme.typography.labelLarge,
                maxLines = 1,
            )
            when {
                showClose -> Icon(
                    imageVector = gg.pqp.app.ui.theme.PqpIcons.Close,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                )
                trailingIcon != null -> Icon(
                    imageVector = trailingIcon,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                )
            }
        }
    }
}

/** The uppercase rule ("FIXADOS", "23 RESPOSTAS"), with a hairline to the edge. */
@Composable
fun ForumSectionRule(text: String, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        icon?.let {
            Icon(
                imageVector = it,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(12.dp),
            )
            Spacer(Modifier.width(6.dp))
        }
        Text(
            text = text.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.width(Spacing.sm))
        ChromeDivider(Modifier.weight(1f))
    }
}

/** "agora", "4 min", "2 h", "3 d", "12 set". */
@Composable
fun agoText(iso: String): String {
    val ago = remember(iso) { ForumTime.ago(iso) } ?: return ""
    return when (ago) {
        Ago.Now -> stringResource(R.string.forum_ago_now)
        is Ago.Minutes -> stringResource(R.string.forum_ago_minutes, ago.n.toInt())
        is Ago.Hours -> stringResource(R.string.forum_ago_hours, ago.n.toInt())
        is Ago.Days -> stringResource(R.string.forum_ago_days, ago.n.toInt())
        is Ago.Date -> ago.text
    }
}

/**
 * A post's preview as plain words. The server already flattens it to one
 * line; the emphasis marks it keeps (`**`, `__`, `~~`, `||`, backticks) would
 * read as noise on a card.
 */
fun previewText(preview: String): String =
    preview.replace(MARKS, "").replace(Regex("\\s+"), " ").trim()

private val MARKS = Regex("\\*\\*|__|~~|\\|\\||`")

/** A thin spacer used between the card's lines. */
@Composable
fun LineGap() = Spacer(Modifier.height(Spacing.xs))
