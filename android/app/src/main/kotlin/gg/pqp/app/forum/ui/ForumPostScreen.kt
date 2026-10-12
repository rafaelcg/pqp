package gg.pqp.app.forum.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import gg.pqp.app.R
import gg.pqp.app.core.Backend
import gg.pqp.app.core.Message
import gg.pqp.app.core.SessionStore
import gg.pqp.app.forum.ForumLimits
import gg.pqp.app.forum.ForumNotice
import gg.pqp.app.forum.ForumPostUiState
import gg.pqp.app.forum.ForumPostViewModel
import gg.pqp.app.forum.ForumTag
import gg.pqp.app.forum.forumPostLink
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.screens.ChatExtras
import gg.pqp.app.ui.screens.ChatLanding
import gg.pqp.app.ui.screens.ChatMessageAction
import gg.pqp.app.ui.screens.ChatScreen
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing

/**
 * One post on a phone (UX §2.4, mock 08): full screen, the question first,
 * the accepted answer right under it, then the replies. The transcript, the
 * composer, reactions and files are the chat screen's, pointed at the post's
 * channel; this file adds what a post has and a chat does not.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ForumPostScreen(
    session: SessionStore,
    serverId: String?,
    forumId: String,
    forumName: String,
    postId: String,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val model: ForumPostViewModel = viewModel(
        key = "forum-post:$postId",
        factory = ForumPostViewModel.factory(session, serverId, postId),
    )
    val state by model.state.collectAsStateWithLifecycle()

    LaunchedEffect(model) {
        model.notices.collect { notice ->
            Toast.makeText(context, context.getString(noticeText(notice)), Toast.LENGTH_SHORT).show()
        }
    }

    val post = state.post
    when {
        state.removed -> {
            PostGone(text = stringResource(R.string.forum_removed), onBack = onBack)
            return
        }
        state.loadFailed -> {
            PostGone(text = stringResource(R.string.forum_post_load_failed), onBack = onBack)
            return
        }
    }

    var menuOpen by rememberSaveable { mutableStateOf(false) }
    var editingTitle by rememberSaveable { mutableStateOf(false) }
    var editingTags by rememberSaveable { mutableStateOf(false) }
    var confirmingDelete by rememberSaveable { mutableStateOf(false) }

    // The question is the oldest message; known once the transcript reaches
    // the start. Fed back from the transcript-top slot, which is only drawn
    // when there is no older history.
    var openingId by remember { mutableStateOf<String?>(null) }

    val canEdit = model.canEdit
    val isStaff = state.isStaff
    val locked = post?.locked == true
    val markLabel = stringResource(R.string.forum_solution_mark)
    val unmarkLabel = stringResource(R.string.forum_solution_unmark)
    val replyHint = stringResource(R.string.forum_reply_placeholder_short)
    val replyCount = post?.replyCount ?: 0
    val repliesLabel = repliesText(replyCount)
    val forumTitle = forumName.ifBlank { stringResource(R.string.forum_untitled) }

    val extras = remember(post, state.acceptedAnswer, state.tags, isStaff, canEdit, openingId, state.landingReady, repliesLabel, state.participantCount) {
        ChatExtras(
            primaryChannelId = forumId,
            title = { topVisible ->
                PostTitleBar(
                    forumName = forumTitle,
                    postTitle = post?.title.orEmpty(),
                    replies = repliesLabel,
                    showPostTitle = !topVisible && post != null,
                )
            },
            transcriptTop = {
                if (post != null) {
                    PostHeader(
                        state = state,
                        canEdit = canEdit,
                        onResolve = model::toggleResolved,
                    )
                }
            },
            belowMessageId = openingId,
            belowMessage = {
                Column {
                    state.acceptedAnswer?.let { answer ->
                        SolutionCard(
                            authorName = answer.authorName,
                            excerpt = answer.excerpt,
                            deleted = answer.deleted,
                            onJump = model::jumpToAnswer,
                        )
                    }
                    if (replyCount > 0) {
                        ForumSectionRule(repliesLabel, modifier = Modifier.padding(top = Spacing.sm))
                    }
                }
            },
            authorBadge = { message ->
                if (post?.authorId != null && message.authorId == post.authorId && !post.authorIsWebhook) "OP" else null
            },
            highlightedMessageId = post?.acceptedAnswerId?.takeUnless { state.acceptedAnswer?.deleted == true },
            messageActions = { message: Message ->
                if (post == null || !model.mayMarkAnswer(message, openingId)) {
                    emptyList()
                } else if (post.acceptedAnswerId == message.id) {
                    listOf(ChatMessageAction(unmarkLabel, PqpIcons.Resolved, "forum.unmarkAnswer") { model.unmarkAnswer() })
                } else {
                    listOf(ChatMessageAction(markLabel, PqpIcons.Resolved, "forum.markAnswer") { model.markAnswer(message) })
                }
            },
            landing = ChatLanding(ready = state.landingReady, previousReadAt = state.previousReadAt),
            composerReplacement = if (locked && !isStaff) {
                { LockedBar() }
            } else {
                null
            },
            composerNote = if (locked && isStaff) {
                { LockedStaffNote() }
            } else {
                null
            },
            composerHint = replyHint,
            scrollRequests = model.jumps,
            onOldest = { openingId = it },
            showPins = false,
        )
    }

    ChatScreen(
        session = session,
        channelId = postId,
        channelName = post?.title.orEmpty(),
        onBack = onBack,
        serverId = serverId,
        extras = extras,
        actions = {
            if (state.viewer != null) {
                val following = state.viewer?.following == true
                IconButton(onClick = model::toggleFollow, modifier = Modifier.testTag("forum.follow")) {
                    Icon(
                        imageVector = if (following) PqpIcons.Following else PqpIcons.Follow,
                        contentDescription = stringResource(if (following) R.string.forum_following else R.string.forum_follow),
                        tint = if (following) ForumColors.onAccentSoft() else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(Sizes.iconAction),
                    )
                }
            }
            IconButton(onClick = { menuOpen = true }, enabled = post != null, modifier = Modifier.testTag("forum.post.menu")) {
                Icon(
                    PqpIcons.Menu,
                    contentDescription = stringResource(R.string.forum_post_menu),
                    modifier = Modifier.size(Sizes.iconAction),
                )
            }
        },
    )

    if (menuOpen && post != null) {
        PostMenu(
            state = state,
            canEdit = canEdit,
            onDismiss = { menuOpen = false },
            onEditTags = { menuOpen = false; editingTags = true },
            onEditTitle = { menuOpen = false; editingTitle = true },
            onCopyLink = {
                menuOpen = false
                val link = forumPostLink(Backend.appUrl, serverId ?: "", forumId, postId)
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                if (clipboard != null) {
                    clipboard.setPrimaryClip(ClipData.newPlainText(post.title, link))
                    model.linkCopied()
                }
            },
            onResolve = { menuOpen = false; model.toggleResolved() },
            onPin = { menuOpen = false; model.togglePinned() },
            onLock = { menuOpen = false; model.toggleLocked() },
            onDelete = { menuOpen = false; confirmingDelete = true },
        )
    }
    if (editingTitle && post != null) {
        EditTitleDialog(
            initial = post.title,
            onSave = { editingTitle = false; model.setTitle(it) },
            onDismiss = { editingTitle = false },
        )
    }
    if (editingTags && post != null) {
        EditTagsSheet(
            tags = state.tags,
            selected = post.tagIds,
            isStaff = isStaff,
            onSave = { editingTags = false; model.setTags(it) },
            onDismiss = { editingTags = false },
        )
    }
    if (confirmingDelete && post != null) {
        AlertDialog(
            onDismissRequest = { confirmingDelete = false },
            title = { Text(stringResource(R.string.forum_delete_title)) },
            text = {
                Text(
                    if (post.replyCount == 0) {
                        stringResource(R.string.forum_delete_body_zero)
                    } else {
                        pluralStringResource(R.plurals.forum_delete_body, post.replyCount, post.replyCount)
                    },
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmingDelete = false
                        model.delete(onDone = onBack)
                    },
                    modifier = Modifier.testTag("forum.delete.confirm"),
                ) { Text(stringResource(R.string.forum_delete), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { confirmingDelete = false }) { Text(stringResource(R.string.forum_edit_cancel)) }
            },
        )
    }
}

private fun noticeText(notice: ForumNotice): Int = when (notice) {
    ForumNotice.SaveFailed -> R.string.forum_save_failed
    ForumNotice.PinFull -> R.string.forum_pin_full
    ForumNotice.AutomodTitle -> R.string.forum_composer_automod_title
    ForumNotice.TagRequired -> R.string.forum_composer_tags_required_error
    ForumNotice.LinkCopied -> R.string.forum_post_link_copied
    ForumNotice.Following -> R.string.forum_follow_on
    ForumNotice.Unfollowed -> R.string.forum_follow_off
}

/**
 * The bar: the forum and the reply count while the big title is on screen;
 * the post's title once it scrolls off (UX §2.4 #22, never the title twice).
 */
@Composable
private fun PostTitleBar(forumName: String, postTitle: String, replies: String, showPostTitle: Boolean) {
    AnimatedContent(
        targetState = showPostTitle,
        transitionSpec = {
            (fadeIn(tween(180)) + slideInVertically { it / 3 }) togetherWith
                (fadeOut(tween(120)) + slideOutVertically { -it / 3 })
        },
        label = "post-title",
    ) { showTitle ->
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (!showTitle) {
                    Icon(
                        imageVector = PqpIcons.ForumChannel,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                }
                Text(
                    text = if (showTitle) postTitle else forumName,
                    style = if (showTitle) MaterialTheme.typography.titleMedium else MaterialTheme.typography.titleLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                text = if (showTitle) "$forumName · $replies" else replies,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** Title (Gabarito 19/24), status, tags and the resolve action, above the question. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PostHeader(state: ForumPostUiState, canEdit: Boolean, onResolve: () -> Unit) {
    val post = state.post ?: return
    Column(
        Modifier
            .fillMaxWidth()
            .padding(start = Spacing.gutter, end = Spacing.gutter, top = Spacing.md, bottom = Spacing.sm)
            .animateContentSize()
            .testTag("forum.post.header"),
    ) {
        Text(
            text = post.title,
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.testTag("forum.post.title"),
        )
        val tags = post.tagIds.mapNotNull(state.tagsById::get)
        if (post.resolved || post.locked || post.pinned || tags.isNotEmpty()) {
            Spacer(Modifier.height(Spacing.sm))
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (post.resolved) ResolvedBadge()
                if (post.locked) ForumBadge(BadgeKind.Locked)
                if (post.pinned) ForumBadge(BadgeKind.Pinned)
                tags.forEach { ForumTagChip(it) }
            }
        }
        if (canEdit && !post.resolved) {
            Spacer(Modifier.height(Spacing.sm))
            Surface(
                onClick = onResolve,
                shape = RoundedCornerShape(10.dp),
                color = androidx.compose.ui.graphics.Color.Transparent,
                border = androidx.compose.foundation.BorderStroke(Sizes.hairline, MaterialTheme.colorScheme.outline),
                modifier = Modifier.heightIn(min = 36.dp).testTag("forum.resolve"),
            ) {
                Row(
                    Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(PqpIcons.Resolved, contentDescription = null, tint = ForumColors.success(), modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(stringResource(R.string.forum_resolve), style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }
}

/** The status badge with its tick, the mock's "✓ RESOLVIDO". */
@Composable
private fun ResolvedBadge() {
    Row(
        modifier = Modifier
            .heightIn(min = 20.dp)
            .clip(RoundedCornerShape(4.dp))
            .background(ForumColors.successSoft())
            .padding(horizontal = 6.dp, vertical = 2.dp)
            .testTag("forum.badge.resolved"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(PqpIcons.Resolved, contentDescription = null, tint = ForumColors.success(), modifier = Modifier.size(12.dp))
        Spacer(Modifier.width(4.dp))
        Text(
            text = stringResource(R.string.forum_badge_resolved).uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = ForumColors.success(),
        )
    }
}

/** The green "Solução" card under the question (UX §2.4 #25). */
@Composable
private fun SolutionCard(authorName: String?, excerpt: String?, deleted: Boolean, onJump: () -> Unit) {
    val success = ForumColors.success()
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.gutter, vertical = Spacing.sm)
            .clip(RoundedCornerShape(12.dp))
            .background(ForumColors.successSoft())
            .border(Sizes.hairline, success.copy(alpha = 0.35f), RoundedCornerShape(12.dp))
            .padding(12.dp)
            .testTag("forum.solution"),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(PqpIcons.Resolved, contentDescription = null, tint = success, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(6.dp))
            Text(
                text = stringResource(R.string.forum_solution_title).uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = success,
            )
        }
        Spacer(Modifier.height(Spacing.sm))
        if (deleted) {
            Text(
                text = stringResource(R.string.forum_solution_deleted),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            return@Column
        }
        Row(verticalAlignment = Alignment.Top) {
            val name = authorName ?: stringResource(R.string.forum_deleted_author)
            Avatar(name = name, url = null, size = 20.dp, cornerRadius = 5.dp)
            Spacer(Modifier.width(Spacing.sm))
            Text(
                text = androidx.compose.ui.text.buildAnnotatedString {
                    pushStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.SemiBold))
                    append(name)
                    pop()
                    excerpt?.let { append(" "); append(previewText(it)) }
                },
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.height(Spacing.sm))
        Row(
            modifier = Modifier
                .heightIn(min = 32.dp)
                .clip(RoundedCornerShape(6.dp))
                .clickable(onClick = onJump)
                .padding(vertical = 4.dp, horizontal = 2.dp)
                .testTag("forum.solution.jump"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(stringResource(R.string.forum_solution_jump), style = MaterialTheme.typography.labelLarge, color = success)
            Spacer(Modifier.width(4.dp))
            Icon(PqpIcons.JumpDown, contentDescription = null, tint = success, modifier = Modifier.size(14.dp))
        }
    }
}

/** Where the composer was: the reason, not a box that refuses (UX §2.4 #27). */
@Composable
private fun LockedBar() {
    val outline = MaterialTheme.colorScheme.outline
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(horizontal = Spacing.gutter, vertical = Spacing.md)
            .drawBehind {
                drawRoundRect(
                    color = outline,
                    style = Stroke(width = 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(10f, 8f))),
                    cornerRadius = CornerRadius(12.dp.toPx()),
                )
            }
            .padding(horizontal = Spacing.lg, vertical = 14.dp)
            .testTag("forum.locked"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(PqpIcons.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(Spacing.sm))
        Text(
            text = stringResource(R.string.forum_locked),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun LockedStaffNote() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.gutter, vertical = Spacing.xs)
            .testTag("forum.lockedStaff"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(PqpIcons.Lock, contentDescription = null, tint = ForumColors.warning(), modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(6.dp))
        Text(
            text = stringResource(R.string.forum_locked_staff),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** The post is gone, or never was visible: say so, with the way back (UX §2.7 #48). */
@Composable
private fun PostGone(text: String, onBack: () -> Unit) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .padding(Spacing.xxl)
                .testTag("forum.post.gone"),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                Modifier
                    .size(64.dp)
                    .clip(androidx.compose.foundation.shape.CircleShape)
                    .background(MaterialTheme.colorScheme.surfaceContainer),
                contentAlignment = Alignment.Center,
            ) {
                Icon(PqpIcons.ForumChannel, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(28.dp))
            }
            Spacer(Modifier.height(Spacing.lg))
            Text(text, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
            Spacer(Modifier.height(Spacing.xl))
            Button(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(stringResource(R.string.forum_post_back))
            }
        }
    }
}

/** The `⋯` menu, grouped by who may act, destructive last (UX §2.4 #29). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PostMenu(
    state: ForumPostUiState,
    canEdit: Boolean,
    onDismiss: () -> Unit,
    onEditTags: () -> Unit,
    onEditTitle: () -> Unit,
    onCopyLink: () -> Unit,
    onResolve: () -> Unit,
    onPin: () -> Unit,
    onLock: () -> Unit,
    onDelete: () -> Unit,
) {
    val post = state.post ?: return
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.testTag("forum.post.menuSheet"),
    ) {
        Column(Modifier.navigationBarsPadding().padding(bottom = Spacing.lg)) {
            ForumSectionRule(stringResource(R.string.forum_menu_post))
            if (canEdit) {
                MenuRow(PqpIcons.Tag, stringResource(R.string.forum_edit_tags), "forum.menu.tags", onClick = onEditTags)
                MenuRow(PqpIcons.Edit, stringResource(R.string.forum_edit_title), "forum.menu.title", onClick = onEditTitle)
                MenuRow(
                    if (post.resolved) PqpIcons.Reopen else PqpIcons.Resolved,
                    stringResource(if (post.resolved) R.string.forum_reopen else R.string.forum_resolve),
                    "forum.menu.resolve",
                    onClick = onResolve,
                )
            }
            MenuRow(PqpIcons.Link, stringResource(R.string.forum_post_copy_link), "forum.menu.link", onClick = onCopyLink)
            if (state.isStaff) {
                ForumSectionRule(stringResource(R.string.forum_menu_staff), modifier = Modifier.padding(top = Spacing.sm))
                MenuRow(
                    if (post.pinned) PqpIcons.Unpin else PqpIcons.Pin,
                    stringResource(if (post.pinned) R.string.forum_unpin else R.string.forum_pin),
                    "forum.menu.pin",
                    trailing = if (post.pinned) null else stringResource(R.string.forum_pin_max, ForumLimits.MAX_PINNED),
                    onClick = onPin,
                )
                MenuRow(
                    if (post.locked) PqpIcons.Unlock else PqpIcons.Lock,
                    stringResource(if (post.locked) R.string.forum_unlock else R.string.forum_lock),
                    "forum.menu.lock",
                    onClick = onLock,
                )
                Spacer(Modifier.height(Spacing.sm))
                gg.pqp.app.ui.components.ChromeDivider()
                MenuRow(PqpIcons.Delete, stringResource(R.string.forum_delete), "forum.menu.delete", destructive = true, onClick = onDelete)
            }
        }
    }
}

@Composable
private fun MenuRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    testTag: String,
    destructive: Boolean = false,
    trailing: String? = null,
    onClick: () -> Unit,
) {
    val tint = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .clickable(onClick = onClick)
            .padding(horizontal = Spacing.gutter)
            .testTag(testTag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(Sizes.iconAction))
        Spacer(Modifier.width(Spacing.lg))
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge,
            color = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )
        trailing?.let {
            Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun EditTitleDialog(initial: String, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var text by rememberSaveable { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.forum_edit_title)) },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it.replace('\n', ' ').take(ForumLimits.TITLE_MAX) },
                singleLine = true,
                supportingText = { Text("${text.length}/${ForumLimits.TITLE_MAX}") },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth().testTag("forum.editTitle.field"),
            )
        },
        confirmButton = {
            TextButton(onClick = { onSave(text) }, enabled = text.isNotBlank()) {
                Text(stringResource(R.string.forum_edit_save))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.forum_edit_cancel)) } },
    )
}

/** "Editar tags": the same chips as the composer; staff-only tags for staff. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun EditTagsSheet(
    tags: List<ForumTag>,
    selected: List<String>,
    isStaff: Boolean,
    onSave: (List<String>) -> Unit,
    onDismiss: () -> Unit,
) {
    var picked by rememberSaveable { mutableStateOf(selected) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(
            Modifier
                .navigationBarsPadding()
                .padding(horizontal = Spacing.gutter)
                .padding(bottom = Spacing.lg),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.forum_edit_tags), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                Text(
                    "${picked.size}/${ForumLimits.MAX_TAGS_PER_POST}",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(Spacing.md))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                // A staff-only tag already on the post stays visible to its
                // author, who cannot take it off; the server refuses that too.
                tags.filter { isStaff || !it.moderated || it.id in selected }.forEach { tag ->
                    val on = tag.id in picked
                    ForumFilterChip(
                        label = tag.name,
                        selected = on,
                        showClose = false,
                        trailingIcon = if (on) PqpIcons.Confirm else if (tag.moderated) PqpIcons.StaffOnly else null,
                        leading = tag.emoji?.takeIf { it.isNotBlank() }?.let { e -> { Text(e) } },
                        onClick = {
                            if (tag.moderated && !isStaff) return@ForumFilterChip
                            picked = when {
                                on -> picked - tag.id
                                picked.size >= ForumLimits.MAX_TAGS_PER_POST -> picked
                                else -> picked + tag.id
                            }
                        },
                        testTag = "forum.editTags.${tag.id}",
                    )
                }
            }
            Spacer(Modifier.height(Spacing.lg))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.forum_edit_cancel)) }
                Spacer(Modifier.width(Spacing.sm))
                Button(onClick = { onSave(picked) }, modifier = Modifier.testTag("forum.editTags.save")) {
                    Text(stringResource(R.string.forum_edit_save))
                }
            }
        }
    }
}
