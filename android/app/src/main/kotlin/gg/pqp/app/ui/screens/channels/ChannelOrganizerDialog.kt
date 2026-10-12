package gg.pqp.app.ui.screens.channels

import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.zIndex
import gg.pqp.app.R
import gg.pqp.app.core.Channel
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

private const val FOOTER_KEY = "organize-footer"

/** What saving the staged order came to, once the channel list has applied it. */
sealed interface ChannelLayoutSaveOutcome {
    data object Saved : ChannelLayoutSaveOutcome

    /** Somebody else changed the list first. The list draws theirs; the organizer starts again from it. */
    data class Stale(val layout: SidebarLayout<LayoutRow>, val version: Int) : ChannelLayoutSaveOutcome

    /** The server is not in the mixed list any more. The old list is drawn. */
    data object Off : ChannelLayoutSaveOutcome

    /** Nothing was saved. The staged order stays, with this sentence. */
    data class Failed(val message: String) : ChannelLayoutSaveOutcome
}

/**
 * ORGANIZAR CANAIS: AN EXPLICIT MODE, NOT A LONG-PRESS DRAG ON THE LIST.
 *
 * A list people mostly tap should not rearrange by accident, so reordering is
 * a screen of its own. Every row and heading has a handle (≡); the drag starts
 * on the handle only, the row follows the finger, and the list closes behind
 * it and opens where it will land. A heading carries its channels; a channel
 * belongs to the nearest heading above where it lands. Nothing is sent until
 * Concluir, which sends the whole order in one `PUT`; Cancelar (or back)
 * throws the staged order away.
 *
 * TalkBack cannot drag, so every row and heading also carries Mover para cima
 * / Mover para baixo as custom actions ([ChannelOrganizer.step]), which cross
 * category borders the way the web's menu does, and the result is announced.
 *
 * Motion is the list's own springs, which the system animator duration scale
 * shortens or turns off.
 */
@Composable
fun ChannelOrganizerDialog(
    layout: SidebarLayout<LayoutRow>,
    baseVersion: Int,
    onDismiss: () -> Unit,
    save: suspend (SidebarLayout<LayoutRow>, Int) -> ChannelLayoutSaveOutcome,
    /** Creates a category on the server; the list version after the write, when it could be read. */
    createCategory: suspend (String) -> Pair<Channel, Int?>,
    /** Renames a category on the server; the list version after the write. */
    renameCategory: suspend (Channel, String) -> Pair<Channel, Int?>,
) {
    val organizer = remember { ChannelOrganizer(layout) }
    // The organizer is a plain class: this counter is what tells Compose it changed.
    var revision by remember { mutableIntStateOf(0) }
    var version by remember { mutableIntStateOf(baseVersion) }
    var saving by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }
    var renaming by remember { mutableStateOf<Channel?>(null) }
    var creating by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val view = LocalView.current
    // What a Mover para cima / baixo did, read out through a polite live region.
    var announcement by remember { mutableStateOf("") }
    val staleText = stringResource(R.string.channels_reorder_stale)
    val failedText = stringResource(R.string.channels_reorder_failed)

    val items = remember(revision) { organizer.items }
    val listState = rememberLazyListState()
    var draggingKey by remember { mutableStateOf<String?>(null) }
    var dragStartOffset by remember { mutableIntStateOf(0) }
    var dragDelta by remember { mutableFloatStateOf(0f) }

    fun dismiss() {
        if (!saving) onDismiss()
    }

    fun commit() {
        if (!organizer.hasChanges) {
            onDismiss()
            return
        }
        saving = true
        scope.launch {
            val outcome = try {
                save(organizer.layout, version)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                ChannelLayoutSaveOutcome.Failed(failedText)
            }
            saving = false
            when (outcome) {
                ChannelLayoutSaveOutcome.Saved, ChannelLayoutSaveOutcome.Off -> onDismiss()
                is ChannelLayoutSaveOutcome.Stale -> {
                    organizer.reset(outcome.layout)
                    version = outcome.version
                    revision++
                    notice = staleText
                }
                is ChannelLayoutSaveOutcome.Failed -> notice = outcome.message
            }
        }
    }

    // The drag: the handle reports deltas; the row under the dragged row's
    // middle is where it goes, applied to the staged order as it happens.
    fun onDrag(delta: Float) {
        val key = draggingKey ?: return
        dragDelta += delta
        val info = listState.layoutInfo
        val dragged = info.visibleItemsInfo.firstOrNull { it.key == key } ?: return
        val middle = dragStartOffset + dragDelta + dragged.size / 2f
        val over = info.visibleItemsInfo.firstOrNull { item ->
            item.key != key && item.key != FOOTER_KEY && middle >= item.offset && middle <= item.offset + item.size
        }
        if (over != null) {
            // Indices from the organizer itself: the layout info can be a frame
            // behind a move that just happened.
            val keys = organizer.items.map { it.key }
            val from = keys.indexOf(key)
            val to = keys.indexOf(over.key)
            if (from != -1 && to != -1 && organizer.move(from = from, to = to)) revision++
        }
        // Near an edge, the list scrolls under the finger.
        val edge = 48.dp.value * view.resources.displayMetrics.density
        val top = dragStartOffset + dragDelta - info.viewportStartOffset
        val bottom = info.viewportEndOffset - (dragStartOffset + dragDelta + dragged.size)
        when {
            top < edge -> listState.dispatchRawDelta(-(edge - top) / 4f)
            bottom < edge -> listState.dispatchRawDelta((edge - bottom) / 4f)
        }
    }

    Dialog(
        onDismissRequest = ::dismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        val colors = MaterialTheme.colorScheme
        Column(
            Modifier
                .fillMaxSize()
                .background(colors.background)
                .windowInsetsPadding(WindowInsets.statusBars)
                .testTag("organize.screen"),
        ) {
            Row(
                Modifier.fillMaxWidth().height(56.dp).padding(horizontal = Spacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = ::dismiss, enabled = !saving, modifier = Modifier.testTag("organize.cancel")) {
                    Text(stringResource(R.string.channels_organize_cancel), color = colors.onSurface)
                }
                Text(
                    text = stringResource(R.string.channels_organize),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f).semantics { heading() },
                )
                Box(Modifier.width(96.dp), contentAlignment = Alignment.CenterEnd) {
                    if (saving) {
                        CircularProgressIndicator(Modifier.size(20.dp).padding(end = Spacing.md), strokeWidth = 2.dp)
                    } else {
                        TextButton(onClick = ::commit, modifier = Modifier.testTag("organize.done")) {
                            Text(
                                stringResource(R.string.channels_organize_done),
                                color = colors.primary,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                }
            }

            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(bottom = Spacing.xl),
            ) {
                itemsIndexed(items, key = { _, item -> item.key }) { _, item ->
                    val lifted = item.key == draggingKey
                    val current = listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key == item.key }
                    val shift = if (lifted && current != null) dragStartOffset + dragDelta - current.offset else 0f
                    val handle = Modifier.pointerInput(item.key) {
                        detectDragGestures(
                            onDragStart = {
                                val info = listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key == item.key }
                                draggingKey = item.key
                                dragStartOffset = info?.offset ?: 0
                                dragDelta = 0f
                            },
                            onDragEnd = { draggingKey = null },
                            onDragCancel = { draggingKey = null },
                            onDrag = { change, amount ->
                                change.consume()
                                onDrag(amount.y)
                            },
                        )
                    }
                    Box(
                        Modifier
                            .zIndex(if (lifted) 1f else 0f)
                            .graphicsLayer {
                                translationY = shift
                                shadowElevation = if (lifted) 8.dp.toPx() else 0f
                            }
                            .then(
                                if (lifted) {
                                    Modifier
                                } else {
                                    Modifier.animateItem(
                                        fadeInSpec = spring(stiffness = 400f),
                                        placementSpec = spring(
                                            dampingRatio = 0.85f,
                                            stiffness = 380f,
                                            visibilityThreshold = IntOffset.VisibilityThreshold,
                                        ),
                                        fadeOutSpec = spring(stiffness = 600f),
                                    )
                                },
                            ),
                    ) {
                        OrganizerRow(
                            item = item,
                            lifted = lifted,
                            handle = handle,
                            canUp = { organizer.canStep(it, -1) },
                            canDown = { organizer.canStep(it, 1) },
                            onStep = { id, name, direction ->
                                val target = organizer.step(id, direction)
                                if (target != null) {
                                    revision++
                                    locateInLayout(organizer.layout, id)?.let { place ->
                                        val position = place.index + 1
                                        val text = when {
                                            place.isCategory -> view.context.getString(
                                                R.string.channels_moved_category, name, position, place.total,
                                            )
                                            target.parentId != null -> view.context.getString(
                                                R.string.channels_moved_to,
                                                name,
                                                organizer.layout.categories.first { it.category.id == target.parentId }
                                                    .category.channel.name,
                                                position,
                                                place.total,
                                            )
                                            else -> view.context.getString(
                                                R.string.channels_moved_loose, name, position, place.total,
                                            )
                                        }
                                        announcement = text
                                    }
                                }
                            },
                            onRename = { renaming = it },
                        )
                    }
                }
                item(key = FOOTER_KEY) {
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter, vertical = Spacing.lg),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(Spacing.md),
                    ) {
                        DashedButton(
                            text = stringResource(R.string.channels_create_category),
                            onClick = { creating = true },
                            modifier = Modifier.testTag("organize.createCategory"),
                        )
                        Text(
                            text = stringResource(R.string.channels_organize_tip),
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.onSurfaceVariant,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
            Box(Modifier.size(1.dp).semantics { liveRegion = LiveRegionMode.Polite; contentDescription = announcement })
            Spacer(Modifier.windowInsetsPadding(WindowInsets.navigationBars))
        }

        notice?.let { text ->
            AlertDialog(
                onDismissRequest = { notice = null },
                confirmButton = {
                    TextButton(onClick = { notice = null }, modifier = Modifier.testTag("organize.notice.ok")) {
                        Text(stringResource(R.string.channels_got_it))
                    }
                },
                text = { Text(text, modifier = Modifier.testTag("organize.notice")) },
            )
        }
        renaming?.let { category ->
            CategoryNameDialog(
                title = stringResource(R.string.channels_rename_category),
                confirm = stringResource(R.string.channels_rename),
                initial = category.name,
                onDismiss = { renaming = null },
                onConfirm = { name ->
                    renaming = null
                    if (name == category.name) return@CategoryNameDialog
                    scope.launch {
                        try {
                            val (updated, after) = renameCategory(category, name)
                            organizer.replaceCategory(LayoutRow(updated))
                            after?.let { version = it }
                            revision++
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            notice = e.message ?: failedText
                        }
                    }
                },
            )
        }
        if (creating) {
            CategoryNameDialog(
                title = stringResource(R.string.channels_create_category),
                confirm = stringResource(R.string.channels_create),
                initial = "",
                onDismiss = { creating = false },
                onConfirm = { name ->
                    creating = false
                    scope.launch {
                        try {
                            val (category, after) = createCategory(name)
                            organizer.appendCategory(LayoutRow(category))
                            after?.let { version = it }
                            revision++
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            notice = e.message ?: failedText
                        }
                    }
                },
            )
        }
    }
}

@Composable
private fun OrganizerRow(
    item: OrganizerItem<LayoutRow>,
    lifted: Boolean,
    handle: Modifier,
    canUp: (String) -> Boolean,
    canDown: (String) -> Boolean,
    onStep: (id: String, name: String, direction: Int) -> Unit,
    onRename: (Channel) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val up = stringResource(R.string.channels_move_up)
    val down = stringResource(R.string.channels_move_down)
    val renameLabel = stringResource(R.string.channels_rename_category)

    fun actions(id: String, name: String, extra: List<CustomAccessibilityAction> = emptyList()) = buildList {
        if (canUp(id)) add(CustomAccessibilityAction(up) { onStep(id, name, -1); true })
        if (canDown(id)) add(CustomAccessibilityAction(down) { onStep(id, name, 1); true })
        addAll(extra)
    }

    when (item) {
        is OrganizerItem.Header -> {
            val category = item.category.channel
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(top = Spacing.md)
                    .heightIn(min = 40.dp)
                    .liftedSurface(lifted)
                    .semantics(mergeDescendants = true) {
                        heading()
                        customActions = actions(
                            category.id,
                            category.name,
                            listOf(CustomAccessibilityAction(renameLabel) { onRename(category); true }),
                        )
                    }
                    .padding(start = Spacing.gutter)
                    .testTag("organize.header.${category.name}"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = category.name.uppercase(),
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    IconButton(onClick = { onRename(category) }, modifier = Modifier.size(36.dp)) {
                        Icon(
                            imageVector = PqpIcons.Edit,
                            contentDescription = renameLabel,
                            tint = colors.onSurfaceVariant,
                            modifier = Modifier.size(14.dp),
                        )
                    }
                }
                DragHandle(category.name, handle)
            }
        }
        is OrganizerItem.Row -> {
            val channel = item.channel.channel
            Row(
                Modifier
                    .fillMaxWidth()
                    .height(ChannelRowHeight + 4.dp)
                    .liftedSurface(lifted)
                    .semantics(mergeDescendants = true) { customActions = actions(channel.id, channel.name) }
                    .padding(start = Spacing.gutter + Spacing.xs)
                    .testTag("organize.row.${channel.name}"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ChannelGlyph(channel = channel, tint = colors.onSurfaceVariant)
                Spacer(Modifier.width(Spacing.sm + 2.dp))
                Text(
                    text = channel.name,
                    style = MaterialTheme.typography.bodyLarge,
                    color = colors.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                DragHandle(channel.name, handle)
            }
        }
        is OrganizerItem.Empty -> {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(start = Spacing.gutter, end = Spacing.gutter)
                    .height(36.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.width(1.dp).height(28.dp).background(colors.outlineVariant))
                Text(
                    text = stringResource(R.string.channels_empty_category),
                    style = MaterialTheme.typography.bodyMedium,
                    fontStyle = FontStyle.Italic,
                    color = colors.onSurfaceVariant,
                    modifier = Modifier.padding(start = Spacing.md),
                )
            }
        }
    }
}

/** The lifted row: raised surface, an accent ring. */
@Composable
private fun Modifier.liftedSurface(lifted: Boolean): Modifier {
    if (!lifted) return this
    val colors = MaterialTheme.colorScheme
    val shape = MaterialTheme.shapes.small
    return this
        .padding(horizontal = Spacing.railInset)
        .background(colors.surfaceContainerHigh, shape)
        .border(1.dp, colors.primary.copy(alpha = 0.6f), shape)
}

/** ≡, the only place a drag starts. */
@Composable
private fun DragHandle(name: String, gesture: Modifier) {
    val tint = MaterialTheme.colorScheme.onSurfaceVariant
    val label = stringResource(R.string.channels_drag_handle, name)
    Box(
        Modifier
            .size(48.dp)
            .then(gesture)
            .semantics { contentDescription = label }
            .testTag("organize.handle.$name"),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(width = 18.dp, height = 12.dp)) {
            val stroke = 1.5.dp.toPx()
            listOf(0f, size.height / 2f, size.height).forEach { y ->
                drawLine(tint, Offset(0f, y), Offset(size.width, y), strokeWidth = stroke)
            }
        }
    }
}

@Composable
private fun DashedButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    val outline = colors.outline
    TextButton(
        onClick = onClick,
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp),
    ) {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Canvas(Modifier.matchParentSize()) {
                drawRoundRect(
                    color = outline,
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(8.dp.toPx()),
                    style = androidx.compose.ui.graphics.drawscope.Stroke(
                        width = 1.dp.toPx(),
                        pathEffect = PathEffect.dashPathEffect(floatArrayOf(8f, 6f)),
                    ),
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = Spacing.md)) {
                Icon(PqpIcons.Add, contentDescription = null, tint = colors.onSurface, modifier = Modifier.size(Sizes.iconInline))
                Spacer(Modifier.width(Spacing.sm))
                Text(text, color = colors.onSurface, style = MaterialTheme.typography.bodyLarge)
            }
        }
    }
}

/** A category name: 1 to 32 characters, spaces welcome. Confirm is off until the server would take it. */
@Composable
fun CategoryNameDialog(
    title: String,
    confirm: String,
    initial: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var text by remember { mutableStateOf(initial) }
    val valid = normalizedCategoryName(text)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                singleLine = true,
                label = { Text(stringResource(R.string.channels_category_name)) },
                placeholder = { Text(stringResource(R.string.channels_category_name_hint)) },
                modifier = Modifier.testTag("channels.categoryName"),
            )
        },
        confirmButton = {
            TextButton(
                onClick = { valid?.let(onConfirm) },
                enabled = valid != null,
                modifier = Modifier.testTag("channels.categoryName.confirm"),
            ) { Text(confirm) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.channels_organize_cancel)) } },
    )
}
