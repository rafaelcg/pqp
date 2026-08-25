package gg.pqp.app.social.ui

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Badge
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.social.DmSummary
import gg.pqp.app.social.PublicUser
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.theme.Palette
import java.time.Instant

/**
 * The four states anybody else is ever told about.
 *
 * `invisible` is deliberately absent: the server resolves it to `offline`
 * before it reaches a client, so there is nothing here to draw and nothing a
 * client could accidentally leak. Anything unrecognised is offline for the same
 * reason: a state we cannot name must not be shown as presence.
 */
@Composable
fun StatusDot(status: String, modifier: Modifier = Modifier, size: Dp = 12.dp) {
    val (color, label) = when (status) {
        "online" -> Palette.Success to R.string.status_online
        "idle" -> Palette.Warning to R.string.status_idle
        "dnd" -> Palette.Danger to R.string.status_dnd
        else -> Palette.PaperMuted to R.string.status_offline
    }
    val description = stringResource(label)

    Box(
        modifier = modifier
            .size(size)
            .clip(CircleShape)
            .background(color)
            .border(2.dp, MaterialTheme.colorScheme.background, CircleShape)
            .semantics { contentDescription = description },
    )
}

/** A person, with their status painted into the corner of their picture. */
@Composable
fun PersonAvatar(
    name: String,
    avatarUrl: String?,
    status: String?,
    modifier: Modifier = Modifier,
    size: Dp = 44.dp,
) {
    Box(modifier = modifier.size(size)) {
        Avatar(name = name, url = avatarUrl, size = size)
        if (status != null) {
            StatusDot(
                status = status,
                size = size / 3.4f,
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .offset(x = 2.dp, y = 2.dp),
            )
        }
    }
}

/**
 * A conversation's picture: one face for a 1:1, two overlapping for a group.
 *
 * Two rather than all of them because the row is one line tall and a stack of
 * nine circles is a smear. The count is in the subtitle, where it can be read.
 */
@Composable
fun ConversationAvatar(
    participants: List<PublicUser>,
    modifier: Modifier = Modifier,
    size: Dp = 44.dp,
) {
    when (participants.size) {
        0 -> Avatar(name = "?", url = null, size = size, modifier = modifier)
        1 -> Avatar(
            name = participants[0].displayName,
            url = participants[0].avatarUrl,
            size = size,
            modifier = modifier,
        )
        else -> Box(modifier = modifier.size(size)) {
            Avatar(
                name = participants[1].displayName,
                url = participants[1].avatarUrl,
                size = size * 0.72f,
                modifier = Modifier.align(Alignment.TopEnd),
            )
            Avatar(
                name = participants[0].displayName,
                url = participants[0].avatarUrl,
                size = size * 0.72f,
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .border(2.dp, MaterialTheme.colorScheme.background, CircleShape)
                    .padding(1.dp),
            )
        }
    }
}

@Composable
fun UnreadBadge(unread: Int, mentions: Int, modifier: Modifier = Modifier) {
    if (unread <= 0) return
    Badge(
        modifier = modifier,
        // A mention is the one thing worth the loud colour. Everything else is
        // "there is something here", which the badge already says by existing.
        containerColor = if (mentions > 0) {
            MaterialTheme.colorScheme.primary
        } else {
            MaterialTheme.colorScheme.surfaceContainerHighest
        },
        contentColor = if (mentions > 0) {
            MaterialTheme.colorScheme.onPrimary
        } else {
            MaterialTheme.colorScheme.onSurface
        },
    ) {
        Text(if (unread > 99) "99+" else unread.toString())
    }
}

/**
 * What a conversation is called.
 *
 * A conversation has no name of its own, and `channels.name` is stored empty,
 * because any string invented server-side would be wrong the moment somebody
 * renamed themselves. The participants are the title, and the viewer is already
 * excluded from that list by the server.
 */
@Composable
fun conversationTitle(conversation: DmSummary): String =
    conversation.titleOr(stringResource(R.string.dms_empty_conversation))

/**
 * The same rule, without a composable context, for the places that have to name
 * a conversation while building a navigation route rather than while drawing.
 */
fun DmSummary.titleOr(fallback: String): String =
    if (participants.isEmpty()) fallback else participants.joinToString(", ") { it.displayName }

/**
 * "3 min ago", in the reader's language, from the system.
 *
 * Null for a conversation nobody has spoken in yet, which is a real state: a DM
 * exists from the moment it is opened, before anything is said in it.
 */
fun relativeTime(iso: String?): CharSequence? {
    val instant = runCatching { Instant.parse(iso ?: return null) }.getOrNull() ?: return null
    return DateUtils.getRelativeTimeSpanString(
        instant.toEpochMilli(),
        System.currentTimeMillis(),
        DateUtils.MINUTE_IN_MILLIS,
        DateUtils.FORMAT_ABBREV_RELATIVE,
    )
}

/** The colour a row's text takes once it has something unread in it. */
@Composable
fun unreadTint(unread: Int): Color =
    if (unread > 0) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant
