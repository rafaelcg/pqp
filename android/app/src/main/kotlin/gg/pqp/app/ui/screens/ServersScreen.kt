package gg.pqp.app.ui.screens

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.bau.BauBadge
import gg.pqp.app.bau.CommunityHomeConfig
import gg.pqp.app.bau.CommunityHomeConfigs
import gg.pqp.app.bau.bauUnreadAll
import gg.pqp.app.communities.CommunitiesConfigs
import gg.pqp.app.communities.CommunityAccess
import gg.pqp.app.communities.ui.CommunitySheet
import gg.pqp.app.communities.ui.PublicBadge
import gg.pqp.app.core.IdempotencyAttempt
import gg.pqp.app.core.ServerSummary
import gg.pqp.app.core.SessionStore
import gg.pqp.app.invites.ui.InviteSheet
import gg.pqp.app.reports.ReportDraft
import gg.pqp.app.reports.ReportTarget
import gg.pqp.app.reports.ui.ReportSheet
import gg.pqp.app.social.ui.CountBadge
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.components.ChromeDivider
import gg.pqp.app.ui.components.EmptyState
import gg.pqp.app.ui.components.pqpLargeTopBarColors
import gg.pqp.app.ui.theme.Motion
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServersScreen(
    session: SessionStore,
    onOpenServer: (ServerSummary) -> Unit,
    onOpenProfile: (() -> Unit)?,
) {
    val servers by session.servers.collectAsStateWithLifecycle()
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())
    val snackbars = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    var refreshing by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    // One key per create attempt, reused across a retry of the same name so
    // a lost response never makes a second room. Scoped to the screen, not
    // the dialog, so it survives the dialog closing on submit (see the
    // create call below) and still catches the person reopening it and
    // retyping the same name.
    val createAttempt = remember { IdempotencyAttempt() }
    var leaving by remember { mutableStateOf<ServerSummary?>(null) }
    var deleting by remember { mutableStateOf<ServerSummary?>(null) }
    var reporting by remember { mutableStateOf<ServerSummary?>(null) }
    var inviting by remember { mutableStateOf<ServerSummary?>(null) }
    var publicAccess by remember { mutableStateOf<ServerSummary?>(null) }

    // Public access (the address and the directory) exists only while the
    // instance has communities on, asked once per session, off on any failure.
    // It gates both the menu item and the "Público" mark: with communities off
    // the address answers 404 and the mark would be a lie.
    var communitiesOn by remember { mutableStateOf(false) }
    LaunchedEffect(session) { communitiesOn = CommunitiesConfigs.resolve(session.api).enabled }

    // A refusal is the server's sentence, verbatim. Only it knows whether a
    // delete was refused because the caller is no longer the owner, or a leave
    // because they are. The fallback is used only when it said nothing at all.
    val fallback = stringResource(R.string.error_network)
    val refused: (String) -> Unit = { message ->
        scope.launch { snackbars.showSnackbar(message.ifBlank { fallback }) }
    }

    LaunchedEffect(Unit) { session.refreshServers() }

    // Unread Baú posts per server, for the lime badge on each icon. Two yeses
    // as everywhere else: the instance flag (asked once per session, off on any
    // failure) and then one read for all servers rather than one per row. Asked
    // again on every resume, because the moment it is most wrong is coming back
    // from the Baú, which stamped itself read while this screen sat behind it.
    // A failed read keeps what is on screen: a badge one behind beats one that
    // flickers away.
    var communityHome by remember { mutableStateOf(CommunityHomeConfig()) }
    LaunchedEffect(session) { communityHome = CommunityHomeConfigs.resolve(session.api) }
    var bauUnread by remember { mutableStateOf<Map<String, Int>>(emptyMap()) }
    LifecycleResumeEffect(communityHome.enabled) {
        // Tied to this resume: a slow read that outlives it must not land after
        // a newer one (or after the Baú stamped itself read) and put stale
        // counts back, so pausing cancels it.
        val read = if (communityHome.enabled) {
            scope.launch {
                runCatching { session.api.bauUnreadAll() }.onSuccess { bauUnread = it }
            }
        } else {
            null
        }
        onPauseOrDispose { read?.cancel() }
    }

    // Unread channel messages per server: read when the list comes to the front
    // (at most every thirty seconds, and at once for a server whose channel was
    // just read), and kept right between reads by live frames.
    val unreadStore = remember(session) { gg.pqp.app.unread.ServerUnreadStore.of(session) }
    val channelUnread by unreadStore.unread.collectAsStateWithLifecycle()
    LifecycleResumeEffect(servers) {
        unreadStore.hydrate(servers)
        onPauseOrDispose { }
    }

    Scaffold(
        modifier = Modifier
            .fillMaxSize()
            .nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            // The bar and its hairline are one piece of chrome, so they are one
            // slot. The rule is drawn always rather than only once the list has
            // scrolled: it is what says "the bar is the frame and the list is
            // the page", and a line that appears halfway through a scroll reads
            // as a shadow arriving late.
            Column {
                LargeTopAppBar(
                    title = {
                        // Material renders this slot twice, once in each row of
                        // a large bar, and crossfades between them. It cannot be
                        // given two type styles, so the style is chosen from how
                        // far the bar has collapsed: Gabarito at 30sp while the
                        // bar is a headline, at 19sp once it is a label above a
                        // list.
                        val collapsed = scrollBehavior.state.collapsedFraction > 0.5f
                        Text(
                            text = stringResource(R.string.servers_title),
                            style = if (collapsed) {
                                MaterialTheme.typography.titleLarge
                            } else {
                                MaterialTheme.typography.headlineLarge
                            },
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    actions = {
                        // Null on the Conversas phone tabs, where "Tu" is a tab
                        // of its own and a second door to it is noise.
                        if (onOpenProfile != null) {
                            IconButton(onClick = onOpenProfile) {
                                Icon(
                                    imageVector = PqpIcons.Person,
                                    contentDescription = stringResource(R.string.you_open),
                                    modifier = Modifier.size(Sizes.iconAction),
                                )
                            }
                        }
                    },
                    colors = pqpLargeTopBarColors(),
                    // Material's large bar is 152dp expanded, which is a
                    // two-line hero for a title that is one short word. At 124
                    // the headline still has room to breathe above the list and
                    // the first two servers are on screen at rest instead of
                    // one. The collapse behaviour is untouched; only the height
                    // it collapses from moves. The number lives in `Sizes`
                    // because the two sibling tabs have to agree with it.
                    expandedHeight = Sizes.largeTopBarExpanded,
                    scrollBehavior = scrollBehavior,
                )
                ChromeDivider()
            }
        },
        floatingActionButton = {
            // The one lime object on this screen, and the reason the rows below
            // are not allowed a second one. `primary` rather than the default
            // `primaryContainer`, which on this palette is `SignalDim` and is
            // reserved for the pressed state of something already lime.
            ExtendedFloatingActionButton(
                onClick = { creating = true },
                icon = {
                    Icon(
                        imageVector = PqpIcons.Add,
                        contentDescription = null,
                        modifier = Modifier.size(Sizes.iconAction),
                    )
                },
                text = { Text(stringResource(R.string.servers_create)) },
                shape = MaterialTheme.shapes.large,
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
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
                EmptyState(stringResource(R.string.servers_empty), icon = PqpIcons.Server)
            } else {
                LazyColumn(
                    contentPadding = PaddingValues(top = Spacing.sm, bottom = 96.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(servers, key = { it.id }) { server ->
                        ServerRow(
                            server = server,
                            unread = channelUnread[server.id] ?: gg.pqp.app.unread.ServerUnreadSummary(),
                            bauUnread = if (communityHome.enabled && server.communityHomeEnabled) {
                                BauBadge.unreadFor(server.id, bauUnread)
                            } else {
                                0
                            },
                            onClick = { onOpenServer(server) },
                            onLeave = { leaving = server },
                            onDelete = { deleting = server },
                            onReport = { reporting = server },
                            onInvite = { inviting = server },
                            communitiesOn = communitiesOn,
                            onPublicAccess = { publicAccess = server },
                            // Null at the ends: an item that does nothing is
                            // worse than no item.
                            onMoveUp = if (servers.firstOrNull()?.id == server.id) {
                                null
                            } else {
                                { session.moveServer(server.id, -1, refused) }
                            },
                            onMoveDown = if (servers.lastOrNull()?.id == server.id) {
                                null
                            } else {
                                { session.moveServer(server.id, 1, refused) }
                            },
                        )
                    }
                }
            }
        }
    }

    inviting?.let { server ->
        InviteSheet(
            api = session.api,
            server = server,
            onDismiss = { inviting = null },
        )
    }

    publicAccess?.let { server ->
        CommunitySheet(
            api = session.api,
            // The live row, so the role the sheet decides on is never stale.
            server = servers.firstOrNull { it.id == server.id } ?: server,
            onChanged = { session.refreshServers() },
            onDismiss = { publicAccess = null },
        )
    }

    if (creating) {
        CreateServerDialog(
            onDismiss = { creating = false },
            onCreate = { name ->
                creating = false
                session.createServer(
                    name = name,
                    idempotencyKey = createAttempt.keyFor(name),
                    onSuccess = { createAttempt.reset() },
                    onError = { message ->
                        scope.launch { snackbars.showSnackbar(message.ifBlank { "" }) }
                    },
                )
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

    /**
     * The list with [id] moved [delta] places, or null when nothing would
     * change (an unknown id, or already at that end). A pure function so the
     * one rule with an edge, the ends, is testable without a screen.
     */
    /**
     * [servers] in the order [ids] names. Ids the list does not hold are
     * ignored; servers [ids] does not name keep their place after the named
     * ones. Only the ORDER changes, so a rollback never touches other fields.
     */
    fun applyOrder(servers: List<ServerSummary>, ids: List<String>): List<ServerSummary> {
        val byId = servers.associateBy { it.id }.toMutableMap()
        val out = ArrayList<ServerSummary>(servers.size)
        for (id in ids) byId.remove(id)?.let { out.add(it) }
        servers.filterTo(out) { byId.containsKey(it.id) }
        return out
    }

    /**
     * What a `server-order-update` frame does to the list, or null when it must
     * change nothing:
     *  - it came from THIS phone (its own echo, named by `origin`);
     *  - a save of this phone's is still in flight (the order on screen is the
     *    newer one, and the save that follows says so on every other device);
     *  - it would not move anything.
     * Servers the frame does not name keep their place after the named ones
     * (a server joined a moment ago), exactly [applyOrder].
     */
    fun followRemoteOrder(
        servers: List<ServerSummary>,
        ids: List<String>,
        origin: String?,
        ownOrigin: String,
        saving: Boolean,
    ): List<ServerSummary>? {
        if (origin == ownOrigin || saving) return null
        val next = applyOrder(servers, ids)
        return if (next.map { it.id } == servers.map { it.id }) null else next
    }

    /**
     * When this phone's saves have all settled: the order of a remote update that was ignored
     * while they were out, if one of them failed (so this phone's order never reached the
     * server and the remote one is the newest). Null when nothing changes.
     */
    fun afterSaves(servers: List<ServerSummary>, ignoredRemote: List<String>?, anySaveFailed: Boolean): List<ServerSummary>? {
        if (ignoredRemote == null || !anySaveFailed) return null
        val next = applyOrder(servers, ignoredRemote)
        return if (next.map { it.id } == servers.map { it.id }) null else next
    }

    fun reordered(servers: List<ServerSummary>, id: String, delta: Int): List<ServerSummary>? {
        val from = servers.indexOfFirst { it.id == id }
        if (from < 0) return null
        val to = (from + delta).coerceIn(0, servers.lastIndex)
        if (to == from) return null
        return servers.toMutableList().apply { add(to, removeAt(from)) }
    }
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
    unread: gg.pqp.app.unread.ServerUnreadSummary,
    bauUnread: Int,
    onClick: () -> Unit,
    onLeave: () -> Unit,
    onDelete: () -> Unit,
    onReport: () -> Unit,
    onInvite: () -> Unit,
    communitiesOn: Boolean,
    onPublicAccess: () -> Unit,
    onMoveUp: (() -> Unit)?,
    onMoveDown: (() -> Unit)?,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val interactions = remember { MutableInteractionSource() }
    val pressed by interactions.collectIsPressedAsState()

    // A row takes its highlight the instant a finger lands and gives it back
    // over 140ms. Fading it in as well makes the whole list feel like it is
    // catching up with the hand.
    val surface by animateColorAsState(
        targetValue = if (pressed) {
            MaterialTheme.colorScheme.surfaceContainerHigh
        } else {
            Color.Transparent
        },
        animationSpec = if (pressed) snap() else tween(Motion.QUICK_MILLIS),
        label = "server-row-press",
    )

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = Sizes.serverRow)
            // Full bleed and square: a server row is one of a continuous stack,
            // not a card, so its press runs edge to edge. The channel list is
            // the screen where a row is a pill, and it is a pill there because
            // it is a sidebar.
            .background(surface)
            .clickable(
                interactionSource = interactions,
                // No ripple: the surface above already is the press, and a
                // ripple on top of it is a second answer to the same touch.
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Squircle rather than a circle: a server is a place, a person is a
        // circle, and Material draws the distinction the same way.
        //
        // The seed is the id, not the name. Two servers called "casa" are two
        // different places and should not be the same colour, and a server that
        // is renamed should not change colour under the people already in it.
        Box {
            Avatar(
                name = server.name,
                url = server.iconUrl,
                size = Sizes.avatarServer,
                cornerRadius = 14.dp,
                seed = server.id,
            )
            // Channel unread, at the icon's other corner (the Baú owns the top one):
            // a lime count when somebody pinged this person, otherwise a dot.
            ServerUnreadMark(
                unread = unread,
                modifier = Modifier.align(Alignment.BottomEnd).offset(x = 4.dp, y = 4.dp),
            )
            // Lime, at the icon's corner: a new Baú post is news for the whole
            // server, and the brand signal is what says so at a glance.
            BauBadge.label(bauUnread)?.let { label ->
                CountBadge(
                    count = bauUnread,
                    loud = true,
                    label = label,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .offset(x = 6.dp, y = (-4).dp)
                        .testTag("servers.bau.unread"),
                )
            }
        }
        Spacer(Modifier.width(Spacing.md))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = server.name,
                    style = MaterialTheme.typography.titleMedium,
                    // Something unread in a channel: the name is bold, the way a channel
                    // row with news is, and the badge on the icon says how much.
                    fontWeight = if (unread.hasUnread) FontWeight.Bold else null,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                // Strangers can walk in: said where the server is named.
                if (communitiesOn && server.isCommunity) {
                    Spacer(Modifier.width(Spacing.sm))
                    PublicBadge()
                }
            }
            server.role?.let { role ->
                val label = when (role) {
                    "owner" -> stringResource(R.string.role_owner)
                    "admin" -> stringResource(R.string.role_admin)
                    "member" -> stringResource(R.string.role_member)
                    // A role this build has not heard of. Showing the wire word
                    // is better than showing nothing, and it is the only case
                    // where an untranslated word can reach the screen.
                    else -> role
                }
                Text(
                    text = label,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Box {
            IconButton(onClick = { menuOpen = true }) {
                Icon(
                    PqpIcons.More,
                    contentDescription = stringResource(R.string.server_actions),
                )
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                // First, because it is the one action here that is not about
                // getting out. Offered to every role: CREATE_INVITE is in the
                // default member permission set, and a server that has taken
                // it away refuses in its own words inside the sheet.
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.invite_people)) },
                    onClick = {
                        menuOpen = false
                        onInvite()
                    },
                )
                // The address and the directory. Owner and admin always hold
                // Manage Server; a member with a cargo that grants it finds the
                // same sheet in the server's own menu.
                if (communitiesOn && CommunityAccess.mayOpenFromRole(server.role)) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.community_menu)) },
                        modifier = Modifier.testTag("servers.publicAccess"),
                        onClick = {
                            menuOpen = false
                            onPublicAccess()
                        },
                    )
                }
                // Reorder this account's own list (a drag is not reachable by
                // TalkBack, and a menu is what the phone channel list uses).
                onMoveUp?.let { move ->
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.server_move_up)) },
                        onClick = {
                            menuOpen = false
                            move()
                        },
                    )
                }
                onMoveDown?.let { move ->
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.server_move_down)) },
                        onClick = {
                            menuOpen = false
                            move()
                        },
                    )
                }
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
        title = {
            Text(
                text = stringResource(R.string.servers_create),
                style = MaterialTheme.typography.titleMedium,
            )
        },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.take(100) },
                label = { Text(stringResource(R.string.servers_create_name)) },
                singleLine = true,
                shape = MaterialTheme.shapes.small,
                modifier = Modifier.fillMaxWidth(),
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
        // Both stated rather than inherited, and both are corrections rather
        // than taste. `AlertDialogDefaults.shape` reads `shapes.extraLarge`,
        // which is the 28dp meant for a bottom sheet; the shape scale gives a
        // dialog 20dp. `AlertDialogDefaults.containerColor` reads
        // `surfaceContainerHigh`, which on this ramp is the colour of a pressed
        // row, and a dialog is a thing that lifts rather than a thing that
        // reacts.
        shape = MaterialTheme.shapes.large,
        containerColor = MaterialTheme.colorScheme.surfaceContainer,
    )
}

/**
 * The corner mark for a server with channel news: a lime `@N` when somebody
 * pinged this person (capped at "9+" like every badge on an icon), otherwise a
 * dot. It carries its own words for TalkBack, since a dot says nothing alone.
 */
@Composable
private fun ServerUnreadMark(unread: gg.pqp.app.unread.ServerUnreadSummary, modifier: Modifier = Modifier) {
    when {
        unread.mentions > 0 -> {
            val label = "@" + gg.pqp.app.bau.BauBadge.label(unread.mentions)
            val words = pluralStringResource(R.plurals.servers_unread_mentions, unread.mentions, unread.mentions)
            CountBadge(
                count = unread.mentions,
                loud = true,
                label = label,
                modifier = modifier
                    .semantics { contentDescription = words }
                    .testTag("servers.unread.mentions"),
            )
        }
        unread.hasUnread -> {
            val words = stringResource(R.string.servers_unread)
            Box(
                modifier
                    .size(12.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary)
                    .border(2.dp, MaterialTheme.colorScheme.surface, CircleShape)
                    .semantics { contentDescription = words }
                    .testTag("servers.unread.dot"),
            )
        }
    }
}
