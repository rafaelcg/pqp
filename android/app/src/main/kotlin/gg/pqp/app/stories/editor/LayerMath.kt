package gg.pqp.app.stories.editor

import gg.pqp.app.stories.StoryLayers
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * The geometry behind dragging, pinching and turning a layer: no Compose, so
 * the edges (a rotation wrapping past pi, a snap that must let go, a hit test
 * on a turned layer) are JVM tests.
 *
 * Positions are fractions of the canvas while stored (`x`, `y` in 0..1) and
 * pixels while a finger is on them; [Canvas] converts.
 */
object LayerMath {

    data class Pt(val x: Float, val y: Float)

    /** The canvas the layers sit on, in pixels. Always 9:16, but the math does not assume it. */
    data class Canvas(val width: Float, val height: Float) {
        fun px(x: Float, y: Float) = Pt(x * width, y * height)
        fun fractionX(px: Float) = if (width > 0f) px / width else 0f
        fun fractionY(px: Float) = if (height > 0f) px / height else 0f
    }

    data class Placement(val x: Float, val y: Float, val scale: Float, val rotation: Float)

    private const val TWO_PI = (2 * PI).toFloat()

    fun clampScale(scale: Float): Float = scale.coerceIn(StoryLayers.SCALE_MIN, StoryLayers.SCALE_MAX)

    /** The same angle inside -pi..pi, so a layer turned round and round never leaves what the server accepts. */
    fun normalizeRotation(radians: Float): Float {
        var r = radians % TWO_PI
        if (r > PI.toFloat()) r -= TWO_PI
        if (r < -PI.toFloat()) r += TWO_PI
        return r
    }

    /** A centre stays on the canvas: a layer dragged off the edge keeps a handle to be dragged back by. */
    fun clampCenter(fraction: Float): Float = fraction.coerceIn(0f, 1f)

    /**
     * What a gesture does to a layer. [pan] is in pixels, [zoom] a factor,
     * [rotationDelta] in radians (clockwise positive), all since the last event.
     */
    fun applyGesture(from: Placement, pan: Pt, zoom: Float, rotationDelta: Float, canvas: Canvas): Placement =
        Placement(
            x = clampCenter(from.x + canvas.fractionX(pan.x)),
            y = clampCenter(from.y + canvas.fractionY(pan.y)),
            scale = clampScale(from.scale * zoom),
            rotation = normalizeRotation(from.rotation + rotationDelta),
        )

    data class Snap(val value: Float, val snapped: Boolean)

    /**
     * Pulls [fraction] to the middle (0.5) when it is within [threshold] of it.
     * The caller keeps the unsnapped number and snaps a copy every event, so
     * the layer lets go again once the finger has moved on.
     */
    fun snapToCenter(fraction: Float, threshold: Float): Snap =
        if (abs(fraction - 0.5f) <= threshold) Snap(0.5f, true) else Snap(fraction, false)

    /** Pulls a rotation to the nearest quarter turn (0, 90, 180, 270 degrees) when it is within [threshold] radians. */
    fun snapRotation(radians: Float, threshold: Float): Snap {
        val quarter = (PI / 2).toFloat()
        val nearest = (radians / quarter).roundToInt() * quarter
        return if (abs(radians - nearest) <= threshold) Snap(normalizeRotation(nearest), true) else Snap(radians, false)
    }

    /** A layer's box before scale and rotation, in pixels. */
    data class Size(val width: Float, val height: Float)

    /**
     * Whether a touch at [point] is on a layer centred at [center], sized
     * [size] before [scale], turned by [rotation]. The test is made in the
     * layer's own frame (undo the turn), so a rotated rectangle is a
     * rectangle, not its bounding box. [slop] makes a small layer grabbable.
     */
    fun hit(point: Pt, center: Pt, size: Size, scale: Float, rotation: Float, slop: Float): Boolean {
        val dx = point.x - center.x
        val dy = point.y - center.y
        val c = cos(-rotation)
        val s = sin(-rotation)
        val lx = dx * c - dy * s
        val ly = dx * s + dy * c
        val halfW = size.width * scale / 2f + slop
        val halfH = size.height * scale / 2f + slop
        return abs(lx) <= halfW && abs(ly) <= halfH
    }

    /** The topmost layer under [point], or null. [layers] is back to front; the last one drawn is the first hit. */
    fun topHit(
        layers: List<EditorLayer>,
        sizes: Map<String, Size>,
        canvas: Canvas,
        point: Pt,
        slop: Float,
    ): EditorLayer? = layers.asReversed().firstOrNull { layer ->
        if (layer is InkLayer) return@firstOrNull false
        val size = sizes[layer.id] ?: return@firstOrNull false
        hit(point, canvas.px(layer.x, layer.y), size, layer.scale, layer.rotation, slop)
    }

    /** Whether a finger at [pointer] is on the trash circle. */
    fun inTrash(pointer: Pt, trashCenter: Pt, radius: Float): Boolean {
        val dx = pointer.x - trashCenter.x
        val dy = pointer.y - trashCenter.y
        return dx * dx + dy * dy <= radius * radius
    }

    /** A text layer's font size in pixels: its `size` times a share of the canvas width. */
    fun textSizePx(size: Float, canvasWidth: Float): Float = size * StoryLayers.TEXT_BASE * canvasWidth

    /** A photo layer's box in pixels at scale 1: 40% of the canvas width, the picture's own aspect. */
    fun photoSize(width: Int, height: Int, canvasWidth: Float): Size {
        val w = StoryLayers.IMAGE_BASE_WIDTH * canvasWidth
        val aspect = if (width > 0) height.toFloat() / width else 1f
        return Size(w, max(1f, w * aspect))
    }

    /**
     * Where a new layer goes: the middle, nudged a little for each layer
     * already there so the second one is not hidden exactly behind the first.
     */
    fun startPosition(existing: Int): Pt {
        val step = (existing % 5) * 0.025f
        return Pt(0.5f + step, 0.5f + step)
    }
}
