package gg.pqp.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDefaults
import androidx.compose.material3.DatePickerState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.core.SessionStore
import gg.pqp.app.ui.theme.Spacing
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * The one-shot age declaration.
 *
 * It is answered here rather than skipped because the server enforces it: until
 * it passes, every endpoint but four answers 403 and the WebSocket refuses the
 * handshake. The date travels as a plain `YYYY-MM-DD` with no time and no zone,
 * which is what a date of birth is; attaching an instant to it is the classic
 * way to refuse somebody on their own birthday.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgeGateScreen(session: SessionStore) {
    val pickerState = rememberDatePickerState()
    var error by remember { mutableStateOf<String?>(null) }
    var submitting by remember { mutableStateOf(false) }
    val selected by remember(pickerState) {
        derivedStateOf { calendarDateOf(pickerState) }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Spacing.gutter),
        verticalArrangement = Arrangement.Center,
    ) {
        Spacer(Modifier.height(Spacing.xl))
        Text(
            text = stringResource(R.string.age_gate_title),
            style = MaterialTheme.typography.headlineMedium,
        )
        Spacer(Modifier.height(Spacing.md))
        Text(
            text = stringResource(R.string.age_gate_body),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(Spacing.lg))

        DatePicker(
            state = pickerState,
            title = null,
            headline = null,
            showModeToggle = true,
            // The picker is part of this page rather than a card dropped onto
            // it, so it sits on the page's own colour. Material would give it
            // `surfaceContainerHigh`, which on this ramp is the colour a row
            // takes when it is pressed. Today's date loses its lime ring for
            // the same reason the ring exists at all: the one loud thing on
            // this screen has to be the day the reader picked.
            colors = DatePickerDefaults.colors(
                containerColor = MaterialTheme.colorScheme.surface,
                todayDateBorderColor = MaterialTheme.colorScheme.outline,
            ),
        )

        // The declaration is irreversible and the server enforces it: a date
        // under 18 closes the account for good, with no second attempt. The web
        // client says so before the button; not saying it here would be asking
        // somebody to answer honestly without telling them what honesty costs.
        Spacer(Modifier.height(12.dp))
        Text(
            text = stringResource(R.string.age_gate_warning),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        error?.let {
            Spacer(Modifier.height(Spacing.sm))
            Text(
                text = it,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
        }

        Spacer(Modifier.height(Spacing.lg))
        Button(
            onClick = {
                val date = selected ?: return@Button
                submitting = true
                error = null
                session.submitAgeCheck(date) { message ->
                    submitting = false
                    error = message.ifBlank { null }
                }
            },
            enabled = selected != null && !submitting,
            shape = MaterialTheme.shapes.small,
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp),
        ) {
            Text(stringResource(R.string.age_gate_confirm))
        }
        Spacer(Modifier.height(Spacing.xl))
    }
}

/**
 * The picker reports UTC midnight for the day that was tapped, so reading it
 * back in UTC is what keeps the calendar date the one the person chose rather
 * than the day before it.
 */
@OptIn(ExperimentalMaterial3Api::class)
private fun calendarDateOf(state: DatePickerState): String? =
    state.selectedDateMillis?.let { millis ->
        Instant.ofEpochMilli(millis)
            .atZone(ZoneOffset.UTC)
            .toLocalDate()
            .format(DateTimeFormatter.ISO_LOCAL_DATE)
    }
