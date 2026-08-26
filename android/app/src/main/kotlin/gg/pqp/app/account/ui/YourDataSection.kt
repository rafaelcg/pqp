package gg.pqp.app.account.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.account.exportMyData
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.SessionStore
import java.time.LocalDate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The two rights the privacy policy promises, as buttons.
 *
 * **PLAY REQUIRES THE SECOND ONE.** An app that supports account creation must
 * let the account be deleted from inside the app, and a submission without it
 * is rejected. That is the same rule that held the iOS app at Guideline
 * 5.1.1(v) until build 12; until now the only route on an Android phone was to
 * email an address and wait for somebody to run SQL by hand.
 *
 * Its own section rather than a footer at the end of a scroll: the right to
 * leave belongs somewhere a person can find it on purpose.
 *
 * The confirmation is **not** presented from here. It hangs off the screen that
 * owns this section, so that it cannot be torn down by a recomposition of the
 * row that opened it.
 */
@Composable
fun YourDataSection(session: SessionStore, onRequestDelete: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    var exporting by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var failed by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf<ByteArray?>(null) }

    // The web client mints a blob URL and clicks an invisible link; iOS writes a
    // temp file and hands it to the share sheet. Android's own answer is the
    // system file picker, which needs no FileProvider and no storage
    // permission, and which lets somebody put the file where they will find it
    // again rather than where the app chose.
    val save = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("application/json"),
    ) { uri: Uri? ->
        val bytes = pending
        pending = null
        if (uri == null || bytes == null) return@rememberLauncherForActivityResult
        scope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                        ?: error("no stream")
                }.isSuccess
            }
            failed = !ok
            message = context.getString(
                if (ok) R.string.you_data_export_saved else R.string.you_data_export_failed,
            )
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = stringResource(R.string.you_data_title).uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        OutlinedButton(
            onClick = {
                // Fetched *before* the picker opens, so a failure is a message
                // rather than an empty file somebody has already named and
                // filed away.
                scope.launch {
                    exporting = true
                    message = null
                    failed = false
                    val bytes = runCatching { session.api.exportMyData() }
                    exporting = false
                    bytes
                        .onSuccess {
                            pending = it
                            save.launch("pqp-my-data-${LocalDate.now()}.json")
                        }
                        .onFailure { error ->
                            failed = true
                            message = (error as? ApiException)?.serverMessage
                                ?: context.getString(R.string.you_data_export_failed)
                        }
                }
            },
            enabled = !exporting,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                stringResource(
                    if (exporting) R.string.you_data_exporting else R.string.you_data_export,
                ),
            )
        }

        Text(
            text = stringResource(R.string.you_data_export_note),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        message?.let {
            Text(
                text = it,
                style = MaterialTheme.typography.bodySmall,
                color = if (failed) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.primary
                },
            )
        }

        TextButton(onClick = onRequestDelete, modifier = Modifier.fillMaxWidth()) {
            Text(
                text = stringResource(R.string.you_data_delete),
                color = MaterialTheme.colorScheme.error,
            )
        }

        Text(
            text = stringResource(R.string.you_data_delete_note),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
