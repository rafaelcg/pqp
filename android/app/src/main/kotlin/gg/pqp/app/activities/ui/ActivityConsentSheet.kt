package gg.pqp.app.activities.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.spring
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.activities.ActivityApp
import gg.pqp.app.activities.ActivityConsents
import gg.pqp.app.ui.theme.Spacing

/** What the sheet is for: the first time a person joins, watches or starts an activity. */
enum class ConsentMode { Join, Watch, Start }

/**
 * The sheet before a first join (`app-join-sheet.tsx`): what the activity sees,
 * what it does not and why that is safe, once per person per app. Nothing is
 * sent until the person says yes; Agora não leaves everything as it was.
 *
 * The platform's two lines ("A atividade vê", "Ela não vê") and the sandbox line
 * are always there and are the platform's, never the app's; the app adds only
 * its own notice. Entering locks both buttons and the dialog cannot be dismissed
 * by a swipe while the answer is out; a failure says so and the same button
 * becomes "Tentar de novo".
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ActivityConsentSheet(
    app: ActivityApp,
    mode: ConsentMode,
    startedByName: String?,
    working: Boolean,
    failed: Boolean,
    phoneWatchesOnly: Boolean,
    onConfirm: (identityGranted: Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    val locale = activityLocale()
    val name = app.displayName(locale)
    val colors = MaterialTheme.colorScheme
    val sheetState = rememberModalBottomSheetState(
        skipPartiallyExpanded = true,
        confirmValueChange = { !working },
    )
    var identity by remember { mutableStateOf(false) }
    ModalBottomSheet(
        onDismissRequest = { if (!working) onDismiss() },
        sheetState = sheetState,
        modifier = Modifier.testTag("activities.consent"),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = Spacing.gutter)
                .padding(bottom = Spacing.lg)
                .animateContentSize(spring(stiffness = 500f)),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ActivityBadge(app, size = 48.dp)
                Spacer(Modifier.width(Spacing.md))
                Column(Modifier.weight(1f)) {
                    Text(
                        text = stringResource(
                            if (mode == ConsentMode.Start) R.string.activities_start_title else R.string.activities_join_title,
                            name,
                        ),
                        style = MaterialTheme.typography.titleLarge,
                        color = colors.onSurface,
                    )
                    if (startedByName != null && mode != ConsentMode.Start) {
                        Text(
                            text = stringResource(R.string.activities_join_started_by, startedByName),
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.onSurfaceVariant,
                        )
                    }
                }
            }
            Spacer(Modifier.height(Spacing.md))
            Text(
                text = app.displayDescription(locale),
                style = MaterialTheme.typography.bodyMedium,
                color = colors.onSurfaceVariant,
            )
            Spacer(Modifier.height(Spacing.lg))
            Surface(
                shape = MaterialTheme.shapes.medium,
                color = colors.surfaceContainerHigh,
                border = BorderStroke(1.dp, colors.outline),
            ) {
                Column(Modifier.padding(Spacing.md), verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(Spacing.sm)) {
                    Line(R.string.activities_join_sees_lead, R.string.activities_join_sees)
                    if (ActivityConsents.keepsOnDevice(app)) {
                        Line(R.string.activities_join_keeps_lead, R.string.activities_join_keeps)
                    }
                    Line(R.string.activities_join_not_lead, R.string.activities_join_not)
                    app.notice?.let { key ->
                        Text(
                            text = app.textFor(key, locale),
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.onSurfaceVariant,
                        )
                    }
                }
            }
            Spacer(Modifier.height(Spacing.sm))
            Text(
                text = stringResource(R.string.activities_join_sandbox),
                style = MaterialTheme.typography.bodySmall,
                color = colors.onSurfaceVariant,
            )
            if (phoneWatchesOnly) {
                Spacer(Modifier.height(Spacing.sm))
                Text(
                    text = stringResource(R.string.activities_join_watch_note),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.primary,
                )
            }
            if (ActivityConsents.asksForId(app)) {
                Spacer(Modifier.height(Spacing.md))
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(enabled = !working) { identity = !identity },
                ) {
                    Checkbox(checked = identity, onCheckedChange = { identity = it }, enabled = !working)
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(R.string.activities_join_id_label), style = MaterialTheme.typography.bodyMedium)
                        Text(
                            stringResource(R.string.activities_join_id_hint),
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.onSurfaceVariant,
                        )
                    }
                }
            }
            AnimatedVisibility(visible = failed) {
                Text(
                    text = stringResource(R.string.activities_join_failed),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.error,
                    modifier = Modifier.padding(top = Spacing.md).testTag("activities.consent.failed"),
                )
            }
            Spacer(Modifier.height(Spacing.lg))
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onDismiss, enabled = !working, modifier = Modifier.testTag("activities.consent.no")) {
                    Text(stringResource(R.string.activities_join_not_now))
                }
                Spacer(Modifier.weight(1f))
                Button(
                    onClick = { onConfirm(identity) },
                    enabled = !working,
                    modifier = Modifier.testTag("activities.consent.yes"),
                ) {
                    if (working) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                            color = colors.onPrimary,
                        )
                        Spacer(Modifier.width(Spacing.sm))
                    }
                    Text(
                        stringResource(
                            when {
                                working -> R.string.activities_join_entering
                                failed -> R.string.activities_join_retry
                                mode == ConsentMode.Start -> R.string.activities_join_start
                                mode == ConsentMode.Watch -> R.string.activities_join_watch
                                else -> R.string.activities_join_enter
                            },
                        ),
                    )
                }
            }
        }
    }
}

@Composable
private fun Line(lead: Int, body: Int) {
    Text(
        text = buildAnnotatedString {
            withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)) {
                append(stringResource(lead))
            }
            append(" ")
            append(stringResource(body))
        },
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
