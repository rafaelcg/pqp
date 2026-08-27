package gg.pqp.app.account.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import gg.pqp.app.R
import gg.pqp.app.account.AccountDeletion
import gg.pqp.app.account.AccountDeletionBlocked
import gg.pqp.app.account.BlockingOwnedServer
import gg.pqp.app.account.deleteMyAccount
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.SessionStore
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.launch

/**
 * The confirmation itself.
 *
 * Deliberately not an `AlertDialog` with a Delete button, and deliberately not
 * one tap. The user has to read what goes and what stays, and then type their
 * own tag, which `AccountDeletion.confirmationMatches` checks with the same rule
 * the server refuses on, so the button being enabled and the request being
 * accepted can never disagree.
 *
 * IT STATES WHAT SURVIVES as plainly as what is destroyed. A deletion screen
 * that lists only what disappears is quietly misleading: audit entries, bans
 * this account issued, and reports filed about it all remain, and somebody
 * deleting their account specifically to erase a moderation record deserves to
 * learn that here rather than afterwards.
 *
 * Neither the back gesture nor a tap outside dismisses it. This is the one
 * screen in the app whose next action cannot be undone, so leaving it is an
 * explicit button.
 *
 * ## What the design pass changed, and what it deliberately did not
 *
 * The rules between the sections are gone. This is one long read on one
 * surface, and a divider means two *kinds* of surface meet; the section
 * headings and the space above them do the separating. The two buttons at the
 * end now carry the same weight as each other, because the previous pairing put
 * the irreversible action in a filled button and the safe one in a text button,
 * which is the layout of a dialog that would rather you deleted your account.
 *
 * The confirmation phrase, the rule that matches it and every string are
 * untouched. `AccountDeletionTest` covers that rule and the server refuses on
 * the same one.
 */
@Composable
fun DeleteAccountDialog(
    session: SessionStore,
    tag: String?,
    onDismiss: () -> Unit,
    onDeleted: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var typed by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var blocking by remember { mutableStateOf<List<BlockingOwnedServer>>(emptyList()) }

    val expected = AccountDeletion.expectedConfirmation(tag)
    val confirmed = AccountDeletion.confirmationMatches(typed, tag)

    Dialog(
        onDismissRequest = { if (!busy) onDismiss() },
        properties = DialogProperties(
            dismissOnBackPress = false,
            dismissOnClickOutside = false,
            usePlatformDefaultWidth = false,
        ),
    ) {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = Spacing.gutter, vertical = Spacing.xl),
                verticalArrangement = Arrangement.spacedBy(Spacing.sm),
            ) {
                Text(
                    text = stringResource(R.string.delete_title),
                    style = MaterialTheme.typography.headlineMedium,
                )
                Text(
                    text = stringResource(R.string.delete_intro),
                    style = MaterialTheme.typography.bodyLarge,
                )

                SectionHeading(stringResource(R.string.delete_removed_title))
                Bullet(stringResource(R.string.delete_removed_profile))
                Bullet(stringResource(R.string.delete_removed_messages))
                Bullet(stringResource(R.string.delete_removed_files))
                Bullet(stringResource(R.string.delete_removed_memberships))
                Bullet(stringResource(R.string.delete_removed_signin))
                Bullet(stringResource(R.string.delete_removed_solo_servers))

                SectionHeading(stringResource(R.string.delete_kept_title))
                Bullet(stringResource(R.string.delete_kept_audit))
                Bullet(stringResource(R.string.delete_kept_bans))
                Bullet(stringResource(R.string.delete_kept_reports))
                Text(
                    text = stringResource(R.string.delete_kept_note),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                if (blocking.isNotEmpty()) {
                    SectionHeading(stringResource(R.string.delete_blocking_title))
                    blocking.forEach { server ->
                        Column {
                            Text(server.name, style = MaterialTheme.typography.titleSmall)
                            Text(
                                text = pluralStringResource(
                                    R.plurals.delete_blocking_members,
                                    server.otherMemberCount,
                                    server.otherMemberCount,
                                ),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    Text(
                        text = stringResource(R.string.delete_blocking_note),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                SectionHeading(stringResource(R.string.delete_confirm_title))
                // A value to copy, not words to read, so it is monospaced,
                // never translated, and set as inline code: the one thing on
                // this screen the loud colour is allowed on, because it is the
                // one thing the reader has to reproduce exactly. The fallback
                // phrase stays English even in Portuguese, because the server
                // compares against that exact string.
                Surface(
                    color = MaterialTheme.colorScheme.surfaceContainerHigh,
                    shape = MaterialTheme.shapes.extraSmall,
                ) {
                    Text(
                        text = expected,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(
                            horizontal = Spacing.sm,
                            vertical = Spacing.xs,
                        ),
                    )
                }
                OutlinedTextField(
                    value = typed,
                    onValueChange = { typed = it },
                    singleLine = true,
                    enabled = !busy,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )

                error?.let {
                    Text(
                        text = it,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                    )
                }

                Spacer(Modifier.height(Spacing.sm))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(Spacing.md),
                ) {
                    OutlinedButton(
                        onClick = onDismiss,
                        enabled = !busy,
                        shape = MaterialTheme.shapes.small,
                        modifier = Modifier
                            .weight(1f)
                            .height(52.dp),
                    ) {
                        Text(stringResource(R.string.delete_keep))
                    }
                    Button(
                        onClick = {
                            if (!confirmed || busy) return@Button
                            scope.launch {
                                busy = true
                                error = null
                                blocking = emptyList()
                                try {
                                    session.api.deleteMyAccount(typed)
                                    onDeleted()
                                } catch (refusal: AccountDeletionBlocked) {
                                    // Not an error message: a list of things to
                                    // go and do, each with two remedies, which
                                    // the section above renders by name.
                                    blocking = refusal.servers
                                    error = refusal.serverMessage
                                } catch (cancelled: kotlinx.coroutines.CancellationException) {
                                    throw cancelled
                                } catch (failure: Throwable) {
                                    error = (failure as? ApiException)?.serverMessage
                                        ?: failure.message
                                }
                                busy = false
                            }
                        },
                        enabled = confirmed && !busy,
                        shape = MaterialTheme.shapes.small,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                            contentColor = MaterialTheme.colorScheme.onError,
                        ),
                        modifier = Modifier
                            .weight(1f)
                            .height(52.dp),
                    ) {
                        Text(
                            stringResource(
                                if (busy) R.string.delete_working else R.string.delete_confirm,
                            ),
                        )
                    }
                }
            }
        }
    }
}

/**
 * A heading inside the read.
 *
 * It carries its own space above rather than a rule, which is what turns the
 * dialog back into a document. `Arrangement.spacedBy` already puts 8dp between
 * everything, so this adds the rest of the 24dp the section rule asks for.
 */
@Composable
private fun SectionHeading(text: String) {
    Spacer(Modifier.height(Spacing.lg))
    Text(
        text = text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/**
 * A bullet with a real hanging indent.
 *
 * The old one prefixed the string with a bullet character, so a line that
 * wrapped came back to the left margin and the list stopped looking like a
 * list. The dot is its own box now and the text is a column beside it.
 */
@Composable
private fun Bullet(text: String) {
    Row(verticalAlignment = Alignment.Top) {
        Box(
            modifier = Modifier
                .padding(top = 8.dp)
                .size(4.dp)
                .background(MaterialTheme.colorScheme.onSurfaceVariant, CircleShape),
        )
        Spacer(Modifier.width(Spacing.md))
        Text(text = text, style = MaterialTheme.typography.bodyMedium)
    }
}
