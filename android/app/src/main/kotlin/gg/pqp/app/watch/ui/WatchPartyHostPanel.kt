package gg.pqp.app.watch.ui

import android.app.Activity
import android.content.Context
import android.media.projection.MediaProjectionManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.watch.WatchPartyHostBusy
import gg.pqp.app.watch.WatchPartyHostGate
import gg.pqp.app.watch.WatchPartyHostState
import gg.pqp.app.watch.WatchPartyPayload
import gg.pqp.app.watch.canEndParty
import gg.pqp.app.watch.canGoLiveWith
import kotlinx.coroutines.launch

/**
 * The host's own controls on a `watch_party` channel's stage -- "Criar watch
 * party", the setup card's "Ir ao vivo", and the live card's "Encerrar".
 * Slotted into [WatchPane] as `hostControls`, which is deliberately blind to
 * any of this: hosting is this file's problem alone.
 *
 * State ownership: [gate], [party] and [hostState] are read from
 * [gg.pqp.app.watch.WatchLiveStore] and [gg.pqp.app.watch.WatchPartyHostController]
 * by the caller and handed down, matching how [WatchChannelPane] already reads
 * [gg.pqp.app.watch.WatchLiveStore.channels] for the picture itself. Nothing
 * in this file touches a store directly.
 */
@Composable
fun WatchPartyHostControls(
    gate: WatchPartyHostGate,
    party: WatchPartyPayload?,
    hostState: WatchPartyHostState,
    lowLatencyAvailable: Boolean,
    selfMuted: Boolean,
    checkNeedsAck: suspend () -> Boolean,
    confirmAck: suspend () -> Unit,
    onCreate: (String) -> Unit,
    onGoLive: (lowLatency: Boolean, consent: android.content.Intent) -> Unit,
    onEnd: () -> Unit,
    onUnmute: () -> Unit,
    onDismissError: () -> Unit,
) {
    var showCreateDialog by remember { mutableStateOf(false) }
    var showAckSheet by remember { mutableStateOf(false) }
    var lowLatency by remember(party?.id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    val consentLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val data = result.data
        if (result.resultCode == Activity.RESULT_OK && data != null) {
            onGoLive(lowLatency, data)
        }
        // A refusal of the system dialog is not an error worth a message,
        // same reasoning as the ordinary share button: the person was asked
        // and said no, and the card they were on is still there.
    }

    fun requestGoLive() {
        val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE)
            as MediaProjectionManager
        consentLauncher.launch(manager.createScreenCaptureIntent())
    }

    // Go-live mic prompt: once a share has just gone out and the mic is off,
    // offer to turn it on. Keyed on the busy transition rather than on
    // `sharingScreen` itself so this fires exactly once per go-live and not
    // on every recomposition while muted.
    var awaitingGoLive by remember { mutableStateOf(false) }
    var showMicPrompt by remember { mutableStateOf(false) }
    LaunchedEffect(hostState.busy, hostState.error) {
        if (hostState.busy == WatchPartyHostBusy.GoingLive) {
            awaitingGoLive = true
        } else if (awaitingGoLive) {
            awaitingGoLive = false
            if (hostState.error == null && selfMuted) {
                showMicPrompt = true
            }
        }
    }

    if (gate.canCreate) {
        TextButton(
            onClick = { showCreateDialog = true },
            modifier = Modifier
                .padding(horizontal = Spacing.xs)
                .testTag("watchPartyHost.create"),
        ) {
            Icon(
                imageVector = PqpIcons.WatchParty,
                contentDescription = null,
                modifier = Modifier.size(Sizes.iconInline),
            )
            Text(
                text = stringResource(R.string.watch_party_host_create),
                modifier = Modifier.padding(start = Spacing.xs),
            )
        }
    }

    if (gate.canManage && party != null) {
        if (canGoLiveWith(party)) {
            SetupRow(
                party = party,
                busy = hostState.busy == WatchPartyHostBusy.GoingLive,
                lowLatencyAvailable = lowLatencyAvailable,
                lowLatency = lowLatency,
                onLowLatencyChange = { lowLatency = it },
                onGoLive = {
                    scope.launch {
                        if (checkNeedsAck()) {
                            showAckSheet = true
                        } else {
                            requestGoLive()
                        }
                    }
                },
            )
        } else if (canEndParty(party)) {
            LiveRow(
                busy = hostState.busy == WatchPartyHostBusy.Ending,
                onEnd = onEnd,
            )
        }
    }

    hostState.error?.let { message ->
        Text(
            text = message,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier
                .padding(horizontal = Spacing.lg, vertical = Spacing.xs)
                .testTag("watchPartyHost.error"),
        )
        LaunchedEffect(message) {
            // Read once, shown once; a stale refusal must not survive a
            // second unrelated action.
            onDismissError()
        }
    }

    if (showCreateDialog) {
        CreateWatchPartyDialog(
            busy = hostState.busy == WatchPartyHostBusy.Creating,
            onDismiss = { showCreateDialog = false },
            onCreate = { name ->
                onCreate(name)
                showCreateDialog = false
            },
        )
    }

    if (showAckSheet) {
        HostAckDialog(
            onConfirm = {
                scope.launch {
                    confirmAck()
                    showAckSheet = false
                    requestGoLive()
                }
            },
            onDismiss = { showAckSheet = false },
        )
    }

    if (showMicPrompt) {
        GoLiveMicPromptDialog(
            onUnmute = {
                onUnmute()
                showMicPrompt = false
            },
            onDismiss = { showMicPrompt = false },
        )
    }
}

@Composable
private fun SetupRow(
    party: WatchPartyPayload,
    busy: Boolean,
    lowLatencyAvailable: Boolean,
    lowLatency: Boolean,
    onLowLatencyChange: (Boolean) -> Unit,
    onGoLive: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.lg, vertical = Spacing.xs)) {
        Text(
            text = party.name,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurface,
        )
        if (lowLatencyAvailable) {
            Row(
                Modifier.fillMaxWidth().padding(top = Spacing.xs),
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = stringResource(R.string.watch_party_host_low_latency),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Switch(
                    checked = lowLatency,
                    onCheckedChange = onLowLatencyChange,
                    modifier = Modifier.testTag("watchPartyHost.lowLatency"),
                )
            }
        }
        TextButton(
            onClick = onGoLive,
            enabled = !busy,
            modifier = Modifier
                .padding(top = Spacing.xs)
                .testTag("watchPartyHost.goLive"),
        ) {
            if (busy) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp))
            } else {
                Icon(
                    imageVector = PqpIcons.ShareScreen,
                    contentDescription = null,
                    modifier = Modifier.size(Sizes.iconInline),
                )
            }
            Text(
                text = stringResource(R.string.watch_party_host_go_live),
                modifier = Modifier.padding(start = Spacing.xs),
            )
        }
    }
}

@Composable
private fun LiveRow(busy: Boolean, onEnd: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Spacing.lg, vertical = Spacing.xs),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = stringResource(R.string.watch_party_host_live_label),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TextButton(
            onClick = onEnd,
            enabled = !busy,
            modifier = Modifier.testTag("watchPartyHost.end"),
        ) {
            if (busy) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp))
            } else {
                Text(text = stringResource(R.string.watch_party_host_end))
            }
        }
    }
}

/** "Criar watch party": a name only. See `WatchPartyApi.createWatchParty`'s doc for why no schedule. */
@Composable
private fun CreateWatchPartyDialog(busy: Boolean, onDismiss: () -> Unit, onCreate: (String) -> Unit) {
    var name by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("watchPartyHost.createDialog"),
        title = { Text(stringResource(R.string.watch_party_host_create_title)) },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                singleLine = true,
                placeholder = { Text(stringResource(R.string.watch_party_host_create_name_placeholder)) },
                modifier = Modifier.fillMaxWidth().testTag("watchPartyHost.createName"),
            )
        },
        confirmButton = {
            TextButton(
                onClick = { onCreate(name) },
                enabled = !busy && name.isNotBlank(),
                modifier = Modifier.testTag("watchPartyHost.createSubmit"),
            ) {
                Text(stringResource(R.string.watch_party_host_create_submit))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
        },
    )
}

/**
 * "Você é responsável pelo que transmite", once per host per server -- the
 * same disclosure the web shows before a broadcast, raised here on the
 * setup surface before Ir ao vivo does anything, per `docs/WATCH_PARTY.md`
 * "The streaming notice".
 */
@Composable
private fun HostAckDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("watchPartyHost.ackDialog"),
        title = { Text(stringResource(R.string.watch_party_host_ack_title)) },
        text = { Text(stringResource(R.string.watch_party_host_ack_body)) },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.testTag("watchPartyHost.ackConfirm")) {
                Text(stringResource(R.string.watch_party_host_ack_confirm))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
        },
    )
}

/** Offered once, right after a share has gone live while the host's own mic is still off. */
@Composable
private fun GoLiveMicPromptDialog(onUnmute: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("watchPartyHost.micPrompt"),
        title = { Text(stringResource(R.string.watch_party_host_mic_prompt_title)) },
        text = { Text(stringResource(R.string.watch_party_host_mic_prompt_body)) },
        confirmButton = {
            TextButton(onClick = onUnmute, modifier = Modifier.testTag("watchPartyHost.micPromptConfirm")) {
                Text(stringResource(R.string.watch_party_host_mic_prompt_confirm))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.watch_party_host_mic_prompt_dismiss)) }
        },
    )
}
