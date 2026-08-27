package gg.pqp.app.social.ui

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.CornerSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
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
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.TabularFigures
import java.time.Instant

/**
 * The four states anybody else is ever told about.
 *
 * `invisible` is deliberately absent: the server resolves it to `offline`
 * before it reaches a client, so there is nothing here to draw and nothing a
 * client could accidentally leak. Anything unrecognised is offline for the same
 * reason: a state we cannot name must not be shown as presence.
 *
 * `ringColor` is the surface the dot is being drawn **on**, not a decoration.
 * The dot is meant to read as cut out of the picture rather than stuck on top
 * of it, and that illusion only holds while the ring is the same colour as the
 * ground behind the avatar. It used to be hard-wired to `background`, which is
 * right on a page and wrong on a sheet or on a chrome-coloured row: there it
 * drew a halo of the page's colour in the middle of something else. The default
 * keeps every existing call site drawing exactly what it drew before.
 */
@Composable
fun StatusDot(
    status: String,
    modifier: Modifier = Modifier,
    size: Dp = 12.dp,
    ringColor: Color = MaterialTheme.colorScheme.background,
) {
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
            .border(2.dp, ringColor, CircleShape)
            .semantics { contentDescription = description },
    )
}

/**
 * A person, with their status painted into the corner of their picture.
 *
 * `seed` exists because a monogram's colour is derived from it and a display
 * name is not unique: two people called "Ana" would otherwise be the same
 * colour, and one person renaming themselves would change colour. Anything
 * holding an id passes it.
 */
@Composable
fun PersonAvatar(
    name: String,
    avatarUrl: String?,
    status: String?,
    modifier: Modifier = Modifier,
    size: Dp = Sizes.avatarPerson,
    seed: String = name,
    ringColor: Color = MaterialTheme.colorScheme.background,
) {
    Box(modifier = modifier.size(size)) {
        Avatar(name = name, url = avatarUrl, size = size, seed = seed)
        if (status != null) {
            StatusDot(
                status = status,
                size = size / 3.4f,
                ringColor = ringColor,
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
    size: Dp = Sizes.avatarConversation,
    ringColor: Color = MaterialTheme.colorScheme.background,
) {
    when (participants.size) {
        0 -> Avatar(name = "?", url = null, size = size, modifier = modifier)
        1 -> Avatar(
            name = participants[0].displayName,
            url = participants[0].avatarUrl,
            size = size,
            seed = participants[0].id,
            modifier = modifier,
        )
        else -> Box(modifier = modifier.size(size)) {
            Avatar(
                name = participants[1].displayName,
                url = participants[1].avatarUrl,
                size = size * 0.72f,
                seed = participants[1].id,
                modifier = Modifier.align(Alignment.TopEnd),
            )
            Avatar(
                name = participants[0].displayName,
                url = participants[0].avatarUrl,
                size = size * 0.72f,
                seed = participants[0].id,
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    // Same argument as the presence dot: the front face is cut
                    // out of the one behind it, so the ring has to be the
                    // ground the row is drawn on.
                    .border(2.dp, ringColor, CircleShape)
                    .padding(1.dp),
            )
        }
    }
}

/**
 * A number in the corner of something.
 *
 * Drawn rather than taken from Material's `Badge` because a badge here is a
 * small rounded rectangle on the app's own shape scale, and `Badge` is a
 * capsule at a fixed radius that no theme can reach. Tabular figures for the
 * usual reason: this is a count that ticks while somebody is looking at it.
 *
 * `loud` is never decided here. The caller decides, because what deserves the
 * signal colour is a product question and it is a different answer per surface.
 *
 * The quiet one carries a hairline and the loud one does not, and that is not
 * symmetry for its own sake. A badge is small and it lands on whichever surface
 * the thing it is counting happens to sit on, including chrome; in the light
 * scheme the chrome and the reacting surface are deliberately the same value,
 * so a quiet badge with no edge is a number floating in mid air. The lime one
 * needs no help telling itself apart from anything.
 */
@Composable
fun CountBadge(count: Int, loud: Boolean, modifier: Modifier = Modifier) {
    if (count <= 0) return
    Box(
        modifier = modifier
            .defaultMinSize(minWidth = 18.dp, minHeight = 18.dp)
            .clip(MaterialTheme.shapes.extraSmall)
            .background(
                if (loud) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.surfaceContainerHighest
                },
            )
            .then(
                if (loud) {
                    Modifier
                } else {
                    Modifier.border(
                        Sizes.hairline,
                        MaterialTheme.colorScheme.outline,
                        MaterialTheme.shapes.extraSmall,
                    )
                },
            )
            .padding(horizontal = 5.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = if (count > 99) "99+" else count.toString(),
            style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = TabularFigures),
            color = if (loud) {
                MaterialTheme.colorScheme.onPrimary
            } else {
                MaterialTheme.colorScheme.onSurface
            },
        )
    }
}

@Composable
fun UnreadBadge(unread: Int, mentions: Int, modifier: Modifier = Modifier) {
    // A mention is the one thing worth the loud colour. Everything else is
    // "there is something here", which the badge already says by existing.
    CountBadge(count = unread, loud = mentions > 0, modifier = modifier)
}

/**
 * The corners a bottom sheet in this app is cut with.
 *
 * `extraLarge` on the two corners that are actually visible and square on the
 * two that sit off the bottom of the screen. Written here rather than at each
 * sheet because two sheets rounded to two different radii is the kind of thing
 * nobody notices individually and everybody feels collectively.
 */
@Composable
fun pqpSheetShape(): Shape = MaterialTheme.shapes.extraLarge.copy(
    bottomStart = CornerSize(0.dp),
    bottomEnd = CornerSize(0.dp),
)

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
