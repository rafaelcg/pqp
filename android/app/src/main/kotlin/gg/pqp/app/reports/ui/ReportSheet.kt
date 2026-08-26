package gg.pqp.app.reports.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.ApiException
import gg.pqp.app.reports.ReportDraft
import gg.pqp.app.reports.ReportReason
import gg.pqp.app.reports.ReportTarget
import gg.pqp.app.reports.createReport
import kotlinx.coroutines.launch

/**
 * One report flow for all three subjects: pick a reason, optionally say more,
 * send.
 *
 * A single sheet rather than three, because the differences between the
 * subjects are two sentences of copy and which id goes in the body. What a
 * person is doing is the same thing in all three cases, and so is what they
 * need to be told: a moderator will read this, and you will not be named to
 * the person you reported.
 *
 * There is no cancel-on-failure path and no retry button. A refusal prints the
 * server's own sentence and leaves the half-written report exactly where it
 * was, because the two refusals that actually happen are the hourly ceiling and
 * a subject that has since gone away, and both of those are things to read
 * rather than things to tap through.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReportSheet(
    api: ApiClient,
    target: ReportTarget,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    var reason by remember { mutableStateOf<ReportReason?>(null) }
    var details by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var sent by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = Modifier.testTag("report.sheet"),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(start = 20.dp, end = 20.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (sent) {
                Text(
                    text = stringResource(R.string.report_sent_title),
                    style = MaterialTheme.typography.titleLarge,
                )
                Text(
                    text = stringResource(R.string.report_sent_body),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Button(
                    onClick = onDismiss,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("report.done"),
                ) { Text(stringResource(R.string.report_done)) }
                return@Column
            }

            Text(
                text = when (target) {
                    is ReportTarget.Message ->
                        stringResource(R.string.report_subject_message, target.authorName)
                    is ReportTarget.Person ->
                        stringResource(R.string.report_subject_user, target.displayName)
                    is ReportTarget.Community ->
                        stringResource(R.string.report_subject_community, target.name)
                },
                style = MaterialTheme.typography.titleLarge,
            )

            // What a moderator will actually see, which differs per subject and
            // is the one thing somebody deserves to know before they send it.
            Text(
                text = stringResource(
                    when (target) {
                        is ReportTarget.Message -> R.string.report_body_message
                        is ReportTarget.Person -> R.string.report_body_user
                        is ReportTarget.Community -> R.string.report_body_community
                    },
                ),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Text(
                text = stringResource(R.string.report_reason_prompt).uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Column(Modifier.selectableGroup()) {
                ReportReason.entries.forEach { choice ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .selectable(
                                selected = reason == choice,
                                enabled = !sending,
                                role = Role.RadioButton,
                                onClick = { reason = choice },
                            )
                            .padding(vertical = 4.dp)
                            .testTag("report.reason.${choice.wire}"),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(
                            selected = reason == choice,
                            onClick = null,
                            enabled = !sending,
                        )
                        Text(
                            text = stringResource(choice.label),
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.padding(start = 12.dp),
                        )
                    }
                }
            }

            OutlinedTextField(
                value = details,
                onValueChange = { details = it.take(ReportDraft.DETAILS_MAX_LENGTH) },
                label = { Text(stringResource(R.string.report_details_label)) },
                placeholder = { Text(stringResource(R.string.report_details_placeholder)) },
                enabled = !sending,
                minLines = 3,
                maxLines = 6,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("report.details"),
            )

            error?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            Button(
                onClick = {
                    val picked = reason ?: return@Button
                    scope.launch {
                        sending = true
                        error = null
                        runCatching { api.createReport(ReportDraft.body(target, picked, details)) }
                            .onSuccess { sent = true }
                            .onFailure { failure ->
                                // The server's own sentence, verbatim. Only it
                                // knows whether this was the hourly ceiling or a
                                // subject that is no longer reachable, and the
                                // 404 is deliberately not specific enough to
                                // paraphrase into something friendlier.
                                error = (failure as? ApiException)?.serverMessage
                                    ?.takeIf { it.isNotBlank() }
                                    ?: context.getString(R.string.report_failed)
                            }
                        sending = false
                    }
                },
                enabled = reason != null && !sending,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("report.send"),
            ) {
                Text(
                    stringResource(
                        if (sending) R.string.report_sending else R.string.report_send,
                    ),
                )
            }

            TextButton(
                onClick = onDismiss,
                enabled = !sending,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(stringResource(R.string.cancel)) }
        }
    }
}
