package gg.pqp.app.ui.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.isImeVisible
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
import com.clerk.api.ui.ClerkColors
import com.clerk.api.ui.ClerkTheme
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

@OptIn(ExperimentalLayoutApi::class)
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

    // The lift exists to spend dead space, so it is given up the moment there
    // is none. Clerk's scaffold applies no IME inset and does not scroll, so
    // with the keyboard up the form stays exactly where it was and whatever is
    // under the fold is simply covered: holding on to 32dp there would put the
    // "Continue" button behind the top row of keys on a shorter phone.
    val lift = if (WindowInsets.isImeVisible) 0.dp else Spacing.xxl

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        if (!initialized) {
            CircularProgressIndicator()
        } else {
            AuthView(
                // `AuthView` is `Modifier.fillMaxSize().then(modifier)`
                // internally, so it always takes the whole window and this
                // padding insets its content rather than shrinking the sheet.
                // It is the only lever on vertical placement there is: the form
                // is top-aligned inside Clerk's own full-screen `Scaffold`,
                // which is why the screen used to open with the title jammed
                // under the status bar and a third of the window empty
                // underneath. Modest on purpose, because that `Scaffold` does
                // not scroll: every dp spent here is a dp the tallest step of
                // the flow no longer has.
                modifier = Modifier.padding(top = lift),
                // The ground, which is ours to set even though the form is not.
                // Clerk's dark default is #131316, a neutral near-black that
                // sits visibly lighter and greyer than `Ink`, so without this
                // the padding above would read as a band rather than as space.
                // Only the background is overridden; the rest of Clerk's
                // palette is left alone rather than half-restyled.
                clerkTheme = ClerkTheme(
                    colors = ClerkColors(background = MaterialTheme.colorScheme.background),
                ),
                // Clerk renders this centred in its own top bar, which was
                // otherwise an empty row. So the brand mark costs almost
                // nothing in height, stands above the form the way a sign-in
                // screen's mark should, and stays there through every later
                // step of the flow: the code entry, MFA, the lot.
                logo = { PqpMark() },
                isDismissible = false,
            )
        }
    }
}

/**
 * The pqp mark: the launcher icon's foreground, which is the speech bubble with
 * the typing dots, drawn on nothing.
 *
 * 80dp rather than the 96 the dev screen uses. The drawable is a 108dp
 * viewport with the art inside the central 72dp launcher safe zone, so 80dp of
 * box is about 53dp of bubble, and every dp of box is height the form below it
 * does not get.
 */
@Composable
private fun PqpMark() {
    Image(
        painter = painterResource(R.drawable.ic_launcher_foreground),
        contentDescription = null,
        modifier = Modifier.size(80.dp),
    )
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
