package gg.pqp.app.social.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.SessionStore
import gg.pqp.app.social.BlockedUser
import gg.pqp.app.social.blockedUsers
import gg.pqp.app.social.unblockUser
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.launch

/**
 * Who this account has blocked, and a way to undo it.
 *
 * The Friends screen can start a block but never showed one again once its
 * row scrolled off: `POST /api/blocks` has always been called, `GET
 * /api/blocks` and `DELETE /api/blocks/:userId` have always answered, and
 * nothing on Android ever asked either. iOS and the web both have this
 * screen; this is the phone catching up to an endpoint that was already
 * there.
 *
 * A dialog rather than a nav destination, the same call
 * `ConnectionDoctorDialog` makes: a list this short does not need a back
 * stack entry of its own, and `YouScreen` already owns a handful of these.
 */
@Composable
fun BlockedUsersDialog(session: SessionStore, onDismiss: () -> Unit) {
    var blocked by remember { mutableStateOf<List<BlockedUser>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var unblocking by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        runCatching { session.api.blockedUsers() }
            .onSuccess { blocked = it }
            .onFailure { error = it.readable() }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("you.blockedUsers"),
        title = { Text(stringResource(R.string.blocked_users_title)) },
        text = {
            val list = blocked
            when {
                error != null -> Text(
                    text = error.orEmpty(),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                )

                list == null -> Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(Spacing.md),
                    horizontalArrangement = Arrangement.Center,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp))
                }

                list.isEmpty() -> Text(
                    text = stringResource(R.string.blocked_users_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                // A bounded LazyColumn rather than Column+verticalScroll rendering
                // every row up front: an account with hundreds or thousands of
                // blocks would otherwise hold the full response and compose
                // every avatar and row at once on open (Farol review, PR 676).
                // Same height cap as the pinned-messages dialog's list
                // (ChatScreen.kt).
                else -> LazyColumn(Modifier.heightIn(max = 420.dp)) {
                    items(list.size, key = { list[it].id }) { index ->
                        val person = list[index]
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = Spacing.xs)
                                .testTag("you.blockedUsers.row.${person.id}"),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Avatar(
                                name = person.displayName,
                                url = person.avatarUrl,
                                size = Sizes.avatarRow,
                                seed = person.id,
                            )
                            Spacer(Modifier.width(Spacing.sm))
                            Text(
                                text = person.displayName,
                                style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.weight(1f),
                            )
                            TextButton(
                                enabled = unblocking != person.id,
                                onClick = {
                                    unblocking = person.id
                                    scope.launch {
                                        runCatching { session.api.unblockUser(person.id) }
                                            .onSuccess {
                                                blocked = blocked?.filterNot { it.id == person.id }
                                                // A PRIOR unblock's failure must not go on
                                                // hiding the list behind its stale message
                                                // once a later one succeeds against the
                                                // server (Farol review, PR 676): the error
                                                // branch above takes precedence over the
                                                // list whenever `error` is non-null, and
                                                // only a successful action ever cleared
                                                // `blocked`, never `error`.
                                                error = null
                                            }
                                            .onFailure { error = it.readable() }
                                        unblocking = null
                                    }
                                },
                                modifier = Modifier.testTag("you.blockedUsers.unblock.${person.id}"),
                            ) {
                                Text(stringResource(R.string.blocked_users_unblock))
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.ok)) }
        },
    )
}

private fun Throwable.readable(): String =
    (this as? ApiException)?.serverMessage ?: message.orEmpty()
