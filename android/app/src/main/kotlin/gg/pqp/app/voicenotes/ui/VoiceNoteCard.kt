package gg.pqp.app.voicenotes.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.PqpApplication
import gg.pqp.app.R
import gg.pqp.app.core.Attachment
import gg.pqp.app.core.NoteListener
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.ui.theme.TabularFigures
import gg.pqp.app.voicenotes.NotePlayback
import gg.pqp.app.voicenotes.PlaybackSpeeds
import gg.pqp.app.voicenotes.QueueEntry
import gg.pqp.app.voicenotes.VoiceNotes
import gg.pqp.app.voicenotes.decodeWaveform
import gg.pqp.app.voicenotes.formatNoteDuration
import gg.pqp.app.voicenotes.formatPlaybackClock
import gg.pqp.app.voicenotes.resamplePeaks
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/**
 * The message a voice note rode in on. The card needs it to build a queue
 * entry, to know whose note it is (your own never shows a dot and never counts
 * as a listen), and to name the sender to a screen reader.
 */
data class VoiceNoteContext(
    val messageId: String,
    val channelId: String,
    val authorId: String,
    val authorName: String,
    val isMine: Boolean,
)

/** The app-wide player, or null where there is no application (previews). */
@Composable
fun rememberVoiceNotes(): VoiceNotes? {
    val context = LocalContext.current
    return remember(context) { (context.applicationContext as? PqpApplication)?.voiceNotes }
}

/**
 * A voice note in the message row.
 *
 * Round play button, the waveform with its played portion filled, the clock,
 * a dot while it is unheard, and the speed pill. Under a note of yours, in a
 * conversation, a line says who heard it.
 *
 * ## What recomposes
 *
 * The player publishes its position ten times a second. Every card collecting
 * that would redraw the whole visible transcript ten times a second, so each
 * card collects a projection that is **identical for every note but the one
 * playing**: a flow that maps to the full state for its own note and to a
 * constant for any other, de-duplicated. Only the card that owns the player
 * ever sees the position change.
 */
@Composable
fun VoiceNoteCard(
    attachment: Attachment,
    note: VoiceNoteContext,
    modifier: Modifier = Modifier,
) {
    val voice = attachment.voice ?: return
    val notes = rememberVoiceNotes() ?: return
    val id = attachment.id

    val playback by remember(notes, id) {
        notes.playback
            .map { if (it.attachmentId == id) it else NotePlayback(speed = it.speed) }
            .distinctUntilChanged()
    }.collectAsStateWithLifecycle(NotePlayback())
    val heardLocally by notes.heard.collectAsStateWithLifecycle()
    val receipts by notes.receipts.collectAsStateWithLifecycle()

    val entry = remember(attachment, note) {
        QueueEntry(
            attachmentId = id,
            messageId = note.messageId,
            channelId = note.channelId,
            authorId = note.authorId,
            url = attachment.url,
            durationMs = voice.durationMs,
            listenedByMe = voice.listenedByMe,
        )
    }
    val playing = playback.attachmentId == id && playback.playing
    val current = playback.attachmentId == id
    val unheard = !note.isMine && !voice.listenedByMe && id !in heardLocally

    val peaks = remember(voice.waveform) { decodeWaveform(voice.waveform) }
    val total = formatNoteDuration(voice.durationMs)
    val clock = if (current) formatPlaybackClock(playback.positionMs) else total
    val speedLabel = PlaybackSpeeds.label(playback.speed)

    val describe = stringResource(R.string.voice_note_card, note.authorName, total)
    val playLabel = stringResource(
        if (playing) R.string.voice_note_pause_playback else R.string.voice_note_play,
    )
    val speedDescription = stringResource(R.string.voice_note_speed, speedLabel)
    val unheardLabel = stringResource(R.string.voice_note_unheard)

    Column(modifier = modifier.testTag("voice-note")) {
        Row(
            modifier = Modifier
                .widthIn(max = CARD_MAX_WIDTH)
                .fillMaxWidth()
                .clip(MaterialTheme.shapes.medium)
                .background(MaterialTheme.colorScheme.surfaceContainer)
                .border(
                    width = Sizes.hairline,
                    color = MaterialTheme.colorScheme.outline,
                    shape = MaterialTheme.shapes.medium,
                )
                .semantics(mergeDescendants = false) { contentDescription = describe }
                .padding(start = Spacing.sm, end = Spacing.md, top = Spacing.sm, bottom = Spacing.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            Box(
                modifier = Modifier
                    .size(PLAY_SIZE)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary)
                    .clickable(onClickLabel = playLabel) { notes.toggle(entry) }
                    .testTag("voice-note-play"),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = if (playing) PqpIcons.Pause else PqpIcons.Play,
                    contentDescription = playLabel,
                    tint = MaterialTheme.colorScheme.onPrimary,
                    modifier = Modifier
                        .size(Sizes.iconInline)
                        // Optical centring, as on the video card: a play
                        // triangle's weight sits behind its box.
                        .padding(start = if (playing) 0.dp else 2.dp),
                )
            }

            Waveform(
                peaks = peaks,
                fraction = if (current) playback.fraction else 0f,
                onSeek = { fraction ->
                    if (current) notes.seekTo(id, fraction) else notes.toggle(entry)
                },
                modifier = Modifier.weight(1f).height(WAVE_HEIGHT),
            )

            Text(
                text = clock,
                style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = TabularFigures),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.clearAndSetSemantics {},
            )

            if (unheard) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primary)
                        .semantics { contentDescription = unheardLabel }
                        .testTag("voice-note-unheard"),
                )
            }

            Box(
                modifier = Modifier
                    .heightIn(min = SPEED_HEIGHT)
                    .clip(CircleShape)
                    .border(Sizes.hairline, MaterialTheme.colorScheme.outline, CircleShape)
                    .clickable(onClickLabel = speedDescription) { notes.cycleSpeed() }
                    .padding(horizontal = Spacing.sm)
                    .testTag("voice-note-speed"),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = speedLabel,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }

        if (note.isMine) {
            val listeners = remember(voice, receipts[id]) {
                (voice.listeners + receipts[id].orEmpty()).distinctBy { it.userId }
            }
            HeardLine(listeners)
        }
    }
}

/**
 * "Ouviu às 21:06", under a note of yours, once somebody has played it.
 *
 * The server only ever puts listeners on the author's copy of a note in a
 * conversation of ten people or fewer, so this needs no rule about which
 * channels get one: where the list is empty, nothing is drawn.
 */
@Composable
private fun HeardLine(listeners: List<NoteListener>) {
    val first = listeners.firstOrNull() ?: return
    val at = first.listenedAt?.let(::formatHeardTime)
    Row(
        modifier = Modifier.padding(top = 4.dp).testTag("voice-note-heard"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(
            imageVector = PqpIcons.Listening,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(14.dp),
        )
        Text(
            text = if (at != null) {
                stringResource(R.string.voice_note_heard_at, at)
            } else {
                stringResource(R.string.voice_note_heard)
            },
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

private val HEARD_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

private fun formatHeardTime(iso: String): String? = runCatching {
    Instant.parse(iso).atZone(ZoneId.systemDefault()).format(HEARD_FORMAT)
}.getOrNull()

/**
 * The bars, with the played part filled.
 *
 * Bars are 3dp with a 2dp gap and the count follows the width, so the same 64
 * peaks fill a small phone and a tablet. A tap seeks (or starts the note), and
 * a horizontal drag scrubs. The touch is on the bars themselves, because a
 * scrubber nobody can find is not one.
 */
@Composable
private fun Waveform(
    peaks: FloatArray,
    fraction: Float,
    onSeek: (Float) -> Unit,
    modifier: Modifier = Modifier,
) {
    val played = MaterialTheme.colorScheme.primary
    val rest = MaterialTheme.colorScheme.outline
    Canvas(
        modifier = modifier
            .pointerInput(Unit) {
                detectTapGestures { offset -> onSeek((offset.x / size.width).coerceIn(0f, 1f)) }
            }
            .pointerInput(Unit) {
                detectHorizontalDragGestures { change, _ ->
                    onSeek((change.position.x / size.width).coerceIn(0f, 1f))
                }
            },
    ) {
        val barWidth = BAR_WIDTH.toPx()
        val gap = BAR_GAP.toPx()
        val count = ((size.width + gap) / (barWidth + gap)).toInt().coerceAtLeast(1)
        val bars = resamplePeaks(peaks, count)
        val minHeight = MIN_BAR.toPx()
        val radius = CornerRadius(barWidth / 2f)
        val playedBars = (fraction * count)

        bars.forEachIndexed { index, peak ->
            val barHeight = (peak * size.height).coerceAtLeast(minHeight)
            drawRoundRect(
                color = if (index < playedBars) played else rest,
                topLeft = Offset(index * (barWidth + gap), (size.height - barHeight) / 2f),
                size = Size(barWidth, barHeight),
                cornerRadius = radius,
            )
        }
    }
}

private val CARD_MAX_WIDTH = 360.dp
private val PLAY_SIZE = 40.dp
private val WAVE_HEIGHT = 32.dp
private val SPEED_HEIGHT = 24.dp
private val BAR_WIDTH = 3.dp
private val BAR_GAP = 2.dp
private val MIN_BAR = 3.dp
