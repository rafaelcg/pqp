package gg.pqp.app.social.ui

import androidx.compose.foundation.combinedClickable
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
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Edit
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
import gg.pqp.app.ui.screens.EmptyState
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
            LargeTopAppBar(
                title = { Text(stringResource(R.string.dms_title)) },
                scrollBehavior = scrollBehavior,
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onNewConversation,
                icon = { Icon(Icons.Filled.Edit, contentDescription = null) },
                text = { Text(stringResource(R.string.dms_new)) },
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
                EmptyState(stringResource(R.string.dms_empty))
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

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun ConversationRow(
    conversation: DmSummary,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    val unread = conversation.unread.count
    val subtitle = relativeTime(conversation.lastMessageAt)?.toString()
        ?: stringResource(R.string.dms_no_messages)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ConversationAvatar(conversation.participants, size = 48.dp)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = conversationTitle(conversation),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = if (unread > 0) FontWeight.Bold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (conversation.isGroup) {
                    Text(
                        // The caller is a participant too and the server left
                        // them out of the list, so the group is one bigger than
                        // what came back.
                        text = pluralStringResource(
                            R.plurals.dms_group_people,
                            conversation.participants.size + 1,
                            conversation.participants.size + 1,
                        ),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = unreadTint(unread),
                    maxLines = 1,
                )
            }
        }
        Box(Modifier.padding(start = 8.dp)) {
            UnreadBadge(unread, conversation.unread.mentions)
        }
    }
}

/** The icon the bottom bar uses for this tab. Exported so the bar has one source. */
val ConversationsIcon = Icons.AutoMirrored.Filled.Chat
