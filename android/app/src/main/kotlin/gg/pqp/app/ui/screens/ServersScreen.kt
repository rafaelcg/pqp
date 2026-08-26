package gg.pqp.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberTopAppBarState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.core.ServerSummary
import gg.pqp.app.core.SessionStore
import gg.pqp.app.reports.ReportDraft
import gg.pqp.app.reports.ReportTarget
import gg.pqp.app.reports.ui.ReportSheet
import gg.pqp.app.ui.components.Avatar
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServersScreen(
    session: SessionStore,
    onOpenServer: (ServerSummary) -> Unit,
    onOpenProfile: () -> Unit,
) {
    val servers by session.servers.collectAsStateWithLifecycle()
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())
    val snackbars = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    var refreshing by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    var leaving by remember { mutableStateOf<ServerSummary?>(null) }
    var deleting by remember { mutableStateOf<ServerSummary?>(null) }
    var reporting by remember { mutableStateOf<ServerSummary?>(null) }

    // A refusal is the server's sentence, verbatim. Only it knows whether a
    // delete was refused because the caller is no longer the owner, or a leave
    // because they are. The fallback is used only when it said nothing at all.
    val fallback = stringResource(R.string.error_network)
    val refused: (String) -> Unit = { message ->
        scope.launch { snackbars.showSnackbar(message.ifBlank { fallback }) }
    }

    LaunchedEffect(Unit) { session.refreshServers() }

    Scaffold(
        modifier = Modifier
            .fillMaxSize()
            .nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            LargeTopAppBar(
                title = { Text(stringResource(R.string.servers_title)) },
                actions = {
                    IconButton(onClick = onOpenProfile) {
                        Icon(Icons.Filled.Person, contentDescription = stringResource(R.string.you_title))
                    }
                },
                scrollBehavior = scrollBehavior,
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { creating = true },
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text(stringResource(R.string.servers_create)) },
            )
        },
        snackbarHost = { SnackbarHost(snackbars) },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                session.refreshServers()
                scope.launch {
                    // The store has no "finished" signal to wait on, and a
                    // spinner that never stops is worse than one that stops
                    // early. Kept short because the list is unpaginated.
                    delay(600)
                    refreshing = false
                }
            },
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            if (servers.isEmpty()) {
                EmptyState(stringResource(R.string.servers_empty))
            } else {
                LazyColumn(
                    contentPadding = PaddingValues(bottom = 96.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(servers, key = { it.id }) { server ->
                        ServerRow(
                            server = server,
                            onClick = { onOpenServer(server) },
                            onLeave = { leaving = server },
                            onDelete = { deleting = server },
                            onReport = { reporting = server },
                        )
                    }
                }
            }
        }
    }

    if (creating) {
        CreateServerDialog(
            onDismiss = { creating = false },
            onCreate = { name ->
                creating = false
                session.createServer(name) { message ->
                    scope.launch { snackbars.showSnackbar(message.ifBlank { "" }) }
                }
            },
        )
    }

    leaving?.let { server ->
        LeaveServerDialog(
            server = server,
            onDismiss = { leaving = null },
            onConfirm = {
                leaving = null
                session.leaveServer(server.id, refused)
            },
        )
    }

    reporting?.let { server ->
        ReportSheet(
            api = session.api,
            target = ReportTarget.Community(serverId = server.id, name = server.name),
            onDismiss = { reporting = null },
        )
    }

    deleting?.let { server ->
        DeleteServerDialog(
            server = server,
            onDismiss = { deleting = null },
            onConfirm = {
                deleting = null
                session.deleteServer(server.id, refused)
            },
        )
    }
}

/**
 * What a member can do to a community from the list, as values.
 *
 * Split out from the composables so the one rule with an edge to get wrong is
 * testable: the typed name is compared the way `AccountDeletion` compares a
 * typed tag, trimmed and case-insensitively, because the requirement is
 * deliberate intent rather than typing accuracy.
 */
object ServerActions {

    const val OWNER_ROLE = "owner"

    /**
     * A missing role is treated as *not* owner, so the row offers Leave. If
     * that turns out to be wrong the server refuses it in its own words, which
     * is better than offering a destructive action on a guess.
     */
    fun isOwner(role: String?): Boolean = role == OWNER_ROLE

    fun deleteConfirmationMatches(typed: String, name: String): Boolean =
        typed.trim().lowercase() == name.trim().lowercase()
}

/**
 * A community, and the two things that can be done to it.
 *
 * The overflow menu is not decoration. `DELETE /api/me` refuses while the
 * account still owns a community somebody else is in, and told people to go to
 * that community's settings, which this app does not have. This is where an
 * Android user actually unblocks their own account deletion.
 */
@Composable
private fun ServerRow(
    server: ServerSummary,
    onClick: () -> Unit,
    onLeave: () -> Unit,
    onDelete: () -> Unit,
    onReport: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Squircle rather than a circle: a server is a place, a person is a
        // circle, and Material draws the distinction the same way.
        Avatar(name = server.name, url = server.iconUrl, size = 48.dp, cornerRadius = 16.dp)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(server.name, style = MaterialTheme.typography.titleMedium)
            server.role?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Box {
            IconButton(onClick = { menuOpen = true }) {
                Icon(
                    Icons.Filled.MoreVert,
                    contentDescription = stringResource(R.string.server_actions),
                )
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                if (ServerActions.isOwner(server.role)) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.server_delete)) },
                        onClick = {
                            menuOpen = false
                            onDelete()
                        },
                    )
                } else {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.server_leave)) },
                        onClick = {
                            menuOpen = false
                            onLeave()
                        },
                    )
                }
                // Only a listed community can be reported: the route answers
                // 404 for anything else, and an item that can only ever fail is
                // worse than no item. See ReportDraft.canReportCommunity.
                if (ReportDraft.canReportCommunity(server.isCommunity)) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.report_action)) },
                        onClick = {
                            menuOpen = false
                            onReport()
                        },
                    )
                }
            }
        }
    }
}

/**
 * Leaving is reversible with a new invite and destroys nothing, so it is a
 * plain confirmation rather than a typed one.
 */
@Composable
private fun LeaveServerDialog(
    server: ServerSummary,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.server_leave_title, server.name)) },
        text = { Text(stringResource(R.string.server_leave_body)) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(stringResource(R.string.server_leave_confirm))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
        },
    )
}

/**
 * Deleting is not, so it asks for the community's name to be typed, the same
 * way `DeleteAccountDialog` asks for a tag: it says what goes before it asks,
 * prints the name as a value to copy rather than a sentence to read, and keeps
 * the destructive button dark until the typed name matches.
 */
@Composable
private fun DeleteServerDialog(
    server: ServerSummary,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    var typed by remember { mutableStateOf("") }
    val confirmed = ServerActions.deleteConfirmationMatches(typed, server.name)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.server_delete_title, server.name)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.server_delete_body))
                Text(stringResource(R.string.server_delete_confirm_prompt))
                Text(
                    text = server.name,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.primary,
                )
                OutlinedTextField(
                    value = typed,
                    onValueChange = { typed = it },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                enabled = confirmed,
                colors = ButtonDefaults.textButtonColors(
                    contentColor = MaterialTheme.colorScheme.error,
                ),
            ) {
                Text(stringResource(R.string.server_delete_confirm))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
        },
    )
}

@Composable
private fun CreateServerDialog(onDismiss: () -> Unit, onCreate: (String) -> Unit) {
    var name by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.servers_create)) },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.take(100) },
                label = { Text(stringResource(R.string.servers_create_name)) },
                singleLine = true,
            )
        },
        confirmButton = {
            TextButton(
                onClick = { onCreate(name.trim()) },
                enabled = name.isNotBlank(),
            ) {
                Text(stringResource(R.string.servers_create_confirm))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
        },
    )
}

@Composable
fun EmptyState(text: String) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
fun FailedScreen(reason: String, onRetry: (() -> Unit)?) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = reason.ifBlank { stringResource(R.string.error_network) },
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
        )
        if (onRetry != null) {
            Spacer(Modifier.height(16.dp))
            TextButton(onClick = onRetry) { Text(stringResource(R.string.connection_retry)) }
        }
    }
}
