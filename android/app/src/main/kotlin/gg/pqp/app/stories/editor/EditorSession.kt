package gg.pqp.app.stories.editor

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.UUID

/** The text styling the last text layer used: the next one starts there, so a person's look sticks. */
data class TextStyleChoice(
    val font: String = "classic",
    val color: String = "white",
    val background: String = "none",
    val align: String = "center",
    val size: Float = 1f,
)

/** The pen the person last picked. */
data class PenChoice(
    val brush: String = Brushes.PEN,
    val color: String = "white",
    val slider: Float = 0.35f,
)

/**
 * Everything the editor is holding while a story is made: the layers, the
 * undo history, what is selected, how big each layer measured. State, with the
 * rules in `LayerOps` and `LayerMath`.
 *
 * Each action that changes the layers pushes the list it replaces, so undo
 * puts back exactly what was there. A drag pushes once, when it starts moving
 * (a tap that moves nothing pushes nothing); ink pushes once per stroke.
 */
@Stable
class EditorSession {
    var layers by mutableStateOf<List<EditorLayer>>(emptyList())
        private set

    private val history = UndoStack<List<EditorLayer>>(20)
    var canUndo by mutableStateOf(false)
        private set

    /** The draw tool is open: a drawing is still being made, and is not worth sending ahead of the story yet. */
    var drawingOpen by mutableStateOf(false)

    /** The layer a finger is on right now. */
    var activeId by mutableStateOf<String?>(null)

    /** The last layer touched: a two-finger pinch anywhere on the canvas turns this one. */
    var selectedId by mutableStateOf<String?>(null)

    /** Layers measured before scale and rotation, for hit testing. */
    val sizes = mutableStateMapOf<String, LayerMath.Size>()

    /** The stroke a finger is drawing right now: shown live, saved (one undo step) when the finger lifts. */
    var liveStroke by mutableStateOf<Stroke?>(null)

    /**
     * What the author says the picture or clip shows, for people who cannot see it. Sent first in the
     * story's `altText`, ahead of the words the text layers carry. Not part of the undo history: it is
     * a field, not a thing on the canvas.
     */
    var description by mutableStateOf("")

    var textStyle by mutableStateOf(TextStyleChoice())
    var pen by mutableStateOf(PenChoice())

    fun newId(): String = UUID.randomUUID().toString()

    private fun syncUndo() {
        canUndo = !history.isEmpty
    }

    /** Remember the list as it is now, before a change. */
    fun checkpoint() {
        history.push(layers)
        syncUndo()
    }

    /** Replace the layers as one undoable step. */
    fun commit(next: List<EditorLayer>) {
        checkpoint()
        layers = next
    }

    /** A live change (a finger mid-drag): no history entry; [checkpoint] was taken when it began. */
    fun live(next: List<EditorLayer>) {
        layers = next
    }

    fun undo(): Boolean {
        val previous = history.pop() ?: return false
        layers = previous
        if (selectedId != null && previous.none { it.id == selectedId }) selectedId = null
        syncUndo()
        return true
    }

    /** Adds [layer] if the limits allow, else says why not. */
    fun add(layer: EditorLayer): LayerOps.Refusal? {
        LayerOps.canAdd(layers, layer)?.let { return it }
        commit(LayerOps.add(layers, layer))
        selectedId = layer.id
        return null
    }

    fun update(layer: EditorLayer) = commit(LayerOps.replace(layers, layer))

    fun remove(id: String) {
        commit(LayerOps.remove(layers, id))
        sizes.remove(id)
        if (selectedId == id) selectedId = null
    }

    fun bringToFront(id: String) = commit(LayerOps.bringToFront(layers, id))

    fun layer(id: String): EditorLayer? = layers.firstOrNull { it.id == id }

    /** The draw tool opened: a drawing already made goes to the top (one undo step) so the next stroke is seen. */
    fun beginDrawing() {
        val next = LayerOps.inkToFront(layers)
        if (next != layers) commit(next)
    }

    fun addStroke(stroke: Stroke) = commit(LayerOps.withStroke(layers, ::newId, stroke))

    val hasInk: Boolean get() = layers.any { it is InkLayer }
}
