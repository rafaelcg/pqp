package gg.pqp.app.stories.editor

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.stories.StoryLayers
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing

/** The most points a single stroke keeps: a long scribble must not grow without bound. */
private const val MAX_POINTS = 4_000

/**
 * The surface a finger draws on while the draw tool is open. It collects one
 * stroke per touch as fractions of the canvas, shows it live through
 * [EditorSession.liveStroke] (drawn by the same renderer as the saved ink), and
 * hands the finished stroke to the session as one undoable step.
 *
 * A single finger only: a second one lands on nothing. Layers are not
 * grabbable while this is up, which is what the tool is for.
 */
@Composable
fun DrawSurface(session: EditorSession, canvas: LayerMath.Canvas, modifier: Modifier = Modifier) {
    Box(
        modifier
            .fillMaxSize()
            .testTag("stories.editor.drawSurface")
            .pointerInput(canvas) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val pen = session.pen
                    val width = Brushes.widthFor(pen.brush, pen.slider)
                    val points = ArrayList<Float>()
                    fun add(at: Offset) {
                        if (points.size >= MAX_POINTS * 2) return
                        val x = canvas.fractionX(at.x).coerceIn(0f, 1f)
                        val y = canvas.fractionY(at.y).coerceIn(0f, 1f)
                        // Samples a pixel apart say nothing a smooth curve needs.
                        if (points.size >= 2 && kotlin.math.abs(points[points.size - 2] - x) * canvas.width < 1f &&
                            kotlin.math.abs(points[points.size - 1] - y) * canvas.height < 1f
                        ) {
                            return
                        }
                        points += x
                        points += y
                    }
                    add(down.position)
                    session.liveStroke = Stroke(pen.brush, pen.color, width, points.toList())
                    down.consume()
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        if (!change.pressed) {
                            change.consume()
                            break
                        }
                        add(change.position)
                        session.liveStroke = Stroke(pen.brush, pen.color, width, points.toList())
                        change.consume()
                    }
                    val done = Stroke(pen.brush, pen.color, width, points.toList())
                    session.liveStroke = null
                    if (done.points.size >= 2) session.addStroke(done)
                }
            },
    )
}

/** The controls over the canvas while drawing: brush, size, color, undo, done. */
@Composable
fun DrawControls(session: EditorSession, onDone: () -> Unit, modifier: Modifier = Modifier) {
    val haptics = LocalHapticFeedback.current
    val pen = session.pen
    Column(modifier.fillMaxSize()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().statusBarsPadding().padding(Spacing.sm),
        ) {
            if (session.canUndo) {
                ToolButton(PqpIcons.Undo, stringResource(R.string.stories_editor_undo), "stories.editor.draw.undo") {
                    haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                    session.undo()
                }
            }
            Box(Modifier.weight(1f))
            Text(
                stringResource(R.string.stories_editor_draw_done),
                color = Palette.Ink,
                style = androidx.compose.material3.MaterialTheme.typography.labelLarge,
                modifier = Modifier
                    .clip(RoundedCornerShape(50))
                    .background(Palette.Signal)
                    .clickable(onClick = onDone)
                    .padding(horizontal = Spacing.lg, vertical = Spacing.sm)
                    .testTag("stories.editor.draw.done"),
            )
        }
        Box(Modifier.weight(1f))
        Column(
            Modifier
                .fillMaxWidth()
                .background(Color.Black.copy(alpha = 0.82f))
                .navigationBarsPadding()
                .padding(vertical = Spacing.sm),
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(Spacing.md, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Brushes.ALL.forEach { brush ->
                    BrushChip(brush, pen.color, selected = pen.brush == brush) {
                        haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                        session.pen = pen.copy(brush = brush)
                    }
                }
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter),
            ) {
                val sizeLabel = stringResource(R.string.stories_editor_draw_size)
                Slider(
                    value = pen.slider,
                    onValueChange = { session.pen = pen.copy(slider = it) },
                    colors = SliderDefaults.colors(thumbColor = Palette.Signal, activeTrackColor = Palette.Signal),
                    modifier = Modifier
                        .weight(1f)
                        .semantics { contentDescription = sizeLabel }
                        .testTag("stories.editor.draw.size"),
                )
            }
            if (pen.brush != Brushes.ERASER) {
                ColorRow(selected = pen.color, onPick = { session.pen = pen.copy(color = it) })
            } else {
                Box(Modifier.height(48.dp))
            }
        }
    }
}

@Composable
private fun BrushChip(brush: String, color: String, selected: Boolean, onClick: () -> Unit) {
    val label = stringResource(
        when (brush) {
            Brushes.MARKER -> R.string.stories_editor_draw_marker
            Brushes.HIGHLIGHTER -> R.string.stories_editor_draw_highlighter
            Brushes.ERASER -> R.string.stories_editor_draw_eraser
            else -> R.string.stories_editor_draw_pen
        },
    )
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(width = 64.dp, height = 48.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (selected) Color.White.copy(alpha = 0.22f) else Color.Transparent)
            .border(if (selected) 2.dp else 1.dp, if (selected) Palette.Signal else Color.White.copy(alpha = 0.3f), RoundedCornerShape(12.dp))
            .semantics {
                role = Role.RadioButton
                this.selected = selected
                contentDescription = label
            }
            .clickable(onClick = onClick)
            .testTag("stories.editor.draw.brush.$brush"),
    ) {
        if (brush == Brushes.ERASER) {
            Icon(PqpIcons.Eraser, contentDescription = null, tint = Color.White, modifier = Modifier.size(24.dp))
        } else {
            // The brush as it paints: a short stroke of its own weight and opacity.
            Canvas(Modifier.size(width = 44.dp, height = 28.dp)) {
                val w = when (brush) {
                    Brushes.MARKER -> 10.dp.toPx()
                    Brushes.HIGHLIGHTER -> 18.dp.toPx()
                    else -> 3.dp.toPx()
                }
                drawLine(
                    color = tokenColor(color).copy(alpha = Brushes.alpha(brush)),
                    start = Offset(w / 2f, size.height / 2f),
                    end = Offset(size.width - w / 2f, size.height / 2f),
                    strokeWidth = w,
                    cap = if (brush == Brushes.HIGHLIGHTER) StrokeCap.Square else StrokeCap.Round,
                )
            }
        }
    }
}

/** The twelve color tokens as swatches, one row that scrolls. */
@Composable
fun ColorRow(selected: String, onPick: (String) -> Unit, modifier: Modifier = Modifier) {
    LazyRow(
        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = Spacing.gutter, vertical = Spacing.xs),
        modifier = modifier.fillMaxWidth(),
    ) {
        items(StoryLayers.COLORS) { token ->
            val label = stringResource(colorName(token))
            val isSelected = token == selected
            Box(
                modifier = Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .background(tokenColor(token))
                    .border(
                        if (isSelected) 3.dp else 1.dp,
                        if (isSelected) Color.White else Color.White.copy(alpha = 0.4f),
                        CircleShape,
                    )
                    .semantics {
                        role = Role.RadioButton
                        this.selected = isSelected
                        contentDescription = label
                    }
                    .clickable { onPick(token) }
                    .testTag("stories.editor.color.$token"),
            )
        }
    }
}

fun colorName(token: String): Int = when (token) {
    "black" -> R.string.stories_editor_color_black
    "lime" -> R.string.stories_editor_color_lime
    "yellow" -> R.string.stories_editor_color_yellow
    "orange" -> R.string.stories_editor_color_orange
    "red" -> R.string.stories_editor_color_red
    "pink" -> R.string.stories_editor_color_pink
    "purple" -> R.string.stories_editor_color_purple
    "blue" -> R.string.stories_editor_color_blue
    "cyan" -> R.string.stories_editor_color_cyan
    "green" -> R.string.stories_editor_color_green
    "gray" -> R.string.stories_editor_color_gray
    else -> R.string.stories_editor_color_white
}

/** A 48 dp dark round button with one icon, the editor's tool buttons. */
@Composable
fun ToolButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    tag: String,
    modifier: Modifier = Modifier,
    tint: Color = Color.White,
    onClick: () -> Unit,
) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .size(48.dp)
            .clip(CircleShape)
            .background(Color.Black.copy(alpha = 0.4f))
            .semantics {
                role = Role.Button
                contentDescription = label
            }
            .clickable(onClick = onClick)
            .testTag(tag),
    ) { Icon(icon, contentDescription = null, tint = tint) }
}
