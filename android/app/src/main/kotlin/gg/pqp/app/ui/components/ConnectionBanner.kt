package gg.pqp.app.ui.components

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.core.RealtimeState
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing

/**
 * The strip under the chrome while the live connection is down.
 *
 * It used to live inside the chat screen alone, say "Offline. Trying to
 * reconnect…" (or "Something went wrong" for a refused session) and offer
 * nothing, forever, including when the server was refusing the session and no
 * amount of reconnecting would help. Now it is app-wide and carries the two
 * ways out: try now, and the check that says what is actually wrong. A
 * session refused twice in a row swaps the wording and offers to sign in
 * again, since that is the only fix.
 *
 * Connecting is a fact and the other two are a problem, so only the other two
 * are marked with a glyph. A warning on the first second of every launch would
 * be crying wolf, and then nobody reads the strip that matters.
 */
@Composable
fun ConnectionBanner(
    state: RealtimeState,
    refusedRepeatedly: Boolean,
    onRetry: () -> Unit,
    onCheck: () -> Unit,
    onSignInAgain: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val refused = state == RealtimeState.Refused && refusedRepeatedly
    val text = when (state) {
        RealtimeState.Connecting -> stringResource(R.string.connection_connecting)
        RealtimeState.Reconnecting -> stringResource(R.string.connection_offline)
        RealtimeState.Refused ->
            if (refused) {
                stringResource(R.string.connection_doctor_advice_sign_in_again)
            } else {
                stringResource(R.string.connection_unauthorized)
            }
        else -> null
    } ?: return

    val warn = state == RealtimeState.Reconnecting || state == RealtimeState.Refused

    Surface(color = MaterialTheme.colorScheme.surfaceContainer, modifier = modifier) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = Spacing.gutter, end = Spacing.sm, top = Spacing.xs, bottom = Spacing.xs)
                .testTag("connection.banner.${state.name.lowercase()}"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (warn) {
                Icon(
                    imageVector = PqpIcons.Warning,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.width(Spacing.sm))
            }
            Text(
                text = text,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            if (refused) {
                TextButton(onClick = onSignInAgain, modifier = Modifier.testTag("connection.signIn")) {
                    Text(stringResource(R.string.connection_sign_in_again))
                }
            } else if (state != RealtimeState.Connecting) {
                TextButton(onClick = onRetry, modifier = Modifier.testTag("connection.retry")) {
                    Text(stringResource(R.string.connection_retry_now))
                }
            }
            TextButton(onClick = onCheck, modifier = Modifier.testTag("connection.check")) {
                Text(stringResource(R.string.connection_check))
            }
        }
    }
}
