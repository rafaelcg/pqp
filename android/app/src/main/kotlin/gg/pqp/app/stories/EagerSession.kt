package gg.pqp.app.stories

import gg.pqp.app.stories.editor.EditorLayer
import gg.pqp.app.stories.editor.InkLayer
import gg.pqp.app.stories.editor.InkRenderer
import gg.pqp.app.stories.editor.LayerFile
import gg.pqp.app.stories.editor.PhotoLayer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The eager uploads of one composer: what it has started, kept in step with what
 * is on the canvas.
 *
 * - The base starts when the picture or clip is final (taken, picked, or trimmed
 *   and cut: the composer only has a [PreparedMedia] once that is so). A different
 *   one (back out and pick again, a re-trim) throws the first away.
 * - A photo layer starts when it is placed and is thrown away when it is removed.
 * - A drawing is rendered and sent when its tool closes ("Pronto"), not stroke by
 *   stroke, and sent again (the old one thrown away) if the strokes change.
 *
 * Throwing away means the PUT is stopped and the server told, at once; an upload
 * nobody claims is also swept by the server after six hours.
 *
 * [handOver] gives the files to the outbox when "Postar" is tapped; [discardAll]
 * is the composer closing without posting.
 */
class EagerSession(private val uploads: StoryEagerUploads) {
    private val handles = LinkedHashMap<String, EagerUpload>()

    /** Set once the files went to the outbox or were thrown away: nothing is started after that. */
    @Volatile
    private var closed = false

    /** The base picture or clip is [media] (null: none). */
    @Synchronized
    fun syncBase(media: PreparedMedia?) {
        if (closed) return
        val current = handles[DraftFile.BASE]
        // One that failed (the link was down) is started again the next time the canvas is looked at.
        if (current != null && (current.tag !== media || current.failed)) {
            uploads.discard(current)
            handles.remove(DraftFile.BASE)
        }
        if (media != null && handles[DraftFile.BASE] == null) {
            handles[DraftFile.BASE] = uploads.start(DraftFile.BASE, "base", media.contentType, media.bytes, tag = media)
        }
    }

    /**
     * The layers on the canvas now, with the prepared file of each photo layer. [drawingOpen] holds drawings back
     * until the draw tool is closed.
     */
    suspend fun syncLayers(layers: List<EditorLayer>, layerFiles: Map<String, LayerFile>, drawingOpen: Boolean) {
        if (closed) return
        val wanted = LinkedHashMap<String, Pair<Any, suspend () -> LayerFile?>>()
        layers.forEach { layer ->
            when (layer) {
                is PhotoLayer -> layerFiles[layer.id]?.let { file -> wanted[layer.id] = file to { file } }
                is InkLayer -> if (!drawingOpen && layer.strokes.isNotEmpty()) {
                    wanted[layer.id] = layer.strokes to {
                        val (w, h) = InkRenderer.exportSize()
                        val png = withContext(Dispatchers.Default) { InkRenderer.renderPng(layer.strokes, w, h) }
                        LayerFile(layer.id, "image/png", png, w, h)
                    }
                }
                else -> Unit
            }
        }
        // A drawing whose tool is open is neither kept nor thrown away: it is still being drawn.
        val holding = layers.filterIsInstance<InkLayer>().map { it.id }.takeIf { drawingOpen }.orEmpty().toSet()
        synchronized(this) {
            handles.keys.filter { it != DraftFile.BASE && it !in wanted && it !in holding }.forEach { key ->
                handles.remove(key)?.let(uploads::discard)
            }
            // A layer whose content changed (a redrawn drawing): the old upload goes.
            wanted.forEach { (key, source) ->
                val current = handles[key]
                if (current != null && (current.tag != source.first || current.failed)) {
                    uploads.discard(current)
                    handles.remove(key)
                }
            }
        }
        for ((key, source) in wanted) {
            if (synchronized(this) { handles.containsKey(key) }) continue
            val file = source.second() ?: continue
            synchronized(this) {
                if (!closed && !handles.containsKey(key)) {
                    handles[key] = uploads.start(key, "layer", file.contentType, file.bytes, tag = source.first, file = file)
                }
            }
        }
    }

    /** "Postar": the outbox takes these. A base that will not be the one posted (muted) is thrown away first. */
    @Synchronized
    fun handOver(baseIsUsable: Boolean): Map<String, EagerUpload> {
        closed = true
        if (!baseIsUsable) handles.remove(DraftFile.BASE)?.let(uploads::discard)
        return LinkedHashMap(handles).also { handles.clear() }
    }

    /** The composer closed without posting: nothing started here will be claimed. */
    @Synchronized
    fun discardAll() {
        closed = true
        handles.values.forEach(uploads::discard)
        handles.clear()
    }
}
