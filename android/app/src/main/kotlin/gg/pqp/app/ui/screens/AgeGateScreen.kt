package gg.pqp.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.core.SessionStore
import gg.pqp.app.onboarding.OnboardingPath
import gg.pqp.app.onboarding.FirstRunScreen
import gg.pqp.app.onboarding.birthDateOf
import gg.pqp.app.onboarding.screenPosition
import gg.pqp.app.onboarding.ui.PrimaryButton
import gg.pqp.app.onboarding.ui.StepHeader
import gg.pqp.app.onboarding.ui.StepRail
import gg.pqp.app.onboarding.ui.rememberOnboardingHaptics
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import java.time.Month
import java.time.format.TextStyle
import java.util.Locale

/** The age the service is for. The server holds the real rule; this is the copy. */
private const val MINIMUM_AGE = 18

/**
 * The one-shot age declaration, and the first screen of first run.
 *
 * It is answered here rather than skipped because the server enforces it: until
 * it passes, every endpoint but four answers 403 and the WebSocket refuses the
 * handshake. The date travels as a plain `YYYY-MM-DD` with no time and no zone,
 * which is what a date of birth is; attaching an instant to it is the classic
 * way to refuse somebody on their own birthday.
 *
 * THE THREE DECISIONS the web gate keeps in its header, kept here too: a date
 * and not a checkbox; the one-attempt rule said BEFORE the field, as the only
 * prose on the screen; and no way out but answering.
 *
 * WHY THREE FIELDS AND NOT THE CALENDAR it used to be. A Material date picker
 * opens on this month, and the answer is twenty or thirty years back: that is
 * a lot of paging, or a mode toggle most people never find, for the first
 * thing the app asks. Day, month and year are three quick answers, and the
 * focus moves itself: two digits of day open the month list, a month moves to
 * the year, and the keyboard's Done submits.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgeGateScreen(session: SessionStore, arrivedOnInvite: Boolean = false) {
    var day by rememberSaveable { mutableStateOf("") }
    var month by rememberSaveable { mutableStateOf<Int?>(null) }
    var year by rememberSaveable { mutableStateOf("") }
    var monthsOpen by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var submitting by remember { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val haptics = rememberOnboardingHaptics()
    val monthFocus = remember { FocusRequester() }
    val yearFocus = remember { FocusRequester() }

    val badDate = stringResource(R.string.age_gate_error_bad_date)
    val saveFailed = stringResource(R.string.age_gate_error_save)
    val locale = Locale.getDefault()
    val monthNames = remember(locale) {
        Month.entries.map { m ->
            m.getDisplayName(TextStyle.FULL_STANDALONE, locale).replaceFirstChar { it.titlecase(locale) }
        }
    }
    val complete = day.isNotEmpty() && month != null && year.length == 4

    fun submit() {
        if (submitting) return
        val date = birthDateOf(day, month, year)
        if (date == null) {
            haptics.reject()
            error = badDate
            return
        }
        focus.clearFocus(force = true)
        keyboard?.hide()
        submitting = true
        error = null
        session.submitAgeCheck(date) { message ->
            submitting = false
            haptics.reject()
            error = message.ifBlank { saveFailed }
        }
    }

    val path = if (arrivedOnInvite) OnboardingPath.Invite else OnboardingPath.Cold
    val position = screenPosition(path, FirstRunScreen.Age)

    Column(
        Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .padding(horizontal = Spacing.gutter + Spacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Only when a wizard follows: an account that already answered it
            // elsewhere sees one screen, and a rail of one is noise.
            if (session.gateLeadsToOnboarding) StepRail(position.index, position.total)
        }
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Spacing.gutter + Spacing.xs)
                .padding(top = Spacing.md, bottom = Spacing.xl),
        ) {
            StepHeader(
                eyebrow = stringResource(R.string.age_gate_eyebrow),
                title = stringResource(R.string.age_gate_title),
                description = stringResource(R.string.age_gate_body, MINIMUM_AGE),
                icon = PqpIcons.Birthday,
            )
            Spacer(Modifier.height(Spacing.xl))

            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                OutlinedTextField(
                    value = day,
                    onValueChange = { input ->
                        val digits = input.filter(Char::isDigit).take(2)
                        day = digits
                        error = null
                        if (digits.length == 2) {
                            haptics.tick()
                            runCatching { monthFocus.requestFocus() }
                            monthsOpen = true
                        }
                    },
                    label = { Text(stringResource(R.string.age_gate_day)) },
                    placeholder = { Text(stringResource(R.string.age_gate_day_placeholder)) },
                    singleLine = true,
                    enabled = !submitting,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Next),
                    keyboardActions = KeyboardActions(onNext = {
                        runCatching { monthFocus.requestFocus() }
                        monthsOpen = true
                    }),
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier.weight(0.9f),
                )

                ExposedDropdownMenuBox(
                    expanded = monthsOpen,
                    onExpandedChange = { if (!submitting) monthsOpen = it },
                    modifier = Modifier.weight(1.5f),
                ) {
                    OutlinedTextField(
                        value = month?.let { monthNames[it - 1] }.orEmpty(),
                        onValueChange = {},
                        readOnly = true,
                        singleLine = true,
                        enabled = !submitting,
                        label = { Text(stringResource(R.string.age_gate_month)) },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = monthsOpen) },
                        shape = MaterialTheme.shapes.small,
                        modifier = Modifier
                            .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
                            .focusRequester(monthFocus),
                    )
                    ExposedDropdownMenu(
                        expanded = monthsOpen,
                        onDismissRequest = { monthsOpen = false },
                    ) {
                        monthNames.forEachIndexed { index, name ->
                            DropdownMenuItem(
                                text = { Text(name) },
                                onClick = {
                                    month = index + 1
                                    monthsOpen = false
                                    error = null
                                    haptics.tick()
                                    runCatching { yearFocus.requestFocus() }
                                },
                                contentPadding = ExposedDropdownMenuDefaults.ItemContentPadding,
                            )
                        }
                    }
                }

                OutlinedTextField(
                    value = year,
                    onValueChange = { input ->
                        year = input.filter(Char::isDigit).take(4)
                        error = null
                        if (year.length == 4) haptics.tick()
                    },
                    label = { Text(stringResource(R.string.age_gate_year)) },
                    placeholder = { Text(stringResource(R.string.age_gate_year_placeholder)) },
                    singleLine = true,
                    enabled = !submitting,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { submit() }),
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier
                        .weight(1.1f)
                        .focusRequester(yearFocus),
                )
            }

            Spacer(Modifier.height(Spacing.lg))
            // The only prose on the screen, and it comes before the button:
            // somebody has to know what honesty costs before they answer.
            Surface(
                shape = MaterialTheme.shapes.medium,
                color = MaterialTheme.colorScheme.surfaceContainer,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(Modifier.padding(Spacing.md), verticalAlignment = Alignment.Top) {
                    Icon(
                        PqpIcons.Warning,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier
                            .padding(top = 1.dp)
                            .size(18.dp),
                    )
                    Spacer(Modifier.width(Spacing.sm + 2.dp))
                    Text(
                        text = stringResource(R.string.age_gate_warning, MINIMUM_AGE),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            AnimatedVisibility(visible = error != null) {
                Text(
                    text = error.orEmpty(),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier
                        .padding(top = Spacing.md)
                        .semantics { liveRegion = LiveRegionMode.Assertive },
                )
            }
        }

        Column(
            Modifier
                .fillMaxWidth()
                .imePadding()
                .navigationBarsPadding()
                .padding(horizontal = Spacing.gutter + Spacing.xs, vertical = Spacing.md),
        ) {
            PrimaryButton(
                text = stringResource(if (submitting) R.string.age_gate_saving else R.string.age_gate_confirm),
                onClick = ::submit,
                enabled = complete,
                busy = submitting,
            )
        }
    }
}
