package gg.pqp.app.ui.components

import android.content.Context
import android.media.projection.MediaProjectionManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.ui.theme.Motion
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.voice.VoiceController
import gg.pqp.app.voice.VoiceStage
import gg.pqp.app.voice.VoiceState

/**
 * The persistent "you are in a call" strip.
 *
 * It sits above the content on every screen while a call is up, which is what
 * makes leaving a channel to read another one safe: the call does not belong to
 * the screen that started it. That also makes it the one piece of chrome
 * somebody stares at continuously, so it is treated as chrome and not as a
 * banner: `surfaceContainerLowest` with a hairline under it, so the screen
 * below reads as a sheet laid on a rail rather than as content pushed down by a
 * card. `tonalElevation` is gone rather than left at 3dp because
 * `LocalTonalElevationEnabled` is off theme-wide and the argument no longer
 * paints anything.
 */
@Composable
fun CallBar(state: VoiceState, controller: VoiceController, modifier: Modifier = Modifier) {
    AnimatedVisibility(
        visible = state.isActive,
        enter = expandVertically(),
        exit = shrinkVertically(),
        modifier = modifier,
    ) {
        Surface(color = MaterialTheme.colorScheme.surfaceContainerLowest) {
            Column {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(
                            start = Spacing.gutter,
                            end = Spacing.sm,
                            top = Spacing.sm,
                            bottom = Spacing.sm,
                        ),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    LiveDot(connected = state.stage != VoiceStage.Joining)
                    Spacer(Modifier.width(Spacing.md))

                    Column(Modifier.weight(1f)) {
                        Text(
                            // A moderator move gives us the room's id and not
                            // its name, so there is a case with nothing to
                            // print. "In voice" beats the previous room's name.
                            text = state.channelName
                                ?: stringResource(R.string.voice_notification_title),
                            style = MaterialTheme.typography.titleSmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
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
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }

                    CallControl(
                        onClick = controller::toggleMute,
                        icon = if (state.muted) PqpIcons.MicMuted else PqpIcons.Mic,
                        contentDescription = stringResource(
                            if (state.muted) R.string.voice_unmute else R.string.voice_mute,
                        ),
                        on = state.muted,
                    )
                    CallControl(
                        onClick = controller::toggleDeafen,
                        // Headphones, not a crossed-out speaker. The old
                        // `VolumeOff` was mute's metaphor one button along, so
                        // the two loudest controls in a call were a crossed
                        // microphone and a crossed speaker. Ears and mouth are
                        // different organs.
                        icon = if (state.deafened) PqpIcons.Deafened else PqpIcons.Listening,
                        contentDescription = stringResource(
                            if (state.deafened) {
                                R.string.voice_undeafen
                            } else {
                                R.string.voice_deafen
                            },
                        ),
                        on = state.deafened,
                    )
                    CallControl(
                        onClick = controller::toggleSpeakerphone,
                        icon = if (state.speakerphone) {
                            PqpIcons.Speakerphone
                        } else {
                            PqpIcons.Earpiece
                        },
                        contentDescription = stringResource(
                            if (state.speakerphone) {
                                R.string.voice_speaker_on
                            } else {
                                R.string.voice_speaker_off
                            },
                        ),
                        // Not a toggled-on container: the speaker is a routing
                        // choice with no "wrong" side, and lighting it up would
                        // put a third raised control next to the two that
                        // genuinely mean something is switched off.
                        on = false,
                    )
                    ShareScreenButton(state, controller)
                    FilledIconButton(
                        onClick = controller::leave,
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                            contentColor = MaterialTheme.colorScheme.onError,
                        ),
                    ) {
                        Icon(
                            imageVector = PqpIcons.HangUp,
                            contentDescription = stringResource(R.string.voice_leave),
                            modifier = Modifier.size(Sizes.iconAction),
                        )
                    }
                }

                WatchScreenRow(state, controller)

                // The rail's edge. Chrome is deeper than the page, and this is
                // the line that says where one stops and the other starts.
                ChromeDivider()
            }
        }
    }
}

/**
 * The one thing on this strip that says "right now" rather than "recently".
 *
 * A pulse rather than a static dot because the strip is otherwise completely
 * still, and a still strip is indistinguishable from a stale one: somebody
 * glancing down needs to know the call is up without reading the head count.
 * Slow, and only down to 0.45f, because this thing is on screen for an hour at
 * a time and anything faster or harder becomes something to look away from.
 *
 * While the call is still connecting there is nothing live to announce, so the
 * dot goes muted and still and the status line does the talking.
 */
@Composable
private fun LiveDot(connected: Boolean) {
    val transition = rememberInfiniteTransition(label = "call-live")
    val pulse by transition.animateFloat(
        initialValue = 0.45f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = PULSE_HALF_MILLIS, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "call-live-alpha",
    )

    Box(
        modifier = Modifier
            .size(8.dp)
            .alpha(if (connected) pulse else 1f)
            .background(
                color = if (connected) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
                shape = CircleShape,
            ),
    )
}

/** Half a cycle, so the dot breathes once every 1.4 seconds. */
private const val PULSE_HALF_MILLIS = 700

/**
 * One control on the strip.
 *
 * A control that is **on** (muted, deafened, sharing) carries a
 * `surfaceContainerHigh` container, so its state is legible without colour and
 * without a second crossed-out glyph doing the work alone. `error` is spent on
 * the one destructive control, hang up, and lime is spent on the live dot;
 * neither is available to a toggle. The container crossfades on
 * `QUICK_MILLIS`, because a spring on a colour overshoots visibly.
 */
@Composable
private fun CallControl(
    onClick: () -> Unit,
    icon: ImageVector,
    contentDescription: String,
    on: Boolean,
) {
    val container by animateColorAsState(
        targetValue = if (on) {
            MaterialTheme.colorScheme.surfaceContainerHigh
        } else {
            Color.Transparent
        },
        animationSpec = tween(durationMillis = Motion.QUICK_MILLIS),
        label = "call-control-container",
    )

    FilledIconButton(
        onClick = onClick,
        colors = IconButtonDefaults.filledIconButtonColors(
            containerColor = container,
            contentColor = if (on) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        ),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = contentDescription,
            modifier = Modifier.size(Sizes.iconAction),
        )
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

    CallControl(
        onClick = {
            if (state.sharingScreen) {
                controller.stopScreenShare()
            } else {
                val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE)
                    as MediaProjectionManager
                consent.launch(manager.createScreenCaptureIntent())
            }
        },
        icon = if (state.sharingScreen) PqpIcons.StopSharing else PqpIcons.ShareScreen,
        contentDescription = stringResource(
            if (state.sharingScreen) {
                R.string.voice_stop_sharing
            } else {
                R.string.voice_share_screen
            },
        ),
        on = state.sharingScreen,
    )
}

/**
 * "Somebody is sharing a screen", with a way to look at each one.
 *
 * Two conditions per presenter, not one: the roster has to say they are
 * presenting *and* a video track has to have arrived from them. The roster is
 * the faster of the two and can be true for a second before any frames exist,
 * so offering to open a viewer on the roster alone puts a black rectangle in
 * front of people.
 *
 * A row per presenter, because two people can share at once. Naming whoever is
 * being watched is what makes that usable: with one line reading "watch" and
 * two shares behind it, opening the viewer is a coin toss.
 */
@Composable
private fun WatchScreenRow(state: VoiceState, controller: VoiceController) {
    val remoteScreens by controller.remoteScreens.collectAsStateWithLifecycle()
    val eglContext = controller.eglContext
    var watchingPeerId by remember { mutableStateOf<String?>(null) }

    // Somebody the roster calls a presenter *and* whose picture has arrived.
    // Our own capture is on the roster too and never sends itself a track, so
    // it drops out here without needing a special case.
    val watchable = state.presenters.mapNotNull { participant ->
        remoteScreens[participant.peerId]?.let { participant to it }
    }

    AnimatedVisibility(
        visible = watchable.isNotEmpty() && eglContext != null,
        enter = expandVertically(),
        exit = shrinkVertically(),
    ) {
        Column {
            watchable.forEach { (participant, _) ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = Spacing.gutter, end = Spacing.sm, bottom = Spacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = stringResource(
                            R.string.voice_watch_screen,
                            participant.displayName,
                        ),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    TextButton(onClick = { watchingPeerId = participant.peerId }) {
                        Text(stringResource(R.string.voice_watch))
                    }
                }
            }
        }
    }

    val watched = watchable.firstOrNull { it.first.peerId == watchingPeerId }

    // The presenter stopped while the viewer was open. Closed from an effect
    // rather than from composition, because writing state while composing is
    // how a recomposition loop starts.
    LaunchedEffect(watched, eglContext) {
        if (watched == null || eglContext == null) watchingPeerId = null
    }

    if (watched != null && eglContext != null) {
        ScreenShareDialog(
            track = watched.second,
            eglContext = eglContext,
            presenter = watched.first.displayName,
            onClose = { watchingPeerId = null },
        )
    }
}
