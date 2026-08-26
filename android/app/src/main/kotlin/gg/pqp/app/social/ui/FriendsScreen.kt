package gg.pqp.app.social.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Tab
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.core.ApiClient
import gg.pqp.app.reports.ReportTarget
import gg.pqp.app.reports.ui.ReportSheet
import gg.pqp.app.social.DmSummary
import gg.pqp.app.social.Friend
import gg.pqp.app.social.FriendRequestEntry
import gg.pqp.app.social.SocialRepository
import gg.pqp.app.ui.components.ChromeDivider
import gg.pqp.app.ui.components.EmptyState
import gg.pqp.app.ui.components.SectionLabel
import gg.pqp.app.ui.components.pqpLargeTopBarColors
import gg.pqp.app.ui.theme.Motion
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Friends: who is around, everybody, and the requests.
 *
 * The rules this screen obeys are the server's, not its own:
 *
 * - A REFUSAL IS NOT AN ORACLE. Every rejected request answers with the same
 *   sentence whether you blocked them, they blocked you, or the id is junk. The
 *   server's wording is shown verbatim; a more "helpful" local one would turn
 *   this screen into a probe for who has blocked whom.
 * - DECLINING IS SILENT, and so are cancelling and unfriending. All three are
 *   one DELETE and the other side is never told, which is what makes declining
 *   cheap enough that people actually do it.
 * - PENDING ENTRIES CARRY NO PRESENCE. Until you accept, the other person is a
 *   stranger, and a stranger must not learn whether you are at your keyboard by
 *   the act of asking. So no status dot on a request row: the server sends none
 *   to draw.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FriendsScreen(
    social: SocialRepository,
    /**
     * Passed in rather than reached through [social], which keeps its session
     * private. Reporting is one POST and belongs to no repository.
     */
    api: ApiClient,
    onOpenConversation: (DmSummary) -> Unit,
) {
    val data by social.friends.collectAsStateWithLifecycle()
    val loading by social.loadingFriends.collectAsStateWithLifecycle()
    val error by social.error.collectAsStateWithLifecycle()
    val nudge by social.friendNudge.collectAsStateWithLifecycle()

    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())
    val snackbars = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    var tab by remember { mutableStateOf(FriendsTab.Online) }
    var adding by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf<Confirmation?>(null) }
    var reporting by remember { mutableStateOf<Friend?>(null) }
    var pickedTabForEmptyAccount by remember { mutableStateOf(false) }

    /**
     * Presence has no frame of its own: a friend's status only changes in this
     * client when `GET /api/friends` is read again. A slow poll while this
     * screen is the thing on screen is the whole of the live half, and it stops
     * the moment the composable leaves.
     */
    LaunchedEffect(Unit) {
        while (true) {
            social.refreshFriends()
            delay(PRESENCE_POLL_MS)
        }
    }

    // An account with no friends at all opens on the wrong tab. "Online" says
    // "nobody is around", which is true and useless to somebody who has nobody:
    // it reads as "your friends are offline" and carries no way to change that.
    // Only on the first load, because yanking the tab out from under a person
    // who chose it themselves would be worse than either.
    LaunchedEffect(data.friends.isEmpty(), loading) {
        if (!pickedTabForEmptyAccount && !loading) {
            pickedTabForEmptyAccount = true
            if (data.friends.isEmpty()) tab = FriendsTab.All
        }
    }

    LaunchedEffect(error) {
        val message = error ?: return@LaunchedEffect
        if (message.isNotBlank()) snackbars.showSnackbar(message)
        social.clearError()
    }

    // Resolved here rather than inside the effect: a `stringResource` call is a
    // composable one and a `LaunchedEffect` body is not.
    val nudgeRequest = stringResource(R.string.friends_nudge_request)
    val nudgeAccepted = stringResource(R.string.friends_nudge_accepted)
    LaunchedEffect(nudge) {
        val message = when (nudge) {
            "request" -> nudgeRequest
            "accepted" -> nudgeAccepted
            // `depoimento` also rides this frame and has no surface here yet.
            else -> null
        }
        if (message != null) snackbars.showSnackbar(message)
        if (nudge != null) social.clearFriendNudge()
    }

    Scaffold(
        modifier = Modifier
            .fillMaxSize()
            .nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            // The bar and the tab strip are one piece of chrome, so they share
            // one ground and the hairline goes under the pair of them rather
            // than between them. Material would put a divider under the tab row
            // by default and lighten the bar on scroll; both are turned off,
            // because two rules and two shades of grey where one seam exists is
            // exactly the settings-screen look this pass is undoing.
            Column(
                modifier = Modifier.background(MaterialTheme.colorScheme.surfaceContainerLowest),
            ) {
                LargeTopAppBar(
                    title = { Text(stringResource(R.string.friends_title)) },
                    colors = pqpLargeTopBarColors(),
                    // Same height as the other two tabs. This screen pays for
                    // the default twice over: the bar and the tab strip under
                    // it are one piece of chrome, so 28dp of empty bar pushes
                    // the strip down too and the list starts lower than it does
                    // on either sibling.
                    expandedHeight = Sizes.largeTopBarExpanded,
                    scrollBehavior = scrollBehavior,
                )
                PrimaryTabRow(
                    selectedTabIndex = tab.ordinal,
                    containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
                    contentColor = MaterialTheme.colorScheme.primary,
                    divider = {},
                ) {
                    FriendsTab.entries.forEach { entry ->
                        Tab(
                            selected = tab == entry,
                            onClick = { tab = entry },
                            selectedContentColor = MaterialTheme.colorScheme.primary,
                            unselectedContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                            text = {
                                // The count sits BESIDE the word rather than
                                // over its shoulder. A tab here is a third of
                                // the screen wide and the overlaid form landed
                                // the badge on the last two letters of
                                // "Pending" and on the edge of "Pendentes".
                                // Lime for the same reason as on the bottom
                                // bar: a request is a thing to act on, and it
                                // is the only one on the strip.
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        text = stringResource(entry.label),
                                        style = MaterialTheme.typography.labelLarge,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    if (entry == FriendsTab.Pending) {
                                        CountBadge(data.pendingCount, loud = true)
                                    }
                                }
                            },
                            modifier = Modifier.testTag("friends.tab.${entry.name.lowercase()}"),
                        )
                    }
                }
                ChromeDivider()
            }
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { adding = true },
                icon = {
                    Icon(
                        imageVector = PqpIcons.AddFriend,
                        contentDescription = null,
                        modifier = Modifier.size(Sizes.iconAction),
                    )
                },
                text = { Text(stringResource(R.string.friends_add)) },
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
                modifier = Modifier.testTag("friends.add"),
            )
        },
        snackbarHost = { SnackbarHost(snackbars) },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = loading,
            onRefresh = social::refreshFriends,
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            when (tab) {
                FriendsTab.Online, FriendsTab.All -> {
                    val rows = if (tab == FriendsTab.Online) {
                        data.friends.filter { it.status != "offline" }.sortedByName()
                    } else {
                        data.friends.onlineFirst()
                    }
                    if (rows.isEmpty()) {
                        EmptyState(
                            text = stringResource(
                                if (tab == FriendsTab.Online) {
                                    R.string.friends_empty_online
                                } else {
                                    R.string.friends_empty_all
                                },
                            ),
                            icon = PqpIcons.People,
                        )
                    } else {
                        LazyColumn(
                            contentPadding = PaddingValues(bottom = 96.dp),
                            modifier = Modifier
                                .fillMaxSize()
                                .testTag("friends.list"),
                        ) {
                            items(rows, key = { it.id }) { friend ->
                                FriendRow(
                                    friend = friend,
                                    onMessage = {
                                        scope.launch {
                                            social.openConversation(listOf(friend.id))
                                                .getOrNull()
                                                ?.let(onOpenConversation)
                                        }
                                    },
                                    onRemove = { confirming = Confirmation.Remove(friend) },
                                    onBlock = { confirming = Confirmation.Block(friend) },
                                    onReport = { reporting = friend },
                                )
                            }
                        }
                    }
                }

                FriendsTab.Pending -> {
                    if (data.incoming.isEmpty() && data.outgoing.isEmpty()) {
                        EmptyState(
                            text = stringResource(R.string.friends_empty_pending),
                            icon = PqpIcons.People,
                        )
                    } else {
                        LazyColumn(
                            contentPadding = PaddingValues(bottom = 96.dp),
                            modifier = Modifier
                                .fillMaxSize()
                                .testTag("friends.pending"),
                        ) {
                            if (data.incoming.isNotEmpty()) {
                                item(key = "incoming-label") {
                                    SectionLabel(stringResource(R.string.friends_section_incoming))
                                }
                                items(data.incoming, key = { "in-${it.id}" }) { entry ->
                                    RequestRow(entry) {
                                        // A request needs one tap to answer, not
                                        // a menu, so both verbs are inline. The
                                        // accept is the one lime object in the
                                        // row and the decline is deliberately
                                        // quiet: declining is free and silent,
                                        // and a row that shouts both ways makes
                                        // the reader weigh a decision that does
                                        // not need weighing.
                                        AcceptAction(
                                            onClick = { scope.launch { social.acceptFriend(entry.id) } },
                                        )
                                        DeclineAction(
                                            description = stringResource(R.string.friends_decline),
                                            onClick = { scope.launch { social.removeFriend(entry.id) } },
                                        )
                                    }
                                }
                            }
                            if (data.outgoing.isNotEmpty()) {
                                item(key = "outgoing-label") {
                                    SectionLabel(stringResource(R.string.friends_section_outgoing))
                                }
                                items(data.outgoing, key = { "out-${it.id}" }) { entry ->
                                    RequestRow(entry) {
                                        // Named rather than drawn as a bare
                                        // cross: it is the only action on the
                                        // row, it has the width, and "cancel"
                                        // and "decline" are different verbs
                                        // that would otherwise be one glyph.
                                        TextButton(onClick = {
                                            scope.launch { social.removeFriend(entry.id) }
                                        }) { Text(stringResource(R.string.friends_cancel_request)) }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (adding) {
        AddFriendSheet(
            social = social,
            known = buildSet {
                data.friends.forEach { add(it.id) }
                data.incoming.forEach { add(it.id) }
                data.outgoing.forEach { add(it.id) }
            },
            onDismiss = { adding = false },
        )
    }

    // No server id: a report filed from the friends list is about a person and
    // not about their conduct in any one place, so it goes to the instance
    // queue rather than to some community's moderators. The server decides
    // that from the absent `serverId`, not from anything said here.
    reporting?.let { friend ->
        ReportSheet(
            api = api,
            target = ReportTarget.Person(userId = friend.id, displayName = friend.displayName),
            onDismiss = { reporting = null },
        )
    }

    confirming?.let { pending ->
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text(stringResource(pending.prompt, pending.person.displayName)) },
            text = { Text(stringResource(pending.explanation)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        val target = pending
                        confirming = null
                        scope.launch {
                            when (target) {
                                is Confirmation.Remove -> social.removeFriend(target.person.id)
                                // No separate unfriend call: the block's own trigger
                                // deletes the friendship row, and issuing both would
                                // race it.
                                is Confirmation.Block -> social.block(target.person.id)
                            }
                        }
                    },
                    // Both of these end a relationship, so the verb is drawn in
                    // the error colour rather than in the signal. The signal
                    // means "do this"; this one is "are you sure".
                    colors = ButtonDefaults.textButtonColors(
                        contentColor = MaterialTheme.colorScheme.error,
                    ),
                ) { Text(stringResource(pending.action)) }
            },
            dismissButton = {
                TextButton(onClick = { confirming = null }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

enum class FriendsTab(val label: Int) {
    Online(R.string.friends_tab_online),
    All(R.string.friends_tab_all),
    Pending(R.string.friends_tab_pending),
}

/** A destructive action held until it is confirmed, so the prompt and the verb cannot drift apart. */
private sealed interface Confirmation {
    val person: Friend
    val prompt: Int
    val explanation: Int
    val action: Int

    data class Remove(override val person: Friend) : Confirmation {
        override val prompt = R.string.friends_remove_prompt
        override val explanation = R.string.friends_remove_explanation
        override val action = R.string.friends_remove
    }

    data class Block(override val person: Friend) : Confirmation {
        override val prompt = R.string.friends_block_prompt

        // Stated because it is the one surprising consequence: the schema's
        // trigger ends the friendship the moment a block lands, both ways.
        override val explanation = R.string.friends_block_explanation
        override val action = R.string.friends_block
    }
}

@Composable
private fun FriendRow(
    friend: Friend,
    onMessage: () -> Unit,
    onRemove: () -> Unit,
    onBlock: () -> Unit,
    onReport: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }

    val interactions = remember { MutableInteractionSource() }
    val pressed by interactions.collectIsPressedAsState()
    val rowColor by animateColorAsState(
        targetValue = if (pressed) MaterialTheme.colorScheme.surfaceContainerHigh else Color.Transparent,
        // Instant on the way in and `QUICK_MILLIS` on the way out. A row that
        // fades in its own highlight feels like the phone is thinking about it.
        animationSpec = tween(if (pressed) 0 else Motion.QUICK_MILLIS),
        label = "friend-press",
    )

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = Sizes.personRow)
            .clickable(
                interactionSource = interactions,
                indication = null,
                onClick = onMessage,
            )
            .background(rowColor)
            .padding(start = Spacing.gutter, end = Spacing.xs, top = Spacing.sm, bottom = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PersonAvatar(
            name = friend.displayName,
            avatarUrl = friend.avatarUrl,
            status = friend.status,
            seed = friend.id,
        )
        Spacer(Modifier.width(Spacing.md))
        Column(Modifier.weight(1f)) {
            Text(
                text = friend.displayName,
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = friend.tag ?: stringResource(statusLabel(friend.status)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Box {
            IconButton(onClick = { menuOpen = true }) {
                Icon(
                    imageVector = PqpIcons.More,
                    contentDescription = stringResource(R.string.friends_more),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(Sizes.iconAction),
                )
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.friends_message)) },
                    leadingIcon = { MenuGlyph(PqpIcons.Messages) },
                    onClick = { menuOpen = false; onMessage() },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.friends_remove)) },
                    leadingIcon = { MenuGlyph(PqpIcons.Close) },
                    onClick = { menuOpen = false; onRemove() },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.friends_block)) },
                    leadingIcon = { MenuGlyph(PqpIcons.Block) },
                    onClick = { menuOpen = false; onBlock() },
                )
                // Beside Block, not instead of it. Blocking stops somebody
                // reaching you and tells nobody; reporting asks a moderator to
                // do something about them. They are different acts and a person
                // in trouble usually wants both.
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.report_action)) },
                    onClick = { menuOpen = false; onReport() },
                )
            }
        }
    }
}

/** A menu's leading glyph: inline size, muted, never tinted. */
@Composable
private fun MenuGlyph(icon: ImageVector) {
    Icon(
        imageVector = icon,
        contentDescription = null,
        tint = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.size(Sizes.iconInline),
    )
}

/** Yes. The one lime object in a request row. */
@Composable
private fun AcceptAction(onClick: () -> Unit) {
    FilledIconButton(
        onClick = onClick,
        shape = MaterialTheme.shapes.small,
        colors = IconButtonDefaults.filledIconButtonColors(
            containerColor = MaterialTheme.colorScheme.primary,
            contentColor = MaterialTheme.colorScheme.onPrimary,
        ),
    ) {
        Icon(
            imageVector = PqpIcons.Confirm,
            contentDescription = stringResource(R.string.friends_accept),
            modifier = Modifier.size(Sizes.iconAction),
        )
    }
}

/** No, quietly. Declining is silent on the wire and it looks silent here too. */
@Composable
private fun DeclineAction(description: String, onClick: () -> Unit) {
    IconButton(onClick = onClick) {
        Icon(
            imageVector = PqpIcons.Close,
            contentDescription = description,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(Sizes.iconAction),
        )
    }
}

@Composable
private fun RequestRow(entry: FriendRequestEntry, actions: @Composable () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = Sizes.personRow)
            .padding(start = Spacing.gutter, end = Spacing.sm, top = Spacing.sm, bottom = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // No status dot: the server sends none for a pending entry, on purpose.
        PersonAvatar(
            name = entry.displayName,
            avatarUrl = entry.avatarUrl,
            status = null,
            seed = entry.id,
        )
        Spacer(Modifier.width(Spacing.md))
        Column(Modifier.weight(1f)) {
            Text(
                text = entry.displayName,
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            entry.tag?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) { actions() }
    }
}

private fun statusLabel(status: String): Int = when (status) {
    "online" -> R.string.status_online
    "idle" -> R.string.status_idle
    "dnd" -> R.string.status_dnd
    else -> R.string.status_offline
}

private fun List<Friend>.sortedByName(): List<Friend> =
    sortedBy { it.displayName.lowercase() }

/** Online first, then by name. The order both other clients use. */
private fun List<Friend>.onlineFirst(): List<Friend> =
    sortedWith(
        compareBy<Friend> { if (it.status == "offline") 1 else 0 }
            .thenBy { it.displayName.lowercase() },
    )

private const val PRESENCE_POLL_MS = 15_000L
