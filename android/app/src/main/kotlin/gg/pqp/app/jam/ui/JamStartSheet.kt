package gg.pqp.app.jam.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.jam.JamInstrument
import gg.pqp.app.jam.JamJoinMode
import gg.pqp.app.jam.JamLimits
import gg.pqp.app.jam.record.NewSongDraft
import gg.pqp.app.ui.theme.Spacing
import java.util.UUID

private const val ARTIST_MAX = 100

/**
 * "Música nova": what a first take creates the song with, asked before the studio so the studio has one job. The web's
 * `jam-start-sheet`, with the same three questions: its name, who it is by, and who may add to it. Nothing is created
 * yet: the song exists on the server only when its first take is sent (and the nonce makes a retry land on one song).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JamStartSheet(onGo: (NewSongDraft) -> Unit, onDismiss: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var title by remember { mutableStateOf("") }
    var artist by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf(JamJoinMode.Open) }
    var wanted by remember { mutableStateOf(emptySet<JamInstrument>()) }
    var tried by remember { mutableStateOf(false) }
    // One per sheet, so a send retried after a lost answer lands on the same song.
    val nonce = remember { UUID.randomUUID().toString() }
    val titleOk = title.isNotBlank()
    val wantedOk = mode != JamJoinMode.Wanted || wanted.isNotEmpty()

    fun go() {
        tried = true
        if (!titleOk || !wantedOk) return
        onGo(
            NewSongDraft(
                title = title.trim(),
                artist = artist.trim().takeIf { it.isNotEmpty() },
                joinMode = mode.wire,
                wantedInstruments = if (mode == JamJoinMode.Wanted) JamInstrument.entries.filter { it in wanted }.map { it.wire } else emptyList(),
                nonce = nonce,
            ),
        )
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, modifier = Modifier.testTag("jam.start")) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
            verticalArrangement = Arrangement.spacedBy(Spacing.md),
        ) {
            Text(stringResource(R.string.jam_start_title), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.ExtraBold)
            OutlinedTextField(
                value = title,
                onValueChange = { title = it.replace('\n', ' ').take(JamLimits.TITLE_MAX) },
                label = { Text(stringResource(R.string.jam_start_song_title)) },
                placeholder = { Text(stringResource(R.string.jam_start_song_title_hint)) },
                singleLine = true,
                isError = tried && !titleOk,
                supportingText = { if (tried && !titleOk) Text(stringResource(R.string.jam_start_need_title)) },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth().testTag("jam.start.title"),
            )
            OutlinedTextField(
                value = artist,
                onValueChange = { artist = it.replace('\n', ' ').take(ARTIST_MAX) },
                label = { Text(stringResource(R.string.jam_start_artist)) },
                placeholder = { Text(stringResource(R.string.jam_start_artist_hint)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth().testTag("jam.start.artist"),
            )
            Text(
                stringResource(R.string.jam_start_who).uppercase(),
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.Bold,
                color = colors.onSurfaceVariant,
            )
            ModeRow(JamJoinMode.Open, R.string.jam_start_open, R.string.jam_start_open_hint, mode) { mode = it }
            ModeRow(JamJoinMode.Wanted, R.string.jam_start_wanted, R.string.jam_start_wanted_hint, mode) { mode = it }
            if (mode == JamJoinMode.Wanted) {
                Text(stringResource(R.string.jam_start_pick_wanted), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), modifier = Modifier.fillMaxWidth()) {
                    JamInstrument.entries.forEach { instrument ->
                        val on = instrument in wanted
                        val tint = instrument.color()
                        androidx.compose.foundation.layout.Box(
                            Modifier
                                .weight(1f)
                                .heightIn(min = 48.dp)
                                .clip(RoundedCornerShape(14.dp))
                                .background(if (on) tint else colors.surfaceContainer)
                                .border(1.dp, if (on) tint else colors.outlineVariant, RoundedCornerShape(14.dp))
                                .clickable { wanted = if (on) wanted - instrument else wanted + instrument }
                                .semantics { role = Role.Checkbox },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(instrument.icon(), contentDescription = instrument.title(), tint = if (on) JamInk else tint, modifier = Modifier.size(22.dp))
                        }
                    }
                }
                if (tried && !wantedOk) {
                    Text(stringResource(R.string.jam_start_need_wanted), style = MaterialTheme.typography.labelMedium, color = colors.error)
                }
            }
            ModeRow(JamJoinMode.Closed, R.string.jam_start_closed, R.string.jam_start_closed_hint, mode) { mode = it }
            Spacer(Modifier.size(Spacing.xs))
            Button(
                onClick = ::go,
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("jam.start.go"),
            ) { Text(stringResource(R.string.jam_start_go), fontWeight = FontWeight.Bold) }
            TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.jam_cancel)) }
        }
    }
}

@Composable
private fun ModeRow(mode: JamJoinMode, title: Int, hint: Int, selected: JamJoinMode, onSelect: (JamJoinMode) -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(if (selected == mode) colors.surfaceContainerHigh else colors.surfaceContainer)
            .clickable { onSelect(mode) }
            .semantics { role = Role.RadioButton }
            .padding(horizontal = Spacing.sm, vertical = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected == mode, onClick = null, modifier = Modifier.padding(Spacing.sm))
        Column(Modifier.weight(1f).padding(vertical = Spacing.sm)) {
            Text(stringResource(title), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
            Text(stringResource(hint), style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
        }
    }
}
