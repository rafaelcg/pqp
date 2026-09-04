package gg.pqp.app.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.BuildConfig
import gg.pqp.app.R
import gg.pqp.app.account.ui.DeleteAccountDialog
import gg.pqp.app.account.ui.YourDataSection
import gg.pqp.app.core.Backend
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.push.PushSettingsSection
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.components.ChromeDivider
import gg.pqp.app.ui.components.ConnectionDoctorDialog
import gg.pqp.app.ui.components.SectionLabel
import gg.pqp.app.ui.components.SettingsRow
import gg.pqp.app.ui.components.pqpTopBarColors
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing

/**
 * The account screen: who you are, then the handful of things you can do about
 * it.
 *
 * It is a profile with a settings list under it, and the design pass is mostly
 * about making it read in that order. It used to open on a 64dp avatar shoved
 * into the top-left corner beside a stack of full-width buttons, separated by
 * dividers, which is the exact shape of the platform's Settings app. Now the
 * person is the header: large, centred, with air around them, and everything
 * below is a row of the same height with a muted glyph in front of it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun YouScreen(session: SessionStore, onBack: () -> Unit) {
    val phase by session.phase.collectAsStateWithLifecycle()
    val me = (phase as? SessionPhase.Ready)?.me
    var confirmingDelete by remember { mutableStateOf(false) }
    var checkingConnection by remember { mutableStateOf(false) }

    // Ends the Clerk session first, then forgets it locally; the order and
    // the reason live on `SessionStore.signOut`, which the connection banner
    // shares.
    fun signOut() = session.signOut()

    if (checkingConnection) {
        ConnectionDoctorDialog(
            session = session,
            onDismiss = { checkingConnection = false },
            onSignInAgain = {
                checkingConnection = false
                signOut()
            },
        )
    }

    // Hung off the screen rather than off the row that opens it, so that a
    // recomposition of the section cannot take the one screen in the app whose
    // next action is irreversible down with it.
    if (confirmingDelete) {
        DeleteAccountDialog(
            session = session,
            tag = me?.tag,
            onDismiss = { confirmingDelete = false },
            onDeleted = {
                confirmingDelete = false
                // The account is gone server-side. Signing out locally is what
                // takes the app back to the sign-in screen; there is nothing
                // left to authenticate with.
                signOut()
            },
        )
    }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        topBar = {
            Column {
                TopAppBar(
                    title = { Text(stringResource(R.string.you_title)) },
                    colors = pqpTopBarColors(),
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Icon(
                                imageVector = PqpIcons.Back,
                                contentDescription = stringResource(R.string.chat_back),
                            )
                        }
                    },
                )
                ChromeDivider()
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                // Scrollable because "Your data" put real copy on this screen:
                // on a short phone in a large font the delete button would
                // otherwise be below the fold with no way to reach it, which on
                // a Play requirement is the same as not having it.
                .verticalScroll(rememberScrollState()),
        ) {
            Spacer(Modifier.height(Spacing.xxl))
            AccountHeader(
                displayName = me?.displayName.orEmpty(),
                tag = me?.tag,
                handle = me?.handle,
                avatarUrl = me?.avatarUrl,
                // The id, so the fallback colour follows the account rather
                // than the name on it: renaming yourself should not repaint
                // your own monogram.
                seed = me?.id ?: me?.displayName.orEmpty(),
            )
            Spacer(Modifier.height(Spacing.xxl))

            SettingsRow(
                icon = PqpIcons.Server,
                label = stringResource(R.string.you_backend),
                value = Backend.apiUrl,
            )
            SettingsRow(
                icon = PqpIcons.Settings,
                label = stringResource(R.string.you_version),
                value = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
            )

            Spacer(Modifier.height(Spacing.lg))
            PushSettingsSection(
                Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.md),
            )

            // Voice. One row for now: the check that tells "fica conectando"
            // apart from a refused session, a blocked socket and a network
            // with no path to the relay. It lives here because voice is what
            // people notice failing first, and because the banner that also
            // offers it is only on screen while the socket is down.
            SectionLabel(stringResource(R.string.you_voice_title))
            SettingsRow(
                icon = PqpIcons.VoiceChannel,
                label = stringResource(R.string.connection_check),
                value = stringResource(R.string.connection_check_hint),
                navigates = true,
                onClick = { checkingConnection = true },
                modifier = Modifier.testTag("you.checkConnection"),
            )

            Spacer(Modifier.height(Spacing.sm))
            YourDataSection(session) { confirmingDelete = true }

            // Its own group, and last. Signing out is not a preference and it
            // is not part of "your data"; it is the way out, and the way out
            // belongs at the bottom of the page.
            Spacer(Modifier.height(Spacing.xl))
            SettingsRow(
                icon = PqpIcons.SignOut,
                label = stringResource(R.string.sign_out),
                contentColor = MaterialTheme.colorScheme.error,
                onClick = ::signOut,
            )
            Spacer(Modifier.height(Spacing.xxl))
        }
    }
}

/**
 * The person, at the top of their own screen.
 *
 * Centred and large on purpose: this is the one place in the app that is about
 * the reader rather than about a room they are in, and a 72dp avatar with the
 * display face under it is what makes that obvious before a word is read. The
 * handle is the only lime thing here, because it is the only line that is also
 * an address somebody else can type.
 */
@Composable
private fun AccountHeader(
    displayName: String,
    tag: String?,
    handle: String?,
    avatarUrl: String?,
    seed: String,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.gutter),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Avatar(
            name = displayName,
            url = avatarUrl,
            size = Sizes.avatarLarge,
            seed = seed,
        )
        Spacer(Modifier.height(Spacing.lg))
        Text(
            text = displayName,
            style = MaterialTheme.typography.headlineSmall,
            textAlign = TextAlign.Center,
        )
        tag?.let {
            Spacer(Modifier.height(Spacing.xs))
            Text(
                text = it,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
        handle?.let {
            Spacer(Modifier.height(Spacing.sm))
            Text(
                text = "pqp.gg/@$it",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
                textAlign = TextAlign.Center,
            )
        }
    }
}
