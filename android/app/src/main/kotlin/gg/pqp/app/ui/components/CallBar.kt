package gg.pqp.app.ui.components

import android.content.Context
import android.media.projection.MediaProjectionManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.automirrored.filled.StopScreenShare
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.PhoneInTalk
import androidx.compose.material.icons.filled.SpeakerPhone
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
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
            Column {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            // A moderator move gives us the room's id and not
                            // its name, so there is a case with nothing to
                            // print. "In voice" beats the previous room's name.
                            text = state.channelName
                                ?: stringResource(R.string.voice_notification_title),
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
                                if (state.deafened) {
                                    R.string.voice_undeafen
                                } else {
                                    R.string.voice_deafen
                                },
                            ),
                        )
                    }
                    IconButton(onClick = controller::toggleSpeakerphone) {
                        Icon(
                            imageVector = if (state.speakerphone) {
                                Icons.Filled.SpeakerPhone
                            } else {
                                Icons.Filled.PhoneInTalk
                            },
                            contentDescription = stringResource(
                                if (state.speakerphone) {
                                    R.string.voice_speaker_on
                                } else {
                                    R.string.voice_speaker_off
                                },
                            ),
                        )
                    }
                    ShareScreenButton(state, controller)
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

                WatchScreenRow(state, controller)
            }
        }
    }
}

/**
 * The button that raises Android's screen-capture consent dialog.
 *
 * The dialog is the system's and can only be raised by a user gesture, which is
 * why the launcher lives on the control rather than anywhere more central. The
 * grant it returns is single use: from Android 15 a fresh one is required for
 * every capture session, so nothing here caches it.
 */
@Composable
private fun ShareScreenButton(state: VoiceState, controller: VoiceController) {
    val context = LocalContext.current
    val consent = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val data = result.data
        if (result.resultCode == android.app.Activity.RESULT_OK && data != null) {
            controller.startScreenShare(data)
        }
        // A refusal is not an error worth a message. The person was asked and
        // said no, and the button they pressed is still there.
    }

    IconButton(
        onClick = {
            if (state.sharingScreen) {
                controller.stopScreenShare()
            } else {
                val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE)
                    as MediaProjectionManager
                consent.launch(manager.createScreenCaptureIntent())
            }
        },
    ) {
        Icon(
            imageVector = if (state.sharingScreen) {
                Icons.AutoMirrored.Filled.StopScreenShare
            } else {
                Icons.AutoMirrored.Filled.ScreenShare
            },
            contentDescription = stringResource(
                if (state.sharingScreen) {
                    R.string.voice_stop_sharing
                } else {
                    R.string.voice_share_screen
                },
            ),
            tint = if (state.sharingScreen) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
    }
}

/**
 * "Somebody is sharing a screen", with a way to look at it.
 *
 * Two conditions, not one: the roster has to say somebody is presenting *and* a
 * video track has to have arrived. The roster is the faster of the two and can
 * be true for a second before any frames exist, so offering to open a viewer on
 * the roster alone puts a black rectangle in front of people.
 */
@Composable
private fun WatchScreenRow(state: VoiceState, controller: VoiceController) {
    val remoteScreen by controller.remoteScreen.collectAsStateWithLifecycle()
    val eglContext = controller.eglContext
    val presenter = state.presenter
    var watching by remember { mutableStateOf(false) }

    AnimatedVisibility(
        visible = presenter != null && remoteScreen != null && eglContext != null,
        enter = expandVertically(),
        exit = shrinkVertically(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, end = 8.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = stringResource(
                    R.string.voice_watch_screen,
                    presenter?.displayName.orEmpty(),
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            TextButton(onClick = { watching = true }) {
                Text(stringResource(R.string.voice_watch))
            }
        }
    }

    val track = remoteScreen

    // The presenter stopped while the viewer was open. Closed from an effect
    // rather than from composition, because writing state while composing is
    // how a recomposition loop starts.
    LaunchedEffect(track, eglContext) {
        if (track == null || eglContext == null) watching = false
    }

    if (watching && track != null && eglContext != null) {
        ScreenShareDialog(
            track = track,
            eglContext = eglContext,
            presenter = presenter?.displayName.orEmpty(),
            onClose = { watching = false },
        )
    }
}
