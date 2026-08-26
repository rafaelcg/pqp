package gg.pqp.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.clerk.api.Clerk
import gg.pqp.app.BuildConfig
import gg.pqp.app.R
import gg.pqp.app.account.ui.DeleteAccountDialog
import gg.pqp.app.account.ui.YourDataSection
import gg.pqp.app.core.AuthMode
import gg.pqp.app.core.Backend
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.push.PushSettingsSection
import gg.pqp.app.ui.components.Avatar
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun YouScreen(session: SessionStore, onBack: () -> Unit) {
    val phase by session.phase.collectAsStateWithLifecycle()
    val me = (phase as? SessionPhase.Ready)?.me
    val scope = rememberCoroutineScope()
    var confirmingDelete by remember { mutableStateOf(false) }

    /**
     * Ends the Clerk session first, while the call can still authenticate.
     * Clearing local state first would leave a live session on the device with
     * nothing able to revoke it.
     */
    fun signOut() {
        scope.launch {
            if (Backend.authMode == AuthMode.Clerk) {
                runCatching { Clerk.auth.signOut() }
            }
            session.signOutLocally()
        }
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
            TopAppBar(
                title = { Text(stringResource(R.string.you_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.chat_back),
                        )
                    }
                },
            )
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
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(
                    name = me?.displayName.orEmpty(),
                    url = me?.avatarUrl,
                    size = 64.dp,
                )
                Spacer(Modifier.width(16.dp))
                Column {
                    Text(
                        text = me?.displayName.orEmpty(),
                        style = MaterialTheme.typography.titleLarge,
                    )
                    me?.tag?.let {
                        Text(
                            text = it,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    me?.handle?.let {
                        Text(
                            text = "pqp.gg/@$it",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }

            Spacer(Modifier.height(8.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

            InfoRow(stringResource(R.string.you_backend), Backend.apiUrl)
            InfoRow(
                stringResource(R.string.you_version),
                "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
            )

            Spacer(Modifier.height(8.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            PushSettingsSection()

            Spacer(Modifier.height(16.dp))
            OutlinedButton(
                onClick = ::signOut,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.sign_out))
            }

            Spacer(Modifier.height(8.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            YourDataSection(session) { confirmingDelete = true }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Column {
        Text(
            text = label.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(text = value, style = MaterialTheme.typography.bodyMedium)
    }
}
