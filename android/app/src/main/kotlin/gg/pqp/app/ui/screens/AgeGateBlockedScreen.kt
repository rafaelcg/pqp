package gg.pqp.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import gg.pqp.app.R
import gg.pqp.app.core.Backend
import gg.pqp.app.onboarding.AGE_GATE_APPEAL_EMAIL
import gg.pqp.app.onboarding.ui.StepHeader
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing

/**
 * The final screen for an account that answered under 18 (the web's
 * `AgeGateBlocked`). It used to be the generic failure screen with the bare
 * word "blocked" on it.
 *
 * The reader may well be a child: it says what happened and what can be done,
 * accuses nobody of lying, and does not suggest signing up again. The way back
 * for somebody who typed the wrong date is on the screen itself, not one link
 * away: write to [AGE_GATE_APPEAL_EMAIL] from the account's email address.
 */
@Composable
fun AgeGateBlockedScreen() {
    val linkStyles = TextLinkStyles(
        style = SpanStyle(color = MaterialTheme.colorScheme.primary, textDecoration = TextDecoration.Underline),
    )
    val contact = linkedSentence(
        before = stringResource(R.string.age_gate_blocked_contact_before),
        link = AGE_GATE_APPEAL_EMAIL,
        after = stringResource(R.string.age_gate_blocked_contact_after),
        url = "mailto:$AGE_GATE_APPEAL_EMAIL",
        linkStyles = linkStyles,
    )
    val appeal = linkedSentence(
        before = stringResource(R.string.age_gate_blocked_appeal_before),
        link = stringResource(R.string.age_gate_blocked_appeal_link),
        after = stringResource(R.string.age_gate_blocked_appeal_after),
        url = Backend.appUrl + "/terms",
        linkStyles = linkStyles,
        spaceAfter = false,
    )
    Column(
        Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Vertical + WindowInsetsSides.Horizontal))
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Spacing.gutter + Spacing.xs)
            .padding(top = Spacing.xl, bottom = Spacing.xl),
    ) {
        StepHeader(
            eyebrow = stringResource(R.string.age_gate_blocked_eyebrow),
            title = stringResource(R.string.age_gate_blocked_title, MINIMUM_AGE),
            description = stringResource(R.string.age_gate_blocked_body, MINIMUM_AGE),
            icon = PqpIcons.Birthday,
        )
        Spacer(Modifier.height(Spacing.xl))
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
            Text(
                text = contact,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                text = appeal,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = stringResource(R.string.age_gate_blocked_wait),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** `before link after`, with only [link] tappable. */
private fun linkedSentence(
    before: String,
    link: String,
    after: String,
    url: String,
    linkStyles: TextLinkStyles,
    spaceAfter: Boolean = true,
): AnnotatedString = buildAnnotatedString {
    append(before)
    append(" ")
    withLink(LinkAnnotation.Url(url, linkStyles)) { append(link) }
    if (spaceAfter) append(" ")
    append(after)
}
