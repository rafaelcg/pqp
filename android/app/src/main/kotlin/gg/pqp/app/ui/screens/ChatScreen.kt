package gg.pqp.app.ui.screens

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
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
import gg.pqp.app.reports.ReportTarget
import gg.pqp.app.reports.ui.ReportSheet
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.components.ChromeDivider
import gg.pqp.app.ui.components.EmptyState
import gg.pqp.app.ui.components.pqpTopBarColors
import gg.pqp.app.ui.theme.Motion
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.ui.theme.TabularFigures
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
    var reporting by remember { mutableStateOf<Message?>(null) }

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
                    // known yet; "#" on its own is not a title. The glyph is
                    // therefore tied to the same condition as the name it
                    // labels: a conversation passes a person's name and gets no
                    // hash, and an unknown channel gets the placeholder alone.
                    title = {
                        val known = channelName.isNotBlank()
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (title == null && known) {
                                Icon(
                                    imageVector = PqpIcons.TextChannel,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.size(Sizes.iconInline),
                                )
                                Spacer(Modifier.width(Spacing.sm))
                            }
                            Text(
                                text = title
                                    ?: if (known) channelName else stringResource(R.string.chat_untitled),
                                style = MaterialTheme.typography.titleLarge,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    },
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Icon(
                                PqpIcons.Back,
                                contentDescription = stringResource(R.string.chat_back),
                                modifier = Modifier.size(Sizes.iconAction),
                            )
                        }
                    },
                    colors = pqpTopBarColors(),
                )
                ChromeDivider()
                ConnectionBanner(connection)
            }
        },
        bottomBar = {
            Column {
                // The one hairline this end of the screen gets, and it is above
                // everything that stands on the composer's surface rather than
                // between the two halves of it: the typing strip and the
                // composer are one continuous piece of chrome.
                ChromeDivider()
                TypingStrip(state.typing)
                Composer(
                    value = draft,
                    onValueChange = {
                        draft = it
                        if (it.isNotEmpty()) model.typing()
                    },
                    onSend = {
                        // Cleared only once the frame has actually left the
                        // phone. A send during a reconnect returns false, and
                        // swallowing the box's contents there is how somebody
                        // loses a sentence they watched themselves type.
                        if (model.send(draft, me)) draft = ""
                    },
                )
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                state.loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator()
                }

                // A history fetch that failed is not an empty channel, and
                // saying "Nothing here yet. Say something." to somebody whose
                // transcript just failed to load invites them to retype a
                // conversation that is still there. `loadInitial` has recorded
                // the reason since it was written and nothing read it, so the
                // one screen that could tell the truth showed the one sentence
                // guaranteed to be wrong. The alert icon carries the same
                // distinction to anyone reading the shape before the words.
                state.messages.isEmpty() && state.error != null -> EmptyState(
                    text = stringResource(R.string.chat_load_failed, state.error.orEmpty()),
                    icon = PqpIcons.Warning,
                )

                state.messages.isEmpty() -> EmptyState(
                    text = stringResource(R.string.chat_empty),
                    icon = PqpIcons.Messages,
                )

                else -> {
                    // Reversed so the newest message is index 0 and the list
                    // starts pinned to the bottom without measuring anything.
                    val rows = remember(state.messages) { state.messages.asReversed() }

                    LazyColumn(
                        state = listState,
                        reverseLayout = true,
                        contentPadding = PaddingValues(vertical = Spacing.md),
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
                                onReport = { reporting = message },
                            )
                        }

                        if (state.hasMore) {
                            item(key = "older") {
                                LaunchedEffect(Unit) { model.loadOlder() }
                                Box(
                                    Modifier.fillMaxWidth().padding(Spacing.gutter),
                                    contentAlignment = Alignment.Center,
                                ) { CircularProgressIndicator(Modifier.width(24.dp)) }
                            }
                        }
                    }
                }
            }
        }
    }

    /*
     * A long press on a message reports it.
     *
     * The one interaction a message row has, deliberately: Play requires a way
     * to report user-generated content from inside the app, and this screen
     * had no per-message gesture at all. It is not the start of a general
     * message action menu.
     *
     * The sheet hangs off the screen rather than off the row that opened it,
     * so scrolling the list underneath cannot tear it down mid-report. Nothing
     * about the channel travels with it: the server reads the channel, and
     * therefore the server or the conversation this belongs to, off the
     * message itself, which is what stops a client aiming a report at the
     * wrong moderators.
     */
    reporting?.let { message ->
        ReportSheet(
            api = session.api,
            target = ReportTarget.Message(
                messageId = message.id,
                authorName = message.authorName,
            ),
            onDismiss = { reporting = null },
        )
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

    // Connecting is a fact and the other two are a problem, so only the other
    // two are marked. A warning glyph on the first second of every launch would
    // be crying wolf, and then nobody reads the strip that matters.
    val warn = state == RealtimeState.Reconnecting || state == RealtimeState.Refused

    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = Spacing.gutter, vertical = Spacing.xs + 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (warn) {
                Icon(
                    imageVector = PqpIcons.Warning,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.width(Spacing.sm))
            }
            Text(
                text = text,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * Who is mid-sentence, on its own strip immediately above the composer.
 *
 * It used to float over the bottom of the transcript, which meant the newest
 * message, the one somebody is most likely reading, was the one it covered.
 * A strip costs a row of height only while somebody is actually typing, and it
 * stands on the composer's own surface so the two read as one piece of chrome
 * rather than as a caption that landed on the wrong sheet.
 */
@Composable
private fun TypingStrip(typing: Set<String>) {
    val names = typing.takeIf { it.isNotEmpty() } ?: return

    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Text(
            text = if (names.size == 1) {
                stringResource(R.string.chat_typing_one, names.first())
            } else {
                stringResource(R.string.chat_typing_many)
            },
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = Spacing.gutter, vertical = Spacing.xs),
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

/**
 * How far in from the page gutter a message's text starts: the avatar, then the
 * gutter between it and the words. Derived rather than written as 48 so that a
 * grouped row, which draws nothing where the avatar was, cannot drift off the
 * column its own header sits on the day somebody changes `Sizes.avatarRow`.
 */
private val TEXT_COLUMN_INSET = Sizes.avatarRow + Spacing.md

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageRow(message: Message, grouped: Boolean, onReport: () -> Unit) {
    if (message.blocked) return

    // `onLongClickLabel` is what puts "Report this message" in TalkBack's
    // actions menu, which is the only place the gesture is discoverable
    // without a visible affordance.
    val longPressLabel = stringResource(R.string.report_message_long_press)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = {},
                onLongClick = onReport,
                onLongClickLabel = longPressLabel,
            )
            // Above only. A transcript's rhythm is the gap before a new
            // speaker, and padding both ends doubles every one of those gaps
            // into something that reads as a list of cards.
            .padding(
                start = Spacing.gutter,
                end = Spacing.gutter,
                top = if (grouped) 2.dp else Spacing.xs + 2.dp,
            ),
    ) {
        if (grouped) {
            Spacer(Modifier.width(TEXT_COLUMN_INSET))
        } else {
            Avatar(
                name = message.authorName,
                url = message.authorAvatarUrl,
                size = Sizes.avatarRow,
                // The id, not the name. Two people called "Ana" are two
                // colours, and one person who renames themselves keeps theirs.
                seed = message.authorId,
            )
            Spacer(Modifier.width(Spacing.md))
        }

        Column(Modifier.weight(1f)) {
            if (!grouped) {
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(
                        text = message.authorName,
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Spacer(Modifier.width(Spacing.sm))
                    Text(
                        text = formatTime(message.createdAt),
                        // Tabular, because a column of clock times beside a
                        // column of names is exactly the case proportional
                        // digits ruin: 11:11 and 10:04 should be the same width.
                        //
                        // `labelMedium`, not `labelSmall`: the small role
                        // carries 1.1sp of tracking because it is the app's
                        // uppercase section rule, and that tracking on a
                        // lowercase 12:04 reads as a gap between the digits.
                        style = MaterialTheme.typography.labelMedium
                            .copy(fontFeatureSettings = TabularFigures),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.height(2.dp))
            }

            message.replyTo?.let { reply ->
                Row(
                    modifier = Modifier
                        .height(IntrinsicSize.Min)
                        .padding(bottom = 2.dp),
                ) {
                    // The rule is what says "quoted" rather than "first
                    // sentence". `primaryContainer` is the scheme's spelling of
                    // SignalDim, so it dims with the palette in light mode
                    // instead of staying a dark lime on white paper.
                    Box(
                        Modifier
                            .width(2.dp)
                            .fillMaxHeight()
                            .background(MaterialTheme.colorScheme.primaryContainer),
                    )
                    Spacer(Modifier.width(Spacing.sm))
                    Text(
                        text = "${reply.authorName.orEmpty()} ${reply.excerpt}".trim(),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            if (message.body.isNotEmpty()) {
                Text(
                    text = bodyWithEditMark(message),
                    style = MaterialTheme.typography.bodyLarge,
                )
            }

            message.attachments.forEach { attachment ->
                Spacer(Modifier.height(Spacing.sm))
                if (attachment.isImage) {
                    AsyncImage(
                        model = Backend.absolute(attachment.url),
                        contentDescription = attachment.filename,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier
                            .fillMaxWidth(0.8f)
                            // A frame with a floor and a ceiling rather than one
                            // fixed height: the floor is what the picture loads
                            // into, so the transcript does not jump when it
                            // arrives, and the ceiling is what stops a tall
                            // screenshot owning the whole screen.
                            .heightIn(min = 120.dp, max = 260.dp)
                            .clip(MaterialTheme.shapes.medium)
                            .background(MaterialTheme.colorScheme.surfaceContainer)
                            .border(
                                width = Sizes.hairline,
                                color = MaterialTheme.colorScheme.outline,
                                shape = MaterialTheme.shapes.medium,
                            ),
                    )
                } else {
                    // A chip, and deliberately not lime. Lime means "act on
                    // this"; a file somebody attached is a thing, not an action,
                    // and colouring it like a link is what made the old row look
                    // like the only tappable object on the screen.
                    Row(
                        modifier = Modifier
                            .clip(MaterialTheme.shapes.small)
                            .background(MaterialTheme.colorScheme.surfaceContainer)
                            .padding(horizontal = Spacing.md, vertical = Spacing.sm),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            imageVector = PqpIcons.Attach,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(Sizes.iconInline),
                        )
                        Spacer(Modifier.width(Spacing.sm))
                        Text(
                            text = attachment.filename,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurface,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

/**
 * The body, with the edit mark as its own muted piece rather than two spaces
 * and a word glued onto the end of what somebody wrote.
 *
 * One `Text`, so the mark still wraps with the last line instead of hanging on
 * a row of its own, and a span style rather than a nested composable, so a
 * message that ends mid-line does not push the mark to the next one.
 */
@Composable
private fun bodyWithEditMark(message: Message): AnnotatedString {
    if (message.editedAt == null) return AnnotatedString(message.body)

    val mark = stringResource(R.string.chat_edited)
    val style = MaterialTheme.typography.labelMedium
        .toSpanStyle()
        .copy(color = MaterialTheme.colorScheme.onSurfaceVariant)

    return buildAnnotatedString {
        append(message.body)
        append(" ")
        withStyle(style) { append(mark) }
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
    // Whether there is anything to send, which is the one thing this whole
    // surface animates on.
    val active = value.isNotBlank()
    val sendContainer by animateColorAsState(
        targetValue = if (active) {
            MaterialTheme.colorScheme.primary
        } else {
            MaterialTheme.colorScheme.surfaceContainerHigh
        },
        animationSpec = tween(Motion.QUICK_MILLIS),
        label = "composer-send-container",
    )
    val sendContent by animateColorAsState(
        targetValue = if (active) {
            MaterialTheme.colorScheme.onPrimary
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        },
        animationSpec = tween(Motion.QUICK_MILLIS),
        label = "composer-send-content",
    )

    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .imePadding()
                .navigationBarsPadding()
                .padding(horizontal = Spacing.md, vertical = Spacing.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            TextField(
                value = value,
                onValueChange = onValueChange,
                placeholder = {
                    Text(
                        text = stringResource(R.string.chat_composer_hint),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                },
                modifier = Modifier
                    .weight(1f)
                    // Material floors a text field at 56dp, which is a form
                    // field's height and half again what one line of 15sp
                    // needs. The floor is only applied when nothing above has
                    // asked for a minimum, so asking for one here is how the
                    // pill gets to be the height of its own contents.
                    .heightIn(min = 44.dp)
                    .testTag("composer.input"),
                textStyle = MaterialTheme.typography.bodyLarge,
                maxLines = 6,
                shape = MaterialTheme.shapes.extraLarge,
                colors = TextFieldDefaults.colors(
                    // One container colour in every state. A field that changes
                    // shade on focus is a second thing moving on a surface that
                    // already has the send button waking up on it.
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    disabledContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    focusedTextColor = MaterialTheme.colorScheme.onSurface,
                    unfocusedTextColor = MaterialTheme.colorScheme.onSurface,
                    cursorColor = MaterialTheme.colorScheme.primary,
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
                // The disabled pair is the same animated pair on purpose. The
                // button is disabled exactly while the draft is empty, and
                // Material's default disabled fill is a translucent grey that
                // reads as broken rather than as waiting.
                colors = IconButtonDefaults.filledIconButtonColors(
                    containerColor = sendContainer,
                    contentColor = sendContent,
                    disabledContainerColor = sendContainer,
                    disabledContentColor = sendContent,
                ),
            ) {
                Icon(
                    PqpIcons.Send,
                    contentDescription = stringResource(R.string.chat_send),
                    modifier = Modifier.size(Sizes.iconAction),
                )
            }
        }
    }
}
