package gg.pqp.app.ui.screens

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.platform.LocalContext
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
import gg.pqp.app.attachments.ATTACHMENT_MIME_ALLOWLIST
import gg.pqp.app.attachments.AttachmentRefusal
import gg.pqp.app.attachments.ComposerReadiness
import gg.pqp.app.attachments.ContentAttachmentFiles
import gg.pqp.app.attachments.MAX_ATTACHMENTS_PER_MESSAGE
import gg.pqp.app.attachments.PendingAttachment
import gg.pqp.app.attachments.composerReadiness
import gg.pqp.app.attachments.formatAttachmentSize
import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.Message
import gg.pqp.app.core.Reaction
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
import gg.pqp.app.ui.media.GifLinks
import gg.pqp.app.ui.media.InlineGif
import gg.pqp.app.ui.media.MessageAttachment
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
    val context = LocalContext.current
    // Built from the application context, so the reader outlives this
    // composition without holding the Activity that started it.
    val files = remember(context) { ContentAttachmentFiles(context) }
    val model: ChatViewModel = viewModel(
        key = channelId,
        factory = ChatViewModel.factory(session, channelId, files),
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
    // The long press opens this; "Report" inside it is what sets `reporting`.
    var acting by remember { mutableStateOf<Message?>(null) }

    // So an incoming `reaction-broadcast` naming us can mark its own pill.
    // Set from the session rather than inferred, because a reaction of ours
    // made on another device arrives here as somebody else's frame.
    LaunchedEffect(me?.id) { model.setCurrentUser(me?.id) }

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
                    attachmentsEnabled = state.attachmentsEnabled,
                    attachments = state.attachments,
                    refusal = state.attachmentRefusal,
                    maxAttachmentBytes = state.maxAttachmentBytes,
                    onAttach = model::attach,
                    onRemoveAttachment = model::removeAttachment,
                    onRetryAttachment = model::retryAttachment,
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
                                onOpenActions = { acting = message },
                                onToggleReaction = { emoji ->
                                    model.toggleReaction(message.id, emoji, me)
                                },
                                // Only reached when a video attachment's
                                // presigned URL has expired, which is why it is
                                // the client and not a callback: nothing here
                                // knows the id to re-mint until a player fails.
                                api = session.api,
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
     * A long press on a message opens what can be done to it.
     *
     * It used to go straight to the report sheet, because reporting was the
     * only thing a message row could do and Play requires a way to report
     * user-generated content from inside the app. Reacting is the second thing,
     * and it needed the same gesture: a phone has no hover, so there is nowhere
     * else on a message row for an affordance to live without putting a button
     * on every line of the transcript.
     *
     * Report keeps its own entry in the sheet and its own sheet behind it. It
     * is a Play requirement rather than a feature, and burying it inside a menu
     * with no label would be the way to lose it.
     */
    acting?.let { message ->
        MessageActionsSheet(
            message = message,
            onReact = { emoji ->
                model.toggleReaction(message.id, emoji, me)
                acting = null
            },
            onReport = {
                reporting = message
                acting = null
            },
            onDismiss = { acting = null },
        )
    }

    /*
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
private fun MessageRow(
    message: Message,
    grouped: Boolean,
    onOpenActions: () -> Unit,
    onToggleReaction: (String) -> Unit,
    api: ApiClient,
) {
    if (message.blocked) return

    // `onLongClickLabel` is what puts the gesture in TalkBack's actions menu,
    // which is the only place it is discoverable without a visible affordance.
    val longPressLabel = stringResource(R.string.chat_message_actions)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = {},
                onLongClick = onOpenActions,
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

            // A body that is nothing but a GIF link is the picture, not the
            // link. Both other clients do this (`gifMessageMedia` on the web),
            // and without it a pasted Tenor URL reads on Android as a hundred
            // characters of text where everyone else sees a GIF move. See
            // `GifLinks` for the allowlist and why there is one.
            val gifBody = remember(message.body) { GifLinks.mediaBody(message.body) }

            if (gifBody != null) {
                Spacer(Modifier.height(Spacing.xs))
                InlineGif(gifBody)
            } else if (message.body.isNotEmpty()) {
                Text(
                    text = bodyWithEditMark(message),
                    style = MaterialTheme.typography.bodyLarge,
                )
            }

            message.attachments.forEach { attachment ->
                Spacer(Modifier.height(Spacing.sm))
                MessageAttachment(attachment = attachment, api = api)
            }

            ReactionRow(message.reactions, onToggleReaction)
        }
    }
}

/**
 * The pills under a message.
 *
 * A `FlowRow` because the count is unbounded: eight people can each pick a
 * different emoji, and a single row would push the last of them off the screen
 * on a phone. Nothing is drawn at all when there are none, so an ordinary
 * transcript is exactly as dense as it was.
 *
 * Tapping a pill toggles that emoji, which is the whole interaction. Adding a
 * *new* one lives behind the long press, because a phone has no hover and an
 * always-visible "add reaction" button on every line is a button on every line.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ReactionRow(reactions: List<Reaction>, onToggle: (String) -> Unit) {
    if (reactions.isEmpty()) return

    FlowRow(
        modifier = Modifier.padding(top = Spacing.xs),
        horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        reactions.forEach { reaction ->
            val mine = reaction.me
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .clip(MaterialTheme.shapes.small)
                    .background(
                        if (mine) {
                            MaterialTheme.colorScheme.primaryContainer
                        } else {
                            MaterialTheme.colorScheme.surfaceContainer
                        },
                    )
                    .border(
                        width = Sizes.hairline,
                        // Ours is outlined as well as filled. Fill alone is not
                        // enough of a difference at this size, and "did my
                        // reaction land" is the only question this control has
                        // to answer.
                        color = if (mine) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.outline
                        },
                        shape = MaterialTheme.shapes.small,
                    )
                    .clickable { onToggle(reaction.emoji) }
                    .padding(horizontal = Spacing.sm, vertical = 2.dp),
            ) {
                Text(text = reaction.emoji, style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.width(Spacing.xs))
                Text(
                    text = reaction.count.toString(),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (mine) {
                        MaterialTheme.colorScheme.onPrimaryContainer
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }
        }
    }
}

/**
 * What a long press on a message offers.
 *
 * Two things, and the second is not optional: Play requires a way to report
 * user-generated content from inside the app, so "Report message" is a labelled
 * row rather than an icon somewhere in the emoji strip.
 *
 * The quick set is [QUICK_REACTIONS], which is the web client's list in the web
 * client's order. A channel with two clients in it must not have two different
 * vocabularies.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun MessageActionsSheet(
    message: Message,
    onReact: (String) -> Unit,
    onReport: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = Modifier.testTag("message.actions"),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(bottom = Spacing.lg),
        ) {
            FlowRow(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Spacing.gutter),
                horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
                verticalArrangement = Arrangement.spacedBy(Spacing.sm),
            ) {
                QUICK_REACTIONS.forEach { emoji ->
                    val mine = message.reactions.any { it.emoji == emoji && it.me }
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier
                            .size(48.dp)
                            .clip(MaterialTheme.shapes.small)
                            .background(
                                if (mine) {
                                    MaterialTheme.colorScheme.primaryContainer
                                } else {
                                    MaterialTheme.colorScheme.surfaceContainer
                                },
                            )
                            .clickable { onReact(emoji) },
                    ) {
                        Text(text = emoji, style = MaterialTheme.typography.titleMedium)
                    }
                }
            }

            Spacer(Modifier.height(Spacing.md))
            ChromeDivider()

            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onReport)
                    .padding(horizontal = Spacing.gutter, vertical = Spacing.md),
            ) {
                Icon(
                    imageVector = PqpIcons.Warning,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(Sizes.iconAction),
                )
                Spacer(Modifier.width(Spacing.md))
                Text(
                    text = stringResource(R.string.report_message_long_press),
                    style = MaterialTheme.typography.bodyLarge,
                )
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
private fun Composer(
    value: String,
    onValueChange: (String) -> Unit,
    onSend: () -> Unit,
    attachmentsEnabled: Boolean,
    attachments: List<PendingAttachment>,
    refusal: AttachmentRefusal?,
    maxAttachmentBytes: Long,
    onAttach: (String) -> Unit,
    onRemoveAttachment: (String) -> Unit,
    onRetryAttachment: (String) -> Unit,
) {
    // Whether there is anything to send, which is the one thing this whole
    // surface animates on. It is no longer "is there text": a message may be
    // nothing but a picture, and it may not go while an upload is still
    // running or has failed.
    val readiness = composerReadiness(value, attachments)
    val active = readiness == ComposerReadiness.Ready

    // `OpenMultipleDocuments` rather than `PickVisualMedia`: the allowlist is
    // not only pictures, and a chat app that can send a photo but not a PDF has
    // solved the easy half. The MIME filter is the allowlist itself, so the
    // picker refuses what the server would refuse, in the place where a refusal
    // is still just a greyed-out file.
    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        uris.take(MAX_ATTACHMENTS_PER_MESSAGE).forEach { onAttach(it.toString()) }
    }
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
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .imePadding()
                .navigationBarsPadding(),
        ) {
            AttachmentRefusalLine(refusal, maxAttachmentBytes)
            AttachmentStrip(attachments, onRemoveAttachment, onRetryAttachment)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Spacing.md, vertical = Spacing.sm),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
            ) {
            if (attachmentsEnabled) {
                IconButton(
                    onClick = { picker.launch(ATTACHMENT_MIME_ALLOWLIST.toTypedArray()) },
                    enabled = attachments.size < MAX_ATTACHMENTS_PER_MESSAGE,
                    modifier = Modifier.testTag("composer.attach"),
                ) {
                    Icon(
                        PqpIcons.Attach,
                        contentDescription = stringResource(R.string.chat_attach),
                        modifier = Modifier.size(Sizes.iconAction),
                    )
                }
            }
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
                // `readiness`, not "is there text". A message may be nothing
                // but a picture, and it may not go while an upload is still
                // running. Gating this on the draft alone painted the button
                // lime for an attachment-only message and then swallowed every
                // tap on it, which is the worst of both answers.
                enabled = active,
                modifier = Modifier.testTag("composer.send"),
                // The disabled pair is the same animated pair on purpose. The
                // button is disabled exactly while there is nothing to send,
                // and Material's default disabled fill is a translucent grey
                // that reads as broken rather than as waiting.
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
}

/**
 * Why the last pick did not become an attachment.
 *
 * On the composer rather than in a snackbar: the refusal is about the thing the
 * person is looking at, and a snackbar that has already gone by the time they
 * look up answers nothing. Every branch names the actual limit, because "that
 * did not work" is the sentence this line exists to replace.
 */
@Composable
private fun AttachmentRefusalLine(refusal: AttachmentRefusal?, maxAttachmentBytes: Long) {
    AnimatedVisibility(
        visible = refusal != null,
        enter = expandVertically(),
        exit = shrinkVertically(),
    ) {
        Text(
            text = when (refusal) {
                AttachmentRefusal.TooLarge -> stringResource(
                    R.string.chat_attachment_too_large,
                    formatAttachmentSize(maxAttachmentBytes),
                )

                AttachmentRefusal.UnsupportedType ->
                    stringResource(R.string.chat_attachment_unsupported)

                AttachmentRefusal.TooMany -> stringResource(
                    R.string.chat_attachment_too_many,
                    MAX_ATTACHMENTS_PER_MESSAGE,
                )

                AttachmentRefusal.Unreadable, null ->
                    stringResource(R.string.chat_attachment_unreadable)
            },
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.padding(
                start = Spacing.md,
                end = Spacing.md,
                top = Spacing.sm,
            ),
        )
    }
}

/**
 * The files waiting to go, above the box they will go with.
 *
 * A row that scrolls rather than a grid that grows: the composer must not eat
 * the transcript, and ten attachments is a legal message. Each chip carries its
 * own state, because they upload independently and one failing says nothing
 * about the rest.
 */
@Composable
private fun AttachmentStrip(
    attachments: List<PendingAttachment>,
    onRemove: (String) -> Unit,
    onRetry: (String) -> Unit,
) {
    AnimatedVisibility(
        visible = attachments.isNotEmpty(),
        enter = expandVertically(),
        exit = shrinkVertically(),
    ) {
        LazyRow(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = Spacing.md, vertical = Spacing.sm),
            horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            items(attachments, key = { it.localId }) { attachment ->
                AttachmentChip(attachment, onRemove, onRetry)
            }
        }
    }
}

@Composable
private fun AttachmentChip(
    attachment: PendingAttachment,
    onRemove: (String) -> Unit,
    onRetry: (String) -> Unit,
) {
    val shape = MaterialTheme.shapes.medium
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = shape,
        modifier = Modifier
            .heightIn(min = 56.dp)
            // Tapping a failed chip retries it. Nothing else about a chip is
            // tappable, so the gesture is unambiguous and the alternative is
            // making somebody remove and re-pick the same file.
            .clickable(enabled = attachment.failed) { onRetry(attachment.localId) },
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
            modifier = Modifier.padding(
                start = if (attachment.isImage) 0.dp else Spacing.md,
                end = Spacing.xs,
            ),
        ) {
            if (attachment.isImage) {
                // The local URI, not a presigned GET: the bytes are on the
                // phone and this is drawn before anything has been uploaded.
                AsyncImage(
                    model = attachment.uri,
                    contentDescription = attachment.filename,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier
                        .size(56.dp)
                        .clip(shape),
                )
            }
            Column(
                modifier = Modifier
                    .widthIn(max = 160.dp)
                    .padding(vertical = Spacing.sm),
            ) {
                Text(
                    text = attachment.filename,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = when {
                        attachment.failed -> stringResource(R.string.chat_attachment_failed)
                        attachment.uploading -> stringResource(R.string.chat_attachment_uploading)
                        else -> formatAttachmentSize(attachment.byteSize)
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = if (attachment.failed) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    maxLines = 1,
                )
            }
            when {
                attachment.uploading -> CircularProgressIndicator(
                    strokeWidth = 2.dp,
                    modifier = Modifier.size(Sizes.iconInline),
                )

                attachment.failed -> Icon(
                    PqpIcons.Retry,
                    contentDescription = stringResource(
                        R.string.chat_attachment_retry,
                        attachment.filename,
                    ),
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(Sizes.iconInline),
                )

                else -> Unit
            }
            IconButton(onClick = { onRemove(attachment.localId) }) {
                Icon(
                    PqpIcons.Close,
                    contentDescription = stringResource(
                        R.string.chat_attachment_remove,
                        attachment.filename,
                    ),
                    tint = LocalContentColor.current,
                    modifier = Modifier.size(Sizes.iconInline),
                )
            }
        }
    }
}
