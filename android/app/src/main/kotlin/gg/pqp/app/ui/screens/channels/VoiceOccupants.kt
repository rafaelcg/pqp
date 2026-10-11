package gg.pqp.app.ui.screens.channels

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.core.VoiceParticipant
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing

private val OccupantHeight = 30.dp
private val OccupantAvatar = 22.dp

/**
 * One person sitting in a voice room, under the room's row.
 *
 * The speaking ring is passed in, and the caller only ever passes true for
 * the room this device is in: nobody else's talking reaches this phone.
 * Status marks on the right come straight from the roster: a crossed mic
 * (self or moderator mute), crossed headphones, a screen being shared.
 */
@Composable
fun VoiceOccupantRow(
    participant: VoiceParticipant,
    isSelf: Boolean,
    speaking: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(OccupantHeight)
            .clickable(onClick = onClick)
            .padding(start = ChannelNameInset - Spacing.xs, end = Spacing.railInset + Spacing.md)
            .testTag("channels.occupant"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(
            name = participant.displayName,
            url = participant.avatarUrl,
            size = OccupantAvatar,
            seed = participant.userId,
            speaking = speaking,
        )
        Spacer(Modifier.width(Spacing.sm))
        Text(
            text = if (isSelf) {
                stringResource(R.string.voice_occupant_you, participant.displayName)
            } else {
                participant.displayName
            },
            style = MaterialTheme.typography.bodyMedium,
            color = colors.onSurface.copy(alpha = 0.86f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (participant.sharingScreen) {
            StatusMark(PqpIcons.ShareScreen, stringResource(R.string.voice_occupant_sharing))
        }
        if (participant.muted || participant.serverMuted) {
            StatusMark(PqpIcons.MicMuted, stringResource(R.string.voice_occupant_muted), danger = true)
        }
        if (participant.deafened) {
            StatusMark(PqpIcons.Deafened, stringResource(R.string.voice_occupant_deafened), danger = true)
        }
    }
}

@Composable
private fun StatusMark(icon: ImageVector, description: String, danger: Boolean = false) {
    Spacer(Modifier.width(Spacing.xs + 2.dp))
    Icon(
        imageVector = icon,
        contentDescription = description,
        tint = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.size(14.dp),
    )
}

/** "+N pessoas", with the first faces of the people folded into it. */
@Composable
fun VoiceOverflowRow(
    people: List<VoiceParticipant>,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val faces = people.take(3)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(OccupantHeight)
            .clickable(onClick = onClick)
            .padding(start = ChannelNameInset - Spacing.xs, end = Spacing.railInset + Spacing.md)
            .testTag("channels.occupants.more"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Overlapping, each one ringed in the page colour so the stack reads
        // as separate faces rather than one blob.
        Box(Modifier.width(OccupantAvatar + 12.dp * (faces.size - 1).coerceAtLeast(0))) {
            faces.forEachIndexed { index, person ->
                Box(
                    Modifier
                        .offset(x = 12.dp * index)
                        .size(OccupantAvatar)
                        .border(1.5.dp, colors.background, CircleShape)
                        .background(colors.background, CircleShape),
                ) {
                    Avatar(
                        name = person.displayName,
                        url = person.avatarUrl,
                        size = OccupantAvatar,
                        seed = person.userId,
                    )
                }
            }
        }
        Spacer(Modifier.width(Spacing.sm))
        Text(
            text = pluralStringResource(R.plurals.voice_occupants_more, people.size, people.size),
            style = MaterialTheme.typography.bodyMedium,
            color = colors.onSurfaceVariant,
            maxLines = 1,
        )
    }
}
