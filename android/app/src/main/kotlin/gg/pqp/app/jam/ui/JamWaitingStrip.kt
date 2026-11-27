package gg.pqp.app.jam.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.jam.JamBidi
import gg.pqp.app.jam.JamNoticeRules
import gg.pqp.app.ui.theme.Spacing

/**
 * The wall's one row about what is waiting on this person: "N partes esperando tua resposta" and a button. Parts from
 * outside waiting for the starter's answer, on the songs this wall holds (the web's `JamPublicWaitingStrip`). It reads
 * the starter's inbox, the STATE, not the notice, so it stays when the server's `jam_take_notices` is off.
 *
 * [onSee] opens the song when every waiting part is on one song, and the list of songs when they are on several.
 */
@Composable
fun JamWaitingStrip(songs: List<JamNoticeRules.WaitingSong>, onSee: () -> Unit, modifier: Modifier = Modifier) {
    if (songs.isEmpty()) return
    val total = songs.sumOf { it.count }
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .padding(start = Spacing.md, top = Spacing.sm, bottom = Spacing.sm, end = Spacing.sm)
            .semantics { liveRegion = LiveRegionMode.Polite }
            .testTag("jam.waiting.strip"),
        horizontalArrangement = Arrangement.spacedBy(Spacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = pluralStringResource(R.plurals.jam_waiting_strip, total, total),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.weight(1f),
        )
        Button(onClick = onSee, modifier = Modifier.testTag("jam.waiting.see")) {
            Text(stringResource(R.string.jam_waiting_see), softWrap = false)
        }
    }
}

/**
 * Every song of this wall with a part waiting, each opening the song (hearing one and deciding happens in the song, with
 * the band playing).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JamInboxSheet(songs: List<JamNoticeRules.WaitingSong>, onOpen: (String) -> Unit, onDismiss: () -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, modifier = Modifier.testTag("jam.inbox")) {
        LazyColumn(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding(),
            contentPadding = PaddingValues(horizontal = Spacing.gutter, vertical = Spacing.sm),
            verticalArrangement = Arrangement.spacedBy(Spacing.md),
        ) {
            item(key = "head") {
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
                    Text(stringResource(R.string.jam_inbox_title), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.ExtraBold)
                    Text(
                        stringResource(R.string.jam_inbox_hint),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            items(songs, key = { it.songId }) { song ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(MaterialTheme.colorScheme.surfaceContainer)
                        .padding(start = Spacing.md, top = Spacing.sm, bottom = Spacing.sm, end = Spacing.sm)
                        .testTag("jam.inbox.${song.songId}"),
                    horizontalArrangement = Arrangement.spacedBy(Spacing.md),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            JamBidi.clean(song.title),
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Bold,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            pluralStringResource(R.plurals.jam_requests_count, song.count, song.count),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Button(onClick = { onOpen(song.songId) }) { Text(stringResource(R.string.jam_inbox_open), softWrap = false) }
                }
            }
        }
    }
}
