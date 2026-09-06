package gg.pqp.app.invites.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.Invite
import gg.pqp.app.core.ServerSummary
import gg.pqp.app.invites.InviteLinks
import gg.pqp.app.social.ui.pqpSheetShape
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.launch

/**
 * Invite people to a community: the live links, one button to make another,
 * and copy / share / revoke on each row.
 *
 * The Android half of `client/src/components/layout/invite-panel.tsx`, on the
 * same three routes. Two things decide its shape:
 *
 *  - Listing needs MANAGE_SERVER and creating only needs CREATE_INVITE, which
 *    every member has by default. So a plain member opens this to an empty
 *    list and a working button, and the 403 from the list is swallowed rather
 *    than shown: it is not an error, it is the role.
 *  - Sharing goes through the system sheet (`Intent.ACTION_SEND`), not a
 *    bespoke picker. Where the link goes is the phone's business; what this
 *    app owns is that the link is the web's link, so the receiver's tap lands
 *    in whichever client they have. `InviteLinks` and its test pin that.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InviteSheet(
    api: ApiClient,
    server: ServerSummary,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    var invites by remember { mutableStateOf<List<Invite>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var creating by remember { mutableStateOf(false) }
    var revoking by remember { mutableStateOf<String?>(null) }
    var refusal by remember { mutableStateOf<String?>(null) }

    val fallback = stringResource(R.string.error_network)
    fun sentence(error: Throwable): String =
        ((error as? ApiException)?.serverMessage ?: error.message).orEmpty().ifBlank { fallback }

    LaunchedEffect(server.id) {
        loading = true
        val now = System.currentTimeMillis()
        invites = runCatching { api.invites(server.id) }
            // 403 is "you are a member, not a manager"; there is nothing to
            // list and nothing to say. Any other failure is worth its sentence.
            .onFailure { if ((it as? ApiException)?.status != 403) refusal = sentence(it) }
            .getOrDefault(emptyList())
            .filter { InviteLinks.isLive(it, now) }
        loading = false
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        shape = pqpSheetShape(),
        containerColor = MaterialTheme.colorScheme.surfaceContainer,
        dragHandle = {
            BottomSheetDefaults.DragHandle(color = MaterialTheme.colorScheme.onSurfaceVariant)
        },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(bottom = Spacing.xl),
        ) {
            Text(
                text = stringResource(R.string.invite_people),
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.xs),
            )
            Text(
                text = stringResource(R.string.invite_sheet_body, server.name),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = Spacing.gutter),
            )

            Button(
                onClick = {
                    creating = true
                    refusal = null
                    scope.launch {
                        runCatching { api.createInvite(server.id) }
                            .onSuccess { made ->
                                invites = listOf(made) + invites.filterNot { it.id == made.id }
                            }
                            .onFailure { refusal = sentence(it) }
                        creating = false
                    }
                },
                enabled = !creating,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Spacing.gutter, vertical = Spacing.md),
            ) {
                if (creating) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(Sizes.iconInline),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                } else {
                    Text(stringResource(R.string.invite_create_action))
                }
            }

            refusal?.let { message ->
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.xs),
                )
            }

            when {
                loading -> Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(Spacing.gutter),
                    horizontalArrangement = Arrangement.Center,
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(Sizes.iconInline),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                invites.isEmpty() -> Text(
                    text = stringResource(R.string.invite_none),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.md),
                )

                else -> LazyColumn(
                    contentPadding = PaddingValues(bottom = Spacing.md),
                    modifier = Modifier.heightIn(max = 420.dp),
                ) {
                    items(invites, key = { it.id }) { invite ->
                        InviteRow(
                            invite = invite,
                            busy = revoking == invite.id,
                            onCopy = { copyLink(context, invite) },
                            onShare = { shareLink(context, invite, server.name) },
                            onRevoke = {
                                revoking = invite.id
                                scope.launch {
                                    runCatching { api.deleteInvite(server.id, invite.id) }
                                        .onSuccess { invites = invites.filterNot { it.id == invite.id } }
                                        .onFailure { refusal = sentence(it) }
                                    revoking = null
                                }
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun InviteRow(
    invite: Invite,
    busy: Boolean,
    onCopy: () -> Unit,
    onShare: () -> Unit,
    onRevoke: () -> Unit,
) {
    val hoursLeft = remember(invite) { InviteLinks.hoursLeft(invite, System.currentTimeMillis()) }
    val expiry = when {
        hoursLeft == null -> stringResource(R.string.invite_expiry_never)
        hoursLeft < 1L -> stringResource(R.string.invite_expiry_soon)
        hoursLeft < 48L -> pluralStringResource(R.plurals.invite_expiry_hours, hoursLeft.toInt(), hoursLeft.toInt())
        else -> pluralStringResource(R.plurals.invite_expiry_days, (hoursLeft / 24).toInt(), (hoursLeft / 24).toInt())
    }
    val uses = invite.maxUses?.let { max ->
        stringResource(R.string.invite_uses_of, invite.uses, max)
    } ?: pluralStringResource(R.plurals.invite_uses, invite.uses, invite.uses)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
    ) {
        Text(
            text = invite.code,
            style = MaterialTheme.typography.titleMedium,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = "$uses · $expiry",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = onCopy) { Text(stringResource(R.string.invite_copy)) }
            TextButton(onClick = onShare) { Text(stringResource(R.string.invite_share)) }
            Spacer(Modifier.weight(1f))
            if (busy) {
                CircularProgressIndicator(
                    modifier = Modifier.size(Sizes.iconInline),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                // Offered to everyone and refused by the server for a plain
                // member (MANAGE_SERVER), in its own words. A member who can
                // see this row at all made it themselves this session, and
                // hiding the button on a local guess about roles would be a
                // second permission model that can only disagree with the
                // first.
                TextButton(onClick = onRevoke) { Text(stringResource(R.string.invite_revoke)) }
            }
        }
    }
}

private fun copyLink(context: Context, invite: Invite) {
    val link = InviteLinks.link(invite) ?: return
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("pqp invite", link))
    // Android 13+ draws its own "Copied" overlay; a toast on top of it is two
    // confirmations for one tap.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        Toast.makeText(context, R.string.invite_copied, Toast.LENGTH_SHORT).show()
    }
}

private fun shareLink(context: Context, invite: Invite, serverName: String) {
    val link = InviteLinks.link(invite) ?: return
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, context.getString(R.string.invite_share_text, serverName, link))
        putExtra(Intent.EXTRA_SUBJECT, context.getString(R.string.invite_share_subject, serverName))
    }
    context.startActivity(Intent.createChooser(send, context.getString(R.string.invite_share)))
}
