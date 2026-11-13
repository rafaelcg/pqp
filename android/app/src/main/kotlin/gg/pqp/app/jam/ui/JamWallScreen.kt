package gg.pqp.app.jam.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.jam.JamBand
import gg.pqp.app.jam.JamBands
import gg.pqp.app.jam.JamSongSummary
import gg.pqp.app.jam.JamRecordRules
import gg.pqp.app.jam.JamTileInfo
import gg.pqp.app.jam.RecordGate
import gg.pqp.app.jam.JamTileSize
import gg.pqp.app.jam.JamWallFilter
import gg.pqp.app.jam.JamWallUiState
import gg.pqp.app.jam.JamWallViewModel
import gg.pqp.app.onboarding.ui.rememberReduceMotion
import gg.pqp.app.ui.components.ChromeDivider
import gg.pqp.app.ui.components.pqpTopBarColors
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.launch
import kotlin.math.max

/** Two columns on a phone, and a column of at most this width on anything wider. */
private val MaxWallWidth = 640.dp
private val Gap = 10.dp

/**
 * A jam channel: its songs as a mosaic of tiles of varied sizes, the newest or
 * most active large. Filters, pull to refresh, paging, and the seven live
 * frames (a song arriving settles in with a "nova" mark).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JamWallScreen(
    model: JamWallViewModel,
    channelName: String,
    serverName: String,
    shared: JamSharedScope?,
    onBack: () -> Unit,
    onOpenSong: (JamSongSummary) -> Unit,
    /** The record button and the empty wall's call to action: start a song with a first recording. */
    onRecordNew: () -> Unit,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()
    val reduce = rememberReduceMotion()
    // Tiles that already settled in this visit: scrolling one back into view must not play its entrance again.
    val settled = remember { HashSet<String>() }
    val snackbars = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    // Starting a song is the flag and storage, nothing else the client can know: the server checks the permission to post.
    val gate = JamRecordRules.gateNewSong(state.config)
    val blockedText = when ((gate as? RecordGate.Blocked)?.reason) {
        RecordGate.Reason.Off -> stringResource(R.string.jam_rec_cannot_off)
        RecordGate.Reason.UploadsOff -> stringResource(R.string.jam_rec_cannot_uploads_off)
        else -> stringResource(R.string.jam_rec_cannot_other)
    }
    val record: () -> Unit = {
        if (gate == RecordGate.Open) onRecordNew() else scope.launch { snackbars.showSnackbar(blockedText) }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbars) },
        floatingActionButton = {
            // Only where the server says jam is on: an unflagged server looks exactly as it did.
            if (state.phase == JamWallUiState.Phase.Ready && state.config.enabled) {
                val label = stringResource(R.string.jam_wall_record)
                ExtendedFloatingActionButton(
                    onClick = record,
                    icon = { Icon(PqpIcons.Mic, contentDescription = null) },
                    text = { Text(stringResource(R.string.jam_wall_record_short), fontWeight = FontWeight.Bold) },
                    modifier = Modifier.testTag("jam.wall.record").semantics { contentDescription = label },
                )
            }
        },
        topBar = {
            Column {
                TopAppBar(
                    colors = pqpTopBarColors(),
                    navigationIcon = {
                        IconButton(onClick = onBack, modifier = Modifier.testTag("jam.back")) {
                            Icon(PqpIcons.Back, contentDescription = stringResource(R.string.jam_back))
                        }
                    },
                    title = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                Modifier
                                    .size(32.dp)
                                    .clip(CircleShape)
                                    .background(MaterialTheme.colorScheme.primary),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    PqpIcons.JamChannel,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.onPrimary,
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                            Spacer(Modifier.size(Spacing.sm + 2.dp))
                            Column {
                                Text(
                                    text = channelName.ifBlank { stringResource(R.string.jam_channel_default) },
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold,
                                    maxLines = 1,
                                )
                                val count = state.wall.songs.size
                                if (state.phase == JamWallUiState.Phase.Ready && count > 0) {
                                    Text(
                                        text = if (state.wall.nextCursor != null) {
                                            stringResource(R.string.jam_wall_count_more, count)
                                        } else {
                                            pluralStringResource(R.plurals.jam_wall_count, count, count)
                                        },
                                        style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    },
                )
                ChromeDivider()
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.TopCenter) {
            Column(Modifier.fillMaxSize().widthIn(max = MaxWallWidth)) {
                val showFilters = state.phase == JamWallUiState.Phase.Ready && !state.emptyWall
                if (showFilters) {
                    FilterStrip(state.filter, onSelect = model::setFilter)
                }
                when {
                    state.phase == JamWallUiState.Phase.Loading -> WallSkeleton()
                    state.phase == JamWallUiState.Phase.Failed -> WallMessage(
                        title = stringResource(R.string.jam_wall_failed),
                        action = stringResource(R.string.jam_retry),
                        onAction = model::load,
                    )
                    state.emptyWall -> PullToRefreshBox(
                        isRefreshing = state.refreshing,
                        onRefresh = model::refresh,
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        EmptyWall(onRecord = record, canRecord = state.config.enabled)
                    }
                    else -> PullToRefreshBox(
                        isRefreshing = state.refreshing,
                        onRefresh = model::refresh,
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        Mosaic(
                            state = state,
                            listState = listState,
                            reduce = reduce,
                            settled = settled,
                            shared = shared,
                            model = model,
                            onOpenSong = onOpenSong,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun FilterStrip(selected: JamWallFilter, onSelect: (JamWallFilter) -> Unit) {
    val label = stringResource(R.string.jam_filters_label)
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = Spacing.gutter, vertical = Spacing.sm)
            .semantics { contentDescription = label },
        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        JamWallFilter.entries.forEach { filter ->
            FilterChip(
                selected = selected == filter,
                onClick = { onSelect(filter) },
                label = {
                    Text(
                        stringResource(
                            when (filter) {
                                JamWallFilter.All -> R.string.jam_filter_all
                                JamWallFilter.Missing -> R.string.jam_filter_missing
                                JamWallFilter.Finished -> R.string.jam_filter_finished
                            },
                        ),
                    )
                },
                modifier = Modifier.testTag("jam.filter.${filter.name.lowercase()}"),
            )
        }
    }
}

@Composable
private fun Mosaic(
    state: JamWallUiState,
    listState: androidx.compose.foundation.lazy.LazyListState,
    reduce: Boolean,
    settled: MutableSet<String>,
    shared: JamSharedScope?,
    model: JamWallViewModel,
    onOpenSong: (JamSongSummary) -> Unit,
) {
    val visible = state.visible
    val lastId = visible.lastOrNull()?.id
    val fontScale = LocalDensity.current.fontScale
    // Big type is a single column: two tiles side by side leave a title nowhere to go.
    val columns = if (fontScale >= LARGE_TYPE) 1 else 2
    val bands: List<JamBand> = remember(visible, state.previews, columns) {
        JamBands.build(visible, hasVideo = { song -> JamTileInfo.hasVideo(song, state.anyPreview(song)) }, columns = columns)
    }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val gutter = Spacing.gutter
        val unitWidth: Dp = (maxWidth - gutter * 2 - Gap * (columns - 1)) / columns
        // Type that scales makes a tile that must grow with it, or a long title has nowhere to go.
        val grow = max(1f, fontScale).let { 1f + (it - 1f) * 0.55f }
        val unit: Dp = if (columns == 1) unitWidth * 0.42f * grow else unitWidth * 0.92f * grow

        LazyColumn(
            state = listState,
            contentPadding = PaddingValues(start = gutter, end = gutter, top = Spacing.xs, bottom = Spacing.xxl * 3),
            verticalArrangement = Arrangement.spacedBy(Gap),
            modifier = Modifier.fillMaxSize().testTag("jam.list"),
        ) {
            if (visible.isEmpty()) {
                item(key = "filter-empty") {
                    Text(
                        text = stringResource(R.string.jam_filter_empty),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(vertical = Spacing.xxl),
                    )
                }
            }
            itemsIndexed(bands, key = { _, band -> band.key }) { index, band ->
                val height = unit * band.rows + Gap * (band.rows - 1)
                Row(
                    Modifier.fillMaxWidth().height(height).animateItem(),
                    horizontalArrangement = Arrangement.spacedBy(Gap),
                ) {
                    band.tiles.forEach { entry ->
                        val song = entry.song
                        val first = settled.add(song.id)
                        val fresh = song.id in state.wall.fresh
                        LaunchedEffect(song.id, song.id == lastId) {
                            model.requestPreview(song)
                            if (song.id == lastId) model.lastTileShown()
                        }
                        androidx.compose.runtime.DisposableEffect(song.id) {
                            onDispose { model.cancelPreview(song.id) }
                        }
                        if (fresh) {
                            LaunchedEffect(song.id) {
                                kotlinx.coroutines.delay(FRESH_MS)
                                model.clearFresh(song.id)
                            }
                        }
                        JamTile(
                            song = song,
                            size = entry.cell.let {
                                when {
                                    it.rows > 1 -> JamTileSize.Hero
                                    it.columns > 1 -> JamTileSize.Wide
                                    else -> JamTileSize.Small
                                }
                            },
                            preview = state.anyPreview(song),
                            fresh = fresh,
                            enterDelayMs = if (reduce) 0 else (index * 55L).coerceAtMost(330L),
                            animateEnter = first && !reduce,
                            shared = shared,
                            onClick = { onOpenSong(song) },
                            modifier = Modifier
                                .weight(entry.cell.columns.toFloat())
                                .fillMaxSize(),
                        )
                    }
                    // A lone small tile at the very end keeps its own width.
                    if (columns > 1 && band.tiles.size == 1 && band.tiles.first().cell.columns == 1) {
                        Spacer(Modifier.weight(1f))
                    }
                }
            }
            item(key = "footer") {
                Footer(state = state, onRetry = model::loadMore)
            }
        }
    }
}

private const val FRESH_MS = 6000L

/** From this font scale up the wall is one column. */
private const val LARGE_TYPE = 1.5f

@Composable
private fun Footer(state: JamWallUiState, onRetry: () -> Unit) {
    when {
        state.loadingMore -> Box(Modifier.fillMaxWidth().padding(Spacing.lg), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
        }
        // The automatic search under a filter gave up: the person decides whether to read further.
        state.chaseStopped -> Text(
            text = stringResource(R.string.jam_look_further),
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.primary,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onRetry)
                .padding(Spacing.lg)
                .testTag("jam.lookFurther"),
        )
        state.loadMoreFailed -> Text(
            text = stringResource(R.string.jam_more_failed),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onRetry)
                .padding(Spacing.lg)
                .testTag("jam.moreFailed"),
        )
        else -> Spacer(Modifier.height(Spacing.sm))
    }
}

@Composable
private fun EmptyWall(onRecord: () -> Unit, canRecord: Boolean) {
    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = Spacing.xl)
            .testTag("jam.empty"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier
                .size(72.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.16f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(PqpIcons.JamChannel, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(32.dp))
        }
        Spacer(Modifier.height(Spacing.lg))
        Text(
            text = stringResource(R.string.jam_empty_title),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(Spacing.sm))
        Text(
            text = stringResource(R.string.jam_empty_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        if (canRecord) {
            Spacer(Modifier.height(Spacing.lg))
            Button(onClick = onRecord, modifier = Modifier.testTag("jam.empty.record")) {
                Icon(PqpIcons.Mic, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.jam_empty_cta), fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun WallMessage(title: String, action: String, onAction: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(Spacing.xl).testTag("jam.error"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(title, style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
        Spacer(Modifier.height(Spacing.md))
        Button(onClick = onAction) { Text(action) }
    }
}

/** Grey blocks where the first page will be, so the screen is never blank while it loads. */
@Composable
private fun WallSkeleton() {
    val pulse = remember { Animatable(0.5f) }
    LaunchedEffect(Unit) {
        while (true) {
            pulse.animateTo(1f, spring(dampingRatio = 1f, stiffness = 40f))
            pulse.animateTo(0.5f, spring(dampingRatio = 1f, stiffness = 40f))
        }
    }
    Column(
        Modifier.fillMaxSize().padding(Spacing.gutter).testTag("jam.loading"),
        verticalArrangement = Arrangement.spacedBy(Gap),
    ) {
        Box(
            Modifier.fillMaxWidth().height(220.dp).clip(MaterialTheme.shapes.large)
                .background(MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = pulse.value)),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(Gap)) {
            repeat(2) {
                Box(
                    Modifier.weight(1f).height(150.dp).clip(MaterialTheme.shapes.large)
                        .background(MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = pulse.value)),
                )
            }
        }
    }
}
