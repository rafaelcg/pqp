package gg.pqp.app.communities.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.widget.Toast
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.communities.CommunityAccess
import gg.pqp.app.communities.CommunityAccess.Change
import gg.pqp.app.communities.CommunityAccess.Edit
import gg.pqp.app.communities.CommunityAccess.Refusal
import gg.pqp.app.communities.CommunityAccess.Visibility
import gg.pqp.app.communities.CommunitySettings
import gg.pqp.app.communities.communitySettings
import gg.pqp.app.communities.updateCommunity
import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.Backend
import gg.pqp.app.core.ServerSummary
import gg.pqp.app.social.ui.pqpSheetShape
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Who can walk into this server without being invited, and the two switches
 * that decide it.
 *
 * The Android half of the web's `CommunitySettingsSection`, on the same two
 * routes. The web edits the pitch (tagline, about, links, picture) in the same
 * panel; those stay on the web and this sheet is only about the door.
 *
 * Two things differ from the web on purpose:
 *
 *  - EACH SWITCH SAVES WHEN IT IS TAPPED, with no Save button underneath. A
 *    phone has no "dirty form" to be careful with, and a switch that looks on
 *    but has not been sent is how a server ends up public (or not) against what
 *    the screen said.
 *  - TURNING A DOOR ON ASKS FIRST, in words, because that is the direction that
 *    lets strangers in and it was one unexplained tick on the web. Turning one
 *    off asks nothing.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CommunitySheet(
    api: ApiClient,
    server: ServerSummary,
    onChanged: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val isOwner = server.role == "owner"

    var settings by remember { mutableStateOf<CommunitySettings?>(null) }
    var loadFailure by remember { mutableStateOf<Refusal?>(null) }
    var busy by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf<Change?>(null) }
    var refusal by remember { mutableStateOf<Refusal?>(null) }
    var retry by remember { mutableStateOf<Change?>(null) }
    var slug by remember { mutableStateOf("") }
    var reload by remember { mutableStateOf(0) }

    fun refuse(error: Throwable): Refusal =
        if (error is ApiException) {
            CommunityAccess.refusal(error.status, error.serverMessage)
        } else {
            Refusal.Other(null)
        }

    LaunchedEffect(server.id, reload) {
        loadFailure = null
        try {
            settings = api.communitySettings(server.id)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            loadFailure = refuse(e)
        }
    }

    fun run(change: Change) {
        busy = true
        refusal = null
        scope.launch {
            try {
                val saved = api.updateCommunity(server.id, change.wire(CommunityAccess.cleanSlug(slug)))
                settings = saved
                retry = null
                slug = ""
                onChanged()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val why = refuse(e)
                refusal = why
                // The address is the one refusal the person can fix on the spot.
                retry = if (CommunityAccess.isAddressRefusal(why)) change else null
            }
            busy = false
        }
    }

    fun request(change: Change) {
        if (CommunityAccess.needsConfirmation(change)) pending = change else run(change)
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        shape = pqpSheetShape(),
        containerColor = MaterialTheme.colorScheme.surfaceContainer,
        dragHandle = { BottomSheetDefaults.DragHandle(color = MaterialTheme.colorScheme.onSurfaceVariant) },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .verticalScroll(rememberScrollState())
                .padding(bottom = Spacing.xl)
                .testTag("community.sheet")
                .animateContentSize(),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.xs),
            ) {
                Icon(
                    imageVector = PqpIcons.Public,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(Sizes.iconAction),
                )
                Spacer(Modifier.width(Spacing.sm))
                Text(
                    text = stringResource(R.string.community_sheet_title),
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
            Text(
                text = server.name,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = Spacing.gutter),
            )

            val current = settings
            when {
                loadFailure != null -> LoadFailure(
                    failure = loadFailure!!,
                    onRetry = { reload++ },
                )

                current == null -> Row(
                    modifier = Modifier.fillMaxWidth().padding(Spacing.gutter),
                    horizontalArrangement = Arrangement.Center,
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(Sizes.iconInline),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                else -> Body(
                    settings = current,
                    isOwner = isOwner,
                    busy = busy,
                    refusal = refusal,
                    showSlug = retry != null,
                    slug = slug,
                    onSlug = { slug = it },
                    onRetrySlug = { retry?.let(::run) },
                    onToggleAddress = { on -> request(if (on) Change.AddressOn else Change.AddressOff) },
                    onToggleListing = { on -> request(if (on) Change.ListingOn else Change.ListingOff) },
                    onCopy = { current.slug?.let { copyAddress(context, it) } },
                )
            }
        }
    }

    pending?.let { change ->
        ConfirmOpen(
            change = change,
            serverName = server.name,
            onDismiss = { pending = null },
            onConfirm = {
                pending = null
                run(change)
            },
        )
    }
}

@Composable
private fun LoadFailure(failure: Refusal, onRetry: () -> Unit) {
    val text = when (failure) {
        is Refusal.Forbidden -> stringResource(R.string.community_no_access)
        Refusal.Unavailable -> stringResource(R.string.community_unavailable)
        else -> stringResource(R.string.community_load_failed)
    }
    Column(Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.md)) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (failure is Refusal.Other) {
            TextButton(onClick = onRetry) { Text(stringResource(R.string.community_try_again)) }
        }
    }
}

@Composable
private fun Body(
    settings: CommunitySettings,
    isOwner: Boolean,
    busy: Boolean,
    refusal: Refusal?,
    showSlug: Boolean,
    slug: String,
    onSlug: (String) -> Unit,
    onRetrySlug: () -> Unit,
    onToggleAddress: (Boolean) -> Unit,
    onToggleListing: (Boolean) -> Unit,
    onCopy: () -> Unit,
) {
    val visibility = CommunityAccess.visibility(settings)
    val addressEdit = CommunityAccess.addressEdit(isOwner, settings)
    val listingEdit = CommunityAccess.listingEdit(isOwner, settings)
    val appUrl = Backend.appUrl

    StateCard(visibility)

    if (settings.suspended) {
        Text(
            text = stringResource(R.string.community_suspended),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.xs),
        )
    }

    SwitchRow(
        title = stringResource(R.string.community_address_title),
        hint = stringResource(R.string.community_address_hint),
        note = if (addressEdit == Edit.LockedByListing) stringResource(R.string.community_address_locked) else null,
        checked = settings.isCommunity,
        enabled = !busy && addressEdit == Edit.Allowed,
        onChange = onToggleAddress,
        tag = "community.address",
    )

    val address = settings.slug
    if (settings.isCommunity && address != null) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(start = Spacing.gutter, end = Spacing.xs),
        ) {
            Text(
                text = CommunityAccess.displayAddress(address, appUrl),
                style = MaterialTheme.typography.titleSmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).testTag("community.address.url"),
            )
            TextButton(onClick = onCopy, modifier = Modifier.testTag("community.copy")) {
                Text(stringResource(R.string.community_copy_link))
            }
        }
    }

    SwitchRow(
        title = stringResource(R.string.community_directory_title),
        hint = stringResource(R.string.community_directory_hint),
        note = when (listingEdit) {
            Edit.OwnerOnly -> stringResource(R.string.community_directory_owner_only)
            Edit.NeedsAddress -> stringResource(R.string.community_directory_needs_address)
            else -> null
        },
        checked = settings.listed,
        enabled = !busy && listingEdit == Edit.Allowed,
        onChange = onToggleListing,
        tag = "community.directory",
    )

    AnimatedVisibility(visible = showSlug, enter = fadeIn(), exit = fadeOut()) {
        Row(
            verticalAlignment = Alignment.Top,
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
        ) {
            OutlinedTextField(
                value = slug,
                onValueChange = onSlug,
                singleLine = true,
                label = { Text(stringResource(R.string.community_slug_label)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.weight(1f).testTag("community.slug"),
            )
            Spacer(Modifier.width(Spacing.sm))
            Button(
                onClick = onRetrySlug,
                enabled = !busy && slug.isNotBlank(),
                modifier = Modifier.padding(top = Spacing.xs).testTag("community.slug.retry"),
            ) { Text(stringResource(R.string.community_try_again)) }
        }
    }

    refusal?.let { why ->
        Text(
            text = refusalText(why),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier
                .padding(horizontal = Spacing.gutter, vertical = Spacing.xs)
                .testTag("community.refusal"),
        )
    }

    Text(
        text = stringResource(R.string.community_moderation),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.md),
    )
}

@Composable
private fun refusalText(refusal: Refusal): String = when (refusal) {
    Refusal.SlugTaken -> stringResource(R.string.community_slug_taken)
    Refusal.SlugRejected -> stringResource(R.string.community_slug_rejected)
    Refusal.NeedsAddress -> stringResource(R.string.community_directory_needs_address)
    Refusal.Unavailable -> stringResource(R.string.community_unavailable)
    // The server says which of its two reasons applies; its own sentence is the
    // accurate one, a local guess about roles is not.
    is Refusal.Forbidden -> refusal.message ?: stringResource(R.string.community_no_access)
    is Refusal.Other -> refusal.message ?: stringResource(R.string.community_save_failed)
}

/** The plain-words state: Private, Public link, or In the directory. */
@Composable
private fun StateCard(visibility: Visibility) {
    val (title, body, icon) = when (visibility) {
        Visibility.Private -> Triple(
            R.string.community_state_private,
            R.string.community_state_private_body,
            PqpIcons.Lock,
        )
        Visibility.PublicLink -> Triple(
            R.string.community_state_public,
            R.string.community_state_public_body,
            PqpIcons.Link,
        )
        Visibility.Listed -> Triple(
            R.string.community_state_listed,
            R.string.community_state_listed_body,
            PqpIcons.Public,
        )
    }
    val open = visibility != Visibility.Private
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.gutter, vertical = Spacing.md)
            .testTag("community.state"),
    ) {
        Row(
            verticalAlignment = Alignment.Top,
            modifier = Modifier.padding(Spacing.md),
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = if (open) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(Sizes.iconAction),
            )
            Spacer(Modifier.width(Spacing.md))
            Column {
                Text(
                    text = stringResource(title),
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = stringResource(body),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** One switch: the row is the control, the switch only draws its state. */
@Composable
private fun SwitchRow(
    title: String,
    hint: String,
    note: String?,
    checked: Boolean,
    enabled: Boolean,
    onChange: (Boolean) -> Unit,
    tag: String,
) {
    Column(Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.xs)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .toggleable(
                    value = checked,
                    enabled = enabled,
                    role = Role.Switch,
                    onValueChange = onChange,
                )
                .padding(vertical = Spacing.sm)
                .testTag(tag),
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = hint,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.width(Spacing.md))
            Switch(checked = checked, onCheckedChange = null, enabled = enabled)
        }
        if (note != null) {
            Text(
                text = note,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** The warning before a door opens. Plain about what strangers get. */
@Composable
private fun ConfirmOpen(
    change: Change,
    serverName: String,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    val address = change == Change.AddressOn
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                stringResource(
                    if (address) R.string.community_confirm_address_title else R.string.community_confirm_directory_title,
                    serverName,
                ),
            )
        },
        text = {
            Text(
                stringResource(
                    if (address) R.string.community_confirm_address_body else R.string.community_confirm_directory_body,
                ),
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.testTag("community.confirm")) {
                Text(
                    stringResource(
                        if (address) R.string.community_confirm_address_action else R.string.community_confirm_directory_action,
                    ),
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.testTag("community.cancel")) {
                Text(stringResource(R.string.cancel))
            }
        },
    )
}

private fun copyAddress(context: Context, slug: String) {
    val link = CommunityAccess.addressLink(slug, Backend.appUrl)
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("pqp community", link))
    // Android 13+ draws its own "Copied" overlay; a toast on top of it is two
    // confirmations for one tap.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        Toast.makeText(context, R.string.invite_copied, Toast.LENGTH_SHORT).show()
    }
}
