package gg.pqp.app.stories

import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * A layer as the viewer reads it (`storyLayerSchema`): where it sits, and
 * what it is. A viewer draws the base, then each layer in order, scaled to its
 * own 9:16 canvas.
 *
 * **Lenient on purpose.** The schema is written strictly and read leniently:
 * a later server may add a layer type, or a layer may not decode. Each layer
 * is parsed on its own and one that cannot be understood is dropped, order
 * kept, so a story never crashes and is never refused over a layer this build
 * does not know. [StoryLayersSerializer] does exactly that for `Story.layers`.
 */
sealed interface StoryLayer {
    val id: String
    val x: Float
    val y: Float
    val scale: Float
    val rotation: Float
}

data class TextStoryLayer(
    override val id: String,
    override val x: Float,
    override val y: Float,
    override val scale: Float,
    override val rotation: Float,
    val text: String,
    val font: String,
    val color: String,
    val background: String,
    val align: String,
    val size: Float,
) : StoryLayer

data class ImageStoryLayer(
    override val id: String,
    override val x: Float,
    override val y: Float,
    override val scale: Float,
    override val rotation: Float,
    val shape: String,
    val url: String,
    val width: Int,
    val height: Int,
) : StoryLayer

/** The ink: a transparent PNG covering the canvas, drawn as is. */
data class DrawingStoryLayer(
    override val id: String,
    override val x: Float,
    override val y: Float,
    override val scale: Float,
    override val rotation: Float,
    val url: String,
    val width: Int,
    val height: Int,
) : StoryLayer

data class CallStoryLayer(
    override val id: String,
    override val x: Float,
    override val y: Float,
    override val scale: Float,
    override val rotation: Float,
    val serverId: String,
    val channelId: String,
) : StoryLayer

data class MentionStoryLayer(
    override val id: String,
    override val x: Float,
    override val y: Float,
    override val scale: Float,
    override val rotation: Float,
    val userId: String,
    /** Present on a read; null when the server could not name the person. */
    val user: StoryAuthor?,
) : StoryLayer

object StoryLayerParser {

    /** One layer, or null when it is not one this build can draw. Never throws. */
    fun parse(element: JsonElement): StoryLayer? = runCatching { parseOrThrow(element.jsonObject) }.getOrNull()

    private fun JsonObject.string(key: String): String? = this[key]?.takeIf { it is JsonPrimitive && it.isString }?.jsonPrimitive?.contentOrNull

    private fun JsonObject.number(key: String): Double? = this[key]?.jsonPrimitive?.doubleOrNull

    private fun JsonObject.integer(key: String): Int? = this[key]?.jsonPrimitive?.intOrNull

    private fun parseOrThrow(o: JsonObject): StoryLayer? {
        val id = o.string("id") ?: return null
        val type = o.string("type") ?: return null
        // The geometry every layer has. A layer with none of it has nowhere to be.
        val x = (o.number("x") ?: return null).toFloat().coerceIn(0f, 1f)
        val y = (o.number("y") ?: return null).toFloat().coerceIn(0f, 1f)
        val scale = (o.number("scale") ?: return null).toFloat().coerceIn(StoryLayers.SCALE_MIN, StoryLayers.SCALE_MAX)
        val rotation = (o.number("rotation") ?: return null).toFloat().coerceIn(-StoryLayers.ROTATION_MAX, StoryLayers.ROTATION_MAX)
        return when (type) {
            "text" -> {
                val text = o.string("text")?.takeIf { it.isNotBlank() } ?: return null
                TextStoryLayer(
                    id, x, y, scale, rotation, text,
                    font = o.string("font")?.takeIf { it in StoryLayers.FONTS } ?: "classic",
                    color = o.string("color")?.takeIf { it in StoryLayers.COLORS } ?: "white",
                    background = o.string("background")?.takeIf { it in StoryLayers.TEXT_BACKGROUNDS } ?: "none",
                    align = o.string("align")?.takeIf { it in StoryLayers.ALIGNS } ?: "center",
                    size = (o.number("size") ?: 1.0).toFloat().coerceIn(StoryLayers.TEXT_SIZE_MIN, StoryLayers.TEXT_SIZE_MAX),
                )
            }
            "image" -> ImageStoryLayer(
                id, x, y, scale, rotation,
                shape = o.string("shape")?.takeIf { it in StoryLayers.SHAPES } ?: "rect",
                url = o.string("url")?.takeIf { it.isNotBlank() } ?: return null,
                width = (o.integer("width") ?: return null).takeIf { it > 0 } ?: return null,
                height = (o.integer("height") ?: return null).takeIf { it > 0 } ?: return null,
            )
            "drawing" -> DrawingStoryLayer(
                id, x, y, scale, rotation,
                url = o.string("url")?.takeIf { it.isNotBlank() } ?: return null,
                width = (o.integer("width") ?: return null).takeIf { it > 0 } ?: return null,
                height = (o.integer("height") ?: return null).takeIf { it > 0 } ?: return null,
            )
            "call" -> CallStoryLayer(
                id, x, y, scale, rotation,
                serverId = o.string("serverId") ?: return null,
                channelId = o.string("channelId") ?: return null,
            )
            "mention" -> MentionStoryLayer(
                id, x, y, scale, rotation,
                userId = o.string("userId") ?: return null,
                user = (o["user"] as? JsonObject)?.let { u ->
                    val uid = u.string("id") ?: return@let null
                    StoryAuthor(
                        id = uid,
                        displayName = u.string("displayName").orEmpty(),
                        avatarUrl = u.string("avatarUrl"),
                        handle = u.string("handle"),
                    )
                },
            )
            // A type a later server added: not ours to draw, not a reason to refuse the story.
            else -> null
        }
    }
}

/** Decodes `layers` one element at a time, dropping each one that cannot be understood. */
object StoryLayersSerializer : KSerializer<List<StoryLayer>> {
    private val delegate = ListSerializer(JsonElement.serializer())
    override val descriptor: SerialDescriptor = delegate.descriptor

    override fun deserialize(decoder: Decoder): List<StoryLayer> {
        val input = decoder as? JsonDecoder ?: return emptyList()
        val array = runCatching { input.decodeJsonElement() }.getOrNull() as? JsonArray ?: return emptyList()
        return array.mapNotNull(StoryLayerParser::parse).take(StoryLayers.MAX)
    }

    /** Never sent: layers are written through `StoryLayers`, not through the read model. */
    override fun serialize(encoder: Encoder, value: List<StoryLayer>) {
        encoder.encodeSerializableValue(delegate, emptyList())
    }
}
