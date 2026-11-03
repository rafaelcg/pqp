package gg.pqp.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.core.VoiceParticipant
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.voice.PEER_VOLUME_MAX
import gg.pqp.app.voice.PEER_VOLUME_STEP
import gg.pqp.app.voice.VoiceController
import gg.pqp.app.voice.VoiceState
import gg.pqp.app.voice.otherParticipants
import kotlin.math.roundToInt

/**
 * "Volume de cada um", a labelled row on the call bar that opens [PeerVolumeSheet].
 *
 * A row with words and not a gesture on a face: the web's version sat behind a
 * hover for months and a moderator running a big community never found it, and
 * a long press is the same mistake on a phone. This client has no tile per
 * person to hang a control on (the bar carries a head count), so the control is
 * the one thing that says what it does. Absent when nobody else is here, since
 * there is nobody to turn up or down.
 */
@Composable
fun PeerVolumeEntry(state: VoiceState, controller: VoiceController) {
    var open by remember { mutableStateOf(false) }
    val others = state.otherParticipants()
    if (others.isEmpty()) {
        // Closed with the last other person, so the sheet cannot outlive its list.
        if (open) open = false
        return
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = Spacing.sm, end = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(
            onClick = { open = true },
            modifier = Modifier.testTag("call.peerVolume"),
        ) {
            Icon(
                imageVector = PqpIcons.Speakerphone,
                contentDescription = null,
                modifier = Modifier.size(Sizes.iconInline),
            )
            Spacer(Modifier.width(Spacing.sm))
            Text(
                text = stringResource(R.string.voice_peer_volume_open),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
    if (open) {
        PeerVolumeSheet(state = state, controller = controller, onDismiss = { open = false })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PeerVolumeSheet(
    state: VoiceState,
    controller: VoiceController,
    onDismiss: () -> Unit,
) {
    val levels by controller.peerVolumeLevels.collectAsStateWithLifecycle()
    val others = state.otherParticipants()
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(Modifier.padding(horizontal = Spacing.gutter).padding(bottom = Spacing.xl)) {
            Text(
                text = stringResource(R.string.voice_peer_volume_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = stringResource(R.string.voice_peer_volume_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = Spacing.xs, bottom = Spacing.md),
            )
            LazyColumn(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                items(others, key = { it.userId }) { person ->
                    PeerVolumeRow(
                        person = person,
                        volume = levels[person.userId] ?: 1.0,
                        onVolume = { controller.setPeerVolume(person.userId, it) },
                        onToggleMute = { controller.togglePeerMute(person.userId) },
                    )
                }
            }
        }
    }
}

/**
 * One person: face, name, the percentage, a mute button, and the slider under
 * them at the full width of the sheet, so a 320dp phone still gets a long
 * enough track to land on 100% with a thumb.
 *
 * The slider runs 0 to [PEER_VOLUME_MAX] and is snapped to the web's 5% steps
 * in code rather than with `steps`, which would draw forty tick marks.
 */
@Composable
private fun PeerVolumeRow(
    person: VoiceParticipant,
    volume: Double,
    onVolume: (Double) -> Unit,
    onToggleMute: () -> Unit,
) {
    val percent = (volume * 100).roundToInt()
    val silenced = volume == 0.0
    val sliderName = stringResource(R.string.voice_peer_volume_for, person.displayName)
    val percentText = stringResource(R.string.voice_peer_volume_percent, percent)
    Column(Modifier.fillMaxWidth().testTag("call.peerVolume.row")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Avatar(
                name = person.displayName,
                url = person.avatarUrl,
                size = Sizes.avatarSmall,
                seed = person.userId,
            )
            Spacer(Modifier.width(Spacing.md))
            Text(
                text = person.displayName,
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = percentText,
                style = MaterialTheme.typography.labelLarge,
                color = if (silenced) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
                modifier = Modifier.padding(horizontal = Spacing.xs).testTag("call.peerVolume.percent"),
            )
            IconButton(onClick = onToggleMute, modifier = Modifier.testTag("call.peerVolume.mute")) {
                Icon(
                    imageVector = if (silenced) PqpIcons.ServerMuted else PqpIcons.Speakerphone,
                    contentDescription = stringResource(
                        if (silenced) R.string.voice_peer_volume_unmute else R.string.voice_peer_volume_mute,
                        person.displayName,
                    ),
                    tint = if (silenced) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    modifier = Modifier.size(Sizes.iconAction),
                )
            }
        }
        Slider(
            value = volume.toFloat(),
            onValueChange = { raw ->
                val snapped = (raw / PEER_VOLUME_STEP).roundToInt() * PEER_VOLUME_STEP
                onVolume(snapped.coerceIn(0.0, PEER_VOLUME_MAX))
            },
            valueRange = 0f..PEER_VOLUME_MAX.toFloat(),
            modifier = Modifier
                .fillMaxWidth()
                .testTag("call.peerVolume.slider")
                .semantics {
                    contentDescription = sliderName
                    stateDescription = percentText
                },
        )
    }
}
