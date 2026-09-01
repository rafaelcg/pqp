package gg.pqp.app.bau.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import coil3.compose.AsyncImage
import gg.pqp.app.R
import gg.pqp.app.attachments.formatAttachmentSize
import gg.pqp.app.bau.BauComment
import gg.pqp.app.bau.BauMedia
import gg.pqp.app.bau.BauPost
import gg.pqp.app.bau.BauViewModel
import gg.pqp.app.bau.YoutubeLinks
import gg.pqp.app.core.SessionStore
import gg.pqp.app.ui.chat.DayLabel
import gg.pqp.app.ui.chat.DayLabels
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.components.ChromeDivider
import gg.pqp.app.ui.components.EmptyState
import gg.pqp.app.ui.components.pqpTopBarColors
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.ui.theme.TabularFigures

/**
 * A server's Baú: the posts that stay, newest first.
 *
 * Read and react only. There is no composer for a post here and there will
 * not be one this pass: staff write from the web, where the media upload and
 * the schedule live. What a phone is for is reading the clip on the bus and
 * leaving a heart, and that is what this screen does.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BauScreen(
    session: SessionStore,
    serverId: String,
    serverName: String,
    onBack: () -> Unit,
) {
    val model: BauViewModel = viewModel(
        key = "bau-$serverId",
        factory = BauViewModel.factory(session, serverId),
    )
    val state by model.state.collectAsStateWithLifecycle()

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        topBar = {
            Column {
                TopAppBar(
                    title = {
                        Column {
                            Text(
                                text = stringResource(R.string.bau_title),
                                style = MaterialTheme.typography.titleLarge,
                                maxLines = 1,
                            )
                            Text(
                                text = stringResource(R.string.bau_subtitle, serverName),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    },
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Icon(
                                imageVector = PqpIcons.Back,
                                contentDescription = stringResource(R.string.chat_back),
                                modifier = Modifier.size(Sizes.iconAction),
                            )
                        }
                    },
                    colors = pqpTopBarColors(),
                )
                ChromeDivider()
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                state.loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator()
                }

                state.posts.isEmpty() && state.error != null -> EmptyState(
                    text = stringResource(R.string.bau_load_failed, state.error.orEmpty()),
                    icon = PqpIcons.Warning,
                    actionLabel = stringResource(R.string.connection_retry),
                    onAction = model::refresh,
                )

                state.posts.isEmpty() -> EmptyState(
                    text = stringResource(R.string.bau_empty, serverName),
                    icon = PqpIcons.Bau,
                )

                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize().testTag("bau.feed"),
                    contentPadding = PaddingValues(
                        horizontal = Spacing.gutter,
                        vertical = Spacing.md,
                    ),
                    verticalArrangement = Arrangement.spacedBy(Spacing.md),
                ) {
                    items(state.posts, key = { it.id }) { post ->
                        PostCard(
                            post = post,
                            vipEnabled = state.config.vipEnabled,
                            expanded = state.expandedComments[post.id],
                            loadingComments = post.id in state.loadingComments,
                            submitting = post.id in state.submitting,
                            commentFailed = post.id in state.commentFailed,
                            onToggleLike = { model.toggleLike(post.id) },
                            onLoadAll = { model.loadAllComments(post.id) },
                            onCollapse = { model.collapseComments(post.id) },
                            onComment = { body -> model.addComment(post.id, body) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun PostCard(
    post: BauPost,
    vipEnabled: Boolean,
    expanded: List<BauComment>?,
    loadingComments: Boolean,
    submitting: Boolean,
    commentFailed: Boolean,
    onToggleLike: () -> Unit,
    onLoadAll: () -> Unit,
    onCollapse: () -> Unit,
    onComment: (String) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .border(
                width = Sizes.hairline,
                color = MaterialTheme.colorScheme.outline,
                shape = MaterialTheme.shapes.medium,
            )
            .padding(Spacing.lg)
            .testTag("bau.post"),
    ) {
        PostHeader(post)

        post.title?.takeIf { it.isNotBlank() }?.let { title ->
            Spacer(Modifier.height(Spacing.md))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f, fill = false),
                )
                // No "free" chip ever, and a VIP chip only while the VIP half
                // of the feature is on: with it off, members-only posts are
                // not in the feed at all, and a chip would name a thing that
                // does not exist here.
                if (post.isMembersOnly && vipEnabled) {
                    Spacer(Modifier.width(Spacing.sm))
                    Chip(stringResource(R.string.bau_vip_chip), accent = true)
                }
            }
        }

        if (post.locked) {
            post.teaser?.takeIf { it.isNotBlank() }?.let { teaser ->
                Spacer(Modifier.height(Spacing.sm))
                Text(
                    text = teaser,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(Spacing.md))
            LockedBox()
        } else {
            post.body?.takeIf { it.isNotBlank() }?.let { body ->
                Spacer(Modifier.height(Spacing.sm))
                Text(text = body, style = MaterialTheme.typography.bodyLarge)
            }
            post.media?.let { media ->
                Spacer(Modifier.height(Spacing.md))
                MediaView(media)
            }
        }

        Spacer(Modifier.height(Spacing.md))
        ActionRow(post, onToggleLike)

        CommentsBlock(
            post = post,
            expanded = expanded,
            loadingComments = loadingComments,
            submitting = submitting,
            commentFailed = commentFailed,
            onLoadAll = onLoadAll,
            onCollapse = onCollapse,
            onComment = onComment,
        )
    }
}

@Composable
private fun PostHeader(post: BauPost) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Avatar(
            name = post.author.displayName,
            url = post.author.avatarUrl,
            size = Sizes.avatarRow,
            seed = post.author.id,
        )
        Spacer(Modifier.width(Spacing.md))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = post.author.displayName,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                when (post.authorBadge) {
                    "owner" -> BadgeChip(stringResource(R.string.bau_badge_owner))
                    "staff" -> BadgeChip(stringResource(R.string.bau_badge_staff))
                }
            }
            Text(
                text = postDate(post.shownAt),
                style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = TabularFigures),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun BadgeChip(text: String) {
    Spacer(Modifier.width(Spacing.sm))
    Chip(text, accent = false)
}

@Composable
private fun Chip(text: String, accent: Boolean) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = if (accent) {
            MaterialTheme.colorScheme.onPrimaryContainer
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        },
        modifier = Modifier
            .clip(MaterialTheme.shapes.small)
            .background(
                if (accent) {
                    MaterialTheme.colorScheme.primaryContainer
                } else {
                    MaterialTheme.colorScheme.surfaceContainerHigh
                },
            )
            .padding(horizontal = Spacing.sm, vertical = 2.dp),
    )
}

/** The date on the card: the day words when recent, a date otherwise. */
@Composable
private fun postDate(iso: String): String = when (val day = DayLabels.labelFor(iso)) {
    DayLabel.Today -> stringResource(R.string.chat_day_today)
    DayLabel.Yesterday -> stringResource(R.string.chat_day_yesterday)
    is DayLabel.Dated -> day.text
    null -> ""
}

/**
 * What a member without the cargo sees instead of the body.
 *
 * The button is disabled and says so. There is no checkout on any client,
 * and a button that opened nothing would be worse than one that admits it is
 * not ready.
 */
@Composable
private fun LockedBox() {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .padding(Spacing.md)
            .testTag("bau.locked"),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                imageVector = PqpIcons.PrivateChannel,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(Sizes.iconInline),
            )
            Spacer(Modifier.width(Spacing.sm))
            Text(
                text = stringResource(R.string.bau_locked_title),
                style = MaterialTheme.typography.titleSmall,
            )
        }
        Spacer(Modifier.height(Spacing.xs))
        Text(
            text = stringResource(R.string.bau_locked_body),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(Spacing.sm))
        Button(onClick = {}, enabled = false) {
            Text(stringResource(R.string.bau_unlock_cta))
        }
    }
}

/**
 * One post's media. Every kind opens *out*: the image in whatever handles it,
 * the video and the file in the browser or a viewer, YouTube in YouTube. A
 * phone has better players for all four than a chat app does, and a card that
 * plays sound on scroll is the thing the web's `preload="none"` exists to
 * avoid.
 */
@Composable
private fun MediaView(media: BauMedia) {
    val context = LocalContext.current
    val target = media.openUrl
    val open: () -> Unit = {
        if (target != null) {
            runCatching {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(target)))
            }
        }
    }

    when {
        target == null -> Text(
            text = stringResource(R.string.bau_media_unavailable),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        media.isImage -> AsyncImage(
            model = target,
            contentDescription = media.name.ifBlank { stringResource(R.string.bau_media_image) },
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 120.dp, max = 360.dp)
                .clip(MaterialTheme.shapes.medium)
                .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                .clickable(role = Role.Image, onClick = open)
                .testTag("bau.media.image"),
        )

        media.isYoutube -> Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(16f / 9f)
                .clip(MaterialTheme.shapes.medium)
                .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                .clickable(role = Role.Button, onClick = open)
                .testTag("bau.media.youtube"),
            contentAlignment = Alignment.Center,
        ) {
            YoutubeLinks.thumbnailUrl(media.youtubeUrl)?.let { thumbnail ->
                AsyncImage(
                    model = thumbnail,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            PlayBadge(stringResource(R.string.bau_media_youtube))
        }

        media.isVideo -> Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(16f / 9f)
                .clip(MaterialTheme.shapes.medium)
                .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                .clickable(role = Role.Button, onClick = open)
                .testTag("bau.media.video"),
            contentAlignment = Alignment.Center,
        ) {
            PlayBadge(media.name.ifBlank { stringResource(R.string.bau_media_video) })
        }

        else -> FileCard(media, open)
    }
}

@Composable
private fun PlayBadge(label: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(MaterialTheme.shapes.small)
            .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.6f))
            .padding(horizontal = Spacing.md, vertical = Spacing.sm),
    ) {
        Icon(
            imageVector = PqpIcons.Play,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onPrimary,
            modifier = Modifier.size(Sizes.iconInline),
        )
        Spacer(Modifier.width(Spacing.sm))
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** A PDF, or any other file: name, size, and a tap that opens it. */
@Composable
private fun FileCard(media: BauMedia, open: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .clickable(role = Role.Button, onClick = open)
            .padding(horizontal = Spacing.md, vertical = Spacing.md)
            .testTag("bau.media.file"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = PqpIcons.Attach,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(Sizes.iconAction),
        )
        Spacer(Modifier.width(Spacing.md))
        Column(Modifier.weight(1f)) {
            Text(
                text = media.name.ifBlank { stringResource(R.string.bau_media_file) },
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            media.byteSize?.let { size ->
                Text(
                    text = formatAttachmentSize(size),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Icon(
            imageVector = PqpIcons.Export,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(Sizes.iconInline),
        )
    }
}

@Composable
private fun ActionRow(post: BauPost, onToggleLike: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        val likeLabel = stringResource(if (post.likedByMe) R.string.bau_unlike else R.string.bau_like)
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .clip(MaterialTheme.shapes.small)
                .clickable(role = Role.Button, onClickLabel = likeLabel, onClick = onToggleLike)
                .padding(horizontal = Spacing.sm, vertical = Spacing.xs)
                .testTag("bau.like"),
        ) {
            Icon(
                imageVector = if (post.likedByMe) PqpIcons.LikeFilled else PqpIcons.Like,
                contentDescription = likeLabel,
                tint = if (post.likedByMe) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
                modifier = Modifier.size(Sizes.iconAction),
            )
            Spacer(Modifier.width(Spacing.xs))
            Text(
                text = post.likeCount.toString(),
                style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = TabularFigures),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.width(Spacing.md))
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = Spacing.sm, vertical = Spacing.xs),
        ) {
            Icon(
                imageVector = PqpIcons.Messages,
                contentDescription = stringResource(R.string.bau_comments),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(Sizes.iconAction),
            )
            Spacer(Modifier.width(Spacing.xs))
            Text(
                text = post.commentCount.toString(),
                style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = TabularFigures),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * The two newest comments, "see all" for the rest, and a one-line composer.
 *
 * A locked post carries a count and no words (the API strips the teaser
 * along with the body), so the block draws the composer and nothing else
 * there: a member without the cargo can still say something under a post
 * they cannot read, the same as on the web.
 */
@Composable
private fun CommentsBlock(
    post: BauPost,
    expanded: List<BauComment>?,
    loadingComments: Boolean,
    submitting: Boolean,
    commentFailed: Boolean,
    onLoadAll: () -> Unit,
    onCollapse: () -> Unit,
    onComment: (String) -> Unit,
) {
    val shown = expanded ?: post.commentTeaser
    val hidden = (post.commentCount - post.commentTeaser.size).coerceAtLeast(0)

    if (shown.isNotEmpty()) {
        Spacer(Modifier.height(Spacing.sm))
        ChromeDivider()
        Spacer(Modifier.height(Spacing.sm))
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            shown.forEach { comment -> CommentRow(comment) }
        }
    }

    when {
        expanded != null && hidden > 0 -> TextButton(onClick = onCollapse) {
            Text(stringResource(R.string.bau_comments_show_less))
        }

        loadingComments -> Box(Modifier.padding(Spacing.sm)) {
            CircularProgressIndicator(Modifier.size(18.dp))
        }

        hidden > 0 && !post.locked -> TextButton(
            onClick = onLoadAll,
            modifier = Modifier.testTag("bau.comments.all"),
        ) {
            Text(
                if (post.commentCount == 1) {
                    stringResource(R.string.bau_comments_view_one, post.commentCount)
                } else {
                    stringResource(R.string.bau_comments_view_all, post.commentCount)
                },
            )
        }
    }

    Spacer(Modifier.height(Spacing.sm))
    if (post.commentsEnabled) {
        CommentComposer(
            postId = post.id,
            submitting = submitting,
            failed = commentFailed,
            onSubmit = onComment,
        )
    } else {
        Text(
            text = stringResource(R.string.bau_comments_off),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun CommentRow(comment: BauComment) {
    Row(verticalAlignment = Alignment.Top) {
        Avatar(
            name = comment.author.displayName,
            url = comment.author.avatarUrl,
            size = Sizes.avatarSmall,
            seed = comment.author.id,
        )
        Spacer(Modifier.width(Spacing.sm))
        Column(Modifier.weight(1f)) {
            Text(
                text = comment.author.displayName,
                style = MaterialTheme.typography.labelMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(text = comment.body, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun CommentComposer(
    postId: String,
    submitting: Boolean,
    failed: Boolean,
    onSubmit: (String) -> Unit,
) {
    var draft by rememberSaveable(postId) { mutableStateOf("") }
    var wasSubmitting by remember { mutableStateOf(false) }

    // The box empties once the comment has actually landed, not on tap. A
    // draft that vanished on a failed send is a sentence the person has to
    // type again; keeping it and saying "did not post" costs nothing.
    LaunchedEffect(submitting, failed) {
        if (wasSubmitting && !submitting && !failed) draft = ""
        wasSubmitting = submitting
    }

    val send = {
        if (!submitting && draft.isNotBlank()) onSubmit(draft)
    }

    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                placeholder = { Text(stringResource(R.string.bau_comment_placeholder)) },
                singleLine = true,
                enabled = !submitting,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { send() }),
                textStyle = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f).testTag("bau.comment.input"),
            )
            Spacer(Modifier.width(Spacing.sm))
            IconButton(
                onClick = send,
                enabled = !submitting && draft.isNotBlank(),
                modifier = Modifier.testTag("bau.comment.send"),
            ) {
                Icon(
                    imageVector = PqpIcons.Send,
                    contentDescription = stringResource(R.string.bau_comment_submit),
                    modifier = Modifier.size(Sizes.iconAction),
                )
            }
        }
        if (failed) {
            Text(
                text = stringResource(R.string.bau_comment_failed),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(top = Spacing.xs),
            )
        }
    }
}
