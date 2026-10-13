package gg.pqp.app.forum.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import gg.pqp.app.R
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.forum.ForumList
import gg.pqp.app.forum.ForumPostSummary
import gg.pqp.app.forum.ForumPrefs
import gg.pqp.app.forum.ForumSort
import gg.pqp.app.forum.ForumStatus
import gg.pqp.app.forum.ForumUiState
import gg.pqp.app.forum.ForumUnread
import gg.pqp.app.forum.ForumViewModel
import gg.pqp.app.push.VisibleChannel
import gg.pqp.app.ui.components.ChromeDivider
import gg.pqp.app.ui.components.pqpTopBarColors
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.launch

/**
 * A forum on a phone (UX §2.9, mock 07): the list is the whole screen. Header
 * with the forum and its count, guidelines as one row that opens a sheet, one
 * sideways strip for every filter, pinned posts on top, the cards, and the
 * "Novo post" button bottom right where the thumb is.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ForumScreen(
    session: SessionStore,
    serverId: String,
    serverName: String,
    forumId: String,
    forumName: String,
    /** The forum's topic, which is its guidelines. */
    guidelines: String?,
    onBack: () -> Unit,
    onOpenPost: (ForumPostSummary) -> Unit,
    /** Opens the composer, with a title when it comes from an empty search. */
    onCompose: (String?) -> Unit,
) {
    val context = LocalContext.current
    val prefs = remember(context) { ForumPrefs(context) }
    val model: ForumViewModel = viewModel(
        key = "forum:$forumId",
        factory = ForumViewModel.factory(session, prefs, serverId, forumId),
    )
    val state by model.state.collectAsStateWithLifecycle()
    val phase by session.phase.collectAsStateWithLifecycle()
    val meId = (phase as? SessionPhase.Ready)?.me?.id

    // The forum's own slot on the socket, taken back whenever this screen is
    // in front: a post opened on top of it rides the thread slot and keeps
    // this one, but a chat or a conversation opened from a notification takes
    // it. Coming back also marks the post just read and merges a fresh page 1.
    LifecycleStartEffect(forumId) {
        VisibleChannel.enter(forumId)
        model.resubscribe()
        onStopOrDispose { VisibleChannel.leave(forumId) }
    }
    var returning by remember { mutableStateOf(false) }
    LifecycleResumeEffect(forumId) {
        if (returning) {
            model.setOpenPost(null)
            model.refreshInPlace()
        }
        returning = true
        onPauseOrDispose { }
    }

    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    // Away from the top, live moves queue behind the pill instead of shifting
    // the card under the reader's thumb (UX §2.2 #14).
    val awayFromTop by remember {
        derivedStateOf { listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > 24 }
    }
    LaunchedEffect(awayFromTop) { model.setHold(awayFromTop) }

    // The FAB hides on the way down and comes back on the way up (UX §2.9 #58).
    var fabVisible by remember { mutableStateOf(true) }
    LaunchedEffect(listState) {
        var lastIndex = 0
        var lastOffset = 0
        snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
            .collect { (index, offset) ->
                val down = index > lastIndex || (index == lastIndex && offset > lastOffset + 8)
                val up = index < lastIndex || (index == lastIndex && offset < lastOffset - 8)
                if (down) fabVisible = false
                if (up || (index == 0 && offset == 0)) fabVisible = true
                lastIndex = index
                lastOffset = offset
            }
    }

    // Paging: 600dp-ish before the end, the next 25.
    val nearEnd by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: 0
            info.totalItemsCount > 0 && last >= info.totalItemsCount - 4
        }
    }
    LaunchedEffect(nearEnd, state.list.nextCursor) {
        if (nearEnd && state.list.nextCursor != null && !state.moreError) model.loadMore()
    }

    var showingRules by rememberSaveable { mutableStateOf(false) }
    var showingSort by rememberSaveable { mutableStateOf(false) }
    var searchText by rememberSaveable { mutableStateOf("") }

    val open: (ForumPostSummary) -> Unit = { post ->
        model.setOpenPost(post.id)
        onOpenPost(post)
    }

    Scaffold(
        topBar = {
            Column {
                ForumTopBar(
                    forumName = forumName,
                    serverName = serverName,
                    state = state,
                    searchText = searchText,
                    onSearchText = {
                        searchText = it
                        model.setQuery(it)
                    },
                    onOpenSearch = model::openSearch,
                    onCloseSearch = {
                        searchText = ""
                        model.closeSearch()
                    },
                    onBack = onBack,
                )
                ChromeDivider()
            }
        },
        floatingActionButton = {
            AnimatedVisibility(
                visible = fabVisible && state.mayCreate && !state.forumEmpty && !state.loading,
                enter = scaleIn(spring(dampingRatio = 0.7f, stiffness = 500f)) + fadeIn(),
                exit = scaleOut(tween(140)) + fadeOut(tween(140)),
            ) {
                ExtendedFloatingActionButton(
                    onClick = { onCompose(null) },
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                    shape = MaterialTheme.shapes.large,
                    icon = { Icon(PqpIcons.Add, contentDescription = null) },
                    text = { Text(stringResource(R.string.forum_new_post), style = MaterialTheme.typography.labelLarge) },
                    modifier = Modifier.testTag("forum.newPost"),
                )
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(
                state = listState,
                contentPadding = PaddingValues(bottom = 96.dp),
                modifier = Modifier.fillMaxSize().testTag("forum.list"),
            ) {
                if (!guidelines.isNullOrBlank()) {
                    item(key = "rules") {
                        GuidelinesRow(onClick = { showingRules = true })
                    }
                }
                val showFilters = !state.forumEmpty || state.filters.active
                if (showFilters && !state.loading) {
                    item(key = "filters") {
                        FilterStrip(
                            state = state,
                            onSort = { showingSort = true },
                            onStatus = model::toggleStatus,
                            onMine = model::toggleMine,
                            onTag = model::toggleTag,
                        )
                    }
                }
                when {
                    state.loading -> items(3, key = { "skeleton-$it" }) {
                        ForumCardSkeleton(Modifier.padding(horizontal = Spacing.gutter, vertical = 6.dp))
                    }
                    state.loadError -> item(key = "error") {
                        ForumMessage(
                            title = stringResource(R.string.forum_load_error),
                            actionLabel = stringResource(R.string.forum_retry),
                            onAction = model::reload,
                            warning = true,
                        )
                    }
                    state.forumEmpty -> item(key = "empty") {
                        ForumEmpty(
                            mayCreate = state.mayCreate,
                            paused = !state.postingEnabled,
                            onCreate = { onCompose(null) },
                        )
                    }
                    state.isEmpty -> item(key = "filter-empty") {
                        FilteredEmpty(
                            state = state,
                            onClear = {
                                if (state.filters.q.isNotEmpty()) {
                                    searchText = ""
                                    model.closeSearch()
                                }
                                model.clearFilters()
                            },
                            onPost = { onCompose(state.filters.q) },
                        )
                    }
                    else -> {
                        if (state.list.pinned.isNotEmpty()) {
                            item(key = "pinned-rule") {
                                ForumSectionRule(stringResource(R.string.forum_pinned), icon = PqpIcons.Pin)
                            }
                            items(state.list.pinned, key = { "pin-${it.id}" }) { post ->
                                val unread = ForumList.unread(post, state.list.viewer[post.id], meId, state.list.forumPreviousReadAt)
                                ForumPinnedRow(
                                    post = post,
                                    bold = unread !is ForumUnread.Read,
                                    onClick = { open(post) },
                                    modifier = Modifier
                                        .padding(horizontal = Spacing.gutter, vertical = 4.dp)
                                        .animateItem(),
                                )
                            }
                            item(key = "pinned-gap") { Spacer(Modifier.height(Spacing.sm)) }
                        }
                        items(state.list.posts, key = { it.id }) { post ->
                            ForumPostCard(
                                post = post,
                                unread = ForumList.unread(post, state.list.viewer[post.id], meId, state.list.forumPreviousReadAt),
                                tagsById = state.tagsById,
                                onClick = { open(post) },
                                modifier = Modifier
                                    .padding(horizontal = Spacing.gutter, vertical = 6.dp)
                                    .animateItem(),
                            )
                        }
                        item(key = "footer") {
                            ListFooter(state = state, onRetry = model::loadMore)
                        }
                    }
                }
            }

            // "3 posts com novidade · Atualizar" (UX §2.2 #14). One polite
            // live region, never one announcement per card.
            val queued = state.list.queued.size
            AnimatedVisibility(
                visible = queued > 0,
                enter = slideInVertically(spring(dampingRatio = 0.7f, stiffness = 500f)) { -it } + fadeIn(),
                exit = slideOutVertically { -it } + fadeOut(),
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = Spacing.sm),
            ) {
                LivePill(
                    count = queued,
                    onClick = {
                        model.flush()
                        scope.launch { listState.animateScrollToItem(0) }
                    },
                )
            }

            if (!state.postingEnabled && !state.forumEmpty && !state.loading) {
                PausedLine(Modifier.align(Alignment.BottomCenter))
            }
        }
    }

    if (showingRules && !guidelines.isNullOrBlank()) {
        GuidelinesSheet(text = guidelines, onDismiss = { showingRules = false })
    }
    if (showingSort) {
        SortSheet(
            current = state.filters.sort,
            onPick = {
                model.setSort(it)
                showingSort = false
            },
            onDismiss = { showingSort = false },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ForumTopBar(
    forumName: String,
    serverName: String,
    state: ForumUiState,
    searchText: String,
    onSearchText: (String) -> Unit,
    onOpenSearch: () -> Unit,
    onCloseSearch: () -> Unit,
    onBack: () -> Unit,
) {
    val focus = remember { FocusRequester() }
    TopAppBar(
        navigationIcon = {
            IconButton(onClick = if (state.searching) onCloseSearch else onBack) {
                Icon(
                    PqpIcons.Back,
                    contentDescription = stringResource(R.string.chat_back),
                    modifier = Modifier.size(Sizes.iconAction),
                )
            }
        },
        title = {
            AnimatedContent(
                targetState = state.searching,
                transitionSpec = { fadeIn(tween(160)) togetherWith fadeOut(tween(120)) },
                label = "forum-title",
            ) { searching ->
                if (searching) {
                    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
                    TextField(
                        value = searchText,
                        onValueChange = onSearchText,
                        singleLine = true,
                        placeholder = { Text(stringResource(R.string.forum_search)) },
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
                            unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
                            focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                            unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                        ),
                        textStyle = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier
                            .fillMaxWidth()
                            .focusRequester(focus)
                            .testTag("forum.search"),
                    )
                } else {
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                imageVector = PqpIcons.ForumChannel,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.size(Sizes.iconInline),
                            )
                            Spacer(Modifier.width(Spacing.sm))
                            Text(
                                text = forumName.ifBlank { stringResource(R.string.forum_untitled) },
                                style = MaterialTheme.typography.titleLarge,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        val count = state.list.counts?.posts
                        val subtitle = listOfNotNull(
                            serverName.takeIf { it.isNotBlank() },
                            count?.let {
                                if (it == 0) {
                                    stringResource(R.string.forum_header_count_zero)
                                } else {
                                    pluralStringResource(R.plurals.forum_header_count, it, it)
                                }
                            },
                        ).joinToString(" · ")
                        if (subtitle.isNotEmpty()) {
                            Text(
                                text = subtitle,
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        },
        actions = {
            if (state.searching) {
                if (searchText.isNotEmpty()) {
                    IconButton(onClick = { onSearchText("") }) {
                        Icon(PqpIcons.Close, contentDescription = stringResource(R.string.forum_search_clear))
                    }
                }
            } else if (!state.forumEmpty && !state.loading) {
                // An empty forum has nothing to search (UX §2.8 #49).
                IconButton(onClick = onOpenSearch, modifier = Modifier.testTag("forum.openSearch")) {
                    Icon(
                        PqpIcons.Search,
                        contentDescription = stringResource(R.string.forum_search),
                        modifier = Modifier.size(Sizes.iconAction),
                    )
                }
            }
        },
        colors = pqpTopBarColors(),
    )
}

/** "Regras do fórum ›": one row on a phone, the whole text in a sheet (UX §2.9 #55). */
@Composable
private fun GuidelinesRow(onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(14.dp),
        color = colors.surfaceContainer,
        border = androidx.compose.foundation.BorderStroke(Sizes.hairline, colors.outline),
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = Spacing.gutter, end = Spacing.gutter, top = Spacing.md)
            .testTag("forum.rules"),
    ) {
        Row(
            modifier = Modifier.heightIn(min = 52.dp).padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(28.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(ForumColors.accentSoft()),
                contentAlignment = Alignment.Center,
            ) {
                Icon(PqpIcons.Guidelines, contentDescription = null, tint = ForumColors.onAccentSoft(), modifier = Modifier.size(16.dp))
            }
            Spacer(Modifier.width(Spacing.md))
            Text(
                text = stringResource(R.string.forum_rules_title),
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.weight(1f),
            )
            Icon(PqpIcons.Forward, contentDescription = null, tint = colors.onSurfaceVariant, modifier = Modifier.size(18.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GuidelinesSheet(text: String, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = Spacing.gutter)
                .padding(bottom = Spacing.xl),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(PqpIcons.Guidelines, contentDescription = null, tint = ForumColors.onAccentSoft(), modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(Spacing.sm))
                Text(stringResource(R.string.forum_rules_title), style = MaterialTheme.typography.titleLarge)
            }
            Spacer(Modifier.height(Spacing.md))
            gg.pqp.app.ui.chat.MessageBody(body = text, editedMark = null, selfUsername = null)
        }
    }
}

/**
 * Every filter in one sideways strip (UX §2.9 #56): the sort chip, then
 * Abertos and Resolvidos as toggles (Todos is "neither"), Meus posts, then
 * the tags. Active chips come first so a short list says why it is short.
 */
@Composable
private fun FilterStrip(
    state: ForumUiState,
    onSort: () -> Unit,
    onStatus: (ForumStatus) -> Unit,
    onMine: () -> Unit,
    onTag: (String) -> Unit,
) {
    val filters = state.filters
    data class Chip(val key: String, val active: Boolean, val content: @Composable () -> Unit)

    val chips = buildList {
        add(
            Chip("status-open", filters.status == ForumStatus.Open) {
                ForumFilterChip(
                    label = stringResource(R.string.forum_filter_open),
                    selected = filters.status == ForumStatus.Open,
                    onClick = { onStatus(ForumStatus.Open) },
                    testTag = "forum.filter.open",
                )
            },
        )
        add(
            Chip("status-resolved", filters.status == ForumStatus.Resolved) {
                ForumFilterChip(
                    label = stringResource(R.string.forum_filter_resolved),
                    selected = filters.status == ForumStatus.Resolved,
                    onClick = { onStatus(ForumStatus.Resolved) },
                    testTag = "forum.filter.resolved",
                )
            },
        )
        add(
            Chip("mine", filters.mine) {
                ForumFilterChip(
                    label = stringResource(R.string.forum_filter_mine),
                    selected = filters.mine,
                    onClick = onMine,
                    testTag = "forum.filter.mine",
                )
            },
        )
        state.tags.forEach { tag ->
            val on = tag.id in filters.tagIds
            add(
                Chip("tag-${tag.id}", on) {
                    ForumFilterChip(
                        label = tag.displayName(),
                        selected = on,
                        onClick = { onTag(tag.id) },
                        leading = if (tag.hasGlyph()) {
                            { ForumTagGlyph(tag, size = 16.dp) }
                        } else {
                            null
                        },
                        testTag = "forum.filter.tag.${tag.id}",
                    )
                },
            )
        }
    }.sortedByDescending { it.active }

    LazyRow(
        contentPadding = PaddingValues(horizontal = Spacing.gutter),
        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = Spacing.xs)
            .testTag("forum.filters"),
    ) {
        item(key = "sort") {
            ForumFilterChip(
                label = stringResource(
                    if (filters.sort == ForumSort.Activity) R.string.forum_sort_activity_short else R.string.forum_sort_created,
                ),
                selected = false,
                showClose = false,
                onClick = onSort,
                leading = { Icon(PqpIcons.Sort, contentDescription = null, modifier = Modifier.size(14.dp)) },
                trailingIcon = PqpIcons.Expand,
                testTag = "forum.sort",
            )
        }
        items(chips, key = { it.key }) { chip ->
            Box(Modifier.animateItem()) { chip.content() }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SortSheet(current: ForumSort, onPick: (ForumSort) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.navigationBarsPadding().padding(bottom = Spacing.lg)) {
            Text(
                text = stringResource(R.string.forum_sort_label),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
            )
            listOf(
                ForumSort.Activity to R.string.forum_sort_activity,
                ForumSort.Created to R.string.forum_sort_created,
            ).forEach { (sort, label) ->
                Surface(
                    onClick = { onPick(sort) },
                    color = androidx.compose.ui.graphics.Color.Transparent,
                    modifier = Modifier.fillMaxWidth().testTag("forum.sort.${sort.wire}"),
                ) {
                    Row(
                        modifier = Modifier.heightIn(min = 52.dp).padding(horizontal = Spacing.gutter),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = sort == current, onClick = null)
                        Spacer(Modifier.width(Spacing.md))
                        Text(stringResource(label), style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
        }
    }
}

@Composable
private fun LivePill(count: Int, onClick: () -> Unit) {
    val text = pluralStringResource(R.plurals.forum_live, count, count)
    Surface(
        onClick = onClick,
        shape = CircleShape,
        color = MaterialTheme.colorScheme.primary,
        contentColor = MaterialTheme.colorScheme.onPrimary,
        shadowElevation = 4.dp,
        modifier = Modifier
            .heightIn(min = 40.dp)
            .semantics { liveRegion = LiveRegionMode.Polite }
            .testTag("forum.livePill"),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(PqpIcons.SlideUp, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            Text(text = "$text · ${stringResource(R.string.forum_live_refresh)}", style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
private fun ListFooter(state: ForumUiState, onRetry: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(Spacing.lg),
        contentAlignment = Alignment.Center,
    ) {
        when {
            state.loadingMore -> CircularProgressIndicator(Modifier.size(24.dp))
            state.moreError -> TextButton(onClick = onRetry) {
                Text(stringResource(R.string.forum_load_more_failed))
            }
            state.list.nextCursor == null -> {
                val total = state.list.counts?.posts ?: (state.list.pinned.size + state.list.posts.size)
                if (!state.filters.active && total > 0) {
                    Text(
                        text = pluralStringResource(R.plurals.forum_end, total, total),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.testTag("forum.end"),
                    )
                }
            }
        }
    }
}

/** A centred message with one action: errors and the empty states. */
@Composable
private fun ForumMessage(
    title: String,
    body: String? = null,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    secondaryLabel: String? = null,
    onSecondary: (() -> Unit)? = null,
    warning: Boolean = false,
    icon: androidx.compose.ui.graphics.vector.ImageVector = PqpIcons.ForumChannel,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.xxl, vertical = 56.dp)
            .animateContentSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier
                .size(64.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.surfaceContainer),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = if (warning) PqpIcons.Warning else icon,
                contentDescription = null,
                tint = if (warning) ForumColors.warning() else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(28.dp),
            )
        }
        Spacer(Modifier.height(Spacing.lg))
        Text(title, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
        body?.let {
            Spacer(Modifier.height(Spacing.sm))
            Text(
                it,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
        if (actionLabel != null && onAction != null) {
            Spacer(Modifier.height(Spacing.xl))
            Button(onClick = onAction, modifier = Modifier.heightIn(min = 48.dp).testTag("forum.message.action")) {
                Text(actionLabel)
            }
        }
        if (secondaryLabel != null && onSecondary != null) {
            Spacer(Modifier.height(Spacing.sm))
            OutlinedButton(onClick = onSecondary, modifier = Modifier.heightIn(min = 48.dp)) { Text(secondaryLabel) }
        }
    }
}

/** UX §2.8 #49: no search, no filters, one primary action. */
@Composable
private fun ForumEmpty(mayCreate: Boolean, paused: Boolean, onCreate: () -> Unit) {
    ForumMessage(
        title = stringResource(R.string.forum_empty),
        body = stringResource(if (paused) R.string.forum_paused else R.string.forum_empty_body),
        actionLabel = stringResource(R.string.forum_empty_cta).takeIf { mayCreate },
        onAction = onCreate.takeIf { mayCreate },
    )
}

/** Filters, the search or "Meus posts" left nothing (UX §2.8 #50). */
@Composable
private fun FilteredEmpty(state: ForumUiState, onClear: () -> Unit, onPost: () -> Unit) {
    val filters = state.filters
    when {
        filters.q.isNotEmpty() -> ForumMessage(
            title = stringResource(R.string.forum_search_empty, filters.q),
            body = stringResource(R.string.forum_search_empty_body),
            actionLabel = stringResource(R.string.forum_search_empty_post, filters.q).takeIf { state.mayCreate },
            onAction = onPost.takeIf { state.mayCreate },
            icon = PqpIcons.Search,
        )
        filters.mine && filters.status == null && filters.tagIds.isEmpty() -> ForumMessage(
            title = stringResource(R.string.forum_mine_empty),
            actionLabel = stringResource(R.string.forum_filter_empty_clear),
            onAction = onClear,
        )
        else -> ForumMessage(
            title = stringResource(R.string.forum_filter_empty),
            actionLabel = stringResource(R.string.forum_filter_empty_clear),
            onAction = onClear,
        )
    }
}

/** The flag is off for this server: reading and replying go on, new posts wait (UX §2.8 #52). */
@Composable
private fun PausedLine(modifier: Modifier = Modifier) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        border = androidx.compose.foundation.BorderStroke(Sizes.hairline, MaterialTheme.colorScheme.outline),
        modifier = modifier
            .padding(Spacing.gutter)
            .navigationBarsPadding()
            .testTag("forum.paused"),
    ) {
        Text(
            text = stringResource(R.string.forum_paused),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.md),
        )
    }
}
