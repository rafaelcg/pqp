package gg.pqp.app.stories

import gg.pqp.app.core.PqpJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Which pictures a story is held back for, and preloaded for: all of them, so it appears as one finished picture. */
class StoryAssetsTest {

    private fun story(json: String): Story = PqpJson.decodeFromString(Story.serializer(), json)

    private val author = """"author":{"id":"a","displayName":"Bia","avatarUrl":"https://cdn/face.png"}"""

    private fun urls(story: Story) = StoryAssets.of(story, emptyList()).map { it.url }

    @Test
    fun `a photo with layers waits for its base, each layer picture, the drawing and the author's face`() {
        val s = story(
            """{"id":"s1",$author,"kind":"image","media":{"url":"https://cdn/base.jpg","contentType":"image/jpeg","width":810,"height":1440},
            "layers":[
              {"id":"l1","type":"image","x":0.5,"y":0.5,"scale":1,"rotation":0,"shape":"rounded","url":"https://cdn/l1.jpg","width":100,"height":100},
              {"id":"d1","type":"drawing","x":0.5,"y":0.5,"scale":1,"rotation":0,"url":"https://cdn/d1.png","width":10,"height":10},
              {"id":"t1","type":"text","x":0.5,"y":0.5,"scale":2,"rotation":0,"text":"hi","font":"classic","color":"white","background":"none","align":"center","size":1}
            ]}""",
        )
        assertEquals(listOf("https://cdn/face.png", "https://cdn/base.jpg", "https://cdn/l1.jpg", "https://cdn/d1.png"), urls(s))
    }

    @Test
    fun `base and layers are held under the keys the preloader fills`() {
        val s = story(
            """{"id":"s1",$author,"kind":"image","media":{"url":"https://cdn/base.jpg","contentType":"image/jpeg","width":1,"height":1},
            "layers":[{"id":"l1","type":"image","x":0.5,"y":0.5,"scale":1,"rotation":0,"shape":"rounded","url":"https://cdn/l1.jpg","width":1,"height":1}]}""",
        )
        val keys = StoryAssets.of(s, emptyList()).map { it.key }
        assertEquals(listOf(null, StoryPreloadRules.baseKey("s1"), StoryPreloadRules.layerKey("s1", "l1")), keys)
    }

    @Test
    fun `a clip waits for its poster, not for itself`() {
        val s = story(
            """{"id":"v1",$author,"kind":"video","media":{"url":"https://cdn/v.mp4","posterUrl":"https://cdn/poster.jpg","contentType":"video/mp4","width":720,"height":1280}}""",
        )
        assertEquals(listOf("https://cdn/face.png", "https://cdn/poster.jpg"), urls(s))
    }

    @Test
    fun `a card of words waits for nothing but the face`() {
        val s = story("""{"id":"t1",$author,"kind":"text","text":"hello","background":"night"}""")
        assertEquals(listOf("https://cdn/face.png"), urls(s))
    }

    @Test
    fun `a story of mine still processing has no picture to wait for`() {
        val s = story(
            """{"id":"p1",$author,"kind":"image","media":{"url":"https://cdn/base.jpg","contentType":"image/jpeg","width":1,"height":1},"own":{"status":"processing"}}""",
        )
        assertEquals(listOf("https://cdn/face.png"), urls(s))
    }

    @Test
    fun `the same picture is only fetched once`() {
        val s = story(
            """{"id":"s1",$author,"kind":"image","media":{"url":"https://cdn/same.jpg","contentType":"image/jpeg","width":1,"height":1},
            "layers":[{"id":"l1","type":"image","x":0.5,"y":0.5,"scale":1,"rotation":0,"shape":"rounded","url":"https://cdn/same.jpg","width":1,"height":1}]}""",
        )
        assertTrue(urls(s).count { it == "https://cdn/same.jpg" } == 1)
    }

    @Test
    fun `the faces on a live call card and the server's icon are waited for too`() {
        val s = story(
            """{"id":"c1",$author,"kind":"text","background":"night",
            "layers":[{"id":"c","type":"call","x":0.5,"y":0.5,"scale":1,"rotation":0,"serverId":"srv","channelId":"ch"}],
            "call":{"serverId":"srv","channelId":"ch","channelName":"Lobby","state":"live","count":2,"joinable":true,
              "participants":[{"id":"p1","displayName":"A","avatarUrl":"https://cdn/p1.png"},{"id":"p2","displayName":"B"}]}}""",
        )
        val servers = listOf(gg.pqp.app.core.ServerSummary(id = "srv", name = "QG", ownerId = "o", createdAt = "", iconUrl = "https://cdn/icon.png"))
        assertEquals(
            listOf("https://cdn/face.png", "https://cdn/p1.png", "https://cdn/icon.png"),
            StoryAssets.of(s, servers).map { it.url },
        )
    }
}
