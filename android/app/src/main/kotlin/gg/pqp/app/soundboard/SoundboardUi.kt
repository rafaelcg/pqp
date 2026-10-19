package gg.pqp.app.soundboard

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.PqpApplication
import gg.pqp.app.R
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.delay

/**
 * The call's soundboard: a button under the call bar while the room's server has `soundboard` on, and a sheet of
 * tiles (the six built-in clips, then the server's own). A tap sends `soundboard-play`; the room's echo is what
 * every phone, this one included, plays (see [SoundboardController]). Drawn only for a call in a server channel
 * whose server has the board on.
 */
@Composable
fun SoundboardRow(channelId: String?, modifier: Modifier = Modifier) {
    val controller = (LocalContext.current.applicationContext as? PqpApplication)?.soundboard ?: return
    LaunchedEffect(channelId) { controller.refresh(channelId) }
    val available by controller.available.collectAsStateWithLifecycle()
    val on = (available as? SoundboardController.Availability.On)?.takeIf { it.channelId == channelId } ?: return

    var open by remember { mutableStateOf(false) }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(start = Spacing.gutter, end = Spacing.sm, bottom = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FilledTonalButton(
            onClick = { open = true },
            contentPadding = ButtonDefaults.ButtonWithIconContentPadding,
            modifier = Modifier.testTag("call.soundboard"),
        ) {
            Icon(PqpIcons.Soundboard, contentDescription = null, modifier = Modifier.size(ButtonDefaults.IconSize))
            Spacer(Modifier.width(ButtonDefaults.IconSpacing))
            Text(stringResource(R.string.soundboard_open), maxLines = 1)
        }
    }
    if (open) {
        SoundboardSheet(on, onSend = { id -> controller.send(on.channelId, id) }, onDismiss = { open = false })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SoundboardSheet(
    board: SoundboardController.Availability.On,
    onSend: (String) -> Boolean,
    onDismiss: () -> Unit,
) {
    var slow by remember { mutableStateOf(false) }
    LaunchedEffect(slow) {
        if (slow) {
            delay(SLOW_SHOWN_MS)
            slow = false
        }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.padding(horizontal = Spacing.gutter).padding(bottom = Spacing.xl)) {
            Text(stringResource(R.string.soundboard_title), style = MaterialTheme.typography.titleMedium)
            Text(
                text = stringResource(if (slow) R.string.soundboard_slow else R.string.soundboard_hint),
                style = MaterialTheme.typography.bodySmall,
                color = if (slow) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = Spacing.xs, bottom = Spacing.md).testTag("soundboard.hint"),
            )
            val tiles = SoundboardBuiltins.ALL.map { Tile(it.id, it.emoji, stringResource(it.label)) } +
                board.sounds.map { Tile(it.id, it.emoji, it.name) }
            LazyVerticalGrid(
                columns = GridCells.Fixed(3),
                horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
                verticalArrangement = Arrangement.spacedBy(Spacing.sm),
                modifier = Modifier.heightIn(max = 420.dp),
            ) {
                items(tiles, key = { it.id }) { tile ->
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier
                            .clip(MaterialTheme.shapes.medium)
                            .semantics {
                                role = Role.Button
                                contentDescription = tile.name
                            }
                            .clickable { if (!onSend(tile.id)) slow = true }
                            .padding(vertical = Spacing.md, horizontal = Spacing.xs)
                            .testTag("soundboard.tile.${tile.id}"),
                    ) {
                        // The clip's own glyph: it is the clip's identity on the wire, not decoration.
                        Text(tile.emoji, style = MaterialTheme.typography.headlineMedium)
                        Text(
                            tile.name,
                            style = MaterialTheme.typography.labelMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
        }
    }
}

private data class Tile(val id: String, val emoji: String, val name: String)

private const val SLOW_SHOWN_MS = 3_000L
