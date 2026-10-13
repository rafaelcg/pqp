package gg.pqp.app.stories

import gg.pqp.app.protocol.RepoSources
import gg.pqp.app.stories.editor.BaseFit
import gg.pqp.app.stories.editor.Brushes
import gg.pqp.app.stories.editor.CallLayer
import gg.pqp.app.stories.editor.EditorLayer
import gg.pqp.app.stories.editor.EditorPost
import gg.pqp.app.stories.editor.InkLayer
import gg.pqp.app.stories.editor.LayerFile
import gg.pqp.app.stories.editor.LayerMath
import gg.pqp.app.stories.editor.LayerMath.Canvas
import gg.pqp.app.stories.editor.LayerMath.Placement
import gg.pqp.app.stories.editor.LayerMath.Pt
import gg.pqp.app.stories.editor.LayerMath.Size
import gg.pqp.app.stories.editor.LayerOps
import gg.pqp.app.stories.editor.MentionLayer
import gg.pqp.app.stories.editor.PhotoLayer
import gg.pqp.app.stories.editor.PointsBuilder
import gg.pqp.app.stories.editor.Stroke
import gg.pqp.app.stories.editor.TextLayer
import gg.pqp.app.stories.editor.UndoStack
import gg.pqp.app.stories.editor.storyFont
import gg.pqp.app.stories.editor.textPaint
import gg.pqp.app.stories.editor.tokenColor
import kotlin.math.PI
import kotlinx.serialization.descriptors.elementNames
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The editor's rules: the layer geometry (drag, pinch, turn, snap, hit, trash),
 * the per-type limits, undo, and the body that leaves the phone checked
 * against `packages/shared/src/stories.ts`.
 */
class EditorTest {

    private val shared = "packages/shared/src/stories.ts"
    private val source by lazy { RepoSources.stripComments(RepoSources.read(shared)) }

    private fun constant(name: String): Double =
        Regex("""const\s+$name\s*=\s*([\d_.]+)""").find(source)!!.groupValues[1].replace("_", "").toDouble()

    private fun list(name: String): List<String> {
        val body = Regex("""const\s+$name\s*=\s*\[([^\]]*)]""").find(source)!!.groupValues[1]
        return Regex(""""([^"]+)"""").findAll(body).map { it.groupValues[1] }.toList()
    }

    // --- the schema ---

    @Test
    fun `layer limits and enums are the shared ones`() {
        assertEquals(constant("STORY_LAYERS_MAX").toInt(), StoryLayers.MAX)
        assertEquals(constant("STORY_LAYER_IMAGES_MAX").toInt(), StoryLayers.MAX_IMAGES)
        assertEquals(constant("STORY_LAYER_DRAWINGS_MAX").toInt(), StoryLayers.MAX_DRAWINGS)
        assertEquals(constant("STORY_LAYER_CALLS_MAX").toInt(), StoryLayers.MAX_CALLS)
        assertEquals(constant("STORY_LAYER_MENTIONS_MAX").toInt(), StoryLayers.MAX_MENTIONS)
        assertEquals(constant("STORY_LAYER_SCALE_MIN"), StoryLayers.SCALE_MIN.toDouble(), 1e-6)
        assertEquals(constant("STORY_LAYER_SCALE_MAX"), StoryLayers.SCALE_MAX.toDouble(), 1e-6)
        assertEquals(constant("STORY_LAYER_ROTATION_MAX"), StoryLayers.ROTATION_MAX.toDouble(), 1e-6)
        assertEquals(constant("STORY_LAYER_TEXT_SIZE_MIN"), StoryLayers.TEXT_SIZE_MIN.toDouble(), 1e-6)
        assertEquals(constant("STORY_LAYER_TEXT_SIZE_MAX"), StoryLayers.TEXT_SIZE_MAX.toDouble(), 1e-6)
        assertEquals(constant("STORY_ALT_TEXT_MAX").toInt(), StoryLayers.ALT_TEXT_MAX)
        assertEquals(list("STORY_LAYER_FONTS"), StoryLayers.FONTS)
        assertEquals(list("STORY_LAYER_COLORS"), StoryLayers.COLORS)
        assertEquals(list("STORY_LAYER_TEXT_BACKGROUNDS"), StoryLayers.TEXT_BACKGROUNDS)
        assertEquals(list("STORY_LAYER_ALIGNS"), StoryLayers.ALIGNS)
        assertEquals(list("STORY_LAYER_IMAGE_SHAPES"), StoryLayers.SHAPES)
    }

    @Test
    fun `every color token has a color, light ones are light and the rest are not`() {
        StoryLayers.COLORS.forEach { token ->
            assertTrue("$token has no color", StoryLayers.colorArgb(token) != 0xFFFFFFFF || token == "white")
            assertEquals(0xFF, (StoryLayers.colorArgb(token) shr 24).toInt() and 0xFF)
        }
        assertTrue(StoryLayers.isLight("white"))
        assertTrue(StoryLayers.isLight("yellow"))
        assertFalse(StoryLayers.isLight("black"))
        assertFalse(StoryLayers.isLight("blue"))
        assertFalse(StoryLayers.isLight("red"))
    }

    /** Top-level keys of a plain `const name = { ... }` (the layer field blocks), spreads resolved. */
    private fun fieldKeys(name: String): Set<String> {
        val start = source.indexOf("const $name = {")
        check(start >= 0) { "no const $name in $shared" }
        var depth = 0
        var i = source.indexOf('{', start)
        val begin = i
        while (i < source.length) {
            when (source[i]) {
                '{', '[', '(' -> depth++
                '}', ']', ')' -> {
                    depth--
                    if (depth == 0) break
                }
            }
            i++
        }
        val keys = mutableSetOf<String>()
        var level = 0
        val body = source.substring(begin + 1, i)
        body.lines().forEach { line ->
            val trimmed = line.trim()
            if (level == 0) {
                Regex("""^\.\.\.(\w+),?$""").find(trimmed)?.let { keys += fieldKeys(it.groupValues[1]) }
                Regex("""^(\w+)\s*:""").find(trimmed)?.let { keys += it.groupValues[1] }
            }
            level += line.count { it in "{[(" } - line.count { it in "}])" }
        }
        return keys
    }

    @Test
    fun `the request and the answer carry the layer fields`() {
        val request = source.substringAfter("createStorySchema").substringBefore("superRefine")
        listOf("layers", "altText").forEach { key ->
            assertTrue("createStorySchema has no $key", Regex("""\b$key\s*:""").containsMatchIn(request))
            assertTrue(CreateStoryRequest.serializer().descriptor.elementNames.contains(key))
        }
        // `storyLayerUploadSchema` is the base upload plus the layer it is for.
        val have = StoryLayerUploadSlot.serializer().descriptor.elementNames.toSet()
        val known = RepoSources.objectKeys(shared, "storyUploadSchema").toSet() + "layerId"
        assertTrue("slot names a field the schema lacks: ${have - known}", (have - known).isEmpty())
        assertTrue(source.substringAfter("storyLayerUploadSchema").substringBefore(";").contains("layerId"))
        assertTrue(RepoSources.objectKeys(shared, "createStoryResponseSchema").contains("layerUploads"))
        assertTrue(CreateStoryResponse.serializer().descriptor.elementNames.contains("layerUploads"))
        assertTrue(StoriesConfig.serializer().descriptor.elementNames.contains("layersMax"))
        assertTrue(RepoSources.objectKeys(shared, "storiesConfigSchema").contains("layersMax"))
    }

    // --- the wire ---

    private fun JsonObject.str(key: String) = this[key]?.jsonPrimitive?.contentOrNull
    private fun JsonObject.num(key: String) = this[key]?.jsonPrimitive?.content?.toDouble()

    @Test
    fun `a text layer goes out with every field the schema names, trimmed, rounded and in range`() {
        val layer = TextLayer("t1", x = 0.123456f, y = 0.9f, scale = 1.5f, rotation = 0.5f, text = "  bora  ", font = "neon", color = "lime", background = "soft", align = "left", size = 1.25f)
        val json = EditorPost.layersJson(listOf(layer), emptyMap()).single()
        assertEquals("text", json.str("type"))
        assertEquals("bora", json.str("text"))
        assertEquals(0.1235, json.num("x")!!, 1e-9)
        assertEquals("neon", json.str("font"))
        assertEquals("lime", json.str("color"))
        assertEquals("soft", json.str("background"))
        assertEquals("left", json.str("align"))
        assertEquals(1.25, json.num("size")!!, 1e-9)
        // Every key is one the schema has for a text layer.
        assertEquals(fieldKeys("textLayerFields"), json.keys)
    }

    @Test
    fun `an empty text layer is never sent`() {
        assertTrue(EditorPost.layersJson(listOf(TextLayer("t", text = "   ")), emptyMap()).isEmpty())
    }

    @Test
    fun `a photo declares the size of the file it will upload, and one with no file is left out`() {
        val photo = PhotoLayer("p1", shape = "circle", source = "content://x", width = 900, height = 1200)
        val file = LayerFile("p1", "image/jpeg", ByteArray(4321), 900, 1200)
        val json = EditorPost.layersJson(listOf(photo), mapOf("p1" to file)).single()
        assertEquals("image", json.str("type"))
        assertEquals("circle", json.str("shape"))
        val upload = json["upload"]!!.jsonObject
        assertEquals("image/jpeg", upload.str("contentType"))
        assertEquals(4321.0, upload.num("byteSize")!!, 0.0)
        assertEquals(900.0, upload.num("width")!!, 0.0)
        assertTrue(EditorPost.layersJson(listOf(photo), emptyMap()).isEmpty())
    }

    @Test
    fun `the drawing is centred, unscaled and unturned whatever else says`() {
        val ink = InkLayer("d1", listOf(Stroke("pen", "red", 0.01f, listOf(0.1f, 0.1f, 0.2f, 0.2f))))
        val json = EditorPost.layersJson(listOf(ink), mapOf("d1" to LayerFile("d1", "image/png", ByteArray(10), 810, 1440))).single()
        assertEquals("drawing", json.str("type"))
        assertEquals(0.5, json.num("x")!!, 0.0)
        assertEquals(0.5, json.num("y")!!, 0.0)
        assertEquals(1.0, json.num("scale")!!, 0.0)
        assertEquals(0.0, json.num("rotation")!!, 0.0)
        assertEquals("image/png", json["upload"]!!.jsonObject.str("contentType"))
    }

    @Test
    fun `a call and a mention carry only what the server checks`() {
        val call = CallLayer("c1", serverId = "srv", channelId = "ch", roomName = "Lobby", serverName = "Sandbox")
        val mention = MentionLayer("m1", userId = "u1", name = "Bia")
        val (callJson, mentionJson) = EditorPost.layersJson(listOf(call, mention), emptyMap())
        assertEquals("srv", callJson.str("serverId"))
        assertEquals("ch", callJson.str("channelId"))
        assertNull(callJson["roomName"])
        assertEquals("u1", mentionJson.str("userId"))
        assertNull(mentionJson["name"])
    }

    @Test
    fun `slots are paired with the files by layer id, all or nothing`() {
        val a = LayerFile("a", "image/jpeg", ByteArray(1), 1, 1)
        val b = LayerFile("b", "image/png", ByteArray(2), 1, 1)
        val slots = listOf(StoryLayerUploadSlot("b", "u-b"), StoryLayerUploadSlot("a", "u-a"))
        val pairs = EditorPost.pair(slots, mapOf("a" to a, "b" to b))!!
        assertEquals(listOf("b", "a"), pairs.map { it.second.layerId })
        assertNull(EditorPost.pair(slots.take(1), mapOf("a" to a, "b" to b)))
        assertNull(EditorPost.pair(listOf(StoryLayerUploadSlot("x", "u")), mapOf("a" to a)))
    }

    @Test
    fun `a story is published only when something was uploaded`() {
        assertFalse(EditorPost.needsPublish(false, emptyList()))
        assertTrue(EditorPost.needsPublish(true, emptyList()))
        assertTrue(EditorPost.needsPublish(false, listOf(StoryLayerUploadSlot("a", "u"))))
        assertEquals("text", EditorPost.kind(null, hasMedia = false))
        assertEquals("video", EditorPost.kind(true, hasMedia = true))
        assertEquals("image", EditorPost.kind(false, hasMedia = true))
    }

    @Test
    fun `the alt text reads the text layers in order and stays inside its bound`() {
        assertNull(StoryLayers.altText(emptyList()))
        assertNull(StoryLayers.altText(listOf("  ", "")))
        assertEquals("bora. hoje as 22h", StoryLayers.altText(listOf("bora", " ", "hoje as 22h")))
        val long = StoryLayers.altText(listOf("x".repeat(600)))!!
        assertTrue(long.length <= StoryLayers.ALT_TEXT_MAX)
        val layers = listOf(TextLayer("a", text = "um"), PhotoLayer("p", source = "s", width = 1, height = 1), TextLayer("b", text = "dois"))
        assertEquals("um. dois", LayerOps.spokenText(layers))
    }

    // --- geometry ---

    private val canvas = Canvas(360f, 640f)

    @Test
    fun `rotation wraps into minus pi to pi and the server's bound holds`() {
        assertEquals(0f, LayerMath.normalizeRotation(0f), 1e-6f)
        assertEquals((3.5 - 2 * PI).toFloat(), LayerMath.normalizeRotation(3.5f), 1e-5f)
        assertEquals((-3.5 + 2 * PI).toFloat(), LayerMath.normalizeRotation(-3.5f), 1e-5f)
        assertEquals(0.1f, LayerMath.normalizeRotation((10 * PI + 0.1).toFloat()), 1e-4f)
        listOf(-20f, -7f, -3.2f, 0f, 3.2f, 7f, 20f).forEach {
            assertTrue(kotlin.math.abs(LayerMath.normalizeRotation(it)) <= StoryLayers.ROTATION_MAX)
        }
    }

    @Test
    fun `scale stays inside what the server takes`() {
        assertEquals(StoryLayers.SCALE_MIN, LayerMath.clampScale(0.01f), 0f)
        assertEquals(StoryLayers.SCALE_MAX, LayerMath.clampScale(40f), 0f)
        assertEquals(1.7f, LayerMath.clampScale(1.7f), 0f)
    }

    @Test
    fun `a gesture pans in canvas fractions, zooms by a factor and turns clockwise`() {
        val from = Placement(0.5f, 0.5f, 1f, 0f)
        val moved = LayerMath.applyGesture(from, Pt(36f, -64f), 2f, 0.5f, canvas)
        assertEquals(0.6f, moved.x, 1e-5f)
        assertEquals(0.4f, moved.y, 1e-5f)
        assertEquals(2f, moved.scale, 1e-5f)
        assertEquals(0.5f, moved.rotation, 1e-5f)
        // Dragged way off the edge: the centre stays on the canvas, the layer can still be grabbed.
        val off = LayerMath.applyGesture(from, Pt(9_999f, -9_999f), 1f, 0f, canvas)
        assertEquals(1f, off.x, 0f)
        assertEquals(0f, off.y, 0f)
        // Pinched past the limits.
        assertEquals(StoryLayers.SCALE_MAX, LayerMath.applyGesture(from, Pt(0f, 0f), 100f, 0f, canvas).scale, 0f)
    }

    @Test
    fun `a snap pulls to the middle and lets go once the finger has moved on`() {
        val near = LayerMath.snapToCenter(0.51f, 0.02f)
        assertTrue(near.snapped)
        assertEquals(0.5f, near.value, 0f)
        val far = LayerMath.snapToCenter(0.53f, 0.02f)
        assertFalse(far.snapped)
        assertEquals(0.53f, far.value, 0f)
        assertTrue(LayerMath.snapToCenter(0.482f, 0.02f).snapped)
    }

    @Test
    fun `a rotation snaps to the nearest quarter turn`() {
        val quarter = (PI / 2).toFloat()
        assertTrue(LayerMath.snapRotation(0.03f, 0.07f).snapped)
        assertEquals(0f, LayerMath.snapRotation(0.03f, 0.07f).value, 1e-6f)
        assertEquals(quarter, LayerMath.snapRotation(quarter + 0.04f, 0.07f).value, 1e-5f)
        assertEquals(-quarter, LayerMath.snapRotation(-quarter - 0.04f, 0.07f).value, 1e-5f)
        // Half a turn is the same place from either side.
        assertTrue(kotlin.math.abs(LayerMath.snapRotation(PI.toFloat() - 0.03f, 0.07f).value) >= 3.14f)
        assertFalse(LayerMath.snapRotation(0.5f, 0.07f).snapped)
    }

    @Test
    fun `a touch hits the layer's own rectangle, turned with it, and slop makes a small one grabbable`() {
        val center = Pt(180f, 320f)
        val wide = Size(200f, 40f)
        // Unturned: wide, not tall.
        assertTrue(LayerMath.hit(Pt(270f, 320f), center, wide, 1f, 0f, 0f))
        assertFalse(LayerMath.hit(Pt(180f, 360f), center, wide, 1f, 0f, 0f))
        // Turned a quarter: now it is tall, not wide.
        val quarter = (PI / 2).toFloat()
        assertTrue(LayerMath.hit(Pt(180f, 410f), center, wide, 1f, quarter, 0f))
        assertFalse(LayerMath.hit(Pt(270f, 320f), center, wide, 1f, quarter, 0f))
        // Scaled: twice as big is twice as hittable.
        assertTrue(LayerMath.hit(Pt(180f, 350f), center, wide, 2f, 0f, 0f))
        // Slop.
        assertFalse(LayerMath.hit(Pt(180f, 345f), center, wide, 1f, 0f, 0f))
        assertTrue(LayerMath.hit(Pt(180f, 345f), center, wide, 1f, 0f, 12f))
    }

    @Test
    fun `the topmost layer under a touch wins, and ink is never grabbed`() {
        val below = TextLayer("below", text = "a")
        val above = TextLayer("above", text = "b")
        val ink = InkLayer("ink", listOf(Stroke("pen", "red", 0.01f, listOf(0f, 0f, 1f, 1f))))
        val sizes = mapOf("below" to Size(100f, 40f), "above" to Size(100f, 40f), "ink" to Size(360f, 640f))
        val at = Pt(180f, 320f)
        assertEquals("above", LayerMath.topHit(listOf(ink, below, above), sizes, canvas, at, 0f)!!.id)
        assertEquals("below", LayerMath.topHit(listOf(ink, above.copy(x = 0.1f), below), sizes, canvas, at, 0f)!!.id)
        assertNull(LayerMath.topHit(listOf(ink), sizes, canvas, at, 0f))
        // A layer that has not been measured yet cannot be hit.
        assertNull(LayerMath.topHit(listOf(below), emptyMap(), canvas, at, 0f))
    }

    @Test
    fun `the trash takes a finger inside its circle`() {
        val trash = Pt(180f, 600f)
        assertTrue(LayerMath.inTrash(Pt(180f, 600f), trash, 36f))
        assertTrue(LayerMath.inTrash(Pt(200f, 620f), trash, 36f))
        assertFalse(LayerMath.inTrash(Pt(180f, 500f), trash, 36f))
    }

    @Test
    fun `layers have a natural size tied to the canvas width`() {
        assertEquals(0.08f * 360f, LayerMath.textSizePx(1f, 360f), 1e-4f)
        assertEquals(2f * 0.08f * 360f, LayerMath.textSizePx(2f, 360f), 1e-4f)
        val size = LayerMath.photoSize(1000, 500, 360f)
        assertEquals(144f, size.width, 1e-3f)
        assertEquals(72f, size.height, 1e-3f)
        // A photo with no size yet is square rather than flat.
        assertEquals(144f, LayerMath.photoSize(0, 0, 360f).height, 1e-3f)
    }

    @Test
    fun `the layout numbers are the canonical ones every platform draws with`() {
        assertEquals(0.08f, StoryLayers.TEXT_BASE, 0f)
        assertEquals(1.14f, StoryLayers.TEXT_LINE_HEIGHT, 0f)
        assertEquals(0.84f, StoryLayers.TEXT_WRAP_WIDTH, 0f)
        assertEquals(0.40f, StoryLayers.IMAGE_BASE_WIDTH, 0f)
        assertEquals(0.05f, StoryLayers.MENTION_FONT, 0f)
    }

    @Test
    fun `new layers fan out so the second is not hidden behind the first`() {
        assertEquals(Pt(0.5f, 0.5f), LayerMath.startPosition(0))
        assertEquals(0.525f, LayerMath.startPosition(1).x, 1e-6f)
        assertEquals(0.5f, LayerMath.startPosition(5).x, 1e-6f)
    }

    // --- the layer list ---

    private fun text(id: String, text: String = "x") = TextLayer(id, text = text)
    private fun photo(id: String) = PhotoLayer(id, source = "s", width = 10, height = 10)
    private fun mention(id: String, user: String) = MentionLayer(id, userId = user, name = user)
    private fun call(id: String, channel: String) = CallLayer(id, serverId = "srv", channelId = channel, roomName = channel)

    @Test
    fun `a story holds 20 layers, 6 photos, 5 mentions each once, one call and one drawing`() {
        val twenty: List<EditorLayer> = List(20) { text("t$it") }
        assertEquals(LayerOps.Refusal.TooMany, LayerOps.canAdd(twenty, text("one more")))

        val sixPhotos = List(6) { photo("p$it") }
        assertEquals(LayerOps.Refusal.TooManyPhotos, LayerOps.canAdd(sixPhotos, photo("p7")))
        assertNull(LayerOps.canAdd(sixPhotos.take(5), photo("p7")))

        val fiveMentions = List(5) { mention("m$it", "u$it") }
        assertEquals(LayerOps.Refusal.TooManyMentions, LayerOps.canAdd(fiveMentions, mention("m6", "u6")))
        assertEquals(LayerOps.Refusal.MentionedAlready, LayerOps.canAdd(fiveMentions.take(2), mention("m9", "u1")))

        // At 20 layers, a call or the ink already there can still be replaced.
        val full = List<EditorLayer>(18) { text("t$it") } + call("c1", "a") + InkLayer("ink")
        assertNull(LayerOps.canAdd(full, call("c2", "b")))
        assertNull(LayerOps.canAdd(full, InkLayer("ink2")))
    }

    @Test
    fun `a second call replaces the first, and the ink goes under everything`() {
        val withCall = LayerOps.add(listOf(text("a"), call("c1", "x"), text("b")), call("c2", "y"))
        assertEquals(listOf("a", "b", "c2"), withCall.map { it.id })
        val inked = LayerOps.add(listOf(text("a"), photo("p")), InkLayer("ink"))
        assertEquals(listOf("ink", "a", "p"), inked.map { it.id })
        // Bringing the ink forward does nothing: it stays under.
        assertEquals(inked, LayerOps.bringToFront(inked, "ink"))
        assertEquals(listOf("ink", "p", "a"), LayerOps.bringToFront(inked, "a").map { it.id })
    }

    @Test
    fun `strokes accumulate on one ink layer`() {
        var n = 0
        val stroke = Stroke("pen", "red", 0.01f, listOf(0f, 0f, 1f, 1f))
        val one = LayerOps.withStroke(listOf(text("a")), { "ink${n++}" }, stroke)
        val two = LayerOps.withStroke(one, { "ink${n++}" }, stroke.copy(color = "blue"))
        val ink = two.filterIsInstance<InkLayer>().single()
        assertEquals(2, ink.strokes.size)
        assertEquals(1, n)
    }

    @Test
    fun `a text card needs a word or a mark, a sticker is enough`() {
        assertFalse(LayerOps.hasContent(emptyList()))
        assertFalse(LayerOps.hasContent(listOf(text("a", "   "))))
        assertTrue(LayerOps.hasContent(listOf(text("a", "oi"))))
        assertTrue(LayerOps.hasContent(listOf(call("c", "x"))))
        assertTrue(LayerOps.hasContent(listOf(InkLayer("i", listOf(Stroke("pen", "red", 0.01f, listOf(0f, 0f)))))))
        // Only the eraser: nothing visible.
        assertFalse(LayerOps.hasContent(listOf(InkLayer("i", listOf(Stroke("eraser", "red", 0.01f, listOf(0f, 0f)))))))
    }

    @Test
    fun `undo keeps the last 20 actions and runs out cleanly`() {
        val stack = UndoStack<Int>(max = 3)
        assertTrue(stack.isEmpty)
        assertNull(stack.pop())
        (1..5).forEach(stack::push)
        assertEquals(3, stack.size)
        assertEquals(5, stack.pop())
        assertEquals(4, stack.pop())
        assertEquals(3, stack.pop())
        assertNull(stack.pop())
    }

    @Test
    fun `brush sizes grow with the slider and the highlighter lets the picture through`() {
        Brushes.ALL.forEach { brush ->
            assertTrue(Brushes.widthFor(brush, 0f) < Brushes.widthFor(brush, 1f))
            assertEquals(Brushes.widthFor(brush, 0f), Brushes.widthFor(brush, -3f), 0f)
            assertEquals(Brushes.widthFor(brush, 1f), Brushes.widthFor(brush, 9f), 0f)
        }
        assertTrue(Brushes.alpha(Brushes.HIGHLIGHTER) < 1f)
        assertEquals(1f, Brushes.alpha(Brushes.PEN), 0f)
        assertTrue(Brushes.widthFor(Brushes.HIGHLIGHTER, 0.5f) > Brushes.widthFor(Brushes.PEN, 0.5f))
    }

    @Test
    fun `placing a layer changes only where it is`() {
        val layer = TextLayer("t", text = "oi", font = "neon", color = "pink")
        val placed = layer.placed(0.2f, 0.3f, 2f, 1f) as TextLayer
        assertEquals("neon", placed.font)
        assertEquals("pink", placed.color)
        assertEquals(0.2f, placed.x, 0f)
        assertEquals(2f, placed.scale, 0f)
        // The ink cannot be moved.
        val ink = InkLayer("i")
        assertEquals(ink, ink.placed(0.1f, 0.1f, 3f, 1f))
        assertNotNull(JsonPrimitive("kept"))
    }

    // --- the base and the audience ---

    @Test
    fun `a picture near 9_16 fills the canvas, any other shape is shown whole`() {
        assertTrue(BaseFit.fills(1080, 1920))
        assertTrue(BaseFit.fills(810, 1440))
        // A 3:4 portrait from the camera app: 12% off 9:16 is the edge.
        assertFalse(BaseFit.fills(3000, 4000))
        assertFalse(BaseFit.fills(1920, 1080))
        assertFalse(BaseFit.fills(1000, 1000))
        // 9:20, a tall phone screenshot, is 20% off 9:16: shown whole.
        assertFalse(BaseFit.fills(1080, 2400))
        // Unknown size: fill, the safe default.
        assertTrue(BaseFit.fills(0, 0))
    }

    private val options = StoryAudienceOptions(
        servers = listOf(
            StoryAudienceServer("s1", "QG do pqp", canPost = true),
            StoryAudienceServer("s2", "Sandbox", canPost = true),
        ),
        friends = StoryAudienceFriends(enabled = true, canPost = true),
    )

    @Test
    fun `the audience reads as names, and a server that is gone is not named`() {
        val both = StoriesRules.audienceParts(options, StoryAudienceTargets(serverIds = listOf("s1", "s2"), friends = true))
        assertEquals(listOf("QG do pqp", "Sandbox"), both.serverNames)
        assertTrue(both.friends)
        val gone = StoriesRules.audienceParts(options, StoryAudienceTargets(serverIds = listOf("s1", "left")))
        assertEquals(listOf("QG do pqp"), gone.serverNames)
        assertFalse(gone.friends)
        val none = StoriesRules.audienceParts(null, StoryAudienceTargets())
        assertTrue(none.serverNames.isEmpty())
    }

    @Test
    fun `text paints by background mode, and a solid chip always has readable ink`() {
        val plain = textPaint("lime", "none", "classic")
        assertEquals(tokenColor("lime"), plain.text)
        assertNull(plain.box)
        // Solid: the chip is the color, the words are dark on a light chip and white on a dark one.
        val onYellow = textPaint("yellow", "solid", "classic")
        assertEquals(tokenColor("yellow"), onYellow.box)
        assertEquals(androidx.compose.ui.graphics.Color.Black, onYellow.text)
        val onBlue = textPaint("blue", "solid", "classic")
        assertEquals(androidx.compose.ui.graphics.Color.White, onBlue.text)
        // Soft: a dark veil, the words keep their color.
        val soft = textPaint("pink", "soft", "classic")
        assertEquals(tokenColor("pink"), soft.text)
        assertNotNull(soft.box)
        assertTrue(soft.box!!.alpha < 1f)
        // Neon glows in its own color, with whiter letters.
        val neon = textPaint("cyan", "none", "neon")
        assertEquals(tokenColor("cyan"), neon.glow)
        assertTrue(neon.text.red >= tokenColor("cyan").red)
    }

    @Test
    fun `the five fonts are all distinct faces`() {
        val faces = StoryLayers.FONTS.map { storyFont(it) }
        assertEquals(StoryLayers.FONTS.size, faces.toSet().size)
    }

    @Test
    fun `a stroke in progress publishes a view, not a copy, and a view never changes`() {
        val points = PointsBuilder(initial = 2)
        points.add(0.1f, 0.2f)
        val first = points.view()
        // Growing past the first array does not touch what the first view saw.
        points.add(0.3f, 0.4f)
        points.add(0.5f, 0.6f)
        assertEquals(listOf(0.1f, 0.2f), first)
        assertEquals(listOf(0.1f, 0.2f, 0.3f, 0.4f, 0.5f, 0.6f), points.view())
        assertEquals(0.5f, points[4], 0f)
        var failed = false
        try {
            first[2]
        } catch (_: IndexOutOfBoundsException) {
            failed = true
        }
        assertTrue("a view cannot read past its own size", failed)
        // The renderer reads these like any list.
        assertEquals(Stroke("pen", "red", 0.01f, points.view()), Stroke("pen", "red", 0.01f, listOf(0.1f, 0.2f, 0.3f, 0.4f, 0.5f, 0.6f)))
    }
}
