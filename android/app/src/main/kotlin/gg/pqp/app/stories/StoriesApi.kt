package gg.pqp.app.stories

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.PqpJson
import gg.pqp.app.social.getJson
import gg.pqp.app.social.postJson
import java.io.File
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer
import okio.BufferedSink
import okio.source

/**
 * Every story route the phone calls, as `ApiClient` extensions (the same
 * pattern as `SocialApi.kt`). All of them are behind the `stories` runtime
 * flag server side: a server strip answers `{enabled:false}` while it is off,
 * and the rest 404.
 */

private fun <T> encode(serializer: KSerializer<T>, value: T): String = PqpJson.encodeToString(serializer, value)

suspend fun ApiClient.storiesConfig(serverId: String? = null): StoriesConfig =
    getJson("/api/stories/config", serverId?.let { mapOf("serverId" to it) } ?: emptyMap())

suspend fun ApiClient.serverStoryStrip(serverId: String): StoryStrip = getJson("/api/servers/$serverId/stories")

suspend fun ApiClient.friendsStoryStrip(): StoryStrip = getJson("/api/stories/friends")

/** Up to 20 ids; the server silently drops what this viewer may not see. */
suspend fun ApiClient.stories(ids: List<String>): List<Story> =
    getJson<StoriesResponse>("/api/stories", mapOf("ids" to ids.take(20).joinToString(","))).stories

suspend fun ApiClient.storyAudiences(): StoryAudienceOptions = getJson("/api/stories/audiences")

suspend fun ApiClient.createStory(request: CreateStoryRequest): CreateStoryResponse =
    postJson("/api/stories", encode(CreateStoryRequest.serializer(), request))

/** Start a file before the story exists. 201 with the signed PUT and the `uploadId` the create will claim. */
suspend fun ApiClient.createStoryUpload(kind: String, contentType: String, byteLength: Long): CreateStoryUploadResponse =
    postJson(
        "/api/stories/uploads",
        encode(CreateStoryUploadRequest.serializer(), CreateStoryUploadRequest(kind, contentType, byteLength)),
    )

/** Throw one away: 204 (and 404 for an id that is not ours, which a caller ignores). */
suspend fun ApiClient.deleteStoryUpload(uploadId: String) = send("DELETE", "/api/stories/uploads/$uploadId", null)

suspend fun ApiClient.publishStory(storyId: String): Story =
    postJson<PublishStoryResponse>("/api/stories/$storyId/publish", "{}").story

suspend fun ApiClient.deleteStory(storyId: String) = send("DELETE", "/api/stories/$storyId", null)

/** Batched and idempotent; the author never counts as their own viewer. */
suspend fun ApiClient.markStoriesViewed(ids: List<String>) {
    send("POST", "/api/stories/views", encode(StoryViewsBatch.serializer(), StoryViewsBatch(ids.take(50))))
}

/** One reaction per viewer per story; null clears it. Never a message. */
suspend fun ApiClient.reactToStory(storyId: String, reaction: String?) {
    send("PUT", "/api/stories/$storyId/reaction", encode(StoryReactionRequest.serializer(), StoryReactionRequest(reaction)))
}

/** A text reply lands in the 1:1 conversation with the author, quoting the story. */
suspend fun ApiClient.replyToStory(storyId: String, text: String, nonce: String? = null): StoryReplyResponse =
    postJson("/api/stories/$storyId/reply", encode(StoryReplyRequest.serializer(), StoryReplyRequest(text, nonce)))

suspend fun ApiClient.storyViewers(storyId: String, cursor: String? = null): StoryViewersPage =
    getJson("/api/stories/$storyId/viewers", cursor?.let { mapOf("cursor" to it) } ?: emptyMap())

suspend fun ApiClient.storyCard(storyId: String): StoryCard = getJson("/api/stories/$storyId/card")

/** A moderator's removal, from this server's slice only. */
suspend fun ApiClient.removeStoryFromServer(serverId: String, storyId: String, reason: String? = null) {
    send(
        "DELETE",
        "/api/servers/$serverId/stories/$storyId",
        encode(StoryModRemoveRequest.serializer(), StoryModRemoveRequest(reason)),
    )
}

/** Silence somebody's stories. They leave the strip; they are not told. */
suspend fun ApiClient.muteStories(userId: String) = send("PUT", "/api/stories/mutes/$userId", "{}")

suspend fun ApiClient.storyNotices(): List<StoryNotice> =
    getJson<StoryNoticesResponse>("/api/stories/notices").notices

suspend fun ApiClient.ackStoryNotice(noticeId: String) = send("POST", "/api/stories/notices/$noticeId/ack", "{}")

/**
 * PUT the media straight to storage with the headers the server signed.
 * Never through `ApiClient`: a Bearer header beside a presigned query is a
 * doubly authenticated request S3 refuses (see `AttachmentApi.upload`).
 */
suspend fun ApiClient.uploadStoryMedia(upload: StoryUpload, contentType: String, bytes: ByteArray) {
    val builder = Request.Builder()
        .url(upload.url)
        .put(bytes.toRequestBody(contentType.toMediaTypeOrNull()))
    upload.headers.forEach { (name, value) -> builder.header(name, value) }
    if (upload.headers.keys.none { it.equals("Content-Type", ignoreCase = true) }) {
        builder.header("Content-Type", contentType)
    }
    withContext(Dispatchers.IO) {
        http.newCall(builder.build()).execute().use { response ->
            check(response.isSuccessful) { "Upload refused with HTTP ${response.code}" }
        }
    }
}

/**
 * The same PUT, from a file on disk and with a running count. The body is
 * streamed (a 25 MB clip never sits in memory beside everything else the phone
 * is holding), [onSent] is told the bytes handed to the socket so far (the
 * progress ring), and cancelling the coroutine cancels the call: the socket
 * closes at once, which is what a discard mid-upload needs.
 */
suspend fun ApiClient.uploadStoryFile(
    upload: StoryUpload,
    contentType: String,
    file: File,
    paceMs: Long = 0L,
    onSent: (Long) -> Unit,
) = putStoryBody(upload, contentType, ProgressBody(file.length(), contentType.toMediaTypeOrNull(), paceMs, onSent) { file.source() })

/** The same PUT for bytes already in memory (an eager upload starts from what the composer holds). */
suspend fun ApiClient.uploadStoryBytes(
    upload: StoryUpload,
    contentType: String,
    bytes: ByteArray,
    paceMs: Long = 0L,
    onSent: (Long) -> Unit,
) = putStoryBody(upload, contentType, ProgressBody(bytes.size.toLong(), contentType.toMediaTypeOrNull(), paceMs, onSent) { bytes.inputStream().source() })

private suspend fun ApiClient.putStoryBody(upload: StoryUpload, contentType: String, body: RequestBody) {
    val builder = Request.Builder().url(upload.url).put(body)
    upload.headers.forEach { (name, value) -> builder.header(name, value) }
    if (upload.headers.keys.none { it.equals("Content-Type", ignoreCase = true) }) {
        builder.header("Content-Type", contentType)
    }
    val call = http.newCall(builder.build())
    suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (continuation.isActive) continuation.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { done ->
                    if (!continuation.isActive) return
                    if (done.isSuccessful) {
                        continuation.resume(Unit)
                    } else {
                        // An answer from storage (an expired or refused signature) is a refusal, not a dropped link.
                        continuation.resumeWithException(gg.pqp.app.core.ApiException(done.code, "Upload refused with HTTP ${done.code}"))
                    }
                }
            }
        })
    }
}

/** A body that says how much of it has gone out; [open] gives a fresh source each time OkHttp writes it (a retry starts over). */
private class ProgressBody(
    private val length: Long,
    private val type: okhttp3.MediaType?,
    private val paceMs: Long,
    private val onSent: (Long) -> Unit,
    private val open: () -> okio.Source,
) : RequestBody() {
    override fun contentType() = type
    override fun contentLength() = length

    override fun writeTo(sink: BufferedSink) {
        var sent = 0L
        onSent(0L)
        open().use { source ->
            val buffer = Buffer()
            while (true) {
                val read = source.read(buffer, CHUNK)
                if (read == -1L) break
                sink.write(buffer, read)
                sent += read
                onSent(sent)
                if (paceMs > 0) Thread.sleep(paceMs)
            }
        }
    }

    private companion object {
        const val CHUNK = 16L * 1024
    }
}

/** A write whose answer nobody reads (204, or a small body). */
private suspend fun ApiClient.send(method: String, path: String, body: String?) {
    val requestBody = (body ?: "").toRequestBody(ApiClient.JSON_MEDIA_TYPE)
    val builder = Request.Builder().url(url(path))
    when (method) {
        "DELETE" -> if (body == null) builder.delete() else builder.delete(requestBody)
        "PUT" -> builder.put(requestBody)
        else -> builder.post(requestBody)
    }
    execute(builder).close()
}
