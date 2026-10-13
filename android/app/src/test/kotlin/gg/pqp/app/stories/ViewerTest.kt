package gg.pqp.app.stories

import gg.pqp.app.core.PqpJson
import gg.pqp.app.protocol.RepoSources
import gg.pqp.app.stories.editor.CallCardState
import gg.pqp.app.stories.editor.CallFaces
import gg.pqp.app.stories.editor.callCardState
import gg.pqp.app.stories.ui.visibleLayers
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The viewer's side of layers: reading them leniently (one bad layer never
 * costs the story), the call card's four states, what a story with no layers
 * still draws, and how long a story with words stays up.
 */
class ViewerTest {

    private val id = "11111111-1111-1111-1111-111111111111"

    private fun story(layers: String, extra: String = "", kind: String = "image"): Story = PqpJson.decodeFromString(
        Story.serializer(),
        """{"id":"s1","author":{"id":"a","displayName":"Bia"},"kind":"$kind","layers":$layers$extra}""",
    )

    private fun geometry(type: String, x: Double = 0.5, y: Double = 0.5) =
        """"id":"$id","type":"$type","x":$x,"y":$y,"scale":1,"rotation":0"""

    // --- reading ---

    @Test
    fun `every layer type reads, in order`() {
        val s = story(
            """[
              {${geometry("text")},"text":"bora","font":"neon","color":"lime","background":"soft","align":"left","size":1.5},
              {${geometry("image")},"shape":"circle","url":"/img.jpg","width":900,"height":1200},
              {${geometry("drawing")},"url":"/ink.png","width":810,"height":1440},
              {${geometry("call")},"serverId":"srv","channelId":"ch"},
              {${geometry("mention")},"userId":"u1","user":{"id":"u1","displayName":"Caio","handle":"caio"}}
            ]""",
        )
        assertEquals(listOf("text", "image", "drawing", "call", "mention"), s.layers.map { it::class.simpleName!!.removeSuffix("StoryLayer").lowercase() })
        val text = s.layers[0] as TextStoryLayer
        assertEquals("neon", text.font)
        assertEquals("soft", text.background)
        assertEquals(1.5f, text.size, 0f)
        assertEquals("circle", (s.layers[1] as ImageStoryLayer).shape)
        assertEquals(810, (s.layers[2] as DrawingStoryLayer).width)
        assertEquals("ch", (s.layers[3] as CallStoryLayer).channelId)
        assertEquals("Caio", (s.layers[4] as MentionStoryLayer).user!!.displayName)
    }

    @Test
    fun `a layer this build cannot read is dropped and the story survives`() {
        val s = story(
            """[
              {${geometry("text")},"text":"first"},
              {${geometry("sparkle")},"glitter":3},
              {"id":"x","type":"text"},
              {${geometry("text")},"text":"   "},
              {${geometry("image")},"url":"/img.jpg"},
              {${geometry("mention")},"userId":"u1"},
              "not even an object",
              42,
              {${geometry("text")},"text":"last"}
            ]""",
        )
        // The unknown type, the one with no geometry, the blank text, the photo with no size and the
        // non-objects are gone; the two words are there in order. The mention with no person is kept
        // off the page by the viewer, but it still parses (the server may drop the person on a block).
        val words = s.layers.filterIsInstance<TextStoryLayer>().map { it.text }
        assertEquals(listOf("first", "last"), words)
        assertEquals(null, s.layers.filterIsInstance<ImageStoryLayer>().firstOrNull())
        assertNull(s.layers.filterIsInstance<MentionStoryLayer>().single().user)
    }

    @Test
    fun `missing, null or malformed layers are an empty list, never a crash`() {
        assertTrue(PqpJson.decodeFromString(Story.serializer(), """{"id":"s","author":{"id":"a"},"kind":"image"}""").layers.isEmpty())
        assertTrue(PqpJson.decodeFromString(Story.serializer(), """{"id":"s","author":{"id":"a"},"kind":"image","layers":null}""").layers.isEmpty())
        assertTrue(PqpJson.decodeFromString(Story.serializer(), """{"id":"s","author":{"id":"a"},"kind":"image","layers":"nope"}""").layers.isEmpty())
        assertTrue(PqpJson.decodeFromString(Story.serializer(), """{"id":"s","author":{"id":"a"},"kind":"image","layers":{"a":1}}""").layers.isEmpty())
    }

    @Test
    fun `out of range numbers are pulled inside what the schema allows, and a bad enum gets its default`() {
        val layer = StoryLayerParser.parse(
            Json.parseToJsonElement(
                """{"id":"i","type":"text","x":4,"y":-2,"scale":99,"rotation":9,"text":"oi","font":"comic","color":"#ff00ff","background":"x","align":"x","size":50}""",
            ),
        ) as TextStoryLayer
        assertEquals(1f, layer.x, 0f)
        assertEquals(0f, layer.y, 0f)
        assertEquals(StoryLayers.SCALE_MAX, layer.scale, 0f)
        assertEquals(StoryLayers.ROTATION_MAX, layer.rotation, 0f)
        assertEquals("classic", layer.font)
        assertEquals("white", layer.color)
        assertEquals("none", layer.background)
        assertEquals("center", layer.align)
        assertEquals(StoryLayers.TEXT_SIZE_MAX, layer.size, 0f)
    }

    @Test
    fun `no more than the schema's layers are read`() {
        val many = (1..30).joinToString(",", "[", "]") { """{"id":"$it","type":"text","x":0.5,"y":0.5,"scale":1,"rotation":0,"text":"n$it"}""" }
        assertEquals(StoryLayers.MAX, story(many).layers.size)
    }

    @Test
    fun `parsing is a function of one element and reads the schema's own field names`() {
        val source = RepoSources.stripComments(RepoSources.read("packages/shared/src/stories.ts"))
        val read = source.substringAfter("export const storyLayerSchema").substringBefore("export type StoryLayer =")
        // The fields the viewer reads off a layer that the writer does not send.
        listOf("url", "user").forEach { assertTrue("storyLayerSchema has no $it", read.contains("$it:")) }
        assertNotNull(StoryLayerParser.parse(Json.parseToJsonElement("""{${geometry("call")},"serverId":"s","channelId":"c"}""")))
        assertNull(StoryLayerParser.parse(JsonArray(emptyList())))
        assertNull(StoryLayerParser.parse(JsonObject(emptyMap())))
    }

    // --- what is drawn ---

    @Test
    fun `a story from before layers keeps its call card where the sticker sat`() {
        val live = ""","call":{"serverId":"srv","channelId":"ch","channelName":"Lobby","count":2,"state":"live","joinable":true}"""
        val old = story("[]", live)
        val layers = visibleLayers(old)
        val call = layers.single() as CallStoryLayer
        assertEquals(0.5f, call.x, 0f)
        assertEquals(0.8f, call.y, 0f)
        assertEquals("ch", call.channelId)
        // A server that already sent the call layer is not given a second one.
        val withLayer = story("""[{${geometry("call")},"serverId":"srv","channelId":"ch"}]""", live)
        assertEquals(1, visibleLayers(withLayer).size)
        // No call, no card.
        assertTrue(visibleLayers(story("[]")).isEmpty())
    }

    // --- the call card ---

    @Test
    fun `the call card says one of four things`() {
        assertEquals(CallCardState.Live, callCardState("live", 3))
        assertEquals(CallCardState.Empty, callCardState("live", 0))
        assertEquals(CallCardState.Full, callCardState("full", 8))
        assertEquals(CallCardState.Ended, callCardState("ended", 0))
        // An ended call is ended however many are listed, and an unknown state reads as live or empty by head count.
        assertEquals(CallCardState.Ended, callCardState("ended", 4))
        assertEquals(CallCardState.Live, callCardState("???", 2))
        assertEquals(CallCardState.Empty, callCardState("???", 0))
    }

    @Test
    fun `three faces and a plus n for the rest`() {
        assertEquals(3, CallFaces.SHOWN)
        assertEquals(0, CallFaces.more(0))
        assertEquals(0, CallFaces.more(3))
        assertEquals(2, CallFaces.more(5))
    }

    // --- how long a story stays ---

    private fun clockStory(kind: String, text: String? = null, layers: String = "[]", call: Boolean = false, duration: Long? = null): Story {
        val media = if (kind == "text") "" else ""","media":{"url":"/m","width":1,"height":1${if (duration != null) ""","durationMs":$duration""" else ""}}"""
        val sticker = if (call) ""","sticker":{"type":"call","serverId":"s","channelId":"c"}""" else ""
        val body = if (text != null) ""","text":"$text"""" else ""
        return story(layers, media + sticker + body, kind)
    }

    private fun textLayer(text: String) = """{${geometry("text")},"text":"$text"}"""

    @Test
    fun `words on a photo keep it up long enough to read`() {
        // A bare photo: 5 s.
        assertEquals(5_000L, StoriesRules.displayMs(clockStory("image")))
        // A caption in a text layer: 5 s plus 50 ms a character.
        val caption = "x".repeat(40)
        assertEquals(7_000L, StoriesRules.displayMs(clockStory("image", layers = "[${textLayer(caption)}]")))
        // A lot of words: ten seconds at most.
        assertEquals(10_000L, StoriesRules.displayMs(clockStory("image", layers = "[${textLayer("y".repeat(280))}]")))
        // A card with words only in `text` (before layers) is the old rule.
        assertEquals(5_500L, StoriesRules.displayMs(clockStory("text", text = "1234567890")))
        // A call keeps 8 s, and more when there is more to read.
        assertEquals(8_000L, StoriesRules.displayMs(clockStory("text", text = "bora", call = true)))
        assertEquals(10_000L, StoriesRules.displayMs(clockStory("text", call = true, layers = "[${textLayer("z".repeat(200))}]")))
        // A clip is its own length.
        assertEquals(12_000L, StoriesRules.displayMs(clockStory("video", duration = 12_000)))
    }

    @Test
    fun `the words of a story are its text layers, or a card's own text`() {
        assertEquals("", StoriesRules.wordsOf(clockStory("image")))
        assertEquals("um\ndois", StoriesRules.wordsOf(clockStory("image", layers = "[${textLayer("um")},${textLayer("dois")}]")))
        assertEquals("velho", StoriesRules.wordsOf(clockStory("text", text = "velho")))
        // A photo's old `text` is not words on it, but its caption is (and it is what a screen reader hears).
        assertEquals("", StoriesRules.wordsOf(clockStory("image", text = "ignorado")))
        val captioned = story("[]", ""","caption":"${"c".repeat(60)}"""")
        assertEquals("c".repeat(60), StoriesRules.wordsOf(captioned))
        assertEquals(8_000L, StoriesRules.displayMs(captioned))
        // With text layers, the layers are the words and the caption is not added twice.
        val both = story("[${textLayer("so isso")}]", ""","caption":"${"c".repeat(60)}"""")
        assertEquals("so isso", StoriesRules.wordsOf(both))
    }

    @Test
    fun `a layer only asks for an address the API or storage could have given`() {
        fun image(url: String) = StoryLayerParser.parse(
            Json.parseToJsonElement("""{${geometry("image")},"url":"$url","width":10,"height":10}"""),
        )
        assertNotNull(image("/api/stories/x/layer.jpg"))
        assertNotNull(image("https://files.pqp.gg/stories/x.jpg?sig=1"))
        assertNotNull(image("http://localhost:59341/pqp-attachments/x.jpg"))
        listOf("file:///data/x.jpg", "content://media/1", "data:image/png;base64,AAAA", "//evil.example/x.png", "x.jpg", "javascript:1").forEach {
            assertNull("$it must not load", image(it))
        }
        // A drawing follows the same rule.
        assertNull(StoryLayerParser.parse(Json.parseToJsonElement("""{${geometry("drawing")},"url":"file:///x.png","width":10,"height":10}""")))
    }

    @Test
    fun `the call card is 82 percent of the canvas wide, as on every platform`() {
        assertEquals(0.82f, StoryLayers.CALL_CARD_WIDTH, 0f)
    }
}
