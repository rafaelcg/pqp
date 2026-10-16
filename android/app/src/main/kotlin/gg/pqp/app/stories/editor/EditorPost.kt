package gg.pqp.app.stories.editor

import gg.pqp.app.stories.StoryLayerUploadSlot
import gg.pqp.app.stories.StoryLayers
import kotlinx.serialization.json.JsonObject

/** A layer's image, prepared and ready to PUT: exactly [bytes], which is what `byteSize` declares. */
class LayerFile(
    val layerId: String,
    val contentType: String,
    val bytes: ByteArray,
    val width: Int,
    val height: Int,
)

/**
 * Turning what is on the canvas into the request body, and the answer back into
 * the PUTs to make. Pure, so the shape that leaves the phone (field names,
 * order, what is declared for each file) is a JVM test against the schema.
 */
object EditorPost {

    /**
     * `layers` for `POST /api/stories`, back to front. A photo or drawing
     * needs its prepared [files] entry (the declared size is the file's own);
     * with none the whole post fails ([IllegalStateException]), rather than a
     * story that quietly leaves out something the author placed.
     */
    fun layersJson(layers: List<EditorLayer>, files: Map<String, LayerFile>): List<JsonObject> = layers.mapNotNull { layer ->
        when (layer) {
            is TextLayer -> if (layer.text.isBlank()) null else StoryLayers.textJson(
                layer.id, layer.x, layer.y, layer.scale, layer.rotation,
                layer.text, layer.font, layer.color, layer.background, layer.align, layer.size,
            )
            is PhotoLayer -> files[layer.id]?.let {
                StoryLayers.imageJson(
                    layer.id, layer.x, layer.y, layer.scale, layer.rotation, layer.shape,
                    StoryLayers.uploadJson(it.contentType, it.bytes.size.toLong(), it.width, it.height),
                )
            } ?: error("The photo layer ${layer.id} has no prepared file")
            is InkLayer -> files[layer.id]?.let {
                StoryLayers.drawingJson(layer.id, StoryLayers.uploadJson(it.contentType, it.bytes.size.toLong(), it.width, it.height))
            } ?: error("The drawing ${layer.id} has no prepared file")
            is MentionLayer -> StoryLayers.mentionJson(layer.id, layer.x, layer.y, layer.scale, layer.rotation, layer.userId)
            is CallLayer -> StoryLayers.callJson(layer.id, layer.x, layer.y, layer.scale, layer.rotation, layer.serverId, layer.channelId)
        }
    }

    /** Which prepared file goes to which slot the server minted: matched by layer id, none left over, none missing. */
    fun pair(slots: List<StoryLayerUploadSlot>, files: Map<String, LayerFile>): List<Pair<StoryLayerUploadSlot, LayerFile>>? {
        if (slots.size != files.size) return null
        return slots.map { slot -> slot to (files[slot.layerId] ?: return null) }
    }

    /**
     * Whether the story has to be published after the PUTs: anything uploaded
     * (a base or a layer file) waits for it. A text card with only words,
     * stickers and mentions is live as soon as it is created.
     */
    fun needsPublish(hasBaseUpload: Boolean, slots: List<StoryLayerUploadSlot>): Boolean = hasBaseUpload || slots.isNotEmpty()

    /** The `kind` the server expects: a photo or clip as picked, otherwise a text card with its layers. */
    fun kind(isVideo: Boolean?, hasMedia: Boolean): String = when {
        !hasMedia -> "text"
        isVideo == true -> "video"
        else -> "image"
    }
}
