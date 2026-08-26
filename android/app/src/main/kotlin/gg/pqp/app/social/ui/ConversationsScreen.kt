package gg.pqp.app.social.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.social.DmSummary
import gg.pqp.app.social.SocialRepository
import gg.pqp.app.ui.components.ChromeDivider
import gg.pqp.app.ui.components.EmptyState
import gg.pqp.app.ui.components.pqpLargeTopBarColors
import gg.pqp.app.ui.theme.Motion
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.ui.theme.TabularFigures
import kotlinx.coroutines.launch

/**
 * The inbox: every conversation this account is in, freshest first.
 *
 * Long-pressing a row offers to close one. Closing is a hide and not a delete:
 * the history and the other person survive, and a 1:1 comes back the moment
 * either side says anything in it. The confirmation says so, because "delete"
 * is what the gesture looks like and being wrong about that in either direction
 * is bad: somebody who thinks it is permanent will not use it, and somebody who
 * thinks it wipes the thread will use it expecting privacy it does not give.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationsScreen(
    social: SocialRepository,
    onOpen: (DmSummary) -> Unit,
    onNewConversation: () -> Unit,
) {
    val conversations by social.conversations.collectAsStateWithLifecycle()
    val loading by social.loadingConversations.collectAsStateWithLifecycle()
    val error by social.error.collectAsStateWithLifecycle()

    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())
    val snackbars = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var closing by remember { mutableStateOf<DmSummary?>(null) }

    LaunchedEffect(Unit) { social.refreshConversations() }

    LaunchedEffect(error) {
        val message = error ?: return@LaunchedEffect
        if (message.isNotBlank()) snackbars.showSnackbar(message)
        social.clearError()
    }

    Scaffold(
        modifier = Modifier
            .fillMaxSize()
            .nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            Column {
                LargeTopAppBar(
                    title = { Text(stringResource(R.string.dms_title)) },
                    colors = pqpLargeTopBarColors(),
                    // The same height the servers tab stands at. This bar has
                    // no action in its top row, so on Material's 152dp default
                    // it was 28dp of nothing above a one-word title, and the
                    // title dropped by that much every time somebody crossed
                    // over from Servers.
                    expandedHeight = Sizes.largeTopBarExpanded,
                    scrollBehavior = scrollBehavior,
                )
                // The bar and the list are two different kinds of surface, so
                // this is one of the few places in the app a rule belongs. It
                // does the job Material would otherwise do by lightening a
                // scrolled bar, and it does it without putting a second shade
                // of grey on the screen.
                ChromeDivider()
            }
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onNewConversation,
                icon = {
                    Icon(
                        imageVector = PqpIcons.Edit,
                        contentDescription = null,
                        modifier = Modifier.size(Sizes.iconAction),
                    )
                },
                text = { Text(stringResource(R.string.dms_new)) },
                // The one lime object on this screen. `primary` rather than
                // Material's `primaryContainer` default, which on this palette
                // is `SignalDim`, and `SignalDim` is reserved for the pressed
                // state of something lime.
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
                modifier = Modifier.testTag("dms.new"),
            )
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
                EmptyState(stringResource(R.string.dms_empty), icon = PqpIcons.Messages)
            } else {
                LazyColumn(
                    contentPadding = PaddingValues(bottom = 96.dp),
                    modifier = Modifier
                        .fillMaxSize()
                        .testTag("dms.list"),
                ) {
                    items(conversations, key = { it.channelId }) { conversation ->
                        ConversationRow(
                            conversation = conversation,
                            onClick = { onOpen(conversation) },
                            onLongClick = { closing = conversation },
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

/**
 * One conversation.
 *
 * No divider under it, on purpose: rows in a list are separated by rhythm, and
 * a rule between every one of them is what turns an inbox into a form. What
 * separates them instead is the 72dp the row occupies and the fact that the
 * text column always starts at the same x.
 *
 * The pressed surface runs the full width with no corner radius, because the
 * inbox is a continuous list rather than a stack of cards. It arrives instantly
 * and releases over `QUICK_MILLIS`: a highlight that fades *in* feels like the
 * phone thinking about it.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun ConversationRow(
    conversation: DmSummary,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    val unread = conversation.unread.count
    val time = relativeTime(conversation.lastMessageAt)?.toString()

    val interactions = remember { MutableInteractionSource() }
    val pressed by interactions.collectIsPressedAsState()
    val rowColor by animateColorAsState(
        targetValue = if (pressed) MaterialTheme.colorScheme.surfaceContainerHigh else Color.Transparent,
        animationSpec = tween(if (pressed) 0 else Motion.QUICK_MILLIS),
        label = "conversation-press",
    )

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = Sizes.conversationRow)
            .combinedClickable(
                interactionSource = interactions,
                indication = null,
                onClick = onClick,
                onLongClick = onLongClick,
            )
            .background(rowColor)
            .padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ConversationAvatar(conversation.participants, size = Sizes.avatarConversation)
        Spacer(Modifier.width(Spacing.md))
        Column(Modifier.weight(1f)) {
            Text(
                text = conversationTitle(conversation),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
                // The one piece of emphasis on the row. A conversation with
                // something in it is heavier than one without, which is a
                // difference the eye reads down a column without being told.
                fontWeight = if (unread > 0) FontWeight.Bold else null,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            // The second line is whatever this row actually knows. The API
            // sends no message preview, so rather than invent one the row says
            // how many people are in a group, or that nobody has spoken yet,
            // and otherwise says nothing and stays one line tall.
            val secondLine = when {
                conversation.isGroup -> pluralStringResource(
                    // The caller is a participant too and the server left them
                    // out of the list, so the group is one bigger than what
                    // came back.
                    R.plurals.dms_group_people,
                    conversation.participants.size + 1,
                    conversation.participants.size + 1,
                )
                time == null -> stringResource(R.string.dms_no_messages)
                else -> null
            }
            if (secondLine != null) {
                Text(
                    text = secondLine,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Column(
            modifier = Modifier.padding(start = Spacing.sm),
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            if (time != null) {
                Text(
                    text = time,
                    // Tabular, because this is a relative time that reticks
                    // while the list is on screen and proportional digits make
                    // the whole trailing column twitch when "5 min" becomes
                    // "11 min".
                    // `labelMedium` rather than `labelSmall`, for the reason
                    // in the type scale: the small role's 1.1sp of tracking is
                    // there for uppercase section rules and reads loose on
                    // "9 min. ago".
                    style = MaterialTheme.typography.labelMedium.copy(
                        fontFeatureSettings = TabularFigures,
                    ),
                    color = unreadTint(unread),
                    maxLines = 1,
                )
            }
            UnreadBadge(unread, conversation.unread.mentions)
        }
    }
}
