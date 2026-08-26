package gg.pqp.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import coil3.compose.AsyncImage
import gg.pqp.app.R
import gg.pqp.app.core.Backend
import gg.pqp.app.core.Message
import gg.pqp.app.core.RealtimeState
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.push.VisibleChannel
import gg.pqp.app.ui.components.Avatar
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    session: SessionStore,
    channelId: String,
    channelName: String,
    onBack: () -> Unit,
    /**
     * What the app bar says, when the caller knows better than this screen
     * does. A conversation passes a person's name, because there is no channel
     * there to prefix. Left null, a server channel renders `#name`, and a
     * channel opened from a notification tap (which carries ids, never a
     * channel record) renders a placeholder rather than a bare `#`.
     */
    title: String? = null,
) {
    val model: ChatViewModel = viewModel(
        key = channelId,
        factory = ChatViewModel.factory(session, channelId),
    )
    val state by model.state.collectAsStateWithLifecycle()
    val connection by session.realtime.state.collectAsStateWithLifecycle()
    val phase by session.phase.collectAsStateWithLifecycle()
    val me = (phase as? SessionPhase.Ready)?.me

    // What stops a push firing about the conversation already on screen.
    //
    // A lifecycle effect rather than a plain DisposableEffect, and that is the
    // whole point: this has to be false the moment the app is backgrounded,
    // which is exactly when a notification is wanted most. `LifecycleStartEffect`
    // enters on START and leaves on STOP, so a chat still in the back stack
    // behind a locked screen does not count as being read. See
    // gg.pqp.app.push.PushPresentation.
    LifecycleStartEffect(channelId) {
        VisibleChannel.enter(channelId)

        // And, in the same breath, take the socket's single channel
        // subscription back. There is more than one chat surface now: a
        // conversation, or a chat opened by a notification tap, can be pushed
        // on top of this one and will have claimed it. Popping that screen off
        // does not hand it back, so the screen underneath would sit there
        // looking connected and receive nothing.
        model.resubscribe()

        onStopOrDispose { VisibleChannel.leave(channelId) }
    }

    val listState = rememberLazyListState()
    var draft by remember { mutableStateOf("") }

    // Follow the tail only when the reader is already there. Yanking somebody
    // back down while they are reading history is the single most annoying
    // thing a chat client does.
    val atBottom by remember {
        derivedStateOf {
            listState.firstVisibleItemIndex <= 1
        }
    }
    LaunchedEffect(state.messages.size) {
        if (atBottom && state.messages.isNotEmpty()) listState.animateScrollToItem(0)
    }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        topBar = {
            Column {
                TopAppBar(
                    // A notification tap can open a channel whose name is not
                    // known yet; "#" on its own is not a title.
                    title = {
                        Text(
                            title
                                ?: if (channelName.isBlank()) {
                                    stringResource(R.string.chat_untitled)
                                } else {
                                    "#$channelName"
                                },
                        )
                    },
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Icon(
                                Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = stringResource(R.string.chat_back),
                            )
                        }
                    },
                )
                ConnectionBanner(connection)
            }
        },
        bottomBar = {
            Composer(
                value = draft,
                onValueChange = {
                    draft = it
                    if (it.isNotEmpty()) model.typing()
                },
                onSend = {
                    // Cleared only once the frame has actually left the phone.
                    // A send during a reconnect returns false, and swallowing
                    // the box's contents there is how somebody loses a sentence
                    // they watched themselves type.
                    if (model.send(draft, me)) draft = ""
                },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                state.loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator()
                }

                state.messages.isEmpty() -> EmptyState(stringResource(R.string.chat_empty))

                else -> {
                    // Reversed so the newest message is index 0 and the list
                    // starts pinned to the bottom without measuring anything.
                    val rows = remember(state.messages) { state.messages.asReversed() }

                    LazyColumn(
                        state = listState,
                        reverseLayout = true,
                        contentPadding = PaddingValues(vertical = 12.dp),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(rows.size, key = { rows[it].id }) { index ->
                            val message = rows[index]
                            // The list is reversed, so the *previous* message in
                            // reading order is the next one in this list.
                            val previous = rows.getOrNull(index + 1)
                            MessageRow(
                                message = message,
                                grouped = shouldGroup(previous, message),
                            )
                        }

                        if (state.hasMore) {
                            item(key = "older") {
                                LaunchedEffect(Unit) { model.loadOlder() }
                                Box(
                                    Modifier.fillMaxWidth().padding(16.dp),
                                    contentAlignment = Alignment.Center,
                                ) { CircularProgressIndicator(Modifier.width(24.dp)) }
                            }
                        }
                    }
                }
            }

            state.typing.takeIf { it.isNotEmpty() }?.let { names ->
                Text(
                    text = if (names.size == 1) {
                        stringResource(R.string.chat_typing_one, names.first())
                    } else {
                        stringResource(R.string.chat_typing_many)
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(horizontal = 20.dp, vertical = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun ConnectionBanner(state: RealtimeState) {
    val text = when (state) {
        RealtimeState.Connecting -> stringResource(R.string.connection_connecting)
        RealtimeState.Reconnecting -> stringResource(R.string.connection_offline)
        RealtimeState.Refused -> stringResource(R.string.error_generic)
        else -> null
    } ?: return

    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp),
        )
    }
}

/**
 * Consecutive messages from one person within a few minutes lose their header,
 * which is what makes a transcript read as conversation rather than as a log.
 */
private fun shouldGroup(previous: Message?, message: Message): Boolean {
    if (previous == null || previous.authorId != message.authorId) return false
    val a = runCatching { Instant.parse(previous.createdAt) }.getOrNull() ?: return false
    val b = runCatching { Instant.parse(message.createdAt) }.getOrNull() ?: return false
    return b.epochSecond - a.epochSecond in 0..300
}

private val TIME_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

@Composable
private fun MessageRow(message: Message, grouped: Boolean) {
    if (message.blocked) return

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = if (grouped) 1.dp else 6.dp),
    ) {
        if (grouped) {
            Spacer(Modifier.width(48.dp))
        } else {
            Avatar(
                name = message.authorName,
                url = message.authorAvatarUrl,
                size = 36.dp,
            )
            Spacer(Modifier.width(12.dp))
        }

        Column(Modifier.weight(1f)) {
            if (!grouped) {
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(
                        text = message.authorName,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = formatTime(message.createdAt),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.height(2.dp))
            }

            message.replyTo?.let { reply ->
                Text(
                    text = "${reply.authorName.orEmpty()} ${reply.excerpt}".trim(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }

            if (message.body.isNotEmpty()) {
                Text(
                    text = if (message.editedAt != null) {
                        message.body + "  " + stringResource(R.string.chat_edited)
                    } else {
                        message.body
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
            }

            message.attachments.forEach { attachment ->
                Spacer(Modifier.height(6.dp))
                if (attachment.isImage) {
                    AsyncImage(
                        model = Backend.absolute(attachment.url),
                        contentDescription = attachment.filename,
                        contentScale = ContentScale.Fit,
                        modifier = Modifier
                            .fillMaxWidth(0.8f)
                            .height(200.dp),
                    )
                } else {
                    Text(
                        text = attachment.filename,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        }
    }
}

private fun formatTime(iso: String): String = runCatching {
    // The server emits `Date.toISOString()`, which always carries
    // milliseconds. `Instant.parse` handles that; a formatter pinned to
    // seconds would fail on literally every message.
    Instant.parse(iso).atZone(ZoneId.systemDefault()).format(TIME_FORMAT)
}.getOrDefault("")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Composer(value: String, onValueChange: (String) -> Unit, onSend: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Column {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .imePadding()
                    .navigationBarsPadding()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                TextField(
                    value = value,
                    onValueChange = onValueChange,
                    placeholder = { Text(stringResource(R.string.chat_composer_hint)) },
                    modifier = Modifier
                        .weight(1f)
                        .testTag("composer.input"),
                    maxLines = 6,
                    shape = RoundedCornerShape(24.dp),
                    colors = TextFieldDefaults.colors(
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                        disabledIndicatorColor = Color.Transparent,
                    ),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { onSend() }),
                )
                FilledIconButton(
                    onClick = onSend,
                    enabled = value.isNotBlank(),
                    modifier = Modifier.testTag("composer.send"),
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.Send,
                        contentDescription = stringResource(R.string.chat_send),
                    )
                }
            }
        }
    }
}
