package gg.pqp.app.voicenotes.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.PqpApplication
import gg.pqp.app.R
import gg.pqp.app.attachments.AttachmentApi
import gg.pqp.app.core.SessionStore
import gg.pqp.app.ui.components.SectionLabel
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.voicenotes.VoiceTranscriptionPreference

/**
 * "Mensagens de voz": the two halves of transcription (`voice-notes-group.tsx` on the web). Drawn only
 * where it exists: the flag is on for conversations, or something in this session has shown it is on
 * for a server (a note arrived with a transcript block), so a deployment without it has no switches
 * for a thing that does not happen.
 *
 * Each switch applies the moment it is pressed. Turning off "my notes" does not reach back into notes
 * already sent: the server copied the choice onto each note when it was recorded, and the copy says so.
 */
@Composable
fun VoiceNotesSettings(session: SessionStore, modifier: Modifier = Modifier) {
    val app = LocalContext.current.applicationContext as? PqpApplication
    val seen by (app?.transcripts?.seen ?: remember { kotlinx.coroutines.flow.MutableStateFlow(false) }).collectAsStateWithLifecycle()
    var globalOn by remember { mutableStateOf(false) }
    LaunchedEffect(session) {
        globalOn = runCatching { AttachmentApi(session.api).config(null).transcriptionOn }.getOrDefault(false)
    }
    if (!globalOn && !seen) return

    val phase by session.phase.collectAsStateWithLifecycle()
    val prefs = VoiceTranscriptionPreference.read(phase)
    val failed by VoiceTranscriptionPreference.failed.collectAsStateWithLifecycle()

    Column(modifier) {
        SectionLabel(stringResource(R.string.voice_notes_settings_title))
        Text(
            text = stringResource(R.string.voice_notes_settings_description),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = Spacing.gutter),
        )
        SwitchRow(
            title = stringResource(R.string.voice_notes_transcribe_mine),
            hint = stringResource(R.string.voice_notes_transcribe_mine_hint),
            checked = prefs.mineOn,
            tag = "you.voiceNotes.mine",
            onChange = { VoiceTranscriptionPreference.change(session, mine = it) },
        )
        SwitchRow(
            title = stringResource(R.string.voice_notes_show_transcripts),
            hint = stringResource(R.string.voice_notes_show_transcripts_hint),
            checked = prefs.showOn,
            tag = "you.voiceNotes.show",
            onChange = { VoiceTranscriptionPreference.change(session, show = it) },
        )
        if (failed) {
            Text(
                text = stringResource(R.string.voice_notes_settings_failed),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = Spacing.gutter).testTag("you.voiceNotes.failed"),
            )
        }
    }
}

@Composable
private fun SwitchRow(title: String, hint: String, checked: Boolean, tag: String, onChange: (Boolean) -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.gutter, vertical = Spacing.md)
            .testTag(tag),
    ) {
        Column(Modifier.weight(1f)) {
            Text(text = title, style = MaterialTheme.typography.titleMedium)
            Text(
                text = hint,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.size(12.dp))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}
