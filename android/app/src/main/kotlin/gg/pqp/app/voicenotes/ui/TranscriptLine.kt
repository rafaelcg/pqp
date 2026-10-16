package gg.pqp.app.voicenotes.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.PqpApplication
import gg.pqp.app.R
import gg.pqp.app.core.NoteTranscript
import gg.pqp.app.onboarding.ui.rememberReduceMotion
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.voicenotes.NoteTranscripts
import gg.pqp.app.voicenotes.TranscriptRequest
import gg.pqp.app.voicenotes.VoiceTranscriptionPreference
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/**
 * What goes under a voice note's card (`voice-note-transcript.tsx` on the web): the transcript, a
 * quiet "Transcrevendo" line while one is on its way, or a small "Transcrever" button on a note that
 * has none yet.
 *
 * Nothing at all unless the message was read WITH a transcript block (the server leaves it off when
 * transcripts do not exist where the note lives) and the reader has transcripts on. The button is
 * explicit rather than automatic because a transcript in a server channel is paid for by the first
 * person who asks; a conversation's notes are transcribed at send, so there the button only appears
 * when that did not happen. Your own notes never offer it.
 */
@Composable
fun TranscriptLine(
    attachmentId: String,
    base: NoteTranscript?,
    isMine: Boolean,
    modifier: Modifier = Modifier,
) {
    val app = LocalContext.current.applicationContext as? PqpApplication ?: return
    val transcripts = app.transcripts
    val phase by app.session.phase.collectAsStateWithLifecycle()
    val show = VoiceTranscriptionPreference.read(phase).showOn

    // Each card reads one note's entry, so a frame for another note redraws nothing here.
    val fromStore by remember(transcripts, attachmentId) {
        transcripts.stored.map { it[attachmentId] }.distinctUntilChanged()
    }.collectAsStateWithLifecycle(null)
    val request by remember(transcripts, attachmentId) {
        transcripts.requests.map { it[attachmentId] ?: TranscriptRequest.Idle }.distinctUntilChanged()
    }.collectAsStateWithLifecycle(TranscriptRequest.Idle)

    // A block on the read is the server saying transcription is on where this note lives, which is
    // what settings needs to know to draw its switches.
    val exists = base != null
    LaunchedEffect(exists) { if (exists) transcripts.markAvailable() }

    val transcript = NoteTranscripts.resolve(base, fromStore)
    if (!show || transcript == null) return

    when (transcript.status) {
        "done" -> transcript.text?.takeIf { it.isNotBlank() }?.let {
            TranscriptText(it, modifier)
        }

        "pending" -> Pending(modifier)

        "no_speech" -> Quiet(stringResource(R.string.voice_note_transcript_no_speech), "voice-note-transcript-no-speech", modifier)

        "failed" -> Quiet(stringResource(R.string.voice_note_transcript_failed), "voice-note-transcript-failed", modifier)

        // No provider, or the day's budget is spent: nothing to say and nothing to press.
        "unavailable" -> Unit

        // `none` is the only state with something to offer. `Refused` means the server already said
        // no for this note: no button to press in vain.
        "none" -> if (!isMine && request != TranscriptRequest.Refused) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = modifier.padding(top = Spacing.xs).testTag("voice-note-transcript-none"),
            ) {
                val label = stringResource(R.string.voice_note_transcript_request)
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .heightIn(min = 32.dp)
                        .semantics { role = Role.Button }
                        .clickable { transcripts.request(attachmentId) }
                        .padding(vertical = 6.dp, horizontal = 2.dp)
                        .testTag("voice-note-transcribe"),
                )
                val note = when (request) {
                    TranscriptRequest.Slow -> R.string.voice_note_transcript_slow
                    TranscriptRequest.Failed -> R.string.voice_note_transcript_request_failed
                    else -> null
                }
                if (note != null) {
                    Text(
                        text = stringResource(note),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = Spacing.sm),
                    )
                }
            }
        }
    }
}

@Composable
private fun Quiet(text: String, tag: String, modifier: Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.padding(top = Spacing.xs).testTag(tag),
    )
}

/** "Transcrevendo": a gentle pulse, or a still line with animations off. */
@Composable
private fun Pending(modifier: Modifier) {
    val reduce = rememberReduceMotion()
    val alpha = if (reduce) {
        1f
    } else {
        val pulse = rememberInfiniteTransition(label = "transcribing")
        pulse.animateFloat(
            initialValue = 0.45f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
            label = "transcribingAlpha",
        ).value
    }
    Text(
        text = stringResource(R.string.voice_note_transcript_pending),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.padding(top = Spacing.xs).alpha(alpha).testTag("voice-note-transcript-pending"),
    )
}

/** The text, two lines of it, and "ver mais" when there is more than that. */
@Composable
private fun TranscriptText(text: String, modifier: Modifier) {
    var expanded by remember(text) { mutableStateOf(false) }
    var overflows by remember(text) { mutableStateOf(false) }
    Column(modifier = modifier.padding(top = Spacing.xs).widthIn(max = 360.dp).fillMaxWidth().testTag("voice-note-transcript")) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = if (expanded) Int.MAX_VALUE else COLLAPSED_LINES,
            overflow = TextOverflow.Ellipsis,
            onTextLayout = { if (!expanded) overflows = it.hasVisualOverflow },
        )
        if (overflows || expanded) {
            Text(
                text = stringResource(if (expanded) R.string.voice_note_transcript_less else R.string.voice_note_transcript_more),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .heightIn(min = 32.dp)
                    .semantics { role = Role.Button }
                    .clickable { expanded = !expanded }
                    .padding(vertical = 6.dp)
                    .testTag("voice-note-transcript-toggle"),
            )
        }
    }
}

private const val COLLAPSED_LINES = 2
