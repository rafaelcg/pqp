package gg.pqp.app.stories

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Layers on the wire: `packages/shared/src/stories.ts` (`storyLayerInputSchema`
 * is what is sent, `storyLayerUploadSchema` what comes back). Every list and
 * limit here is read out of that file by `StoryLayersTest`, so a renamed font
 * or a new color token fails the Android build instead of a post.
 *
 * A story is its base (photo, video, or a text card's background) plus up to
 * [MAX] layers, back to front, each centred at `x`, `y` (0..1 of the 9:16
 * canvas) with a `scale` and a clockwise `rotation` in radians.
 */
object StoryLayers {

    const val MAX = 20
    const val MAX_IMAGES = 6
    const val MAX_DRAWINGS = 1
    const val MAX_CALLS = 1
    const val MAX_MENTIONS = 5
    const val SCALE_MIN = 0.2f
    const val SCALE_MAX = 5f
    const val ROTATION_MAX = 3.1416f
    const val TEXT_SIZE_MIN = 0.5f
    const val TEXT_SIZE_MAX = 3f
    const val ALT_TEXT_MAX = 500
    const val MAX_BYTES = 8 * 1024 * 1024

    val FONTS = listOf("classic", "bold", "typewriter", "serif", "neon")
    val COLORS = listOf("white", "black", "lime", "yellow", "orange", "red", "pink", "purple", "blue", "cyan", "green", "gray")
    val TEXT_BACKGROUNDS = listOf("none", "solid", "soft")
    val ALIGNS = listOf("left", "center", "right")
    val SHAPES = listOf("rect", "rounded", "circle")

    /**
     * What a text layer's `size` 1 is, as a share of the canvas width, and the
     * line height as a multiple of the font size. The canonical layout every
     * platform draws with (web is the reference): the viewer uses the same numbers.
     */
    const val TEXT_BASE = 0.08f
    const val TEXT_LINE_HEIGHT = 1.14f

    /** A mention pill's font, as a share of the canvas width. */
    const val MENTION_FONT = 0.05f

    /** A photo layer at scale 1 is this share of the canvas width (the schema's own rule). */
    const val IMAGE_BASE_WIDTH = 0.4f

    /** A text layer wraps at this share of the canvas width, before its scale. */
    const val TEXT_WRAP_WIDTH = 0.84f

    /**
     * The twelve color tokens as ARGB. Tokens, never free hex: the server only
     * accepts these names, and every client paints them the same.
     */
    fun colorArgb(token: String): Long = when (token) {
        "white" -> 0xFFFFFFFF
        "black" -> 0xFF000000
        "lime" -> 0xFFBBEC4C
        "yellow" -> 0xFFFFD60A
        "orange" -> 0xFFFF9500
        "red" -> 0xFFFF3B30
        "pink" -> 0xFFFF5FA2
        "purple" -> 0xFFAF52DE
        "blue" -> 0xFF0A84FF
        "cyan" -> 0xFF64D2FF
        "green" -> 0xFF30D158
        "gray" -> 0xFF8E8E93
        else -> 0xFFFFFFFF
    }

    /** Whether text on this token reads as dark ink (the light tokens). */
    fun isLight(token: String): Boolean = token in setOf("white", "lime", "yellow", "orange", "pink", "cyan", "green", "gray")

    /** `altText`: the text layers read in order, the spoken version of the story. Null when there is nothing to say. */
    fun altText(texts: List<String>): String? {
        val joined = texts.map { it.trim() }.filter { it.isNotEmpty() }.joinToString(". ")
        if (joined.isEmpty()) return null
        return if (joined.length <= ALT_TEXT_MAX) joined else joined.take(ALT_TEXT_MAX - 1).trimEnd() + "…"
    }

    /** Four decimals is more than a 1080 px canvas can show, and keeps the body small. */
    fun round4(value: Float): Double = Math.round(value.toDouble() * 10_000.0) / 10_000.0

    private fun geometry(builder: kotlinx.serialization.json.JsonObjectBuilder, id: String, type: String, x: Float, y: Float, scale: Float, rotation: Float) {
        builder.put("id", id)
        builder.put("type", type)
        builder.put("x", round4(x))
        builder.put("y", round4(y))
        builder.put("scale", round4(scale))
        builder.put("rotation", round4(rotation))
    }

    fun textJson(
        id: String,
        x: Float,
        y: Float,
        scale: Float,
        rotation: Float,
        text: String,
        font: String,
        color: String,
        background: String,
        align: String,
        size: Float,
    ): JsonObject = buildJsonObject {
        geometry(this, id, "text", x, y, scale, rotation)
        put("text", text.trim())
        put("font", font)
        put("color", color)
        put("background", background)
        put("align", align)
        put("size", round4(size))
    }

    fun uploadJson(contentType: String, byteSize: Long, width: Int, height: Int): JsonObject = buildJsonObject {
        put("contentType", contentType)
        put("byteSize", byteSize)
        put("width", width)
        put("height", height)
    }

    fun imageJson(id: String, x: Float, y: Float, scale: Float, rotation: Float, shape: String, upload: JsonObject): JsonObject =
        buildJsonObject {
            geometry(this, id, "image", x, y, scale, rotation)
            put("shape", shape)
            put("upload", upload)
        }

    /** The drawing covers the whole canvas, so its geometry is fixed: centred, unscaled, unturned. */
    fun drawingJson(id: String, upload: JsonObject): JsonObject = buildJsonObject {
        geometry(this, id, "drawing", 0.5f, 0.5f, 1f, 0f)
        put("upload", upload)
    }

    fun callJson(id: String, x: Float, y: Float, scale: Float, rotation: Float, serverId: String, channelId: String): JsonObject =
        buildJsonObject {
            geometry(this, id, "call", x, y, scale, rotation)
            put("serverId", serverId)
            put("channelId", channelId)
        }

    fun mentionJson(id: String, x: Float, y: Float, scale: Float, rotation: Float, userId: String): JsonObject =
        buildJsonObject {
            geometry(this, id, "mention", x, y, scale, rotation)
            put("userId", JsonPrimitive(userId))
        }
}

/** One file to PUT for a layer: `storyLayerUploadSchema`, the base's upload plus the layer it is for. */
@Serializable
data class StoryLayerUploadSlot(
    val layerId: String,
    val url: String,
    val method: String = "PUT",
    val headers: Map<String, String> = emptyMap(),
    val expiresAt: String? = null,
) {
    fun asUpload(): StoryUpload = StoryUpload(url = url, method = method, headers = headers, expiresAt = expiresAt)
}
