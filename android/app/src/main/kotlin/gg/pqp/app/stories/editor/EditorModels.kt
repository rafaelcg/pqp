package gg.pqp.app.stories.editor

import gg.pqp.app.stories.StoryLayers

/**
 * What the editor holds while somebody builds a story: pure data, no Compose
 * and no Android, so every rule over it is a JVM test.
 *
 * A layer is centred at `x`, `y` (0..1 of the 9:16 canvas) and drawn at `scale`
 * and a clockwise `rotation` in radians. The same fields the server stores, so
 * what is posted is what was placed.
 */
sealed interface EditorLayer {
    val id: String
    val x: Float
    val y: Float
    val scale: Float
    val rotation: Float

    /** The same layer somewhere else: the one thing a gesture changes on every type. */
    fun placed(x: Float = this.x, y: Float = this.y, scale: Float = this.scale, rotation: Float = this.rotation): EditorLayer

    /** The kind, as the schema names it. */
    val type: String
}

data class TextLayer(
    override val id: String,
    override val x: Float = 0.5f,
    override val y: Float = 0.5f,
    override val scale: Float = 1f,
    override val rotation: Float = 0f,
    val text: String,
    val font: String = "classic",
    val color: String = "white",
    val background: String = "none",
    val align: String = "center",
    val size: Float = 1f,
) : EditorLayer {
    override val type get() = "text"
    override fun placed(x: Float, y: Float, scale: Float, rotation: Float) = copy(x = x, y = y, scale = scale, rotation = rotation)
}

/** A photo placed on top of the story. [source] is a local URI string; the bytes are prepared at post time. */
data class PhotoLayer(
    override val id: String,
    override val x: Float = 0.5f,
    override val y: Float = 0.5f,
    override val scale: Float = 1f,
    override val rotation: Float = 0f,
    val shape: String = "rect",
    val source: String,
    val width: Int,
    val height: Int,
) : EditorLayer {
    override val type get() = "image"
    override fun placed(x: Float, y: Float, scale: Float, rotation: Float) = copy(x = x, y = y, scale = scale, rotation = rotation)
}

/** Freehand ink over the whole canvas. There is at most one; it never moves, but it has a place in the stack like any layer. */
data class InkLayer(
    override val id: String,
    val strokes: List<Stroke> = emptyList(),
) : EditorLayer {
    override val x get() = 0.5f
    override val y get() = 0.5f
    override val scale get() = 1f
    override val rotation get() = 0f
    override val type get() = "drawing"
    override fun placed(x: Float, y: Float, scale: Float, rotation: Float) = this
}

data class MentionLayer(
    override val id: String,
    override val x: Float = 0.5f,
    override val y: Float = 0.5f,
    override val scale: Float = 1f,
    override val rotation: Float = 0f,
    val userId: String,
    val name: String,
    val avatarUrl: String? = null,
) : EditorLayer {
    override val type get() = "mention"
    override fun placed(x: Float, y: Float, scale: Float, rotation: Float) = copy(x = x, y = y, scale = scale, rotation = rotation)
}

data class CallLayer(
    override val id: String,
    override val x: Float = 0.5f,
    override val y: Float = 0.7f,
    override val scale: Float = 1f,
    override val rotation: Float = 0f,
    val serverId: String,
    val channelId: String,
    val roomName: String,
    val serverName: String = "",
    val serverIconUrl: String? = null,
) : EditorLayer {
    override val type get() = "call"
    override fun placed(x: Float, y: Float, scale: Float, rotation: Float) = copy(x = x, y = y, scale = scale, rotation = rotation)
}

/**
 * One stroke of ink. Points are stored as fractions of the canvas (x of its
 * width, y of its height) and the width as a fraction of the canvas width, so
 * the same ink draws the same on the screen and in the exported PNG, whatever
 * size either is.
 */
data class Stroke(
    /** `pen`, `marker`, `highlighter` or `eraser`. */
    val brush: String,
    val color: String,
    val width: Float,
    /** x0, y0, x1, y1, ... */
    val points: List<Float>,
)

/**
 * An immutable view of the first [size] values of an array that only ever grows
 * at its end. A stroke being drawn publishes one of these on every frame
 * without copying what it has so far: the view cannot see what is appended
 * after it, and nothing it can see is ever changed.
 */
class FloatPoints(private val data: FloatArray, override val size: Int) : AbstractList<Float>(), RandomAccess {
    override fun get(index: Int): Float {
        if (index < 0 || index >= size) throw IndexOutOfBoundsException("$index of $size")
        return data[index]
    }
}

/** The growing side of [FloatPoints]. */
class PointsBuilder(initial: Int = 256) {
    private var data = FloatArray(initial)
    var size = 0
        private set

    fun add(x: Float, y: Float) {
        if (size + 2 > data.size) data = data.copyOf(data.size * 2)
        data[size++] = x
        data[size++] = y
    }

    /** The value at [index], for the "is this a new point" check. */
    operator fun get(index: Int): Float = data[index]

    fun view(): List<Float> = FloatPoints(data, size)
}

object Brushes {
    const val PEN = "pen"
    const val MARKER = "marker"
    const val HIGHLIGHTER = "highlighter"
    const val ERASER = "eraser"
    val ALL = listOf(PEN, MARKER, HIGHLIGHTER, ERASER)

    /** Brush width as a share of the canvas width, for slider position 0..1. */
    fun widthFor(brush: String, slider: Float): Float {
        val t = slider.coerceIn(0f, 1f)
        val (min, max) = when (brush) {
            MARKER -> 0.022f to 0.07f
            HIGHLIGHTER -> 0.035f to 0.10f
            ERASER -> 0.03f to 0.12f
            else -> 0.006f to 0.04f
        }
        return min + (max - min) * t
    }

    /** How opaque a brush paints: the highlighter lets the picture through. */
    fun alpha(brush: String): Float = if (brush == HIGHLIGHTER) 0.4f else 1f
}

/** What the story is drawn on. */
sealed interface EditorBase {
    /** A text card: a gradient background token, and nothing else. */
    data class Card(val background: String) : EditorBase

    /** A photo or video the person picked or shot. Held by the composer next to the editor (its bytes are not data). */
    data object Media : EditorBase
}

/** A bounded undo history of whole layer lists. Whole snapshots are cheap: at most 20 small immutable layers. */
class UndoStack<T>(private val max: Int = 20) {
    private val items = ArrayDeque<T>()

    val isEmpty: Boolean get() = items.isEmpty()
    val size: Int get() = items.size

    fun push(snapshot: T) {
        items.addLast(snapshot)
        while (items.size > max) items.removeFirst()
    }

    fun pop(): T? = items.removeLastOrNull()

    fun clear() = items.clear()
}

/** Layer-list rules that have an edge to get wrong: the per-type limits, ordering, replacement. */
object LayerOps {

    /** Why a layer could not be added, in the editor's own words (the UI turns it into copy). */
    enum class Refusal { TooMany, TooManyPhotos, TooManyMentions, MentionedAlready }

    fun count(layers: List<EditorLayer>, type: String): Int = layers.count { it.type == type }

    fun canAdd(layers: List<EditorLayer>, layer: EditorLayer): Refusal? = when {
        // A call and the drawing replace themselves, so only the total can refuse them.
        layers.size >= StoryLayers.MAX && !(layer is CallLayer && layers.any { it is CallLayer }) &&
            !(layer is InkLayer && layers.any { it is InkLayer }) -> Refusal.TooMany
        layer is PhotoLayer && count(layers, "image") >= StoryLayers.MAX_IMAGES -> Refusal.TooManyPhotos
        layer is MentionLayer && layers.any { it is MentionLayer && it.userId == layer.userId } -> Refusal.MentionedAlready
        layer is MentionLayer && count(layers, "mention") >= StoryLayers.MAX_MENTIONS -> Refusal.TooManyMentions
        else -> null
    }

    /**
     * Adds [layer] on top: the order is the order things were made, for every
     * type, the drawing included. A second call replaces the first (there is
     * one call per story), and so does a second drawing (one per story).
     */
    fun add(layers: List<EditorLayer>, layer: EditorLayer): List<EditorLayer> = when (layer) {
        is CallLayer -> layers.filterNot { it is CallLayer } + layer
        is InkLayer -> layers.filterNot { it is InkLayer } + layer
        else -> layers + layer
    }

    fun remove(layers: List<EditorLayer>, id: String): List<EditorLayer> = layers.filterNot { it.id == id }

    fun replace(layers: List<EditorLayer>, layer: EditorLayer): List<EditorLayer> =
        layers.map { if (it.id == layer.id) layer else it }

    /** To the top of the stack. The drawing goes like any other layer. */
    fun bringToFront(layers: List<EditorLayer>, id: String): List<EditorLayer> {
        val layer = layers.firstOrNull { it.id == id } ?: return layers
        if (layers.last().id == id) return layers
        return layers.filterNot { it.id == id } + layer
    }

    /** Whether "bring forward" would change anything: not for the topmost layer, nor the only one. */
    fun canBringForward(layers: List<EditorLayer>, id: String): Boolean =
        layers.size > 1 && layers.any { it.id == id } && layers.last().id != id

    /**
     * The ink with one more stroke on it, or the ink created. A story has one
     * drawing, so a new drawing session that starts with layers above it
     * brings it back to the top: the new stroke is on top of what the finger
     * sees, never hidden under a photo placed since.
     */
    fun withStroke(layers: List<EditorLayer>, newId: () -> String, stroke: Stroke): List<EditorLayer> {
        val ink = layers.filterIsInstance<InkLayer>().firstOrNull()
        return if (ink == null) {
            add(layers, InkLayer(newId(), listOf(stroke)))
        } else {
            layers.filterNot { it.id == ink.id } + ink.copy(strokes = ink.strokes + stroke)
        }
    }

    /** Opening the draw tool with a drawing already there: it goes to the top so what is drawn next is seen. */
    fun inkToFront(layers: List<EditorLayer>): List<EditorLayer> {
        val ink = layers.firstOrNull { it is InkLayer } ?: return layers
        return bringToFront(layers, ink.id)
    }

    /** What a screen reader says for the story: its text layers, in order. */
    fun spokenText(layers: List<EditorLayer>): String? =
        StoryLayers.altText(layers.filterIsInstance<TextLayer>().map { it.text })

    /** A text card must say something: at least one layer that is not empty ink. */
    fun hasContent(layers: List<EditorLayer>): Boolean = layers.any {
        when (it) {
            is TextLayer -> it.text.isNotBlank()
            is InkLayer -> it.strokes.any { stroke -> stroke.brush != Brushes.ERASER }
            else -> true
        }
    }
}
