package gg.pqp.app.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.core.OwnStatus
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.social.ui.StatusDot
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing

/** The dot a manual choice is drawn with: `away` is what everybody else sees as idle, `invisible` as offline. */
private fun dotFor(choice: String): String = when (choice) {
    "online" -> "online"
    "away" -> "idle"
    "dnd" -> "dnd"
    else -> "offline"
}

@Composable
private fun statusLabel(choice: String): String = stringResource(
    when (choice) {
        "away" -> R.string.status_away
        "dnd" -> R.string.status_dnd
        "invisible" -> R.string.status_invisible
        else -> R.string.status_online
    },
)

/**
 * The account's own status: online, away, do not disturb, invisible. One source, the session, so
 * a choice made on another device (the server's `own-status` frame, see `SessionStore`) shows here
 * without a reload, the same as the web's user panel. A failed write puts the old choice back and
 * says so: this is the one preference that must not fail quietly.
 */
@Composable
fun StatusRow(session: SessionStore, modifier: Modifier = Modifier) {
    val phase by session.phase.collectAsStateWithLifecycle()
    val current = OwnStatus.read((phase as? SessionPhase.Ready)?.me?.preferences?.status)
    var open by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }

    Column(modifier) {
        Box {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { role = Role.DropdownList }
                    .clickable { open = true }
                    .heightIn(min = Sizes.personRow)
                    .padding(horizontal = Spacing.gutter, vertical = Spacing.md)
                    .testTag("you.status"),
            ) {
                Box(Modifier.size(Sizes.iconInline), contentAlignment = Alignment.Center) {
                    StatusDot(status = dotFor(current))
                }
                Spacer(Modifier.width(Spacing.md))
                Text(
                    text = stringResource(R.string.status_your),
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = statusLabel(current),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.width(Spacing.sm))
                Icon(
                    imageVector = PqpIcons.Forward,
                    contentDescription = stringResource(R.string.status_change),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(Sizes.iconInline),
                )
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                OwnStatus.CHOICES.forEach { choice ->
                    DropdownMenuItem(
                        modifier = Modifier
                            .semantics {
                                role = Role.RadioButton
                                selected = choice == current
                            }
                            .testTag("you.status.$choice"),
                        leadingIcon = { StatusDot(status = dotFor(choice)) },
                        text = {
                            Column {
                                Text(statusLabel(choice), style = MaterialTheme.typography.bodyLarge)
                                hintFor(choice)?.let {
                                    Text(
                                        stringResource(it),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        },
                        onClick = {
                            open = false
                            failed = false
                            session.setOwnStatus(choice) { failed = true }
                        },
                    )
                }
            }
        }
        if (failed) {
            Text(
                text = stringResource(R.string.status_save_failed),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = Spacing.gutter).testTag("you.status.failed"),
            )
        }
    }
}

private fun hintFor(choice: String): Int? = when (choice) {
    "away" -> R.string.status_away_hint
    "dnd" -> R.string.status_dnd_hint
    "invisible" -> R.string.status_invisible_hint
    else -> null
}
