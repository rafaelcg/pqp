package gg.pqp.app.forum.ui

import android.os.SystemClock
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import gg.pqp.app.R
import gg.pqp.app.attachments.ATTACHMENT_MIME_ALLOWLIST
import gg.pqp.app.attachments.AttachmentRefusal
import gg.pqp.app.attachments.ContentAttachmentFiles
import gg.pqp.app.attachments.PendingAttachment
import gg.pqp.app.core.SessionStore
import gg.pqp.app.forum.ForumComposerError
import gg.pqp.app.forum.ForumComposerState
import gg.pqp.app.forum.ForumComposerViewModel
import gg.pqp.app.forum.ForumLimits
import gg.pqp.app.forum.ForumList
import gg.pqp.app.forum.ForumPostSummary
import gg.pqp.app.forum.ForumPrefs
import gg.pqp.app.ui.components.pqpTopBarColors
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.ui.theme.TabularFigures
import kotlinx.coroutines.delay

/**
 * "Novo post" on a phone (UX §2.5, mock 09): a full-screen sheet, X closes and
 * keeps the draft, "Publicar" top right so the keyboard never covers it. Title
 * first (it drives "Posts parecidos"), then the details, then tags and files.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ForumComposerScreen(
    session: SessionStore,
    serverId: String,
    forumId: String,
    initialTitle: String?,
    onClose: () -> Unit,
    /** A similar post was tapped; the draft stays for when the reader comes back. */
    onOpenPost: (ForumPostSummary) -> Unit,
    /** The new post exists: open it in place of this screen. */
    onPublished: (ForumPostSummary) -> Unit,
) {
    val context = LocalContext.current
    val prefs = remember(context) { ForumPrefs(context) }
    val files = remember(context) { ContentAttachmentFiles(context) }
    val model: ForumComposerViewModel = viewModel(
        key = "forum-composer:$forumId",
        factory = ForumComposerViewModel.factory(session, prefs, serverId, forumId, files, initialTitle),
    )
    val state by model.state.collectAsStateWithLifecycle()

    LaunchedEffect(model) { model.published.collect(onPublished) }
    LaunchedEffect(state.draftRestored) {
        if (state.draftRestored) {
            Toast.makeText(context, context.getString(R.string.forum_composer_draft_restored), Toast.LENGTH_SHORT).show()
            model.draftRestoredSeen()
        }
    }

    // The slow-mode wait, counted down on the button itself.
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    val holdUntil = (state.error as? ForumComposerError.SlowMode)?.untilMs ?: 0L
    LaunchedEffect(holdUntil) {
        now = SystemClock.elapsedRealtime()
        while (holdUntil > now) {
            delay(250)
            now = SystemClock.elapsedRealtime()
        }
    }
    val waitSeconds = if (holdUntil > now) ((holdUntil - now + 999) / 1000).toInt() else 0

    val titleFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { titleFocus.requestFocus() } }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onClose, modifier = Modifier.testTag("forum.composer.close")) {
                        Icon(PqpIcons.Close, contentDescription = stringResource(R.string.forum_composer_close))
                    }
                },
                title = { Text(stringResource(R.string.forum_composer_heading), style = MaterialTheme.typography.titleLarge) },
                actions = {
                    Button(
                        onClick = model::publish,
                        enabled = state.canPublish && waitSeconds == 0,
                        shape = RoundedCornerShape(10.dp),
                        contentPadding = ButtonDefaults.ContentPadding,
                        modifier = Modifier
                            .padding(end = Spacing.sm)
                            .heightIn(min = 40.dp)
                            .testTag("forum.composer.publish"),
                    ) {
                        if (state.publishing) {
                            CircularProgressIndicator(
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onPrimary,
                                modifier = Modifier.size(14.dp),
                            )
                            Spacer(Modifier.width(6.dp))
                        }
                        Text(
                            text = when {
                                state.publishing -> stringResource(R.string.forum_composer_publishing)
                                waitSeconds > 0 -> "${waitSeconds}s"
                                else -> stringResource(R.string.forum_composer_publish)
                            },
                            style = MaterialTheme.typography.labelLarge,
                        )
                    }
                },
                colors = pqpTopBarColors(),
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Spacing.gutter)
                .padding(bottom = Spacing.xxl),
        ) {
            ErrorBanner(state.error, waitSeconds)

            // --- title ---
            FieldLabel(
                text = stringResource(R.string.forum_composer_title),
                trailing = "${state.title.length}/${ForumLimits.TITLE_MAX}",
                modifier = Modifier.padding(top = Spacing.lg),
            )
            OutlinedTextField(
                value = state.title,
                onValueChange = model::setTitle,
                singleLine = true,
                placeholder = { Text(stringResource(R.string.forum_composer_title_placeholder)) },
                isError = state.error == ForumComposerError.TitleRequired,
                textStyle = MaterialTheme.typography.bodyLarge,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Next),
                shape = RoundedCornerShape(12.dp),
                colors = composerFieldColors(),
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(titleFocus)
                    .testTag("forum.composer.title"),
            )
            if (state.error == ForumComposerError.TitleRequired) {
                FieldError(stringResource(R.string.forum_composer_title_required))
            }

            SimilarPosts(state = state, onOpen = { post ->
                model.saveDraftNow()
                onOpenPost(post)
            })

            // --- tags ---
            if (state.offeredTags.isNotEmpty()) {
                TagPicker(state = state, onToggle = model::toggleTag)
            }

            // --- details ---
            FieldLabel(
                text = stringResource(R.string.forum_composer_body),
                modifier = Modifier.padding(top = Spacing.lg),
            )
            BodyField(state = state, onBody = model::setBody, onAttach = model::attach, onRemove = model::removeAttachment)
            if (state.error == ForumComposerError.BodyRequired) {
                FieldError(stringResource(R.string.forum_composer_body_required))
            }
            state.attachmentRefusal?.let { refusal ->
                FieldError(attachmentRefusalText(refusal, state.maxAttachmentBytes))
            }

            if (state.title.isNotBlank() || state.body.isNotBlank() || state.tagIds.isNotEmpty()) {
                Row(Modifier.fillMaxWidth().padding(top = Spacing.md), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        stringResource(R.string.forum_composer_draft_saved),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    TextButton(onClick = model::discard, modifier = Modifier.testTag("forum.composer.discard")) {
                        Text(stringResource(R.string.forum_composer_discard))
                    }
                }
            }
        }
    }
}

@Composable
private fun composerFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = MaterialTheme.colorScheme.primary,
    unfocusedBorderColor = MaterialTheme.colorScheme.outline,
    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
)

@Composable
private fun FieldLabel(text: String, modifier: Modifier = Modifier, trailing: String? = null, extra: (@Composable () -> Unit)? = null) {
    Row(
        modifier = modifier.fillMaxWidth().padding(bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, style = MaterialTheme.typography.labelLarge)
        extra?.let {
            Spacer(Modifier.width(Spacing.sm))
            it()
        }
        Spacer(Modifier.weight(1f))
        trailing?.let {
            Text(
                it,
                style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = TabularFigures),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun FieldError(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
        modifier = Modifier
            .padding(top = 6.dp)
            .semantics { liveRegion = LiveRegionMode.Polite }
            .testTag("forum.composer.error"),
    )
}

/** Refusals that are not about one field: the server's no, said once at the top. */
@Composable
private fun ErrorBanner(error: ForumComposerError?, waitSeconds: Int) {
    val text = when (error) {
        is ForumComposerError.SlowMode -> if (waitSeconds > 0) stringResource(R.string.forum_composer_slow_mode, waitSeconds) else null
        is ForumComposerError.RateLimited -> stringResource(R.string.forum_composer_rate_limited, error.minutes)
        is ForumComposerError.Automod -> listOfNotNull(
            // Which half AutoMod refused, so it says "esse título".
            stringResource(
                when (error.field) {
                    "title" -> R.string.forum_composer_automod_title
                    "body" -> R.string.forum_composer_automod_body
                    else -> R.string.forum_composer_automod_post
                },
            ),
            error.message,
        ).joinToString(" ")
        is ForumComposerError.CannotPost -> error.message ?: stringResource(R.string.forum_composer_cannot_send)
        ForumComposerError.Paused -> stringResource(R.string.forum_paused)
        ForumComposerError.Failed -> stringResource(R.string.forum_composer_failed)
        ForumComposerError.Uploading -> stringResource(R.string.forum_composer_uploading)
        else -> null
    }
    AnimatedVisibility(
        visible = text != null,
        enter = expandVertically() + fadeIn(),
        exit = shrinkVertically() + fadeOut(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = Spacing.md)
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.error.copy(alpha = 0.12f))
                .padding(12.dp)
                .semantics { liveRegion = LiveRegionMode.Polite }
                .testTag("forum.composer.banner"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(PqpIcons.Warning, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(Spacing.sm))
            Text(text.orEmpty(), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/**
 * "Posts parecidos" (UX §2.5 #33): up to five, resolved first, the words the
 * title shares underlined. Loading keeps the last answer, dimmed; nothing
 * found hides the box. Never in the way of publishing.
 */
@Composable
private fun SimilarPosts(state: ForumComposerState, onOpen: (ForumPostSummary) -> Unit) {
    val posts = remember(state.similar) { state.similar.sortedByDescending { it.resolved } }
    val dim by animateFloatAsState(if (state.similarLoading) 0.55f else 1f, tween(160), label = "similar-dim")
    AnimatedVisibility(
        visible = posts.isNotEmpty(),
        enter = expandVertically() + fadeIn(),
        exit = shrinkVertically() + fadeOut(),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(top = Spacing.sm)
                .clip(RoundedCornerShape(12.dp))
                .border(Sizes.hairline, MaterialTheme.colorScheme.outline, RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.surfaceContainer)
                .alpha(dim)
                .animateContentSize()
                .testTag("forum.composer.similar"),
        ) {
            Row(
                Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(PqpIcons.Similar, contentDescription = null, tint = ForumColors.warning(), modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(Spacing.sm))
                Text(
                    stringResource(R.string.forum_composer_similar_title_short),
                    style = MaterialTheme.typography.labelLarge,
                )
            }
            posts.forEach { post ->
                gg.pqp.app.ui.components.ChromeDivider()
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 44.dp)
                        .clickable { onOpen(post) }
                        .padding(horizontal = 12.dp, vertical = 10.dp)
                        .testTag("forum.composer.similar.${post.id}"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = if (post.resolved) PqpIcons.Resolved else PqpIcons.OpenStatus,
                        contentDescription = stringResource(if (post.resolved) R.string.forum_badge_resolved else R.string.forum_card_open),
                        tint = if (post.resolved) ForumColors.success() else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(Spacing.sm))
                    Text(
                        text = highlightMatches(post.title, state.title),
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(Spacing.sm))
                    Text(
                        post.replyCount.toString(),
                        style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = TabularFigures),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            gg.pqp.app.ui.components.ChromeDivider()
            Text(
                text = stringResource(R.string.forum_composer_similar_footer),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            )
        }
    }
}

/** The title's words, accent-insensitive, bold and underlined where the similar title has them. */
private fun highlightMatches(title: String, query: String): AnnotatedString {
    val words = ForumList.fold(query).split(Regex("\\s+")).filter { it.length >= 2 }.toSet()
    if (words.isEmpty()) return AnnotatedString(title)
    return buildAnnotatedString {
        Regex("\\S+|\\s+").findAll(title).forEach { match ->
            val token = match.value
            val folded = ForumList.fold(token).trim { !it.isLetterOrDigit() }
            if (token.isNotBlank() && folded in words) {
                pushStyle(SpanStyle(fontWeight = FontWeight.SemiBold, textDecoration = TextDecoration.Underline))
                append(token)
                pop()
            } else {
                append(token)
            }
        }
    }
}

/**
 * Tags as inline toggle chips (UX §2.5 #35): every tag the reader may put on,
 * at most five, a counter, and "pelo menos 1" in warning colour when the
 * forum asks for one. Past eight chips the rest fold behind "+N".
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TagPicker(state: ForumComposerState, onToggle: (String) -> Unit) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val offered = state.offeredTags
    // Picked tags always show, wherever they sit in the order.
    val shown = if (expanded || offered.size <= COLLAPSED_TAGS) {
        offered
    } else {
        offered.filterIndexed { index, tag -> index < COLLAPSED_TAGS || tag.id in state.tagIds }
    }
    val hidden = offered.size - shown.size
    FieldLabel(
        text = stringResource(R.string.forum_composer_tags),
        trailing = "${state.tagIds.size}/${ForumLimits.MAX_TAGS_PER_POST}",
        modifier = Modifier.padding(top = Spacing.lg),
        extra = if (state.requireTag) {
            {
                Text(
                    stringResource(R.string.forum_composer_tags_required),
                    style = MaterialTheme.typography.labelMedium,
                    color = ForumColors.warning(),
                )
            }
        } else {
            null
        },
    )
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
        modifier = Modifier.animateContentSize().testTag("forum.composer.tags"),
    ) {
        shown.forEach { tag ->
            val on = tag.id in state.tagIds
            val full = !on && state.tagIds.size >= ForumLimits.MAX_TAGS_PER_POST
            ForumFilterChip(
                label = tag.name,
                selected = on,
                showClose = false,
                trailingIcon = when {
                    on -> PqpIcons.Confirm
                    tag.moderated -> PqpIcons.StaffOnly
                    else -> null
                },
                leading = tag.emoji?.takeIf { it.isNotBlank() }?.let { emoji -> { Text(emoji) } },
                onClick = { onToggle(tag.id) },
                modifier = Modifier.alpha(if (full) 0.45f else 1f),
                testTag = "forum.composer.tag.${tag.id}",
            )
        }
        if (hidden > 0) {
            ForumFilterChip(
                label = "+$hidden",
                selected = false,
                showClose = false,
                onClick = { expanded = true },
                testTag = "forum.composer.moreTags",
            )
        }
    }
    if (state.tagsNoneToPick) {
        Text(
            stringResource(R.string.forum_composer_tags_none_to_pick),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 6.dp).testTag("forum.composer.tagsNone"),
        )
    } else if (state.error == ForumComposerError.TagRequired) {
        FieldError(stringResource(R.string.forum_composer_tags_required_error))
    } else if (state.tagIds.size >= ForumLimits.MAX_TAGS_PER_POST) {
        Text(
            stringResource(R.string.forum_composer_tags_max, ForumLimits.MAX_TAGS_PER_POST),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 6.dp),
        )
    }
}

private const val COLLAPSED_TAGS = 8

/** The details: a tall field with the file buttons inside its bottom edge, like the mock. */
@Composable
private fun BodyField(
    state: ForumComposerState,
    onBody: (String) -> Unit,
    onAttach: (String) -> Unit,
    onRemove: (String) -> Unit,
) {
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        uris.take(gg.pqp.app.attachments.MAX_ATTACHMENTS_PER_MESSAGE).forEach { onAttach(it.toString()) }
    }
    val images = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
        uris.take(gg.pqp.app.attachments.MAX_ATTACHMENTS_PER_MESSAGE).forEach { onAttach(it.toString()) }
    }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .border(Sizes.hairline, MaterialTheme.colorScheme.outline, RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceContainer),
    ) {
        androidx.compose.material3.TextField(
            value = state.body,
            onValueChange = onBody,
            placeholder = { Text(stringResource(R.string.forum_composer_body_placeholder)) },
            textStyle = MaterialTheme.typography.bodyLarge,
            minLines = 5,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            colors = androidx.compose.material3.TextFieldDefaults.colors(
                focusedContainerColor = androidx.compose.ui.graphics.Color.Transparent,
                unfocusedContainerColor = androidx.compose.ui.graphics.Color.Transparent,
                focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
            ),
            modifier = Modifier.fillMaxWidth().testTag("forum.composer.body"),
        )
        if (state.attachments.isNotEmpty()) {
            AttachmentRow(state.attachments, onRemove)
        }
        gg.pqp.app.ui.components.ChromeDivider()
        Row(
            Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = { picker.launch(ATTACHMENT_MIME_ALLOWLIST.toTypedArray()) },
                enabled = state.attachmentsEnabled,
                modifier = Modifier.testTag("forum.composer.attach"),
            ) {
                Icon(PqpIcons.Attach, contentDescription = stringResource(R.string.forum_composer_attach), modifier = Modifier.size(20.dp))
            }
            IconButton(
                onClick = {
                    images.launch(
                        androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo),
                    )
                },
                enabled = state.attachmentsEnabled,
            ) {
                Icon(PqpIcons.Image, contentDescription = stringResource(R.string.forum_composer_attach_image), modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.weight(1f))
            Text(
                stringResource(R.string.forum_composer_markdown),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(end = Spacing.md),
            )
        }
    }
}

@Composable
private fun AttachmentRow(attachments: List<PendingAttachment>, onRemove: (String) -> Unit) {
    androidx.compose.foundation.lazy.LazyRow(
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
        modifier = Modifier.padding(bottom = Spacing.sm),
    ) {
        items(attachments.size, key = { attachments[it].localId }) { index ->
            val attachment = attachments[index]
            Row(
                Modifier
                    .clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                    .padding(start = 10.dp, end = 2.dp)
                    .heightIn(min = 40.dp)
                    .testTag("forum.composer.attachment"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                when {
                    attachment.uploading -> CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(14.dp))
                    attachment.failed -> Icon(PqpIcons.Warning, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(14.dp))
                    else -> Icon(if (attachment.isImage) PqpIcons.Image else PqpIcons.Attach, contentDescription = null, modifier = Modifier.size(14.dp))
                }
                Spacer(Modifier.width(6.dp))
                Text(
                    attachment.filename,
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.width(120.dp),
                )
                IconButton(onClick = { onRemove(attachment.localId) }, modifier = Modifier.size(36.dp)) {
                    Icon(PqpIcons.Close, contentDescription = stringResource(R.string.forum_composer_remove_file), modifier = Modifier.size(14.dp))
                }
            }
        }
    }
}

@Composable
private fun attachmentRefusalText(refusal: AttachmentRefusal, maxBytes: Long): String = when (refusal) {
    AttachmentRefusal.TooLarge -> stringResource(
        R.string.chat_attachment_too_large,
        gg.pqp.app.attachments.formatAttachmentSize(maxBytes),
    )
    AttachmentRefusal.TooMany -> stringResource(R.string.chat_attachment_too_many, gg.pqp.app.attachments.MAX_ATTACHMENTS_PER_MESSAGE)
    AttachmentRefusal.UnsupportedType -> stringResource(R.string.chat_attachment_unsupported)
    AttachmentRefusal.Unreadable -> stringResource(R.string.chat_attachment_unreadable)
}
