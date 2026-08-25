package gg.pqp.app.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.voice.VoiceController
import gg.pqp.app.voice.VoiceStage
import gg.pqp.app.voice.VoiceState

/**
 * The persistent "you are in a call" strip.
 *
 * It sits above the content on every screen while a call is up, which is what
 * makes leaving a channel to read another one safe: the call does not belong to
 * the screen that started it.
 */
@Composable
fun CallBar(state: VoiceState, controller: VoiceController, modifier: Modifier = Modifier) {
    AnimatedVisibility(
        visible = state.isActive,
        enter = expandVertically(),
        exit = shrinkVertically(),
        modifier = modifier,
    ) {
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            tonalElevation = 3.dp,
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        text = state.channelName.orEmpty(),
                        style = MaterialTheme.typography.titleSmall,
                    )
                    // A call that reports "2 in this call" while nobody can
                    // hear anybody is worse than one that admits it, so an
                    // unreachable peer takes the line over the head count.
                    val unreachable = state.unreachablePeers > 0 &&
                        state.stage != VoiceStage.Joining
                    Text(
                        text = when {
                            state.stage == VoiceStage.Joining ->
                                stringResource(R.string.voice_connecting)

                            unreachable -> stringResource(R.string.voice_peer_unreachable)

                            else -> stringResource(
                                R.string.voice_participants,
                                state.participants.size,
                            )
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = if (unreachable) {
                            MaterialTheme.colorScheme.error
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                }

                IconButton(onClick = controller::toggleMute) {
                    Icon(
                        imageVector = if (state.muted) Icons.Filled.MicOff else Icons.Filled.Mic,
                        contentDescription = stringResource(
                            if (state.muted) R.string.voice_unmute else R.string.voice_mute,
                        ),
                    )
                }
                IconButton(onClick = controller::toggleDeafen) {
                    Icon(
                        imageVector = if (state.deafened) {
                            Icons.AutoMirrored.Filled.VolumeOff
                        } else {
                            Icons.AutoMirrored.Filled.VolumeUp
                        },
                        contentDescription = stringResource(
                            if (state.deafened) R.string.voice_undeafen else R.string.voice_deafen,
                        ),
                    )
                }
                FilledIconButton(
                    onClick = controller::leave,
                    colors = IconButtonDefaults.filledIconButtonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                        contentColor = MaterialTheme.colorScheme.onError,
                    ),
                ) {
                    Icon(
                        Icons.Filled.CallEnd,
                        contentDescription = stringResource(R.string.voice_leave),
                    )
                }
            }
        }
    }
}
