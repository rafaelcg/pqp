package gg.pqp.app.ui.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.clerk.api.Clerk
import com.clerk.ui.auth.AuthView
import gg.pqp.app.R
import gg.pqp.app.core.AuthMode
import gg.pqp.app.core.Backend
import gg.pqp.app.core.SessionStore
import gg.pqp.app.ui.theme.Spacing

/**
 * Sign in, in whichever of the two modes this build was configured for.
 *
 * **Clerk's own `AuthView` is used as shipped rather than a hand-built form.**
 * It covers email codes, OAuth (Google included, which is the one that matters
 * on Android) and MFA, none of which can be exercised without a real inbox. A
 * bespoke version would be unverifiable code on the one path where being wrong
 * locks everybody out. The iOS client made the same call for the same reason.
 *
 * Sign in with Apple is not required here: Guideline 4.8 is an App Store rule
 * and has no Play Store counterpart.
 */
@Composable
fun SignInScreen(session: SessionStore) {
    when (Backend.authMode) {
        AuthMode.Clerk -> ClerkSignIn(session)
        AuthMode.DevBypass -> DevSignIn(session)
        AuthMode.Misconfigured -> MisconfiguredSignIn()
    }
}

/**
 * A release build packaged without a Clerk publishable key.
 *
 * Deliberately a dead end with an explanation rather than a button. The only
 * credential such a build could offer is the dev bypass token, which the hosted
 * API refuses, so any button here would be a lie. Saying what is wrong is worth
 * more: whoever is holding the build can report one sentence that names the
 * missing build input.
 */
@Composable
private fun MisconfiguredSignIn() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .padding(horizontal = 28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.sign_in_unavailable_title),
            style = MaterialTheme.typography.headlineSmall,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = stringResource(R.string.sign_in_unavailable_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun ClerkSignIn(session: SessionStore) {
    val initialized by Clerk.isInitialized.collectAsStateWithLifecycle()
    val authFlowComplete by Clerk.isAuthFlowCompleteFlow.collectAsStateWithLifecycle()
    val clerkSession by Clerk.sessionFlow.collectAsStateWithLifecycle()

    // A session that appears while this screen is up is a sign-in that landed.
    // Re-reading `/api/me` is what promotes it to a pqp account, because the
    // server mints the row on first authenticated request.
    androidx.compose.runtime.LaunchedEffect(clerkSession?.id, authFlowComplete) {
        if (clerkSession != null && authFlowComplete) session.restore()
    }

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        if (!initialized) {
            CircularProgressIndicator()
        } else {
            AuthView(isDismissible = false)
        }
    }
}

/**
 * The other mode, which is the only one this pass could style.
 *
 * One mark, one heading in the display face, one sentence under it and one lime
 * button. Everything else on the screen is neutral, which is the whole rule:
 * the loud colour appears once and it is on the thing to press.
 */
@Composable
private fun DevSignIn(session: SessionStore) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .padding(horizontal = 28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Image(
            painter = painterResource(R.drawable.ic_launcher_foreground),
            contentDescription = null,
            modifier = Modifier.size(96.dp),
        )
        Spacer(Modifier.height(Spacing.lg))
        Text(
            text = stringResource(R.string.sign_in_title),
            style = MaterialTheme.typography.displaySmall,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(Spacing.md))
        Text(
            text = stringResource(R.string.sign_in_subtitle),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(Spacing.xxl))
        Button(
            onClick = { session.useDevAccount() },
            shape = MaterialTheme.shapes.small,
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp),
        ) {
            Text(stringResource(R.string.sign_in_dev_action))
        }
        Spacer(Modifier.height(Spacing.md))
        Text(
            text = stringResource(R.string.sign_in_dev_note),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(Spacing.sm))
        TextButton(onClick = session::restore) {
            Text(stringResource(R.string.connection_retry))
        }
    }
}
