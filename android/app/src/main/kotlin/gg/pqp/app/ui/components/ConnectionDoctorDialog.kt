package gg.pqp.app.ui.components

import android.content.ClipData
import android.content.ClipboardManager
import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.pqp.app.BuildConfig
import gg.pqp.app.R
import gg.pqp.app.core.Advice
import gg.pqp.app.core.Backend
import gg.pqp.app.core.CheckId
import gg.pqp.app.core.CheckResult
import gg.pqp.app.core.CheckVerdict
import gg.pqp.app.core.ConnectionChecks
import gg.pqp.app.core.ConnectionDoctor
import gg.pqp.app.core.DoctorReport
import gg.pqp.app.core.SessionStore
import gg.pqp.app.core.SocketSnapshot
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.voice.WebRtcIceProber

/**
 * The connection check, as a dialog. Runs on open, shows each check as it
 * lands, ends with the one thing to do first and a copyable report for the
 * QG. See `core/ConnectionDoctor.kt` for what is checked and why.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ConnectionDoctorDialog(
    session: SessionStore,
    onDismiss: () -> Unit,
    onSignInAgain: () -> Unit,
) {
    val context = LocalContext.current
    var results by remember { mutableStateOf<Map<CheckId, CheckResult>>(emptyMap()) }
    var report by remember { mutableStateOf<DoctorReport?>(null) }
    var run by remember { mutableIntStateOf(0) }
    var copied by remember { mutableStateOf(false) }
    val running = report == null

    LaunchedEffect(run) {
        results = emptyMap()
        report = null
        copied = false
        val checks = ConnectionChecks(
            http = session.http,
            apiUrl = Backend.apiUrl,
            tokens = session.tokens,
            socket = {
                SocketSnapshot(
                    state = session.realtime.state.value,
                    lastClose = session.realtime.lastClose,
                    unauthorizedStreak = session.realtime.unauthorizedStreak.value,
                )
            },
            iceServers = { session.api.iceServers() },
            prober = WebRtcIceProber(context),
        )
        report = checks.run { result -> results = results + (result.id to result) }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("connection.doctor"),
        title = { Text(stringResource(R.string.connection_doctor_title)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(
                    text = stringResource(R.string.connection_doctor_description),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(Spacing.md))
                CheckId.entries.forEach { id ->
                    CheckRow(id, results[id])
                }
                report?.let { done ->
                    Spacer(Modifier.height(Spacing.md))
                    Surface(
                        color = if (done.advice == Advice.None) {
                            MaterialTheme.colorScheme.surfaceContainerHigh
                        } else {
                            MaterialTheme.colorScheme.tertiaryContainer
                        },
                        shape = MaterialTheme.shapes.medium,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("connection.doctor.advice.${done.advice.wire}"),
                    ) {
                        Text(
                            text = stringResource(adviceLabel(done.advice)),
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(Spacing.md),
                        )
                    }
                }
            }
        },
        confirmButton = {
            // Three buttons on a bad day ("Sign in again", "Copy report",
            // "Run again"), which is wider than a small phone's dialog. A
            // `FlowRow` wraps the third onto a second line instead of
            // clipping it, and `AlertDialog` only wraps what it lays out
            // itself, not the contents of this slot.
            FlowRow(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                if (report?.advice == Advice.SignInAgain) {
                    TextButton(onClick = onSignInAgain) {
                        Text(stringResource(R.string.connection_sign_in_again))
                    }
                }
                TextButton(
                    enabled = report != null,
                    onClick = {
                        val done = report ?: return@TextButton
                        val text = ConnectionDoctor.formatReport(
                            done,
                            appVersion = "android ${BuildConfig.VERSION_NAME}",
                            platform = "Android ${Build.VERSION.RELEASE} ${Build.MANUFACTURER} ${Build.MODEL}",
                        )
                        context.getSystemService(ClipboardManager::class.java)
                            ?.setPrimaryClip(ClipData.newPlainText("pqp connection check", text))
                        copied = true
                    },
                ) {
                    Text(
                        stringResource(
                            if (copied) R.string.connection_doctor_copied else R.string.connection_doctor_copy,
                        ),
                    )
                }
                TextButton(enabled = !running, onClick = { run += 1 }) {
                    Text(
                        stringResource(
                            if (running) R.string.connection_doctor_running else R.string.connection_doctor_run,
                        ),
                    )
                }
            }
        },
    )
}

@Composable
private fun CheckRow(id: CheckId, result: CheckResult?) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = Spacing.xs)
            .testTag("connection.doctor.${id.wire}.${result?.verdict?.name?.lowercase() ?: "pending"}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when (result?.verdict) {
            null -> CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            CheckVerdict.Ok -> Icon(
                imageVector = PqpIcons.Confirm,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(16.dp),
            )
            CheckVerdict.Fail -> Icon(
                imageVector = PqpIcons.Close,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(16.dp),
            )
            CheckVerdict.Skip -> Icon(
                imageVector = PqpIcons.Forward,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(16.dp),
            )
        }
        Spacer(Modifier.width(Spacing.md))
        Column(Modifier.weight(1f)) {
            Text(
                text = stringResource(checkLabel(id)),
                style = MaterialTheme.typography.bodyMedium,
            )
            if (result != null) {
                Text(
                    text = result.detail + if (result.ms > 0) " · ${result.ms} ms" else "",
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

private fun checkLabel(id: CheckId): Int = when (id) {
    CheckId.Api -> R.string.connection_doctor_check_api
    CheckId.Token -> R.string.connection_doctor_check_token
    CheckId.Socket -> R.string.connection_doctor_check_socket
    CheckId.Stun -> R.string.connection_doctor_check_stun
    CheckId.Turn -> R.string.connection_doctor_check_turn
}

private fun adviceLabel(advice: Advice): Int = when (advice) {
    Advice.None -> R.string.connection_doctor_advice_none
    Advice.ApiUnreachable -> R.string.connection_doctor_advice_api_unreachable
    Advice.TokenStuck -> R.string.connection_doctor_advice_token_stuck
    Advice.SignInAgain -> R.string.connection_doctor_advice_sign_in_again
    Advice.SocketBlocked -> R.string.connection_doctor_advice_socket_blocked
    Advice.RelayBlocked -> R.string.connection_doctor_advice_relay_blocked
    Advice.NoUdp -> R.string.connection_doctor_advice_no_udp
}
