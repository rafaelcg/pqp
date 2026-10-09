package gg.pqp.app.voicenotes.ui

import android.Manifest
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import androidx.core.content.ContextCompat
import gg.pqp.app.R
import gg.pqp.app.attachments.PendingAttachment
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.ui.theme.TabularFigures
import gg.pqp.app.voicenotes.DiscardedNote
import gg.pqp.app.voicenotes.GestureEffect
import gg.pqp.app.voicenotes.GestureState
import gg.pqp.app.voicenotes.GestureThresholds
import gg.pqp.app.voicenotes.RecordGestureMachine
import gg.pqp.app.voicenotes.RecordingUi
import gg.pqp.app.voicenotes.VoiceNotice
import gg.pqp.app.voicenotes.formatNoteDuration
import gg.pqp.app.voicenotes.formatPlaybackClock

/**
 * The composer's half of voice notes: the microphone that replaces send, the
 * bar that replaces the text box while recording, the locked panel, the chip
 * for a note on its way, and the undo strip. The rules (what may record, when)
 * live in `ChatViewModel`; everything here only draws state and turns touches
 * into calls.
 */

/** How far the finger travels to cancel. WhatsApp's is about this. */
private val CANCEL_DISTANCE = 96.dp

/** How far it travels up to lock. */
private val LOCK_DISTANCE = 72.dp

private val MIC_SIZE = 48.dp

/**
 * Asks for the microphone with an explanation first, once.
 *
 * Returns a function the composer calls on press. It answers `true` when the
 * permission is already held (the press may start recording) and `false`
 * after opening the explanation, which is the press that is spent on asking.
 * The explanation is ours and says what the microphone is for; the system
 * dialog that follows says only that it is wanted.
 */
@Composable
fun rememberMicrophoneAsk(): () -> Boolean {
    val context = LocalContext.current
    var explaining by remember { mutableStateOf(false) }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        Toast.makeText(
            context,
            context.getString(if (granted) R.string.voice_note_hint else R.string.voice_note_permission_denied),
            Toast.LENGTH_LONG,
        ).show()
    }

    if (explaining) {
        AlertDialog(
            onDismissRequest = { explaining = false },
            title = { Text(stringResource(R.string.voice_note_permission_title)) },
            text = { Text(stringResource(R.string.voice_note_permission_body)) },
            confirmButton = {
                TextButton(onClick = {
                    explaining = false
                    launcher.launch(Manifest.permission.RECORD_AUDIO)
                }) { Text(stringResource(R.string.voice_note_permission_allow)) }
            },
            dismissButton = {
                TextButton(onClick = { explaining = false }) {
                    Text(stringResource(R.string.voice_note_permission_cancel))
                }
            },
        )
    }

    return {
        val held = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (!held) explaining = true
        held
    }
}

/** Says what the recorder or the player wants said, once, as a toast. */
@Composable
fun VoiceNoticeToast(notice: VoiceNotice?, onShown: () -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(notice) {
        val message = when (notice) {
            VoiceNotice.CallActive -> R.string.voice_note_in_call
            VoiceNotice.MicBusy -> R.string.voice_note_mic_busy
            VoiceNotice.TooShort -> R.string.voice_note_hint
            VoiceNotice.LimitReached -> R.string.voice_note_limit
            null -> return@LaunchedEffect
        }
        Toast.makeText(context, context.getString(message), Toast.LENGTH_SHORT).show()
        onShown()
    }
}

/**
 * The microphone. Hold to record, slide left to cancel, slide up to lock.
 *
 * The touch is read on an outer, unscaled box and the picture grows inside it.
 * Pointer positions are relative to the node that reads them, and a node that
 * scales itself under the finger moves the origin the slide is measured from.
 *
 * Haptics: a tick when recording starts, a confirm when it locks, a reject
 * when it cancels. No sound, because the recording is about to hear the room.
 */
@Composable
fun MicHoldButton(
    holding: Boolean,
    lockProgress: Float,
    onPress: () -> Boolean,
    onLock: () -> Unit,
    onCancel: () -> Unit,
    onSend: () -> Unit,
    onProgress: (cancel: Float, lock: Float) -> Unit,
    modifier: Modifier = Modifier,
) {
    val density = androidx.compose.ui.platform.LocalDensity.current
    val haptics = LocalHapticFeedback.current
    val thresholds = remember(density) {
        with(density) { GestureThresholds(cancelPx = CANCEL_DISTANCE.toPx(), lockPx = LOCK_DISTANCE.toPx()) }
    }
    val press by rememberUpdatedState(onPress)
    val lock by rememberUpdatedState(onLock)
    val cancel by rememberUpdatedState(onCancel)
    val send by rememberUpdatedState(onSend)
    val progress by rememberUpdatedState(onProgress)
    val label = stringResource(R.string.voice_note_record)
    val grow = if (holding) 1.6f else 1f

    Box(
        modifier = modifier
            .size(MIC_SIZE)
            .semantics { contentDescription = label }
            .pointerInput(thresholds) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    down.consume()
                    if (!press()) {
                        // The press was spent on asking for permission, or the
                        // recorder refused. Swallow the rest of the touch so a
                        // slide does not become something else.
                        do {
                            val event = awaitPointerEvent()
                        } while (event.changes.any { it.pressed })
                        return@awaitEachGesture
                    }
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)

                    var state = RecordGestureMachine.down()
                    progress(0f, 0f)
                    try {
                        while (state.isHolding) {
                            val event = awaitPointerEvent()
                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                            change.consume()
                            if (!change.pressed) {
                                val (next, effect) = RecordGestureMachine.up(state)
                                state = next
                                if (effect == GestureEffect.Send) send()
                                break
                            }
                            val (next, effect) = RecordGestureMachine.move(
                                state,
                                dx = change.position.x - down.position.x,
                                dy = change.position.y - down.position.y,
                                thresholds = thresholds,
                            )
                            state = next
                            progress(state.cancelProgress(thresholds), state.lockProgress(thresholds))
                            when (effect) {
                                GestureEffect.Lock -> {
                                    haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                                    lock()
                                }

                                GestureEffect.Cancel -> {
                                    haptics.performHapticFeedback(HapticFeedbackType.Reject)
                                    cancel()
                                }

                                else -> Unit
                            }
                        }
                    } finally {
                        // The touch ended without the person deciding: the
                        // system took it, or this button left the screen
                        // mid-hold. Never a send.
                        val (_, effect) = RecordGestureMachine.interrupted(state)
                        if (effect == GestureEffect.Cancel) cancel()
                        progress(0f, 0f)
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        if (holding) {
            LockHint(lockProgress)
            // The halo that says "this is live".
            Box(
                Modifier
                    .size(MIC_SIZE)
                    .scale(grow * 1.25f)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)),
            )
        }
        Box(
            Modifier
                .size(MIC_SIZE)
                .scale(grow)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.primary)
                .testTag("composer.mic"),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                PqpIcons.Mic,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onPrimary,
                modifier = Modifier.size(Sizes.iconAction),
            )
        }
    }
}

/**
 * What stands in for the text box while the finger is down: a red dot, the
 * clock, and "slide to cancel", which fades as the slide approaches the line.
 */
@Composable
fun RecordingBar(
    active: RecordingUi.Active,
    cancelProgress: Float,
    modifier: Modifier = Modifier,
) {
    val pulse = rememberInfiniteTransition(label = "rec-dot")
    val dot by pulse.animateFloat(
        initialValue = 1f,
        targetValue = 0.3f,
        animationSpec = infiniteRepeatable(tween(700), RepeatMode.Reverse),
        label = "rec-dot-alpha",
    )
    Row(
        modifier = modifier
            .heightIn(min = 48.dp)
            .clip(MaterialTheme.shapes.extraLarge)
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .padding(horizontal = Spacing.lg)
            .testTag("composer.recording"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Box(
            Modifier
                .size(10.dp)
                .alpha(dot)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.error),
        )
        Text(
            text = formatPlaybackClock(active.elapsedMs),
            style = MaterialTheme.typography.titleSmall.copy(fontFeatureSettings = TabularFigures),
        )
        Spacer(Modifier.weight(1f))
        val left = active.secondsLeft
        if (left != null) {
            Text(
                text = stringResource(R.string.voice_note_seconds_left, left),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.error,
            )
        } else {
            Row(
                modifier = Modifier.alpha(1f - cancelProgress),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    PqpIcons.SlideLeft,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(Sizes.iconInline),
                )
                Text(
                    text = stringResource(R.string.voice_note_slide_cancel),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * The padlock that rises above the microphone while the finger is down.
 *
 * A popup anchored to the button, not a child of the composer: the composer
 * clips to its own bounds, and growing the composer to make room would move the
 * button, and with it the origin the slide is measured from.
 */
@Composable
fun LockHint(lockProgress: Float) {
    val height = with(androidx.compose.ui.platform.LocalDensity.current) { 112.dp.roundToPx() }
    Popup(
        alignment = Alignment.TopEnd,
        offset = IntOffset(0, -height),
        properties = PopupProperties(focusable = false, clippingEnabled = false),
    ) {
        Column(
            modifier = Modifier
                .width(MIC_SIZE)
                .height(96.dp)
                .clip(MaterialTheme.shapes.extraLarge)
                .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                .padding(vertical = Spacing.md)
                .alpha(0.55f + 0.45f * lockProgress),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            Icon(
                PqpIcons.PrivateChannel,
                contentDescription = stringResource(R.string.voice_note_lock_hint),
                tint = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.size(Sizes.iconInline),
            )
            Icon(
                PqpIcons.SlideUp,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(Sizes.iconInline),
            )
        }
    }
}

/** Hands-free: the clock, the live waveform, and discard, pause and send. */
@Composable
fun LockedRecordingPanel(
    active: RecordingUi.Active,
    onDiscard: () -> Unit,
    onTogglePause: () -> Unit,
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.large)
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .padding(Spacing.md)
            .testTag("composer.recording-locked"),
        verticalArrangement = Arrangement.spacedBy(Spacing.md),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            Box(
                Modifier
                    .size(10.dp)
                    .alpha(if (active.paused) 0.3f else 1f)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.error),
            )
            Text(
                text = formatPlaybackClock(active.elapsedMs),
                style = MaterialTheme.typography.titleSmall.copy(fontFeatureSettings = TabularFigures),
            )
            LiveWaveform(
                levels = active.levels,
                modifier = Modifier.weight(1f).height(28.dp),
            )
            val left = active.secondsLeft
            if (left != null) {
                Text(
                    text = stringResource(R.string.voice_note_seconds_left, left),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            IconButton(onClick = onDiscard, modifier = Modifier.testTag("composer.recording-discard")) {
                Icon(
                    PqpIcons.Delete,
                    contentDescription = stringResource(R.string.voice_note_discard),
                    tint = MaterialTheme.colorScheme.error,
                )
            }
            IconButton(onClick = onTogglePause, modifier = Modifier.testTag("composer.recording-pause")) {
                Icon(
                    if (active.paused) PqpIcons.Mic else PqpIcons.Pause,
                    contentDescription = stringResource(
                        if (active.paused) R.string.voice_note_resume else R.string.voice_note_pause,
                    ),
                )
            }
            FilledIconButton(
                onClick = onSend,
                modifier = Modifier.testTag("composer.recording-send"),
            ) {
                Icon(
                    PqpIcons.Send,
                    contentDescription = stringResource(R.string.voice_note_send),
                    modifier = Modifier.size(Sizes.iconAction),
                )
            }
        }
        Text(
            text = stringResource(if (active.paused) R.string.voice_note_paused else R.string.voice_note_locked),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )
    }
}

/** The last few seconds of input level, newest on the right. */
@Composable
private fun LiveWaveform(levels: List<Float>, modifier: Modifier = Modifier) {
    val color = MaterialTheme.colorScheme.primary
    Canvas(modifier) {
        val barWidth = 3.dp.toPx()
        val gap = 2.dp.toPx()
        val fit = ((size.width + gap) / (barWidth + gap)).toInt().coerceAtLeast(1)
        val shown = levels.takeLast(fit)
        val radius = CornerRadius(barWidth / 2f)
        val startX = size.width - shown.size * (barWidth + gap) + gap
        shown.forEachIndexed { index, level ->
            // Square root: raw input level is so peaky that linear bars are a
            // flat line with occasional spikes.
            val barHeight = (kotlin.math.sqrt(level.coerceIn(0f, 1f)) * size.height).coerceAtLeast(3.dp.toPx())
            drawRoundRect(
                color = color,
                topLeft = Offset(startX + index * (barWidth + gap), (size.height - barHeight) / 2f),
                size = Size(barWidth, barHeight),
                cornerRadius = radius,
            )
        }
    }
}

/**
 * The note on its way, standing in for the text box: uploading, failed (tap to
 * retry) or ready. Text cannot be added to a voice note, so the box is gone
 * for the few seconds it takes, which is also what keeps a stray character
 * from turning the send into a refusal.
 */
@Composable
fun VoiceDraftChip(
    attachment: PendingAttachment,
    onRetry: () -> Unit,
    onRemove: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val duration = formatNoteDuration(attachment.voice?.durationMs ?: 0L)
    val text = when {
        attachment.failed -> stringResource(R.string.voice_note_failed)
        attachment.uploading -> stringResource(R.string.voice_note_sending, duration)
        else -> stringResource(R.string.voice_note_ready, duration)
    }
    Row(
        modifier = modifier
            .heightIn(min = 48.dp)
            .clip(MaterialTheme.shapes.extraLarge)
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .clickable(enabled = attachment.failed, onClickLabel = stringResource(R.string.voice_note_retry)) {
                onRetry()
            }
            .padding(start = Spacing.lg)
            .testTag("composer.voice-draft"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = if (attachment.failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f, fill = false),
        )
        when {
            attachment.uploading -> CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            attachment.failed -> Icon(
                PqpIcons.Retry,
                contentDescription = stringResource(R.string.voice_note_retry),
                modifier = Modifier.size(Sizes.iconInline),
            )
        }
        Spacer(Modifier.weight(1f))
        IconButton(onClick = onRemove) {
            Icon(
                PqpIcons.Close,
                contentDescription = stringResource(R.string.voice_note_remove),
                modifier = Modifier.size(Sizes.iconInline),
            )
        }
    }
}

/** "Áudio descartado (0:11)  Desfazer", for five seconds. */
@Composable
fun DiscardedStrip(discarded: DiscardedNote?, onUndo: () -> Unit) {
    val note = discarded ?: return
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.md, vertical = Spacing.xs)
            .clip(MaterialTheme.shapes.small)
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(start = Spacing.md)
            .testTag("composer.discarded"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            PqpIcons.Delete,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onErrorContainer,
            modifier = Modifier.size(Sizes.iconInline),
        )
        Text(
            text = stringResource(R.string.voice_note_discarded, formatNoteDuration(note.durationMs)),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onErrorContainer,
            modifier = Modifier.weight(1f).padding(horizontal = Spacing.sm),
        )
        TextButton(onClick = onUndo) {
            Text(stringResource(R.string.voice_note_undo), color = MaterialTheme.colorScheme.onErrorContainer)
        }
    }
}
