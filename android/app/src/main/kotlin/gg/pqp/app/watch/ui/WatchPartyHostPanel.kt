package gg.pqp.app.watch.ui

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.ActivityResultLauncher
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
import kotlinx.coroutines.CancellationException

/** Which capture flow the streaming-responsibility ack sheet is standing in front of. */
private enum class PendingCaptureAction { GoLive, RetryShare }

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
    /** Whether THIS phone's own capture is currently on the wire, independent of [party]'s state. */
    sharingScreen: Boolean,
    checkNeedsAck: suspend () -> Boolean,
    confirmAck: suspend () -> Unit,
    onCreate: (String) -> Unit,
    onGoLive: (lowLatency: Boolean, consent: Intent) -> Unit,
    /** "Compartilhar tela" again on an already-live party -- see [LiveRow]'s doc. */
    onRetryShare: (consent: Intent) -> Unit,
    onEnd: () -> Unit,
    onUnmute: () -> Unit,
) {
    var showCreateDialog by remember { mutableStateOf(false) }
    var showAckSheet by remember { mutableStateOf(false) }
    var ackFailed by remember { mutableStateOf(false) }
    // WHICH consent flow the ack sheet is standing in front of. A Farol
    // finding on the first cut: "Compartilhar tela" on the live card
    // (retry-share) called `requestScreenCapture` straight through, with no
    // ack check at all -- the one disclosure this whole sheet exists to
    // guarantee was reachable only via Ir ao vivo's path, not this one. Both
    // now go through [startWithAckGate] below.
    var pendingAction by remember { mutableStateOf<PendingCaptureAction?>(null) }
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

    val retryLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val data = result.data
        if (result.resultCode == Activity.RESULT_OK && data != null) {
            onRetryShare(data)
        }
    }

    fun requestScreenCapture(launcher: ActivityResultLauncher<Intent>) {
        val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE)
            as MediaProjectionManager
        launcher.launch(manager.createScreenCaptureIntent())
    }

    fun requestGoLive() = requestScreenCapture(consentLauncher)
    fun requestRetryShare() = requestScreenCapture(retryLauncher)

    /**
     * The one door both capture flows go through: ask whether the
     * once-per-host-per-server disclosure is still owed, show it if so, and
     * only reach the system consent picker once it has been shown (or was
     * already acknowledged). Ir ao vivo and Compartilhar tela (the live-card
     * retry) are otherwise unrelated user actions, but they are both "this
     * phone's mic/screen is about to reach an audience", which is exactly
     * what the disclosure is about -- so both are gated the same way.
     */
    fun startWithAckGate(action: PendingCaptureAction) {
        scope.launch {
            // Fail CLOSED here too: a lookup that throws shows the notice
            // rather than escaping this launch (a Farol finding).
            val needsAck = try {
                checkNeedsAck()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                true
            }
            if (needsAck) {
                pendingAction = action
                showAckSheet = true
            } else {
                when (action) {
                    PendingCaptureAction.GoLive -> requestGoLive()
                    PendingCaptureAction.RetryShare -> requestRetryShare()
                }
            }
        }
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
                onGoLive = { startWithAckGate(PendingCaptureAction.GoLive) },
            )
        } else if (canEndParty(party)) {
            LiveRow(
                busy = hostState.busy == WatchPartyHostBusy.Ending,
                sharingScreen = sharingScreen,
                onEnd = onEnd,
                onRetryShare = { startWithAckGate(PendingCaptureAction.RetryShare) },
            )
        }
    }

    // No inline error text here on purpose: `hostState.error` on an Encerrar
    // failure arrives AFTER `voice.leave()` has already dropped
    // `canStartWatchParty`, which is what unmounts this whole composable --
    // an inline message would never be seen. `SignedInNav` in `PqpApp.kt`
    // reads `watchPartyHost.state` at a level that survives that and shows
    // it as a toast, the same way it already does for `VoiceController`'s
    // refusals and notices.

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
            failed = ackFailed,
            onConfirm = {
                scope.launch {
                    ackFailed = false
                    // Fail CLOSED: if saving the ack itself throws, the sheet
                    // stays open and the capture never starts. The first cut
                    // of this flow let a thrown `confirmAck` fall through to
                    // `requestGoLive()` anyway (a Farol finding) -- the one
                    // disclosure this whole dialog exists to guarantee is
                    // shown would have been silently skipped from the
                    // host's saved state's point of view.
                    val confirmed = try {
                        confirmAck()
                        true
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        false
                    }
                    if (confirmed) {
                        showAckSheet = false
                        when (pendingAction) {
                            PendingCaptureAction.GoLive -> requestGoLive()
                            PendingCaptureAction.RetryShare -> requestRetryShare()
                            null -> Unit
                        }
                        pendingAction = null
                    } else {
                        ackFailed = true
                    }
                }
            },
            onDismiss = { showAckSheet = false; pendingAction = null },
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

/**
 * The party is live. Normally just "Encerrar" -- but when THIS phone's own
 * capture is not on the wire (`!sharingScreen`, e.g. `setLive` succeeded and
 * the capture then failed or was denied: the intended "live, no picture"
 * failure mode `performWatchPartyGoLive`'s doc describes), a "Compartilhar
 * tela" button is offered too, so that state is recoverable from here rather
 * than requiring Encerrar and a whole new party.
 */
@Composable
private fun LiveRow(busy: Boolean, sharingScreen: Boolean, onEnd: () -> Unit, onRetryShare: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.lg, vertical = Spacing.xs)) {
        Row(
            Modifier.fillMaxWidth(),
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
        if (!sharingScreen) {
            TextButton(
                onClick = onRetryShare,
                modifier = Modifier.testTag("watchPartyHost.retryShare"),
            ) {
                Icon(
                    imageVector = PqpIcons.ShareScreen,
                    contentDescription = null,
                    modifier = Modifier.size(Sizes.iconInline),
                )
                Text(
                    text = stringResource(R.string.watch_party_host_retry_share),
                    modifier = Modifier.padding(start = Spacing.xs),
                )
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
private fun HostAckDialog(failed: Boolean, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("watchPartyHost.ackDialog"),
        title = { Text(stringResource(R.string.watch_party_host_ack_title)) },
        text = {
            Column {
                Text(stringResource(R.string.watch_party_host_ack_body))
                if (failed) {
                    Text(
                        text = stringResource(R.string.watch_party_host_generic_error),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier
                            .padding(top = Spacing.xs)
                            .testTag("watchPartyHost.ackError"),
                    )
                }
            }
        },
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
