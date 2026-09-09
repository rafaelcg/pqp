package gg.pqp.app.ui.screens

import android.os.SystemClock
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
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
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
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
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
import gg.pqp.app.core.Gif
import gg.pqp.app.core.Message
import gg.pqp.app.core.Reaction
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.push.VisibleChannel
import gg.pqp.app.reports.ReportTarget
import gg.pqp.app.reports.ui.ReportSheet
import gg.pqp.app.ui.chat.ChanceCard
import gg.pqp.app.ui.chat.ComposerTarget
import gg.pqp.app.ui.chat.DayLabel
import gg.pqp.app.ui.chat.DayLabels
import gg.pqp.app.ui.chat.MentionAutocomplete
import gg.pqp.app.ui.chat.MentionCandidate
import gg.pqp.app.ui.chat.MessageBody
import gg.pqp.app.ui.chat.MessagePermissions
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
import kotlinx.coroutines.delay

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
    /**
     * The channel's slow mode in seconds, 0 when off or when the caller does
     * not know (a notification tap, a conversation). Only ever a head start:
     * the server's `message-rejected` corrects the countdown if this is stale.
     */
    slowmodeSeconds: Int = 0,
    /**
     * The server this channel belongs to, when the caller knows it. It decides
     * who may delete somebody else's message and who may pin, and whose names
     * `@` completes to. Null in a conversation, and null for a channel opened
     * from a notification tap, which carries ids and no membership.
     */
    serverId: String? = null,
    /**
     * Actions for the app bar's trailing edge. A conversation puts the call
     * button here; a server channel has nothing to add. A slot rather than a
     * flag, so that this screen does not have to know what a call is.
     */
    actions: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit = {},
) {
    val context = LocalContext.current
    // Built from the application context, so the reader outlives this
    // composition without holding the Activity that started it.
    val files = remember(context) { ContentAttachmentFiles(context) }
    val model: ChatViewModel = viewModel(
        key = channelId,
        factory = ChatViewModel.factory(session, channelId, files, slowmodeSeconds, serverId),
    )
    val state by model.state.collectAsStateWithLifecycle()
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
    // A `TextFieldValue` rather than a String, because the caret is now
    // load-bearing: the mention menu is keyed to the token under it, and
    // picking a name has to leave the caret after what it inserted.
    var draft by remember { mutableStateOf(TextFieldValue("")) }

    // The server refused a send: the words come back to the box. The box was
    // cleared when the frame left, so without this the only copy of the
    // sentence was the optimistic row that just came down. Anything typed
    // since is kept underneath rather than overwritten, because losing text is
    // the exact failure this hand-off exists to prevent.
    LaunchedEffect(state.restoredDraft) {
        val body = state.restoredDraft ?: return@LaunchedEffect
        val restored = if (draft.text.isBlank()) body else "$body\n${draft.text}"
        draft = TextFieldValue(restored, TextRange(restored.length))
        model.draftRestored()
    }

    var reporting by remember { mutableStateOf<Message?>(null) }
    // The long press opens this; "Report" inside it is what sets `reporting`.
    var acting by remember { mutableStateOf<Message?>(null) }
    var showingPins by remember { mutableStateOf(false) }
    var pickingGif by remember { mutableStateOf(false) }
    val composerFocus = remember { FocusRequester() }

    // Editing loads the message into the box, which is how a phone offers an
    // edit without a second screen. Cancelling puts back whatever was in the
    // box, so an edit started by mistake does not eat a half-written draft.
    var draftBeforeEdit by remember { mutableStateOf<TextFieldValue?>(null) }
    LaunchedEffect(state.composer) {
        when (val target = state.composer) {
            is ComposerTarget.Edit -> {
                if (draftBeforeEdit == null) draftBeforeEdit = draft
                draft = TextFieldValue(target.message.body, TextRange(target.message.body.length))
                runCatching { composerFocus.requestFocus() }
            }

            is ComposerTarget.Reply -> runCatching { composerFocus.requestFocus() }

            ComposerTarget.New -> {
                draftBeforeEdit?.let {
                    draft = it
                    draftBeforeEdit = null
                }
            }
        }
    }

    val mentionQuery = remember(draft) {
        MentionAutocomplete.find(draft.text, draft.selection.start)
    }
    val mentionMatches = remember(mentionQuery, state.members) {
        mentionQuery?.let { MentionAutocomplete.filter(state.members, it.query) }.orEmpty()
    }

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
                    actions = {
                        IconButton(
                            onClick = {
                                model.loadPins()
                                showingPins = true
                            },
                            modifier = Modifier.testTag("chat.pins"),
                        ) {
                            Icon(
                                PqpIcons.Pin,
                                contentDescription = stringResource(R.string.chat_pins),
                                modifier = Modifier.size(Sizes.iconAction),
                            )
                        }
                        // Whatever the caller adds sits to the right of pins:
                        // a conversation's call button, and nothing at all in
                        // a server channel.
                        actions()
                    },
                    colors = pqpTopBarColors(),
                )
                ChromeDivider()
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
                MentionMenu(mentionMatches) { candidate ->
                    val username = candidate.username
                    val query = mentionQuery
                    if (username != null && query != null) {
                        val (next, caret) = MentionAutocomplete.apply(draft.text, query, username)
                        draft = TextFieldValue(next, TextRange(caret))
                    }
                }
                ComposerTargetStrip(
                    target = state.composer,
                    onCancel = model::cancelComposerTarget,
                )
                Composer(
                    value = draft,
                    onValueChange = {
                        draft = it
                        if (it.text.isNotEmpty()) model.typing()
                    },
                    onSend = {
                        // Cleared only once the frame has actually left the
                        // phone. A send during a reconnect returns false, and
                        // swallowing the box's contents there is how somebody
                        // loses a sentence they watched themselves type.
                        //
                        // An edit takes the same path: `send` routes it to
                        // `saveEdit`, which answers true because the request
                        // is on its way and the box has done its job.
                        if (model.send(draft.text, me)) {
                            draft = TextFieldValue("")
                            draftBeforeEdit = null
                        }
                    },
                    editing = state.composer is ComposerTarget.Edit,
                    gifsEnabled = state.gifsEnabled,
                    onOpenGifs = {
                        model.searchGifs("")
                        pickingGif = true
                    },
                    focusRequester = composerFocus,
                    attachmentsEnabled = state.attachmentsEnabled,
                    attachments = state.attachments,
                    refusal = state.attachmentRefusal,
                    sendRefusal = state.sendRefusal,
                    holdUntilMs = state.sendHoldUntilMs,
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
                            // A new calendar day opens with a row that says
                            // which day, the way the web transcript does. The
                            // oldest loaded message always opens one: the day
                            // has to be named somewhere above the first thing
                            // said in it, and the row moves up when older
                            // history arrives.
                            val startsDay = previous == null ||
                                !DayLabels.isSameDay(previous.createdAt, message.createdAt)
                            // One item, not two: the separator belongs to the
                            // message that opens the day, and keying it on the
                            // message keeps it from being recycled apart from it.
                            Column {
                                if (startsDay) DaySeparator(message.createdAt)
                                MessageRow(
                                    message = message,
                                    grouped = !startsDay && shouldGroup(previous, message),
                                    selfUsername = me?.username,
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
        // The role is `admin` or nothing: the view model has already resolved
        // owner-or-admin into one boolean, and the two are the same answer to
        // every question a message can ask (`canManageMessages` in
        // `packages/shared/src/moderation.ts` is a flat manager check).
        val role = if (state.canManage) "admin" else null
        MessageActionsSheet(
            message = message,
            canEdit = MessagePermissions.canEdit(message, me?.id),
            canDelete = MessagePermissions.canDelete(
                message = message,
                meId = me?.id,
                role = role,
                isServerChannel = state.isServerChannel,
            ),
            canPin = MessagePermissions.canPin(role, state.isServerChannel),
            onReact = { emoji ->
                model.toggleReaction(message.id, emoji, me)
                acting = null
            },
            onReply = {
                model.reply(message)
                acting = null
            },
            onEdit = {
                model.edit(message)
                acting = null
            },
            onDelete = {
                model.delete(message.id)
                acting = null
            },
            onTogglePin = {
                if (message.pinnedAt == null) model.pin(message.id) else model.unpin(message.id)
                acting = null
            },
            onReport = {
                reporting = message
                acting = null
            },
            onDismiss = { acting = null },
        )
    }

    if (showingPins) {
        PinnedSheet(
            pinned = state.pinned,
            loaded = state.pinnedLoaded,
            canUnpin = MessagePermissions.canPin(
                role = if (state.canManage) "admin" else null,
                isServerChannel = state.isServerChannel,
            ),
            selfUsername = me?.username,
            onUnpin = model::unpin,
            onDismiss = { showingPins = false },
        )
    }

    if (pickingGif) {
        GifPickerSheet(
            gifs = state.gifs,
            loading = state.gifsLoading,
            onSearch = model::searchGifs,
            onPick = { gif ->
                model.stageGif(gif)
                pickingGif = false
            },
            onDismiss = { pickingGif = false },
        )
    }

    /*
     * An edit, a delete or a pin the server refused, in the server's own
     * words. It is the only thing on this screen that fails leaving no other
     * trace: the message simply does not change, and somebody told nothing
     * tries again.
     */
    state.actionError?.let { error ->
        ActionErrorDialog(error, model::clearActionError)
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
 * The row that names a day.
 *
 * Between two hairlines rather than on a pill, because a pill is what a message
 * bubble would be and this is not a message: it is the transcript's own rule,
 * the same one the web draws. The time on each message stays where it is; this
 * only says which day those times belong to.
 */
@Composable
private fun DaySeparator(iso: String) {
    val label = when (val day = DayLabels.labelFor(iso)) {
        DayLabel.Today -> stringResource(R.string.chat_day_today)
        DayLabel.Yesterday -> stringResource(R.string.chat_day_yesterday)
        is DayLabel.Dated -> day.text
        null -> return
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.gutter, vertical = Spacing.md)
            .testTag("day-separator"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ChromeDivider(Modifier.weight(1f))
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = Spacing.md),
        )
        ChromeDivider(Modifier.weight(1f))
    }
}

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
    /** The reader's own `username`, so a mention of them can be marked. */
    selfUsername: String?,
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
                    if (message.pinnedAt != null) {
                        Spacer(Modifier.width(Spacing.sm))
                        Icon(
                            imageVector = PqpIcons.Pin,
                            contentDescription = stringResource(R.string.chat_pinned),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(14.dp),
                        )
                    }
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
                        .padding(bottom = 2.dp)
                        .testTag("message.reply"),
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
            } else if (message.chance != null) {
                Spacer(Modifier.height(Spacing.xs))
                ChanceCard(message.chance)
            } else if (message.body.isNotEmpty()) {
                MessageBody(
                    body = message.body,
                    editedMark = message.editedAt?.let { stringResource(R.string.chat_edited) },
                    selfUsername = selfUsername,
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
    canEdit: Boolean,
    canDelete: Boolean,
    canPin: Boolean,
    onReact: (String) -> Unit,
    onReply: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onTogglePin: () -> Unit,
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

            SheetAction(
                icon = PqpIcons.Reply,
                label = stringResource(R.string.chat_reply),
                testTag = "message.reply-action",
                onClick = onReply,
            )
            if (canEdit) {
                SheetAction(
                    icon = PqpIcons.Edit,
                    label = stringResource(R.string.chat_edit),
                    testTag = "message.edit",
                    onClick = onEdit,
                )
            }
            if (canPin) {
                SheetAction(
                    icon = if (message.pinnedAt == null) PqpIcons.Pin else PqpIcons.Unpin,
                    label = stringResource(
                        if (message.pinnedAt == null) R.string.chat_pin else R.string.chat_unpin,
                    ),
                    testTag = "message.pin",
                    onClick = onTogglePin,
                )
            }
            if (canDelete) {
                SheetAction(
                    icon = PqpIcons.Delete,
                    label = stringResource(R.string.chat_delete),
                    testTag = "message.delete",
                    destructive = true,
                    onClick = onDelete,
                )
            }
            SheetAction(
                icon = PqpIcons.Warning,
                label = stringResource(R.string.report_message_long_press),
                testTag = "message.report",
                onClick = onReport,
            )
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
private fun Composer(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    onSend: () -> Unit,
    /** An edit sends a tick rather than a paper plane: it changes, not adds. */
    editing: Boolean,
    gifsEnabled: Boolean,
    onOpenGifs: () -> Unit,
    focusRequester: FocusRequester,
    attachmentsEnabled: Boolean,
    attachments: List<PendingAttachment>,
    refusal: AttachmentRefusal?,
    sendRefusal: SendRefusal?,
    holdUntilMs: Long,
    maxAttachmentBytes: Long,
    onAttach: (String) -> Unit,
    onRemoveAttachment: (String) -> Unit,
    onRetryAttachment: (String) -> Unit,
) {
    // The slow mode countdown, ticked here because a number that changes while
    // somebody looks at it has to be redrawn by something, and the view model
    // only knows when the wait ends. Re-read four times a second so the label
    // never shows a second that has already gone; the loop exits with the
    // wait, so an idle composer costs nothing.
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(holdUntilMs) {
        now = SystemClock.elapsedRealtime()
        while (holdUntilMs > now) {
            delay(250)
            now = SystemClock.elapsedRealtime()
        }
    }
    val waitSeconds = ChatViewModel.remainingWaitSeconds(holdUntilMs, now)

    // Whether there is anything to send, which is the one thing this whole
    // surface animates on. It is no longer "is there text": a message may be
    // nothing but a picture, and it may not go while an upload is still
    // running or has failed, or while slow mode is counting down.
    val readiness = composerReadiness(value.text, attachments)
    val active = readiness == ComposerReadiness.Ready && waitSeconds == 0

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
            SendRefusalLine(sendRefusal, waitSeconds)
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
            // A GIF is not an upload and does not need object storage: the
            // bytes stay with the provider and the server mints a row that
            // points at them. So this button is gated on the GIF key alone,
            // never on `attachmentsEnabled`.
            if (gifsEnabled) {
                IconButton(
                    onClick = onOpenGifs,
                    enabled = attachments.size < MAX_ATTACHMENTS_PER_MESSAGE,
                    modifier = Modifier.testTag("composer.gif"),
                ) {
                    Icon(
                        PqpIcons.Gif,
                        contentDescription = stringResource(R.string.chat_gif),
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
                    .focusRequester(focusRequester)
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
                    if (editing) PqpIcons.Confirm else PqpIcons.Send,
                    contentDescription = stringResource(
                        if (editing) R.string.chat_edit_save else R.string.chat_send,
                    ),
                    modifier = Modifier.size(Sizes.iconAction),
                )
            }
            }
        }
    }
}

/**
 * Why the last send did not land, or how long until the next one may.
 *
 * On the composer for the reason [AttachmentRefusalLine] is: it is about the
 * box the person is looking at. The wait wins over a stale reason, because
 * while it is counting the number is the useful sentence; once it reaches
 * zero the view model clears a wait-shaped refusal and the line goes away on
 * its own. A `sanction-notice` is rendered verbatim: the server wrote that
 * sentence in the person's language, and a client that shows nothing but the
 * string is a correct client.
 */
@Composable
private fun SendRefusalLine(refusal: SendRefusal?, waitSeconds: Int) {
    val rateLimited = refusal is SendRefusal.Rejected && refusal.reason == MessageRejectReason.RateLimited
    val text = when {
        waitSeconds > 0 && rateLimited -> stringResource(R.string.chat_reject_rate_limited_wait, waitSeconds)
        waitSeconds > 0 -> stringResource(R.string.chat_slow_mode_wait, waitSeconds)
        refusal is SendRefusal.Sanctioned -> refusal.message
        refusal is SendRefusal.Rejected -> when (refusal.reason) {
            MessageRejectReason.RateLimited -> stringResource(R.string.chat_reject_rate_limited)
            MessageRejectReason.NoAccess -> stringResource(R.string.chat_reject_no_access)
            MessageRejectReason.CannotSend -> stringResource(R.string.chat_reject_cannot_send)
            MessageRejectReason.Undeliverable -> stringResource(R.string.chat_reject_undeliverable)
            MessageRejectReason.SlowMode -> stringResource(R.string.chat_reject_slow_mode)
            MessageRejectReason.Automod -> refusal.message ?: stringResource(R.string.chat_reject_automod)
            null -> stringResource(R.string.chat_reject_generic)
        }
        else -> ""
    }
    AnimatedVisibility(
        visible = text.isNotEmpty(),
        enter = expandVertically(),
        exit = shrinkVertically(),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier
                .padding(start = Spacing.md, end = Spacing.md, top = Spacing.sm)
                .testTag("composer.refusal"),
        )
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

/** One labelled row in the message sheet. The label is the affordance. */
@Composable
private fun SheetAction(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    testTag: String,
    destructive: Boolean = false,
    onClick: () -> Unit,
) {
    val tint = if (destructive) {
        MaterialTheme.colorScheme.error
    } else {
        MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = Spacing.gutter, vertical = Spacing.md)
            .testTag(testTag),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = tint,
            modifier = Modifier.size(Sizes.iconAction),
        )
        Spacer(Modifier.width(Spacing.md))
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge,
            color = if (destructive) MaterialTheme.colorScheme.error else LocalContentColor.current,
        )
    }
}

/**
 * What the next send is for, when it is not a new message.
 *
 * Above the composer and on its surface, the same place the typing strip
 * stands, because both answer "what is this box about to do". Without it a
 * reply is invisible until it lands quoting something, and an edit is
 * indistinguishable from a draft that mysteriously filled itself in.
 */
@Composable
private fun ComposerTargetStrip(target: ComposerTarget, onCancel: () -> Unit) {
    val label = when (target) {
        is ComposerTarget.Reply -> stringResource(R.string.chat_replying_to, target.to.authorName)
        is ComposerTarget.Edit -> stringResource(R.string.chat_editing)
        ComposerTarget.New -> return
    }

    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = Spacing.gutter, end = Spacing.sm)
                .testTag("composer.target"),
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = onCancel, modifier = Modifier.testTag("composer.target.cancel")) {
                Icon(
                    PqpIcons.Close,
                    contentDescription = stringResource(R.string.chat_cancel),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(Sizes.iconInline),
                )
            }
        }
    }
}

/**
 * The names `@` can complete to, immediately above the composer.
 *
 * A strip rather than a popup: a popup on a phone is drawn over the keyboard
 * or over the transcript, and this has to sit between the two. It draws
 * nothing at all when there is no active token, so an ordinary composer is
 * exactly as tall as it was.
 */
@Composable
private fun MentionMenu(matches: List<MentionCandidate>, onPick: (MentionCandidate) -> Unit) {
    if (matches.isEmpty()) return

    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.fillMaxWidth().testTag("composer.mentions")) {
            ChromeDivider()
            matches.forEach { candidate ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onPick(candidate) }
                        .padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
                ) {
                    Avatar(
                        name = candidate.displayName,
                        url = candidate.avatarUrl,
                        size = Sizes.avatarSmall,
                        seed = candidate.id,
                    )
                    Spacer(Modifier.width(Spacing.md))
                    Text(
                        text = candidate.nickname?.takeIf { it.isNotBlank() } ?: candidate.displayName,
                        style = MaterialTheme.typography.bodyLarge,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.width(Spacing.sm))
                    // The username, because that is what gets inserted and
                    // what the server resolves. A picker that shows only a
                    // display name is a picker you cannot predict.
                    Text(
                        text = "@${candidate.username.orEmpty()}",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/**
 * What this channel has pinned.
 *
 * Fetched when the sheet opens rather than held with the transcript: pins
 * change rarely and are read rarely, and a channel's pin list is a second
 * page of history nobody asked to load.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PinnedSheet(
    pinned: List<Message>,
    loaded: Boolean,
    canUnpin: Boolean,
    selfUsername: String?,
    onUnpin: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = Modifier.testTag("chat.pins.sheet"),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(bottom = Spacing.lg),
        ) {
            Text(
                text = stringResource(R.string.chat_pins),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
            )

            when {
                !loaded -> Box(
                    Modifier.fillMaxWidth().padding(Spacing.xl),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator(Modifier.width(24.dp)) }

                pinned.isEmpty() -> Text(
                    text = stringResource(R.string.chat_pins_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.md),
                )

                else -> LazyColumn(Modifier.heightIn(max = 420.dp)) {
                    items(pinned.size, key = { pinned[it].id }) { index ->
                        val message = pinned[index]
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
                        ) {
                            Column(Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.Bottom) {
                                    Text(
                                        text = message.authorName,
                                        style = MaterialTheme.typography.titleSmall,
                                    )
                                    Spacer(Modifier.width(Spacing.sm))
                                    Text(
                                        text = formatTime(message.createdAt),
                                        style = MaterialTheme.typography.labelMedium
                                            .copy(fontFeatureSettings = TabularFigures),
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                MessageBody(body = message.body, selfUsername = selfUsername)
                            }
                            if (canUnpin) {
                                IconButton(onClick = { onUnpin(message.id) }) {
                                    Icon(
                                        PqpIcons.Unpin,
                                        contentDescription = stringResource(R.string.chat_unpin),
                                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.size(Sizes.iconInline),
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Picking a GIF.
 *
 * The provider is whatever the API is configured with (Klipy today), reached
 * only through the `/api/gifs` routes: no provider key is on the phone and no
 * upstream host is contacted from here, the same arrangement the web has.
 * The picked GIF is staged as an attachment rather than posted as a body, so
 * it can carry a caption and be edited afterwards.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GifPickerSheet(
    gifs: List<Gif>,
    loading: Boolean,
    onSearch: (String) -> Unit,
    onPick: (Gif) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var query by remember { mutableStateOf("") }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = Modifier.testTag("chat.gifs"),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .imePadding()
                .padding(bottom = Spacing.lg),
        ) {
            TextField(
                value = query,
                onValueChange = {
                    query = it
                    onSearch(it)
                },
                placeholder = { Text(stringResource(R.string.chat_gif_search)) },
                singleLine = true,
                shape = MaterialTheme.shapes.extraLarge,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Spacing.gutter)
                    .testTag("gif.search"),
            )
            Spacer(Modifier.height(Spacing.sm))

            when {
                loading && gifs.isEmpty() -> Box(
                    Modifier.fillMaxWidth().padding(Spacing.xl),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator(Modifier.width(24.dp)) }

                gifs.isEmpty() -> Text(
                    text = stringResource(R.string.chat_gif_none),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.md),
                )

                else -> LazyVerticalGrid(
                    columns = GridCells.Fixed(2),
                    horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
                    verticalArrangement = Arrangement.spacedBy(Spacing.sm),
                    contentPadding = PaddingValues(horizontal = Spacing.gutter),
                    modifier = Modifier.heightIn(max = 420.dp),
                ) {
                    items(gifs, key = { it.id }) { gif ->
                        AsyncImage(
                            model = gif.previewUrl,
                            contentDescription = gif.title.ifBlank {
                                stringResource(R.string.chat_gif)
                            },
                            contentScale = ContentScale.Crop,
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(120.dp)
                                .clip(MaterialTheme.shapes.small)
                                .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                                .clickable { onPick(gif) },
                        )
                    }
                }
            }
        }
    }
}

/**
 * A refusal from the server, said out loud.
 *
 * Verbatim, because only the server knows which refusal it was: an edit
 * aimed at somebody else's message, a pin past this channel's ceiling, a
 * delete by somebody who has stopped being a moderator since the sheet opened.
 */
@Composable
private fun ActionErrorDialog(message: String, onDismiss: () -> Unit) {
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.ok)) }
        },
        title = { Text(stringResource(R.string.chat_action_failed)) },
        text = { Text(message) },
        modifier = Modifier.testTag("chat.action-error"),
    )
}
