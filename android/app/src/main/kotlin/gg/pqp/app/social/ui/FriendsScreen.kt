package gg.pqp.app.social.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.People
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.social.DmSummary
import gg.pqp.app.social.Friend
import gg.pqp.app.social.FriendRequestEntry
import gg.pqp.app.social.SocialRepository
import gg.pqp.app.ui.screens.EmptyState
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
            Column {
                LargeTopAppBar(
                    title = { Text(stringResource(R.string.friends_title)) },
                    scrollBehavior = scrollBehavior,
                )
                PrimaryTabRow(selectedTabIndex = tab.ordinal) {
                    FriendsTab.entries.forEach { entry ->
                        Tab(
                            selected = tab == entry,
                            onClick = { tab = entry },
                            text = {
                                if (entry == FriendsTab.Pending && data.pendingCount > 0) {
                                    BadgedBox(badge = { Badge { Text(data.pendingCount.toString()) } }) {
                                        Text(stringResource(entry.label))
                                    }
                                } else {
                                    Text(stringResource(entry.label))
                                }
                            },
                            modifier = Modifier.testTag("friends.tab.${entry.name.lowercase()}"),
                        )
                    }
                }
            }
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { adding = true },
                icon = { Icon(Icons.Filled.PersonAdd, contentDescription = null) },
                text = { Text(stringResource(R.string.friends_add)) },
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
                            stringResource(
                                if (tab == FriendsTab.Online) {
                                    R.string.friends_empty_online
                                } else {
                                    R.string.friends_empty_all
                                },
                            ),
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
                                )
                            }
                        }
                    }
                }

                FriendsTab.Pending -> {
                    if (data.incoming.isEmpty() && data.outgoing.isEmpty()) {
                        EmptyState(stringResource(R.string.friends_empty_pending))
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
                                        // a menu, so both verbs are inline.
                                        TextButton(onClick = {
                                            scope.launch { social.acceptFriend(entry.id) }
                                        }) { Text(stringResource(R.string.friends_accept)) }
                                        TextButton(onClick = {
                                            scope.launch { social.removeFriend(entry.id) }
                                        }) { Text(stringResource(R.string.friends_decline)) }
                                    }
                                }
                            }
                            if (data.outgoing.isNotEmpty()) {
                                item(key = "outgoing-label") {
                                    SectionLabel(stringResource(R.string.friends_section_outgoing))
                                }
                                items(data.outgoing, key = { "out-${it.id}" }) { entry ->
                                    RequestRow(entry) {
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

    confirming?.let { pending ->
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text(stringResource(pending.prompt, pending.person.displayName)) },
            text = { Text(stringResource(pending.explanation)) },
            confirmButton = {
                TextButton(onClick = {
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
                }) { Text(stringResource(pending.action)) }
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
) {
    var menuOpen by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onMessage)
            .padding(start = 16.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PersonAvatar(friend.displayName, friend.avatarUrl, friend.status)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = friend.displayName,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = friend.tag ?: stringResource(statusLabel(friend.status)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
            )
        }
        Box {
            IconButton(onClick = { menuOpen = true }) {
                Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.friends_more))
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.friends_message)) },
                    onClick = { menuOpen = false; onMessage() },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.friends_remove)) },
                    onClick = { menuOpen = false; onRemove() },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.friends_block)) },
                    onClick = { menuOpen = false; onBlock() },
                )
            }
        }
    }
}

@Composable
private fun RequestRow(entry: FriendRequestEntry, actions: @Composable () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // No status dot: the server sends none for a pending entry, on purpose.
        PersonAvatar(entry.displayName, entry.avatarUrl, status = null)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = entry.displayName,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            entry.tag?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(0.dp)) { actions() }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text.uppercase(),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp),
    )
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

/** The icon the bottom bar uses for this tab. */
val FriendsIcon = Icons.Filled.People

private const val PRESENCE_POLL_MS = 15_000L
