package gg.pqp.app.jam.ui

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.jam.ClipWindow
import gg.pqp.app.jam.ClipZoom
import gg.pqp.app.jam.JamAdjust
import gg.pqp.app.jam.JamClip
import gg.pqp.app.jam.JamTrack
import gg.pqp.app.jam.JamTrackEdit
import gg.pqp.app.jam.JamWriteFailure
import gg.pqp.app.jam.TakeEdits
import gg.pqp.app.jam.record.JamTakeEdit
import gg.pqp.app.onboarding.ui.rememberReduceMotion
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlinx.coroutines.withTimeoutOrNull

/*
 * ADJUSTING A POSTED TAKE, drawn: the web's `jam-track-adjust.tsx` and `jam-clip-editor.tsx` on a phone. It opens under
 * the lane it edits, with the song's transport still at the bottom so the take is HEARD while it is moved; every drag
 * and every step reaches the engine at once (`JamSongViewModel.adjust*`), and NOTHING is sent until "Salvar".
 *
 * The take is a clip on the song's timeline with the band's waveform on its own row above it, so lining up is seen and
 * not guessed. Drag an end to cut, drag the middle to move it, or step it earlier and later (a tap is 10 ms, holding
 * repeats and speeds up). One volume, in its own box that says it is what everybody hears. The arithmetic is
 * `JamTrackEdit` and `JamClip` (tested); this file draws it and turns fingers into numbers.
 *
 * Colour: opaque palette shapes only. The parts of the file that are cut are the instrument's colour pulled toward the
 * stage by a fixed share (a flat, lighter shape), never a translucent wash over the waveform.
 */

/** Press steps once; holding repeats, 400 ms later and every 90 ms, faster the longer it is held (10, 50, then 100 ms). */
private const val HOLD_DELAY_NS = 400_000_000L
private const val REPEAT_NS = 90_000_000L

@Composable
fun JamAdjustPanel(
    /** The track as it is STORED: the edits are laid on it. */
    track: JamTrack,
    adjust: JamAdjust,
    /** The other tracks that play with it, drawn behind. */
    band: List<JamTrack>,
    originMs: Double,
    /** The heard position from the transport's zero. Read while drawing, never while composing. */
    position: () -> Double,
    onTrimStart: (Double) -> Unit,
    onTrimEnd: (Double) -> Unit,
    onNudge: (Double) -> Unit,
    onGainPercent: (Int) -> Unit,
    onReset: () -> Unit,
    onSave: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val edits = adjust.edits
    val edited = JamTrackEdit.isEdited(track, edits)
    val busy = adjust.saving
    var zoom by remember { mutableStateOf(ClipZoom.Whole) }
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(colors.surfaceContainer)
            .padding(14.dp)
            .testTag("jam.adjust.${track.id}"),
        verticalArrangement = Arrangement.spacedBy(Spacing.md),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    stringResource(R.string.jam_adjust_title, track.instrument.label()),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    stringResource(R.string.jam_adjust_note),
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.onSurfaceVariant,
                )
            }
            TextButton(onClick = onClose, enabled = !busy, modifier = Modifier.testTag("jam.adjust.close")) {
                Text(stringResource(if (edited) R.string.jam_adjust_back else R.string.jam_close), maxLines = 1)
            }
            Button(
                onClick = onSave,
                enabled = edited && !busy,
                modifier = Modifier.heightIn(min = 40.dp).testTag("jam.adjust.save"),
            ) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = colors.onPrimary)
                } else {
                    Text(stringResource(R.string.jam_adjust_save), fontWeight = FontWeight.Bold, maxLines = 1)
                }
            }
        }

        Text(stringResource(R.string.jam_clip_hint), style = MaterialTheme.typography.bodySmall)
        ZoomChoice(zoom) { zoom = it }

        ClipStage(
            track = track,
            edits = edits,
            band = band,
            zoom = zoom,
            enabled = !busy,
            originMs = originMs,
            position = position,
            onTrimStart = onTrimStart,
            onTrimEnd = onTrimEnd,
            onNudge = onNudge,
        )
        Legend(track)

        TimingCard(edits, enabled = !busy, onNudge = onNudge)
        VolumeCard(edits, enabled = !busy, onGainPercent = onGainPercent)

        if (edited && !busy) {
            TextButton(onClick = onReset, modifier = Modifier.align(Alignment.End).testTag("jam.adjust.reset")) {
                Icon(PqpIcons.Undo, contentDescription = null, modifier = Modifier.size(16.dp))
                Text(stringResource(R.string.jam_rec_nudge_reset), modifier = Modifier.padding(start = 6.dp), maxLines = 1)
            }
        } else if (adjust.resets > 0 && !busy) {
            Text(
                stringResource(R.string.jam_adjust_reset_note),
                style = MaterialTheme.typography.labelMedium,
                color = colors.onSurfaceVariant,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
        adjust.failure?.let { failure ->
            Text(
                text = adjustFailureText(failure),
                style = MaterialTheme.typography.bodySmall,
                color = colors.onErrorContainer,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(colors.errorContainer)
                    .padding(horizontal = 10.dp, vertical = 8.dp)
                    .semantics { liveRegion = LiveRegionMode.Polite }
                    .testTag("jam.adjust.error"),
            )
        }
    }
}

@Composable
private fun adjustFailureText(failure: JamWriteFailure): String = stringResource(
    when (failure) {
        JamWriteFailure.Off -> R.string.jam_err_off
        JamWriteFailure.Denied -> R.string.jam_adjust_denied
        JamWriteFailure.Network -> R.string.jam_err_network
        JamWriteFailure.RateLimited -> R.string.jam_err_rate_limited
        JamWriteFailure.Gone -> R.string.jam_err_gone
        JamWriteFailure.Invalid -> R.string.jam_adjust_invalid
        JamWriteFailure.TooLarge, JamWriteFailure.StorageOff, JamWriteFailure.Other -> R.string.jam_err_other
    },
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ZoomChoice(zoom: ClipZoom, onChange: (ClipZoom) -> Unit) {
    val options = listOf(ClipZoom.Whole to R.string.jam_clip_zoom_whole, ClipZoom.Close to R.string.jam_clip_zoom_close)
    val label = stringResource(R.string.jam_clip_zoom)
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().semantics { contentDescription = label }) {
        options.forEachIndexed { index, (value, text) ->
            SegmentedButton(
                selected = zoom == value,
                onClick = { onChange(value) },
                shape = SegmentedButtonDefaults.itemShape(index, options.size),
                modifier = Modifier.testTag("jam.adjust.zoom.${value.name.lowercase()}"),
                icon = {},
            ) { Text(stringResource(text), style = MaterialTheme.typography.labelMedium, maxLines = 1) }
        }
    }
}

@Composable
private fun Legend(track: JamTrack) {
    val colors = MaterialTheme.colorScheme
    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.md), verticalAlignment = Alignment.CenterVertically) {
        LegendItem(colors.outline, stringResource(R.string.jam_clip_band), line = false)
        LegendItem(track.instrument.color(), stringResource(R.string.jam_clip_your_take), line = false)
        LegendItem(colors.primary, stringResource(R.string.jam_clip_song_start), line = true)
    }
}

@Composable
private fun LegendItem(color: Color, text: String, line: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(
            Modifier
                .then(if (line) Modifier.size(width = 2.dp, height = 12.dp) else Modifier.size(width = 16.dp, height = 8.dp))
                .clip(CircleShape)
                .background(color),
        )
        Text(text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// ------------------------------------------------------------------ the stage

private enum class Grip { Start, End, Body }

/** What a drag in progress holds on to: the edits it started from and the frame, which does not move under the finger. */
private class Held(val grip: Grip, val edits: TakeEdits, val window: ClipWindow)

private val HANDLE_REACH = 22.dp

@Composable
private fun ClipStage(
    track: JamTrack,
    edits: TakeEdits,
    band: List<JamTrack>,
    zoom: ClipZoom,
    enabled: Boolean,
    originMs: Double,
    position: () -> Double,
    onTrimStart: (Double) -> Unit,
    onTrimEnd: (Double) -> Unit,
    onNudge: (Double) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val density = LocalDensity.current
    val haptics = LocalHapticFeedback.current
    val reduce = rememberReduceMotion()
    val tint = track.instrument.color()
    val stage = colors.surfaceContainerLowest
    val bandRow = colors.surfaceContainer
    var widthPx by remember { mutableIntStateOf(0) }
    var held by remember { mutableStateOf<Held?>(null) }
    val liveWindow = JamClip.window(track, edits, zoom)
    val view = held?.window ?: liveWindow
    val span = JamClip.span(track, edits)
    val reach = JamClip.reach(track, edits.nudgeMs)
    val width = widthPx.toFloat()
    // One bar every 5 dp, on any density, so a take reads as a waveform and not as a block.
    val barStepPx = with(density) { 5.dp.toPx() }

    val bandBars = remember(band, view.startMs, view.endMs, widthPx, barStepPx) {
        JamClip.bandEnvelope(band, view, min(300, (width / barStepPx).toInt()))
    }
    val reachPx = max(0f, (JamClip.fraction(view, reach.endMs) - JamClip.fraction(view, reach.startMs)).toFloat() * width)
    val takeBars = remember(track.peaks, reachPx) { JamClip.bars(track.peaks, min(400, (reachPx / barStepPx).toInt())) }
    val level = JamTrackEdit.levelOfGain(edits.gain).toFloat()

    // The drag reads the newest numbers: the stage is recomposed on every step, and a handler built once would not see them.
    val latestEdits by rememberUpdatedState(edits)
    val latestView by rememberUpdatedState(liveWindow)
    val latestStage by rememberUpdatedState(Triple(track, widthPx, enabled))
    val trimStart by rememberUpdatedState(onTrimStart)
    val trimEnd by rememberUpdatedState(onTrimEnd)
    val nudge by rememberUpdatedState(onNudge)

    val handleWidth by animateDpAsState(
        if (held != null && held?.grip != Grip.Body) 14.dp else 10.dp,
        if (reduce) spring(stiffness = 100_000f) else spring(stiffness = 700f),
        label = "handle",
    )

    val moveDescription = stringResource(R.string.jam_clip_move)
    val cutStartDescription = stringResource(R.string.jam_clip_cut_start)
    val cutEndDescription = stringResource(R.string.jam_clip_cut_end)
    val nudgeWords = nudgeWords(edits.nudgeMs)

    Box(
        Modifier
            .fillMaxWidth()
            .height(144.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(stage)
            .border(1.dp, colors.outlineVariant, RoundedCornerShape(14.dp))
            .onSizeChanged { widthPx = it.width }
            .pointerInput(Unit) {
                var total = 0f
                detectDragGestures(
                    onDragStart = { offset ->
                        val (stored, w, on) = latestStage
                        if (!on || w <= 0) return@detectDragGestures
                        val win = latestView
                        val e = latestEdits
                        val s = JamClip.span(stored, e)
                        val startX = (JamClip.fraction(win, s.startMs) * w).toFloat()
                        val endX = (JamClip.fraction(win, s.endMs) * w).toFloat()
                        val reachPx = HANDLE_REACH.toPx()
                        val nearStart = kotlin.math.abs(offset.x - startX)
                        val nearEnd = kotlin.math.abs(offset.x - endX)
                        val grip = when {
                            nearStart <= reachPx && nearStart <= nearEnd -> Grip.Start
                            nearEnd <= reachPx -> Grip.End
                            offset.x in startX..endX -> Grip.Body
                            else -> null
                        }
                        total = 0f
                        held = grip?.let { Held(it, e, win) }
                        if (grip != null) haptics.performHapticFeedback(HapticFeedbackType.GestureThresholdActivate)
                    },
                    onDrag = { change, drag ->
                        val grab = held ?: return@detectDragGestures
                        change.consume()
                        total += drag.x
                        val ms = total * JamClip.msPerPixel(grab.window, latestStage.second.toFloat())
                        when (grab.grip) {
                            Grip.Start -> trimStart(grab.edits.trimStartMs + ms)
                            Grip.End -> trimEnd(grab.edits.trimEndMs - ms)
                            Grip.Body -> nudge(grab.edits.nudgeMs + ms)
                        }
                    },
                    onDragEnd = { held = null },
                    onDragCancel = { held = null },
                )
            }
            .testTag("jam.adjust.stage"),
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val w = size.width
            val h = size.height
            val bandH = 48.dp.toPx()
            val pad = 8.dp.toPx()
            fun x(ms: Double) = (JamClip.fraction(view, ms) * w).toFloat()

            // The band, on its own row right above the take: the beat to line up with.
            drawRect(bandRow, Offset.Zero, Size(w, bandH))
            drawRect(colors.outlineVariant, Offset(0f, bandH - 1.dp.toPx()), Size(w, 1.dp.toPx()))
            drawMirrorBars(bandBars, 0f, w, pad, bandH - pad, colors.outline, 1f)

            // Where the song starts: the line a first note lines up with.
            if (view.startMs < 0 && view.endMs > 0) {
                drawRect(colors.primary, Offset(x(0.0) - 0.5.dp.toPx(), 0f), Size(1.dp.toPx(), h))
            }

            // The take: its whole reach in a flat, lighter shape, and the heard part in the instrument's colour over it.
            val top = bandH + pad
            val bottom = h - pad
            val reachLeft = x(reach.startMs)
            val reachRight = x(reach.endMs)
            val spanLeft = x(span.startMs)
            val spanRight = x(span.endMs)
            val corner = CornerRadius(8.dp.toPx())
            val cutFill = lerp(tint, stage, 0.78f)
            val cutInk = lerp(JamInk, stage, 0.55f)
            drawRoundRect(cutFill, Offset(reachLeft, top), Size(max(0f, reachRight - reachLeft), bottom - top), corner)
            clipRect(reachLeft, top, reachRight, bottom) {
                drawMirrorBars(takeBars, reachLeft, max(0f, reachRight - reachLeft), top + 6.dp.toPx(), bottom - 6.dp.toPx(), cutInk, level)
            }
            clipRect(spanLeft, top, spanRight, bottom) {
                drawRoundRect(tint, Offset(reachLeft, top), Size(max(0f, reachRight - reachLeft), bottom - top), corner)
                drawMirrorBars(takeBars, reachLeft, max(0f, reachRight - reachLeft), top + 6.dp.toPx(), bottom - 6.dp.toPx(), JamInk, level)
            }

            // The handles: where the cut is. A solid pill with a ring, three grip dashes.
            val grab = handleWidth.toPx()
            for (cx in listOf(spanLeft, spanRight)) {
                val left = cx - grab / 2f
                drawRoundRect(stage, Offset(left - 2.dp.toPx(), top - 5.dp.toPx()), Size(grab + 4.dp.toPx(), bottom - top + 10.dp.toPx()), CornerRadius(grab))
                drawRoundRect(colors.onSurface, Offset(left, top - 3.dp.toPx()), Size(grab, bottom - top + 6.dp.toPx()), CornerRadius(grab))
                for (i in -1..1) {
                    drawRoundRect(
                        stage,
                        Offset(cx - 2.dp.toPx(), (top + bottom) / 2f + i * 5.dp.toPx() - 1.dp.toPx()),
                        Size(4.dp.toPx(), 2.dp.toPx()),
                        CornerRadius(1.dp.toPx()),
                    )
                }
            }

            // The playhead, read here from the clock, so a moving line repaints this and recomposes nothing.
            val song = originMs + position()
            if (song >= view.startMs && song <= view.endMs) {
                drawRect(colors.onSurface, Offset(x(song) - 1.dp.toPx(), 0f), Size(2.dp.toPx(), h))
            }
        }

        // The three grips for TalkBack: adjustable like sliders, over what a finger drags. No pointer handling here.
        if (widthPx > 0) {
            val startX = (JamClip.fraction(view, span.startMs) * width).roundToInt()
            val endX = (JamClip.fraction(view, span.endMs) * width).roundToInt()
            val gripWidth = with(density) { 44.dp.roundToPx() }
            val full = Modifier.fillMaxHeight()
            GripSemantics(
                Modifier.offset { IntOffset(startX - gripWidth / 2, 0) }.width(44.dp).then(full),
                cutStartDescription, edits.trimStartMs.toFloat(), 0f..track.durationMs.toFloat(),
                stringResource(R.string.jam_clip_cut_value, "%.1f".format(edits.trimStartMs / 1000.0)),
            ) { trimStart(it.toDouble()) }
            GripSemantics(
                Modifier.offset { IntOffset(endX - gripWidth / 2, 0) }.width(44.dp).then(full),
                cutEndDescription, edits.trimEndMs.toFloat(), 0f..track.durationMs.toFloat(),
                stringResource(R.string.jam_clip_cut_value, "%.1f".format(edits.trimEndMs / 1000.0)),
            ) { trimEnd(it.toDouble()) }
            GripSemantics(
                Modifier.offset { IntOffset(startX + gripWidth / 2, 0) }.width(with(density) { max(0, endX - startX - gripWidth).toDp() }).then(full),
                moveDescription, edits.nudgeMs.toFloat(), -JamTrackEdit.NUDGE_LIMIT_MS.toFloat()..JamTrackEdit.NUDGE_LIMIT_MS.toFloat(),
                nudgeWords,
            ) { nudge(it.toDouble()) }
        }
    }
}

@Composable
private fun GripSemantics(
    modifier: Modifier,
    description: String,
    value: Float,
    range: ClosedFloatingPointRange<Float>,
    words: String,
    onValue: (Float) -> Unit,
) {
    Box(
        modifier.semantics {
            contentDescription = description
            stateDescription = words
            progressBarRangeInfo = ProgressBarRangeInfo(value.coerceIn(range), range)
            setProgress { target ->
                onValue(target)
                true
            }
        },
    )
}

/** Bars mirrored about the middle of a band, [level] scaling them (a quiet take is visibly shorter). */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawMirrorBars(
    bars: List<Float>,
    left: Float,
    width: Float,
    top: Float,
    bottom: Float,
    color: Color,
    level: Float,
) {
    if (bars.isEmpty() || width <= 0f) return
    val step = width / bars.size
    val barW = max(1.5.dp.toPx(), step - 2.dp.toPx())
    val middle = (top + bottom) / 2f
    val half = (bottom - top) / 2f * level.coerceAtMost(1.12f)
    bars.forEachIndexed { i, v ->
        val bh = max(2.dp.toPx(), v.coerceIn(0f, 1f) * half)
        drawRoundRect(color, Offset(left + i * step + (step - barW) / 2f, middle - bh), Size(barW, bh * 2), CornerRadius(barW / 2f))
    }
}

// ------------------------------------------------------------------ timing and volume

@Composable
private fun nudgeWords(nudgeMs: Double): String {
    val ms = JamTrackEdit.wholeMs(nudgeMs)
    return when {
        ms == 0 -> stringResource(R.string.jam_rec_on_time)
        nudgeMs < 0 -> stringResource(R.string.jam_rec_ms_earlier, ms)
        else -> stringResource(R.string.jam_rec_ms_later, ms)
    }
}

@Composable
private fun TimingCard(edits: TakeEdits, enabled: Boolean, onNudge: (Double) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val current by rememberUpdatedState(edits)
    val step by rememberUpdatedState(onNudge)
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(colors.surfaceContainerHigh).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            Text(
                stringResource(R.string.jam_rec_nudge_title),
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            Text(
                nudgeWords(edits.nudgeMs),
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.Bold,
                color = if (edits.nudgeMs == 0.0) colors.onSurfaceVariant else colors.primary,
                textAlign = TextAlign.End,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }.testTag("jam.adjust.nudgeValue"),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            HoldNudgeButton(
                label = stringResource(R.string.jam_rec_earlier),
                icon = PqpIcons.SlideLeft,
                sign = -1,
                enabled = enabled,
                onStep = { step(current.nudgeMs + it) },
                modifier = Modifier.weight(1f).testTag("jam.adjust.earlier"),
            )
            HoldNudgeButton(
                label = stringResource(R.string.jam_rec_later),
                icon = PqpIcons.Forward,
                sign = 1,
                enabled = enabled,
                onStep = { step(current.nudgeMs + it) },
                modifier = Modifier.weight(1f).testTag("jam.adjust.later"),
            )
        }
        Text(stringResource(R.string.jam_rec_hold_hint), style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
    }
}

/**
 * A press steps once; holding it repeats and speeds up (10, 50, then 100 ms a step), because nobody taps thirty times.
 * [onStep] gets the signed size of one step. A TalkBack or keyboard activation is one step: the hold is for a finger.
 */
@Composable
fun HoldNudgeButton(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    sign: Int,
    onStep: (Int) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    container: Color = MaterialTheme.colorScheme.surfaceContainerHighest,
) {
    val colors = MaterialTheme.colorScheme
    val haptics = LocalHapticFeedback.current
    val step by rememberUpdatedState(onStep)
    Box(
        modifier
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(if (enabled) container else colors.surfaceContainer)
            .semantics(mergeDescendants = true) {
                contentDescription = label
                role = Role.Button
                onClick(label) {
                    if (enabled) step(sign * JamTakeEdit.stepFor(0))
                    enabled
                }
            }
            .pointerInput(sign, enabled) {
                if (!enabled) return@pointerInput
                awaitEachGesture {
                    awaitFirstDown()
                    step(sign * JamTakeEdit.stepFor(0))
                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    val started = System.nanoTime()
                    var next = started + HOLD_DELAY_NS
                    while (true) {
                        val wait = max(1L, (next - System.nanoTime()) / 1_000_000L)
                        // Nothing arrives while the finger is still: the wait ends by itself and the step repeats.
                        val event = withTimeoutOrNull(wait) { awaitPointerEvent() }
                        if (event != null && event.changes.none { it.pressed }) break
                        val now = System.nanoTime()
                        if (now >= next) {
                            step(sign * JamTakeEdit.stepFor((now - started) / 1_000_000L))
                            next = now + REPEAT_NS
                        }
                    }
                }
            }
            .padding(horizontal = Spacing.sm),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (sign < 0) Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp))
            Text(label, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold, maxLines = 1)
            if (sign > 0) Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun VolumeCard(edits: TakeEdits, enabled: Boolean, onGainPercent: (Int) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val percent = JamTrackEdit.percentOfGain(edits.gain)
    val delta = JamTrackEdit.volumeDelta(edits.gain) ?: stringResource(R.string.jam_clip_volume_normal)
    val description = stringResource(R.string.jam_clip_volume)
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(colors.surfaceContainerHigh).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(PqpIcons.Speakerphone, contentDescription = null, tint = colors.onSurfaceVariant, modifier = Modifier.size(16.dp))
            Text(stringResource(R.string.jam_clip_everybody), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            Slider(
                value = percent.toFloat(),
                onValueChange = { onGainPercent(it.roundToInt()) },
                valueRange = 0f..JamTrackEdit.GAIN_MAX_PERCENT.toFloat(),
                enabled = enabled,
                colors = SliderDefaults.colors(thumbColor = colors.primary, activeTrackColor = colors.primary),
                modifier = Modifier
                    .weight(1f)
                    .semantics { contentDescription = description; stateDescription = delta }
                    .testTag("jam.adjust.volume"),
            )
            Text(
                delta,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                color = colors.onSurfaceVariant,
                textAlign = TextAlign.End,
                modifier = Modifier.width(64.dp).testTag("jam.adjust.volumeValue"),
            )
        }
    }
}
