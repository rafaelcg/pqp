package gg.pqp.app.social.ui

import android.content.Intent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberTopAppBarState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.core.Backend
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.social.ConversationFilter
import gg.pqp.app.social.ConversationList
import gg.pqp.app.social.DmSummary
import gg.pqp.app.social.SocialRepository
import gg.pqp.app.ui.components.ChromeDivider
import gg.pqp.app.ui.components.pqpLargeTopBarColors
import gg.pqp.app.ui.theme.Motion
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.ui.theme.TabularFigures
import java.time.ZonedDateTime
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Conversas: the conversation list, WhatsApp-style, behind `home` in
 * `GET /api/dms/config` (the web's W1 and W6, `docs/` design in the PR).
 *
 * Friends moved into the header (people icon with the lime request badge) so
 * the third bottom tab can be "Tu". A row says who (presence for friends
 * only, from the friends list this client already holds), what was last said
 * (the server's redacted preview, prefixed for the reader), when, how many are
 * waiting, and "digitando..." while somebody types. Search and the three chips
 * run over the list already in memory: no request per keystroke.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversasScreen(
    session: SessionStore,
    social: SocialRepository,
    onOpen: (DmSummary) -> Unit,
    onNewConversation: () -> Unit,
    onOpenFriends: () -> Unit,
    onAddFriend: () -> Unit,
) {
    val conversations by social.conversations.collectAsStateWithLifecycle()
    val loading by social.loadingConversations.collectAsStateWithLifecycle()
    val error by social.error.collectAsStateWithLifecycle()
    val friends by social.friends.collectAsStateWithLifecycle()
    val typing by social.typing.collectAsStateWithLifecycle()
    val selfId by social.selfId.collectAsStateWithLifecycle()
    val phase by session.phase.collectAsStateWithLifecycle()
    val handle = (phase as? SessionPhase.Ready)?.me?.handle

    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())
    val snackbars = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var closing by remember { mutableStateOf<DmSummary?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf(ConversationFilter.All) }

    LaunchedEffect(Unit) { social.refreshConversations() }

    // Presence has no frame of its own; the Friends screen polls while it is
    // on screen, and this list does the same so a dot is never stale for long.
    LaunchedEffect(Unit) {
        while (true) {
            social.refreshFriends()
            delay(PRESENCE_POLL_MS)
        }
    }

    LaunchedEffect(error) {
        val message = error ?: return@LaunchedEffect
        if (message.isNotBlank()) snackbars.showSnackbar(message)
        social.clearError()
    }

    val statusById = remember(friends) { friends.friends.associate { it.id to it.status } }
    val shown = remember(conversations, query, filter) {
        ConversationList.filter(conversations, query, filter)
    }
    val waiting = ConversationList.waiting(conversations)

    // Plain resources rather than `stringResource`: the preview lambdas run
    // while a row is built, outside any composable scope of their own.
    val resources = LocalContext.current.resources
    val words = ConversationList.PreviewWords(
        you = { text -> resources.getString(R.string.conversas_preview_you, text) },
        groupAuthor = { name, text -> resources.getString(R.string.conversas_preview_group_author, name, text) },
        voice = { duration -> resources.getString(R.string.conversas_preview_voice, duration) },
        gif = stringResource(R.string.conversas_preview_gif),
        attachment = stringResource(R.string.conversas_preview_attachment),
    )
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]
    val yesterday = stringResource(R.string.conversas_yesterday)
    val now = remember(conversations) { ZonedDateTime.now() }

    Scaffold(
        modifier = Modifier
            .fillMaxSize()
            .nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            Column {
                LargeTopAppBar(
                    title = {
                        val collapsed = scrollBehavior.state.collapsedFraction > 0.5f
                        Text(
                            text = stringResource(R.string.conversas_title),
                            style = if (collapsed) {
                                MaterialTheme.typography.titleLarge
                            } else {
                                MaterialTheme.typography.headlineLarge
                            },
                            maxLines = 1,
                        )
                    },
                    actions = {
                        val pending = friends.pendingCount
                        val friendsLabel = if (pending > 0) {
                            pluralStringResource(R.plurals.conversas_friends_requests, pending, pending)
                        } else {
                            stringResource(R.string.conversas_friends)
                        }
                        IconButton(
                            onClick = onOpenFriends,
                            modifier = Modifier.testTag("conversas.friends"),
                        ) {
                            BadgedBox(badge = { CountBadge(count = pending, loud = true) }) {
                                Icon(
                                    imageVector = PqpIcons.People,
                                    contentDescription = friendsLabel,
                                    modifier = Modifier.size(Sizes.iconAction),
                                )
                            }
                        }
                    },
                    colors = pqpLargeTopBarColors(),
                    expandedHeight = Sizes.largeTopBarExpanded,
                    scrollBehavior = scrollBehavior,
                )
                ChromeDivider()
            }
        },
        floatingActionButton = {
            if (conversations.isNotEmpty()) {
                ExtendedFloatingActionButton(
                    onClick = onNewConversation,
                    icon = {
                        Icon(
                            imageVector = PqpIcons.Edit,
                            contentDescription = null,
                            modifier = Modifier.size(Sizes.iconAction),
                        )
                    },
                    text = { Text(stringResource(R.string.conversas_new)) },
                    shape = MaterialTheme.shapes.large,
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                    modifier = Modifier.testTag("dms.new"),
                )
            }
        },
        snackbarHost = { SnackbarHost(snackbars) },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = loading,
            onRefresh = social::refreshConversations,
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            if (conversations.isEmpty()) {
                if (!loading) {
                    EmptyConversas(
                        onAddFriend = onAddFriend,
                        onInvite = {
                            val link = handle?.let { "${Backend.appUrl.trimEnd('/')}/@$it" } ?: Backend.appUrl
                            val send = Intent(Intent.ACTION_SEND)
                                .setType("text/plain")
                                .putExtra(Intent.EXTRA_TEXT, context.getString(R.string.conversas_invite_text, link))
                            context.startActivity(Intent.createChooser(send, null))
                        },
                    )
                }
            } else {
                LazyColumn(
                    contentPadding = PaddingValues(bottom = 96.dp),
                    modifier = Modifier
                        .fillMaxSize()
                        .testTag("dms.list"),
                ) {
                    item(key = "search") {
                        SearchBox(query = query, onQuery = { query = it })
                    }
                    item(key = "chips") {
                        FilterChips(filter = filter, waiting = waiting, onFilter = { filter = it })
                    }
                    if (shown.isEmpty()) {
                        item(key = "nothing") {
                            Text(
                                text = when {
                                    query.isNotBlank() -> stringResource(R.string.conversas_no_match, query.trim())
                                    filter == ConversationFilter.Unread -> stringResource(R.string.conversas_empty_unread)
                                    else -> stringResource(R.string.conversas_empty_groups)
                                },
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                textAlign = TextAlign.Center,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(Spacing.xl)
                                    .testTag("conversas.nothing"),
                            )
                        }
                    }
                    items(shown, key = { it.channelId }) { conversation ->
                        val other = conversation.participants.singleOrNull()
                        val typists = typing[conversation.channelId].orEmpty()
                        ConversaRow(
                            conversation = conversation,
                            status = if (!conversation.isGroup && other != null) statusById[other.id] else null,
                            preview = conversation.lastMessage?.let {
                                ConversationList.previewLine(it, selfId, conversation.isGroup, words)
                            },
                            typing = when {
                                typists.isEmpty() -> null
                                conversation.isGroup ->
                                    stringResource(R.string.conversas_typing_named, typists.first())
                                else -> stringResource(R.string.conversas_typing)
                            },
                            time = ConversationList.listTime(conversation.lastMessageAt, now, locale, yesterday),
                            onClick = { onOpen(conversation) },
                            onLongClick = { closing = conversation },
                            // A row that jumps to the top on a new message
                            // glides there; Compose scales the spring by the
                            // animator duration scale, so "remove animations"
                            // makes it a jump.
                            modifier = Modifier.animateItem(),
                        )
                    }
                }
            }
        }
    }

    closing?.let { conversation ->
        val title = conversationTitle(conversation)
        AlertDialog(
            onDismissRequest = { closing = null },
            title = { Text(stringResource(R.string.dms_close_prompt, title)) },
            text = { Text(stringResource(R.string.dms_close_explanation)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        closing = null
                        scope.launch { social.closeConversation(conversation.channelId) }
                    },
                ) { Text(stringResource(R.string.dms_close)) }
            },
            dismissButton = {
                TextButton(onClick = { closing = null }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

@Composable
private fun SearchBox(query: String, onQuery: (String) -> Unit) {
    val container = MaterialTheme.colorScheme.surfaceContainerHigh
    TextField(
        value = query,
        onValueChange = { onQuery(it.take(64)) },
        singleLine = true,
        shape = MaterialTheme.shapes.small,
        textStyle = MaterialTheme.typography.bodyLarge,
        leadingIcon = {
            Icon(PqpIcons.Search, contentDescription = null, modifier = Modifier.size(Sizes.iconInline))
        },
        trailingIcon = if (query.isNotEmpty()) {
            {
                IconButton(onClick = { onQuery("") }) {
                    Icon(
                        PqpIcons.Close,
                        contentDescription = stringResource(R.string.cancel),
                        modifier = Modifier.size(Sizes.iconInline),
                    )
                }
            }
        } else {
            null
        },
        placeholder = { Text(stringResource(R.string.conversas_search)) },
        colors = TextFieldDefaults.colors(
            focusedContainerColor = container,
            unfocusedContainerColor = container,
            focusedIndicatorColor = Color.Transparent,
            unfocusedIndicatorColor = Color.Transparent,
            focusedLeadingIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
            unfocusedLeadingIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
            focusedPlaceholderColor = MaterialTheme.colorScheme.onSurfaceVariant,
            unfocusedPlaceholderColor = MaterialTheme.colorScheme.onSurfaceVariant,
            cursorColor = MaterialTheme.colorScheme.primary,
        ),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.gutter, vertical = Spacing.sm)
            .testTag("conversas.search"),
    )
}

@Composable
private fun FilterChips(
    filter: ConversationFilter,
    waiting: Int,
    onFilter: (ConversationFilter) -> Unit,
) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = Spacing.gutter)
            .padding(bottom = Spacing.xs),
    ) {
        ConversationFilter.entries.forEach { entry ->
            FilterChip(
                selected = filter == entry,
                onClick = { onFilter(entry) },
                label = {
                    Text(
                        stringResource(
                            when (entry) {
                                ConversationFilter.All -> R.string.conversas_filter_all
                                ConversationFilter.Unread -> R.string.conversas_filter_unread
                                ConversationFilter.Groups -> R.string.conversas_filter_groups
                            },
                        ),
                    )
                },
                trailingIcon = if (entry == ConversationFilter.Unread && waiting > 0) {
                    { CountBadge(count = waiting, loud = false, danger = true) }
                } else {
                    null
                },
                shape = MaterialTheme.shapes.large,
                // The selected chip is a quiet lime wash with lime text, the
                // same treatment as the bottom bar's selected tab, so the one
                // solid lime object on the screen stays the Nova conversa
                // button.
                colors = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.18f),
                    selectedLabelColor = MaterialTheme.colorScheme.primary,
                    containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    labelColor = MaterialTheme.colorScheme.onSurface,
                ),
                border = null,
                modifier = Modifier.testTag("conversas.filter.${entry.name.lowercase()}"),
            )
        }
    }
}

/**
 * One conversation, WhatsApp anatomy: avatar (with presence for a friend),
 * name and time on the first line, preview or "digitando..." and the count on
 * the second. No divider between rows: the rhythm separates them.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun ConversaRow(
    conversation: DmSummary,
    status: String?,
    preview: String?,
    typing: String?,
    time: String?,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val unread = conversation.unread.count
    val interactions = remember { MutableInteractionSource() }
    val pressed by interactions.collectIsPressedAsState()
    val rowColor by animateColorAsState(
        targetValue = if (pressed) MaterialTheme.colorScheme.surfaceContainerHigh else Color.Transparent,
        animationSpec = tween(if (pressed) 0 else Motion.QUICK_MILLIS),
        label = "conversa-press",
    )

    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = Sizes.conversationRow)
            .combinedClickable(
                interactionSource = interactions,
                indication = null,
                onClick = onClick,
                onLongClick = onLongClick,
            )
            .background(rowColor)
            .padding(horizontal = Spacing.gutter, vertical = Spacing.sm)
            .testTag("conversas.row"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val other = conversation.participants.singleOrNull()
        if (other != null && !conversation.isGroup) {
            PersonAvatar(
                name = other.displayName,
                avatarUrl = other.avatarUrl,
                status = status,
                size = Sizes.avatarConversation + 4.dp,
                seed = other.id,
            )
        } else {
            ConversationAvatar(conversation.participants, size = Sizes.avatarConversation + 4.dp)
        }
        Spacer(Modifier.width(Spacing.md))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = conversationTitle(conversation),
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                    fontWeight = if (unread > 0) FontWeight.Bold else null,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (time != null) {
                    Text(
                        text = time,
                        style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = TabularFigures),
                        // The accent says "this one is new" without a word.
                        color = if (unread > 0) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                        fontWeight = if (unread > 0) FontWeight.SemiBold else null,
                        maxLines = 1,
                        modifier = Modifier.padding(start = Spacing.sm),
                    )
                }
            }
            Spacer(Modifier.height(2.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                val line = typing ?: preview ?: when {
                    conversation.isGroup -> pluralStringResource(
                        R.plurals.dms_group_people,
                        conversation.participants.size + 1,
                        conversation.participants.size + 1,
                    )
                    conversation.lastMessageAt == null -> stringResource(R.string.dms_no_messages)
                    else -> ""
                }
                Text(
                    text = line,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (typing != null) {
                        MaterialTheme.colorScheme.primary
                    } else if (unread > 0) {
                        MaterialTheme.colorScheme.onSurface
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    fontStyle = if (typing != null) FontStyle.Italic else null,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .weight(1f)
                        .testTag(if (typing != null) "conversas.row.typing" else "conversas.row.preview"),
                )
                if (unread > 0) {
                    val label = ConversationList.countLabel(unread)
                    CountBadge(
                        count = unread,
                        loud = false,
                        danger = true,
                        label = label,
                        modifier = Modifier
                            .padding(start = Spacing.sm)
                            .semantics { label?.let { contentDescription = it } },
                    )
                }
            }
        }
    }
}

/**
 * An account with no conversation at all. The biggest drop-off for DMs is an
 * empty list, and the people are already in the account's servers, so the
 * screen leads to people instead of saying "nothing here".
 */
@Composable
private fun EmptyConversas(onAddFriend: () -> Unit, onInvite: () -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = Spacing.xl)
            .testTag("conversas.empty"),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(72.dp)
                .background(MaterialTheme.colorScheme.surfaceContainerHigh, MaterialTheme.shapes.extraLarge),
        ) {
            Icon(
                PqpIcons.Messages,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(32.dp),
            )
        }
        Spacer(Modifier.height(Spacing.lg))
        Text(
            text = stringResource(R.string.conversas_empty_title),
            style = MaterialTheme.typography.headlineSmall,
            color = MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(Spacing.sm))
        Text(
            text = stringResource(R.string.conversas_empty_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(Spacing.xl))
        Button(
            onClick = onAddFriend,
            shape = MaterialTheme.shapes.small,
            colors = ButtonDefaults.buttonColors(
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .testTag("conversas.empty.addFriend"),
        ) {
            Icon(PqpIcons.AddFriend, contentDescription = null, modifier = Modifier.size(Sizes.iconInline))
            Spacer(Modifier.width(Spacing.sm))
            Text(stringResource(R.string.friends_add))
        }
        Spacer(Modifier.height(Spacing.sm))
        OutlinedButton(
            onClick = onInvite,
            shape = MaterialTheme.shapes.small,
            modifier = Modifier
                .fillMaxWidth()
                .testTag("conversas.empty.invite"),
        ) {
            Icon(PqpIcons.Link, contentDescription = null, modifier = Modifier.size(Sizes.iconInline))
            Spacer(Modifier.width(Spacing.sm))
            Text(stringResource(R.string.conversas_empty_invite))
        }
    }
}

private const val PRESENCE_POLL_MS = 15_000L

