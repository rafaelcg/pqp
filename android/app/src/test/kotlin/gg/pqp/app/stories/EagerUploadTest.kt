package gg.pqp.app.stories

import gg.pqp.app.core.PqpJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Fitting eager uploads into a create request: which files get an `uploadId`,
 * when the one-call `publish` is allowed, and what a refused create means. The
 * wire shape is the server's contract (`createStorySchema` in
 * `packages/shared/src/stories.ts`: `media.uploadId`, `upload.uploadId`,
 * `publish`).
 */
class EagerUploadTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val photoLayer = StoryLayers.imageJson(
        "l1", 0.5f, 0.5f, 1f, 0f, "rounded",
        StoryLayers.uploadJson("image/jpeg", 100, 10, 20),
    )
    private val drawingLayer = StoryLayers.drawingJson("d1", StoryLayers.uploadJson("image/png", 50, 30, 40))
    private val textLayer = StoryLayers.textJson("t1", 0.5f, 0.5f, 1f, 0f, "hi", "classic", "white", "none", "center", 1f)

    private fun request(vararg layers: JsonObject) = CreateStoryRequest(
        kind = "image",
        audiences = StoryAudienceTargets(serverIds = listOf("s")),
        media = StoryMediaInput("image/jpeg", 1000, 810, 1440),
        layers = layers.toList(),
    )

    private val files = listOf(
        DraftFile(DraftFile.BASE, "image/jpeg", 1000, "base"),
        DraftFile("l1", "image/jpeg", 100, "layer-l1"),
        DraftFile("d1", "image/png", 50, "layer-d1"),
    )

    private fun uploadOf(layer: JsonObject) = layer["upload"] as JsonObject

    @Test
    fun `no eager uploads leaves the request exactly as it was`() {
        val base = request(photoLayer)
        assertEquals(base, EagerRequest.apply(base, files, emptyMap()))
    }

    @Test
    fun `every file eager names each one and asks for one call`() {
        val out = EagerRequest.apply(
            request(photoLayer, textLayer, drawingLayer),
            files,
            mapOf(DraftFile.BASE to "u-base", "l1" to "u-l1", "d1" to "u-d1"),
        )
        assertEquals("u-base", out.media?.uploadId)
        assertEquals(JsonPrimitive("u-l1"), uploadOf(out.layers[0])["uploadId"])
        // The words are not a file: untouched.
        assertEquals(textLayer, out.layers[1])
        assertEquals(JsonPrimitive("u-d1"), uploadOf(out.layers[2])["uploadId"])
        assertEquals(true, out.publish)
    }

    @Test
    fun `a mix keeps the old way for the file that is not eager and never asks for one call`() {
        val out = EagerRequest.apply(request(photoLayer, drawingLayer), files, mapOf(DraftFile.BASE to "u-base", "d1" to "u-d1"))
        assertEquals("u-base", out.media?.uploadId)
        assertNull(uploadOf(out.layers[0])["uploadId"])
        assertEquals(JsonPrimitive("u-d1"), uploadOf(out.layers[1])["uploadId"])
        assertNull(out.publish)
    }

    @Test
    fun `the declared type and size are not touched, the server checks them against the upload`() {
        val out = EagerRequest.apply(request(photoLayer), files.take(2), mapOf(DraftFile.BASE to "b", "l1" to "l"))
        assertEquals("image/jpeg", out.media?.contentType)
        assertEquals(1000L, out.media?.byteSize)
        assertEquals(JsonPrimitive(100), uploadOf(out.layers[0])["byteSize"])
    }

    @Test
    fun `a card of only words has no files and goes the old way`() {
        assertFalse(EagerRequest.allEager(emptyList(), mapOf("x" to "y")))
        assertFalse(EagerRequest.allEager(emptyList(), emptyMap()))
    }

    @Test
    fun `the wire names are the contract's`() {
        val out = EagerRequest.apply(request(photoLayer), files.take(2), mapOf(DraftFile.BASE to "b", "l1" to "l"))
        val json = PqpJson.encodeToString(CreateStoryRequest.serializer(), out)
        assertTrue(json, json.contains("\"uploadId\":\"b\""))
        assertTrue(json, json.contains("\"uploadId\":\"l\""))
        assertTrue(json, json.contains("\"publish\":true"))
        // An old create carries neither.
        val old = PqpJson.encodeToString(CreateStoryRequest.serializer(), request(photoLayer))
        assertFalse(old, old.contains("uploadId"))
        assertFalse(old, old.contains("publish"))
    }

    @Test
    fun `what a refused create means`() {
        assertTrue(EagerRequest.notYet(409))
        assertTrue(EagerRequest.unusable(404))
        assertTrue(EagerRequest.unusable(400))
        assertFalse(EagerRequest.notYet(500))
        assertFalse(EagerRequest.unusable(429))
        assertFalse(EagerRequest.unusable(409))
    }

    @Test
    fun `the upload request and answer have the contract's names`() {
        val ask = PqpJson.encodeToString(CreateStoryUploadRequest.serializer(), CreateStoryUploadRequest("base", "video/mp4", 123))
        assertEquals("""{"kind":"base","contentType":"video/mp4","byteLength":123}""", ask)
        val answer = PqpJson.decodeFromString(
            CreateStoryUploadResponse.serializer(),
            """{"uploadId":"u","url":"https://s/x","method":"PUT","headers":{"Content-Type":"image/jpeg"},"expiresAt":"2026-10-14T15:00:00.000Z","extra":1}""",
        )
        assertEquals("u", answer.uploadId)
        assertEquals("https://s/x", answer.asUpload().url)
        assertEquals(mapOf("Content-Type" to "image/jpeg"), answer.asUpload().headers)
    }

    @Test
    fun `saved upload ids survive on the draft and can be replaced`() {
        val store = StoryDraftStore(folder.newFolder("outbox"))
        val draft = StoryDraft("d", "me", request(photoLayer), files.take(2), createdAt = 1L)
        store.write(draft, mapOf("base" to byteArrayOf(1), "layer-l1" to byteArrayOf(2)))
        assertTrue(store.list().single().uploadIds.isEmpty())
        store.rewrite(draft.copy(uploadIds = mapOf(DraftFile.BASE to "u1")))
        assertEquals(mapOf(DraftFile.BASE to "u1"), store.list().single().uploadIds)
        // The files stayed.
        assertEquals(1, store.file("d", "base").readBytes().size)
        store.rewrite(draft.copy(uploadIds = emptyMap()))
        assertTrue(store.list().single().uploadIds.isEmpty())
    }
}
