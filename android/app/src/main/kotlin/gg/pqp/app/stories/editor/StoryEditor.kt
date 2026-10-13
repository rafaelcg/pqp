package gg.pqp.app.stories.editor

import android.os.SystemClock
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculateCentroidSize
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateRotation
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.changedToUp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.core.VoiceParticipant
import gg.pqp.app.stories.StoriesRules
import gg.pqp.app.stories.StoryLayers
import gg.pqp.app.stories.ui.backgroundBrush
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull

/** What the composer tells the editor about the story it is making. */
data class EditorEnv(
    /** False against a server that predates layers: only the text tool is left, and it folds into a caption. */
    val layersEnabled: Boolean,
    val isVideo: Boolean,
    val muted: Boolean,
    /** Non-null for a text card: the background token being edited. */
    val cardBackground: String?,
    val audienceLabel: String,
    val canPost: Boolean,
    val posting: Boolean,
    /** "You're not in that room": shown while a call card is placed and its author is not in the room. */
    val callWarning: String?,
    val occupancy: Map<String, List<VoiceParticipant>>,
    /** False for a clip with no audio track (shot without the microphone): there is nothing to mute. */
    val hasAudio: Boolean = true,
    /** The list of who may see the story could not be read: the pill says so and offers a retry. */
    val audienceError: Boolean = false,
)

private enum class Sheet { None, Tray, Photo, Call, Mention }

private data class LayerMenu(val id: String, val at: Offset)

private data class TextTarget(val id: String?)

/**
 * The story editor: a 9:16 canvas with the base under it (a photo, a video or
 * a card), layers on top, and the tools around it.
 *
 * - Every layer drags with one finger and pinches to scale and turn with two,
 *   anywhere on the canvas once one is selected. It snaps to the middle lines
 *   (and to quarter turns) with a light tick, a trash circle appears at the
 *   bottom while one is held and deletes it on release, a tap on text edits
 *   it, a long press opens "bring forward / delete".
 * - Undo steps back one action at a time.
 * - TalkBack gets move, resize, turn, bring forward and delete as actions on
 *   each layer, since a drag cannot be done without sight.
 *
 * The recordings of time here (the long press) read the wall clock, not an
 * animation, so every gesture works with "Remove animations" on.
 */
@Composable
fun StoryEditor(
    session: EditorSession,
    env: EditorEnv,
    base: @Composable (LayerMath.Canvas) -> Unit,
    onClose: () -> Unit,
    onToggleMute: () -> Unit,
    onCardBackground: (String) -> Unit,
    onPickGalleryPhoto: () -> Unit,
    onTakePhoto: () -> Unit,
    onAudience: () -> Unit,
    onRetryAudience: () -> Unit = {},
    onPost: () -> Unit,
    callSheet: @Composable (onPick: (CallLayer) -> Unit, onDismiss: () -> Unit) -> Unit,
    mentionSheet: @Composable (onPick: (MentionLayer) -> Unit, onDismiss: () -> Unit) -> Unit,
    openCallSheetAtStart: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val haptics = LocalHapticFeedback.current
    val density = LocalDensity.current
    var drawing by remember { mutableStateOf(false) }
    var sheet by remember { mutableStateOf(if (openCallSheetAtStart) Sheet.Call else Sheet.None) }
    var textTarget by remember { mutableStateOf<TextTarget?>(null) }
    var menu by remember { mutableStateOf<LayerMenu?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    var dragging by remember { mutableStateOf(false) }
    var trashArmed by remember { mutableStateOf(false) }
    var guideV by remember { mutableStateOf(false) }
    var guideH by remember { mutableStateOf(false) }
    var confirmDiscard by remember { mutableStateOf(false) }
    var canvasPx by remember { mutableStateOf(LayerMath.Canvas(1f, 1f)) }

    val limitLayers = stringResource(R.string.stories_editor_limit_layers)
    val limitPhotos = stringResource(R.string.stories_editor_limit_photos)
    val limitMentions = stringResource(R.string.stories_editor_limit_mentions)
    val limitMentioned = stringResource(R.string.stories_editor_limit_mentioned)
    val refuse: (LayerOps.Refusal) -> Unit = { reason ->
        message = when (reason) {
            LayerOps.Refusal.TooMany -> limitLayers
            LayerOps.Refusal.TooManyPhotos -> limitPhotos
            LayerOps.Refusal.TooManyMentions -> limitMentions
            LayerOps.Refusal.MentionedAlready -> limitMentioned
        }
        haptics.performHapticFeedback(HapticFeedbackType.Reject)
    }
    // A text card has nothing on it until somebody writes: open the keyboard on it.
    LaunchedEffect(Unit) {
        if (env.cardBackground != null && session.layers.isEmpty() && !openCallSheetAtStart) textTarget = TextTarget(null)
    }
    LaunchedEffect(message) {
        if (message != null) {
            delay(2_800)
            message = null
        }
    }

    // What "close" means: a story with something on it asks first.
    val close: () -> Unit = {
        if (session.layers.isNotEmpty()) confirmDiscard = true else onClose()
    }
    BackHandler(enabled = textTarget == null && sheet == Sheet.None) {
        if (drawing) drawing = false else close()
    }

    BoxWithConstraints(
        modifier
            .fillMaxSize()
            .background(Color.Black)
            .testTag("stories.editor"),
    ) {
        // The bar above and below a 9:16 canvas on a taller screen: the tools sit inside the canvas, not across its edge.
        val gap = CanvasInsets.gap(maxWidth, maxHeight)
        BoxWithConstraints(Modifier.fillMaxSize()) {
            // The canvas is 9:16, as wide as it can be; the bars above and below carry the tools.
            val width = minOf(maxWidth, maxHeight * 9f / 16f)
            val height = width * 16f / 9f
            val rounded = maxHeight - height > 24.dp
            val canvas = with(density) { LayerMath.Canvas(width.toPx(), height.toPx()) }
            canvasPx = canvas
            val canvasDescription = stringResource(R.string.stories_editor_canvas)

            val trashCenter = LayerMath.Pt(canvas.width / 2f, canvas.height - with(density) { 72.dp.toPx() })
            val trashRadius = with(density) { 40.dp.toPx() }
            val snapPx = with(density) { 6.dp.toPx() }

            Box(
                Modifier
                    .align(Alignment.Center)
                    .size(width, height)
                    .clip(if (rounded) RoundedCornerShape(20.dp) else RoundedCornerShape(0.dp))
                    .clipToBounds()
                    .semantics { contentDescription = canvasDescription }
                    .testTag("stories.editor.canvas")
                    .pointerInput(drawing, textTarget, sheet, canvas) {
                        if (drawing || textTarget != null || sheet != Sheet.None) return@pointerInput
                        layerGestures(
                            session = session,
                            canvas = canvas,
                            density = density.density,
                            snapPx = snapPx,
                            trashCenter = trashCenter,
                            trashRadius = trashRadius,
                            haptics = haptics,
                            onTapLayer = { layer ->
                                session.selectedId = layer.id
                                if (layer is TextLayer) textTarget = TextTarget(layer.id)
                            },
                            // A tap on nothing writes, like every story app: the text tool opens (and
                            // says so when the story is full).
                            onTapEmpty = {
                                session.selectedId = null
                                menu = null
                                if (session.layers.size >= StoryLayers.MAX && env.layersEnabled) refuse(LayerOps.Refusal.TooMany) else textTarget = TextTarget(null)
                            },
                            onLongPress = { layer, at ->
                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                session.selectedId = layer.id
                                menu = LayerMenu(layer.id, at)
                            },
                            onDragging = { dragging = it },
                            onTrashArmed = { trashArmed = it },
                            onGuides = { v, h -> guideV = v; guideH = h },
                        )
                    },
            ) {
                // The base: card gradient, photo, or video.
                if (env.cardBackground != null) {
                    Box(Modifier.fillMaxSize().background(backgroundBrush(env.cardBackground)))
                } else {
                    base(canvas)
                }

                // Everything in the order it was made, the drawing included. The stroke being
                // drawn is on top, which is where the drawing goes the moment it has one.
                val live = session.liveStroke
                val hasInk = session.layers.any { it is InkLayer }
                session.layers.forEach { layer ->
                    key(layer.id) {
                        if (layer is InkLayer) {
                            InkLayerContent(layer.strokes, live = live)
                        } else {
                            LayerHost(
                                layer = layer,
                                canvas = canvas,
                                session = session,
                                env = env,
                                shrink = trashArmed && session.activeId == layer.id,
                                hidden = textTarget?.id == layer.id,
                                onEdit = { textTarget = TextTarget(layer.id) },
                            )
                        }
                    }
                }
                if (live != null && !hasInk) InkLayerContent(emptyList(), live = live)

                // A card nobody has written on yet: a hint where the words will go.
                if (env.cardBackground != null && session.layers.isEmpty() && textTarget == null) {
                    Text(
                        stringResource(R.string.stories_editor_card_hint),
                        color = Color.White.copy(alpha = 0.6f),
                        style = MaterialTheme.typography.titleMedium,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        modifier = Modifier.align(Alignment.Center).padding(horizontal = Spacing.xl).testTag("stories.editor.cardHint"),
                    )
                }

                // Guide lines while a layer sits on the middle.
                AnimatedVisibility(guideV && !trashArmed, enter = fadeIn(tween(80)), exit = fadeOut(tween(120)), modifier = Modifier.align(Alignment.Center)) {
                    Box(Modifier.width(1.5.dp).height(height).background(Palette.Signal.copy(alpha = 0.85f)))
                }
                AnimatedVisibility(guideH && !trashArmed, enter = fadeIn(tween(80)), exit = fadeOut(tween(120)), modifier = Modifier.align(Alignment.Center)) {
                    Box(Modifier.height(1.5.dp).width(width).background(Palette.Signal.copy(alpha = 0.85f)))
                }

                // The trash, only while a layer is held.
                AnimatedVisibility(
                    visible = dragging,
                    enter = fadeIn(tween(120)),
                    exit = fadeOut(tween(120)),
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(bottom = 72.dp - 28.dp),
                ) {
                    val grow by animateFloatAsState(if (trashArmed) 1.25f else 1f, tween(120), label = "trash")
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier
                            .size(56.dp)
                            .scale(grow)
                            .clip(CircleShape)
                            .background(if (trashArmed) Palette.Danger else Color.Black.copy(alpha = 0.55f))
                            .border(1.5.dp, Color.White.copy(alpha = 0.8f), CircleShape)
                            .testTag("stories.editor.trash"),
                    ) { Icon(PqpIcons.Delete, contentDescription = stringResource(R.string.stories_editor_trash), tint = Color.White) }
                }

                if (drawing) DrawSurface(session, canvas)

                // Long-press menu, anchored where the finger was.
                menu?.let { open ->
                    val layer = session.layer(open.id)
                    if (layer != null) {
                        Box(Modifier.offset { IntOffset(open.at.x.roundToInt(), open.at.y.roundToInt()) }) {
                            LayerMenuPopup(
                                layer = layer,
                                onDismiss = { menu = null },
                                canFront = LayerOps.canBringForward(session.layers, layer.id),
                                onFront = {
                                    session.bringToFront(layer.id)
                                    menu = null
                                },
                                onShape = { shape ->
                                    (layer as? PhotoLayer)?.let { session.update(it.copy(shape = shape)) }
                                    menu = null
                                },
                                onEdit = {
                                    textTarget = TextTarget(layer.id)
                                    menu = null
                                },
                                onDelete = {
                                    session.remove(layer.id)
                                    menu = null
                                },
                            )
                        }
                    }
                }
            }
        }

        // --- chrome ---
        val chrome = !dragging && !drawing && textTarget == null
        AnimatedVisibility(
            visible = chrome,
            enter = fadeIn(tween(120)),
            exit = fadeOut(tween(100)),
            modifier = Modifier.align(Alignment.TopCenter),
        ) {
            Column(Modifier.fillMaxWidth().toolsTop(gap)) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(Spacing.sm)) {
                    ToolButton(PqpIcons.Close, stringResource(R.string.stories_viewer_close), "stories.editor.close", onClick = close)
                    Box(Modifier.weight(1f))
                    if (session.canUndo) {
                        ToolButton(PqpIcons.Undo, stringResource(R.string.stories_editor_undo), "stories.editor.undo") {
                            haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                            session.undo()
                        }
                        Spacer(Modifier.width(Spacing.sm))
                    }
                    if (env.isVideo && env.hasAudio) {
                        ToolButton(
                            if (env.muted) PqpIcons.ServerMuted else PqpIcons.Speakerphone,
                            stringResource(if (env.muted) R.string.stories_editor_unmute else R.string.stories_editor_mute),
                            "stories.editor.mute",
                            onClick = onToggleMute,
                        )
                        Spacer(Modifier.width(Spacing.sm))
                    }
                    // At the limit a tool says so instead of opening and doing nothing: dimmed, and a tap
                    // gets the reason.
                    val full = session.layers.size >= StoryLayers.MAX
                    val photosFull = session.layers.count { it is PhotoLayer } >= StoryLayers.MAX_IMAGES
                    val hasInkNow = session.layers.any { it is InkLayer }
                    ToolButton(PqpIcons.AddText, stringResource(R.string.stories_editor_tool_text), "stories.editor.tool.text", dimmed = full && env.layersEnabled) {
                        if (full && env.layersEnabled) refuse(LayerOps.Refusal.TooMany) else textTarget = TextTarget(null)
                    }
                    if (env.layersEnabled) {
                        Spacer(Modifier.width(Spacing.sm))
                        ToolButton(PqpIcons.AddPhoto, stringResource(R.string.stories_editor_tool_photo), "stories.editor.tool.photo", dimmed = full || photosFull) {
                            when {
                                full -> refuse(LayerOps.Refusal.TooMany)
                                photosFull -> refuse(LayerOps.Refusal.TooManyPhotos)
                                else -> sheet = Sheet.Photo
                            }
                        }
                        Spacer(Modifier.width(Spacing.sm))
                        ToolButton(PqpIcons.Stickers, stringResource(R.string.stories_editor_tool_stickers), "stories.editor.tool.stickers", dimmed = full) {
                            if (full) refuse(LayerOps.Refusal.TooMany) else sheet = Sheet.Tray
                        }
                        Spacer(Modifier.width(Spacing.sm))
                        ToolButton(PqpIcons.Draw, stringResource(R.string.stories_editor_tool_draw), "stories.editor.tool.draw", dimmed = full && !hasInkNow) {
                            if (full && !hasInkNow) {
                                refuse(LayerOps.Refusal.TooMany)
                            } else {
                                session.beginDrawing()
                                drawing = true
                            }
                        }
                    }
                }
                // A notice: a limit hit, or "you are not in that call".
                val notice = message ?: env.callWarning
                if (notice != null) {
                    Text(
                        notice,
                        color = if (message != null) Color.White else Palette.Warning,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier
                            .align(Alignment.CenterHorizontally)
                            .padding(horizontal = Spacing.lg)
                            .clip(MaterialTheme.shapes.small)
                            .background(Color.Black.copy(alpha = 0.6f))
                            .padding(horizontal = Spacing.md, vertical = Spacing.sm)
                            .testTag("stories.editor.notice"),
                    )
                }
            }
        }

        AnimatedVisibility(
            visible = chrome,
            enter = fadeIn(tween(120)),
            exit = fadeOut(tween(100)),
            modifier = Modifier.align(Alignment.BottomCenter),
        ) {
            Column(Modifier.fillMaxWidth().toolsBottom(gap).padding(bottom = Spacing.sm)) {
                if (env.cardBackground != null) {
                    BackgroundSwatches(selected = env.cardBackground, onPick = onCardBackground)
                }
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter, vertical = Spacing.xs),
                ) {
                    Box(Modifier.weight(1f).padding(end = Spacing.md), contentAlignment = Alignment.CenterStart) {
                        if (env.audienceError) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(24.dp))
                                    .background(Color.Black.copy(alpha = 0.5f))
                                    .padding(start = Spacing.lg)
                                    .testTag("stories.editor.audienceError"),
                            ) {
                                Text(
                                    env.audienceLabel,
                                    color = Color.White,
                                    style = MaterialTheme.typography.labelMedium,
                                    modifier = Modifier.weight(1f, fill = false),
                                )
                                TextButton(onClick = onRetryAudience, modifier = Modifier.testTag("stories.editor.audienceRetry")) {
                                    Text(stringResource(R.string.connection_retry), color = Palette.Signal)
                                }
                            }
                        } else Text(
                            env.audienceLabel,
                            color = Color.White,
                            style = MaterialTheme.typography.labelLarge,
                            maxLines = 1,
                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                            modifier = Modifier
                                .clip(RoundedCornerShape(50))
                                .background(Color.Black.copy(alpha = 0.5f))
                                .clickable(onClick = onAudience)
                                .padding(horizontal = Spacing.lg, vertical = Spacing.md)
                                .testTag("stories.editor.audience"),
                        )
                    }
                    Button(
                        onClick = onPost,
                        enabled = env.canPost && !env.posting,
                        shape = RoundedCornerShape(50),
                        colors = ButtonDefaults.buttonColors(containerColor = Palette.Signal, contentColor = Palette.Ink),
                        modifier = Modifier.testTag("stories.editor.post"),
                    ) {
                        if (env.posting) {
                            CircularProgressIndicator(Modifier.size(18.dp), color = Palette.Ink, strokeWidth = 2.dp)
                            Spacer(Modifier.width(Spacing.sm))
                            Text(stringResource(R.string.stories_upload_posting))
                        } else {
                            Text(stringResource(R.string.stories_editor_post))
                        }
                    }
                }
            }
        }

        if (drawing) DrawControls(session, onDone = { drawing = false }, canvasGap = gap)

        // --- the text tool ---
        textTarget?.let { target ->
            val existing = target.id?.let { session.layer(it) as? TextLayer }
            TextEditorOverlay(
                initialText = existing?.text.orEmpty(),
                initialStyle = existing?.let {
                    TextStyleChoice(it.font, it.color, it.background, it.align, it.size)
                } ?: session.textStyle,
                canvasWidthPx = canvasPx.width,
                canvasGap = gap,
                dim = if (env.cardBackground != null) 0.3f else 0.78f,
                onCancel = { textTarget = null },
                onDone = { text, style ->
                    session.textStyle = style
                    val trimmed = text.trim()
                    when {
                        existing != null && trimmed.isEmpty() -> session.remove(existing.id)
                        existing != null -> session.update(existing.copy(text = trimmed, font = style.font, color = style.color, background = style.background, align = style.align, size = style.size))
                        trimmed.isNotEmpty() -> {
                            val at = LayerMath.startPosition(session.layers.size)
                            session.add(
                                TextLayer(
                                    id = session.newId(), x = at.x, y = at.y, text = trimmed,
                                    font = style.font, color = style.color, background = style.background, align = style.align, size = style.size,
                                ),
                            )?.let(refuse)
                        }
                    }
                    textTarget = null
                },
            )
        }

        // --- sheets ---
        when (sheet) {
            Sheet.Tray -> StickerTraySheet(
                onCall = { sheet = Sheet.Call },
                onMention = { sheet = Sheet.Mention },
                onDismiss = { sheet = Sheet.None },
            )
            Sheet.Photo -> PhotoSourceSheet(
                onGallery = {
                    sheet = Sheet.None
                    onPickGalleryPhoto()
                },
                onCamera = {
                    sheet = Sheet.None
                    onTakePhoto()
                },
                onDismiss = { sheet = Sheet.None },
            )
            Sheet.Call -> callSheet(
                { layer ->
                    sheet = Sheet.None
                    session.add(layer)?.let(refuse)
                },
                { sheet = Sheet.None },
            )
            Sheet.Mention -> mentionSheet(
                { layer ->
                    sheet = Sheet.None
                    session.add(layer)?.let(refuse)
                },
                { sheet = Sheet.None },
            )
            Sheet.None -> Unit
        }

        if (confirmDiscard) {
            AlertDialog(
                onDismissRequest = { confirmDiscard = false },
                title = { Text(stringResource(R.string.stories_editor_discard_title)) },
                text = { Text(stringResource(R.string.stories_editor_discard_body)) },
                confirmButton = {
                    TextButton(
                        onClick = {
                            confirmDiscard = false
                            onClose()
                        },
                        modifier = Modifier.testTag("stories.editor.discard"),
                    ) { Text(stringResource(R.string.stories_editor_discard), color = Palette.Danger) }
                },
                dismissButton = {
                    TextButton(onClick = { confirmDiscard = false }) { Text(stringResource(R.string.stories_editor_keep)) }
                },
            )
        }
    }
}

/** A layer on the canvas: positioned by its centre, scaled and turned about it, described for TalkBack. */
@Composable
private fun LayerHost(
    layer: EditorLayer,
    canvas: LayerMath.Canvas,
    session: EditorSession,
    env: EditorEnv,
    shrink: Boolean,
    /** Being edited in the text tool: it is typed over there, so it is not drawn here as well. */
    hidden: Boolean,
    onEdit: () -> Unit,
) {
    val shrinkScale by animateFloatAsState(if (shrink) 0.45f else 1f, tween(140), label = "layerShrink")
    val active = session.activeId == layer.id
    val alpha by animateFloatAsState(if (shrink) 0.7f else if (hidden) 0f else 1f, tween(100), label = "layerFade")

    val textLabel = (layer as? TextLayer)?.let { stringResource(R.string.stories_editor_layer_text, it.text) }
    val photoLabel = stringResource(R.string.stories_editor_layer_photo)
    val mentionLabel = (layer as? MentionLayer)?.let { stringResource(R.string.stories_editor_layer_mention, it.name) }
    val callLabel = (layer as? CallLayer)?.let { stringResource(R.string.stories_editor_layer_call, it.roomName) }
    val description = textLabel ?: mentionLabel ?: callLabel ?: photoLabel

    val up = stringResource(R.string.stories_editor_layer_up)
    val down = stringResource(R.string.stories_editor_layer_down)
    val left = stringResource(R.string.stories_editor_layer_left)
    val right = stringResource(R.string.stories_editor_layer_right)
    val bigger = stringResource(R.string.stories_editor_layer_bigger)
    val smaller = stringResource(R.string.stories_editor_layer_smaller)
    val turn = stringResource(R.string.stories_editor_layer_turn)
    val front = stringResource(R.string.stories_editor_layer_front)
    val delete = stringResource(R.string.stories_editor_layer_delete)
    val edit = stringResource(R.string.stories_editor_layer_edit)
    val latest by rememberUpdatedState(layer)

    fun move(dx: Float, dy: Float) {
        val l = latest
        session.update(l.placed(x = LayerMath.clampCenter(l.x + dx), y = LayerMath.clampCenter(l.y + dy)))
    }

    val actions = buildList {
        add(CustomAccessibilityAction(up) { move(0f, -0.05f); true })
        add(CustomAccessibilityAction(down) { move(0f, 0.05f); true })
        add(CustomAccessibilityAction(left) { move(-0.05f, 0f); true })
        add(CustomAccessibilityAction(right) { move(0.05f, 0f); true })
        add(CustomAccessibilityAction(bigger) { session.update(latest.placed(scale = LayerMath.clampScale(latest.scale * 1.2f))); true })
        add(CustomAccessibilityAction(smaller) { session.update(latest.placed(scale = LayerMath.clampScale(latest.scale / 1.2f))); true })
        add(CustomAccessibilityAction(turn) { session.update(latest.placed(rotation = LayerMath.normalizeRotation(latest.rotation + (PI / 12).toFloat()))); true })
        if (LayerOps.canBringForward(session.layers, layer.id)) add(CustomAccessibilityAction(front) { session.bringToFront(latest.id); true })
        if (layer is TextLayer) add(CustomAccessibilityAction(edit) { onEdit(); true })
        add(CustomAccessibilityAction(delete) { session.remove(latest.id); true })
    }

    PlacedLayer(
        x = layer.x,
        y = layer.y,
        scale = layer.scale * shrinkScale,
        rotation = layer.rotation,
        canvas = canvas,
        alpha = alpha,
    ) {
        Box(
            Modifier
                .onSizeChanged { session.sizes[layer.id] = LayerMath.Size(it.width.toFloat(), it.height.toFloat()) }
                .then(if (active) Modifier.border(1.5.dp, Color.White.copy(alpha = 0.85f), RoundedCornerShape(6.dp)) else Modifier)
                .semantics {
                    contentDescription = description
                    customActions = actions
                }
                .testTag("stories.editor.layer.${layer.type}"),
        ) {
            when (layer) {
                is TextLayer -> TextLayerContent(layer.text, layer.font, layer.color, layer.background, layer.align, layer.size, canvas.width)
                is PhotoLayer -> PhotoLayerContent(layer.source, layer.shape, layer.width, layer.height, canvas.width, photoLabel)
                is MentionLayer -> MentionLayerContent(layer.name, canvas.width)
                is CallLayer -> CallLayerPreview(
                    layer = layer,
                    faces = env.occupancy[layer.channelId].orEmpty().take(CallFaces.SHOWN).map { CallFace(it.userId, it.displayName, it.avatarUrl) },
                    count = env.occupancy[layer.channelId].orEmpty().size,
                    canvasWidthPx = canvas.width,
                )
                is InkLayer -> Unit
            }
        }
    }
}

@Composable
private fun LayerMenuPopup(
    layer: EditorLayer,
    onDismiss: () -> Unit,
    /** Whether "bring forward" would change anything: not offered for the topmost layer. */
    canFront: Boolean,
    onFront: () -> Unit,
    onShape: (String) -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    DropdownMenu(expanded = true, onDismissRequest = onDismiss) {
        if (layer is TextLayer) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.stories_editor_layer_edit)) },
                leadingIcon = { Icon(PqpIcons.Edit, contentDescription = null) },
                onClick = onEdit,
            )
        }
        if (layer is PhotoLayer) {
            listOf(
                "rect" to R.string.stories_editor_layer_shape_rect,
                "rounded" to R.string.stories_editor_layer_shape_rounded,
                "circle" to R.string.stories_editor_layer_shape_circle,
            ).forEach { (shape, label) ->
                DropdownMenuItem(
                    text = { Text(stringResource(label), color = if (layer.shape == shape) Palette.Signal else Color.Unspecified) },
                    onClick = { onShape(shape) },
                )
            }
        }
        if (canFront) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.stories_editor_layer_front)) },
                leadingIcon = { Icon(PqpIcons.BringToFront, contentDescription = null) },
                onClick = onFront,
            )
        }
        DropdownMenuItem(
            text = { Text(stringResource(R.string.stories_editor_layer_delete), color = Palette.Danger) },
            leadingIcon = { Icon(PqpIcons.Delete, contentDescription = null, tint = Palette.Danger) },
            onClick = onDelete,
        )
    }
}

/** The gradient swatches under a text card. */
@Composable
internal fun BackgroundSwatches(selected: String, onPick: (String) -> Unit) {
    androidx.compose.foundation.layout.Row(
        horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(Spacing.sm, Alignment.CenterHorizontally),
        modifier = Modifier.fillMaxWidth().padding(vertical = Spacing.sm),
    ) {
        StoriesRules.BACKGROUNDS.forEachIndexed { position, key ->
            val label = stringResource(R.string.stories_compose_background, position + 1)
            Box(
                Modifier
                    .semantics {
                        role = Role.RadioButton
                        this.selected = key == selected
                        contentDescription = label
                    }
                    .size(32.dp)
                    .clip(CircleShape)
                    .background(backgroundBrush(key))
                    .border(if (key == selected) 3.dp else 1.dp, if (key == selected) Color.White else Color.White.copy(alpha = 0.4f), CircleShape)
                    .clickable { onPick(key) }
                    .testTag("stories.composer.bg.$key"),
            )
        }
    }
}

// ----------------------------------------------------------------------------
// The gesture
// ----------------------------------------------------------------------------

/**
 * One touch on the canvas, start to finish.
 *
 * Down on a layer picks it (the topmost under the finger, with a 12 dp margin
 * so a small one can be grabbed). Past touch slop it drags; with a second
 * finger it also scales and turns, and a second finger anywhere turns the
 * last layer touched even if the first one missed. A touch that stays put for
 * the long-press time opens the menu; one that lifts without moving is a tap.
 *
 * The finger's own numbers are kept unsnapped and a snapped copy is shown, so
 * a layer that clicks onto the middle line lets go again when the finger
 * moves on. Holding one over the trash circle and lifting deletes it.
 */
private suspend fun PointerInputScope.layerGestures(
    session: EditorSession,
    canvas: LayerMath.Canvas,
    density: Float,
    snapPx: Float,
    trashCenter: LayerMath.Pt,
    trashRadius: Float,
    haptics: HapticFeedback,
    onTapLayer: (EditorLayer) -> Unit,
    onTapEmpty: () -> Unit,
    onLongPress: (EditorLayer, Offset) -> Unit,
    onDragging: (Boolean) -> Unit,
    onTrashArmed: (Boolean) -> Unit,
    onGuides: (Boolean, Boolean) -> Unit,
) {
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        val touchSlop = viewConfiguration.touchSlop
        val longPressMs = viewConfiguration.longPressTimeoutMillis
        val startedAt = SystemClock.uptimeMillis()
        val hit = LayerMath.topHit(
            session.layers, session.sizes.toMap(), canvas,
            LayerMath.Pt(down.position.x, down.position.y), 12f * density,
        )
        var targetId: String? = hit?.id
        session.activeId = targetId
        var pastSlop = false
        var longPressed = false
        var totalZoom = 1f
        var totalRotation = 0f
        var totalPan = Offset.Zero
        var raw: LayerMath.Placement? = null
        var snappedX = false
        var snappedY = false
        var snappedR = false
        var armed = false
        var moved = false
        val thresholdX = snapPx / canvas.width
        val thresholdY = snapPx / canvas.height

        fun begin(id: String) {
            val layer = session.layer(id) ?: return
            session.checkpoint()
            session.selectedId = id
            raw = LayerMath.Placement(layer.x, layer.y, layer.scale, layer.rotation)
            onDragging(true)
        }

        try {
            while (true) {
                val event = if (!pastSlop && !longPressed && targetId != null) {
                    val remaining = longPressMs - (SystemClock.uptimeMillis() - startedAt)
                    if (remaining <= 0L) null else withTimeoutOrNull(remaining) { awaitPointerEvent() }
                } else {
                    awaitPointerEvent()
                }
                if (event == null) {
                    // Held still long enough: the menu.
                    longPressed = true
                    session.layer(targetId!!)?.let { onLongPress(it, down.position) }
                    continue
                }
                if (event.changes.none { it.pressed } || event.changes.all { it.changedToUp() }) break
                if (longPressed) {
                    event.changes.forEach { it.consume() }
                    continue
                }

                val pressedCount = event.changes.count { it.pressed }
                // A second finger turns the last layer touched, wherever it lands.
                if (targetId == null && pressedCount >= 2) {
                    targetId = session.selectedId?.takeIf { session.layer(it) != null }
                    session.activeId = targetId
                }

                val zoom = event.calculateZoom()
                val rotation = event.calculateRotation()
                val pan = event.calculatePan()

                if (!pastSlop) {
                    totalZoom *= zoom
                    totalRotation += rotation
                    totalPan += pan
                    val centroidSize = event.calculateCentroidSize(useCurrent = false)
                    val zoomMotion = abs(1 - totalZoom) * centroidSize
                    val rotationMotion = abs(totalRotation * PI.toFloat() * centroidSize / 180f)
                    val panMotion = totalPan.getDistance()
                    if (zoomMotion > touchSlop || rotationMotion > touchSlop || panMotion > touchSlop) {
                        pastSlop = true
                        targetId?.let { begin(it) }
                        // Start from what has built up, so the layer does not lag the finger by the slop.
                        raw?.let { r ->
                            raw = LayerMath.applyGesture(r, LayerMath.Pt(totalPan.x, totalPan.y), totalZoom, Math.toRadians(totalRotation.toDouble()).toFloat(), canvas)
                        }
                        moved = true
                    } else {
                        continue
                    }
                } else if (raw != null) {
                    raw = LayerMath.applyGesture(
                        raw!!, LayerMath.Pt(pan.x, pan.y), zoom, Math.toRadians(rotation.toDouble()).toFloat(), canvas,
                    )
                }

                val id = targetId
                val current = raw
                if (pastSlop && id != null && current != null) {
                    val layer = session.layer(id) ?: break
                    val sx = LayerMath.snapToCenter(current.x, thresholdX)
                    val sy = LayerMath.snapToCenter(current.y, thresholdY)
                    val sr = if (pressedCount >= 2) LayerMath.snapRotation(current.rotation, 0.07f) else LayerMath.Snap(current.rotation, false)
                    if ((sx.snapped && !snappedX) || (sy.snapped && !snappedY) || (sr.snapped && !snappedR)) {
                        haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                    }
                    snappedX = sx.snapped
                    snappedY = sy.snapped
                    snappedR = sr.snapped
                    onGuides(snappedX, snappedY)

                    val centroid = event.calculateCentroid(useCurrent = true)
                    val nowArmed = LayerMath.inTrash(LayerMath.Pt(centroid.x, centroid.y), trashCenter, trashRadius)
                    if (nowArmed != armed) {
                        armed = nowArmed
                        onTrashArmed(armed)
                        haptics.performHapticFeedback(if (armed) HapticFeedbackType.GestureThresholdActivate else HapticFeedbackType.SegmentTick)
                    }
                    session.live(LayerOps.replace(session.layers, layer.placed(sx.value, sy.value, current.scale, sr.value)))
                    event.changes.forEach { if (it.positionChanged()) it.consume() }
                }
            }

            when {
                longPressed -> Unit
                pastSlop && armed -> {
                    targetId?.let { id ->
                        // The drag already took its history entry; deleting rides on it.
                        session.live(LayerOps.remove(session.layers, id))
                        session.sizes.remove(id)
                        if (session.selectedId == id) session.selectedId = null
                        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                    }
                }
                !moved -> if (hit != null) onTapLayer(hit) else onTapEmpty()
            }
        } finally {
            session.activeId = null
            onDragging(false)
            onTrashArmed(false)
            onGuides(false, false)
        }
    }
}
