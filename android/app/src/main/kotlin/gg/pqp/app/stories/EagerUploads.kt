package gg.pqp.app.stories

import android.content.Context
import android.util.Log
import gg.pqp.app.core.SessionStore
import gg.pqp.app.stories.editor.LayerFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Eager uploads: a story's file is sent the moment its bytes are final, before
 * the story exists, so "Postar" has almost nothing left to wait for.
 *
 * One [EagerUpload] per file (the base, or a photo or drawing layer). It mints
 * an upload (`POST /api/stories/uploads`), PUTs the bytes to the signed URL and
 * is done; the create then names it by `uploadId` instead of asking for new
 * URLs. Whatever goes wrong (no storage, a rate limit, a dead link) leaves the
 * upload failed and the file simply goes the old way at "Postar": an eager
 * upload only ever makes the post faster, never possible or impossible.
 *
 * App-scoped, because it has to outlive the composer: an upload still running
 * when the person taps "Postar" is the outbox's to wait for.
 */
class StoryEagerUploads(
    private val appContext: Context,
    private val session: SessionStore,
    private val scope: CoroutineScope,
) {
    private val gate = Semaphore(AT_ONCE)

    /**
     * Start sending [bytes]. [tag] names what they were made from (the picked media, a layer file, a
     * drawing's strokes), so a caller can tell later whether the upload still matches what is on the canvas.
     */
    fun start(key: String, kind: String, contentType: String, bytes: ByteArray, tag: Any, file: LayerFile? = null): EagerUpload {
        val upload = EagerUpload(key, kind, contentType, bytes, tag, file)
        val pace = StoryPerf.uploadPaceMs(appContext.filesDir)
        upload.job = scope.launch {
            try {
                // A few at a time, however many files a story has: a story can carry a base and seven layers.
                gate.withPermit {
                    val minted = session.api.createStoryUpload(kind, contentType, bytes.size.toLong())
                    upload.mintedId = minted.uploadId
                    session.api.uploadStoryBytes(minted.asUpload(), contentType, bytes, pace) { upload.sent = it }
                    upload.sent = bytes.size.toLong()
                    upload.completed = true
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "eager $key failed: ${e.message}")
                upload.failed = true
                // A PUT that did not finish is no use to anybody: let the server have it back now.
                upload.mintedId?.let { id -> scope.launch { deleteQuietly(id) } }
            }
        }
        return upload
    }

    /**
     * Throw one away: stop the PUT, then tell the server (in that order, so a PUT that lands after the delete cannot
     * leave an object behind). Fire and forget; the server's sweep is the backstop for a delete that fails.
     */
    fun discard(upload: EagerUpload) {
        upload.job.cancel()
        scope.launch {
            upload.job.join()
            upload.mintedId?.let { deleteQuietly(it) }
        }
    }

    /** Ids a draft still holds that will never be claimed. */
    fun deleteIds(ids: Collection<String>) {
        ids.forEach { id -> scope.launch { deleteQuietly(id) } }
    }

    private suspend fun deleteQuietly(id: String) {
        runCatching { session.api.deleteStoryUpload(id) }
    }

    private companion object {
        const val TAG = "pqp.stories"
        const val AT_ONCE = 3
    }
}

/** One file on its way ahead of the story. Fields are written by the upload and read by whoever waits. */
class EagerUpload internal constructor(
    val key: String,
    val kind: String,
    val contentType: String,
    bytes: ByteArray,
    tag: Any,
    /** A layer's file as the create declares it (type, size, dimensions): what the upload was made from. */
    file: LayerFile?,
) {
    /**
     * What the upload was made from (the picked media, a layer file, a drawing's strokes), so a caller can tell whether it
     * still matches. Held only until nobody needs it any more ([release]): the picked media carries its whole file.
     */
    @Volatile
    var tag: Any = tag
        private set

    /** What was sent, held only until nobody needs it any more ([release]). */
    @Volatile
    var file: LayerFile? = file
        private set

    val size: Long = bytes.size.toLong()

    internal lateinit var job: Job

    @Volatile
    var mintedId: String? = null
        internal set

    @Volatile
    var sent: Long = 0L
        internal set

    @Volatile
    var completed: Boolean = false
        internal set

    @Volatile
    var failed: Boolean = false
        internal set

    /** The post has what it needs from this upload (its id, and a copy of the file on disk): drop the buffers. */
    fun release() {
        file = null
        tag = Released
    }

    private object Released

    /** Waits for the upload to end: its id when the PUT finished, null when it did not. */
    suspend fun await(): String? {
        job.join()
        return if (completed) mintedId else null
    }
}

/**
 * Putting eager uploads into a create request, as pure rules (`EagerUploadTest`).
 *
 * The request is built once, when "Postar" is tapped, before it is known which
 * uploads finished. This fits the answer into it: an `uploadId` on the base and
 * on each photo or drawing layer that has one, and `publish: true` when every
 * file has one (the server then creates and publishes in one call).
 */
object EagerRequest {

    /** [ids] by file key (`DraftFile.BASE` or a layer id). A file without an id keeps asking for its own URL. */
    fun apply(request: CreateStoryRequest, files: List<DraftFile>, ids: Map<String, String>): CreateStoryRequest {
        if (ids.isEmpty()) return request
        return request.copy(
            media = request.media?.let { media -> ids[DraftFile.BASE]?.let { media.copy(uploadId = it) } ?: media },
            layers = request.layers.map { layer -> withUploadId(layer, ids) },
            publish = if (allEager(files, ids)) true else null,
        )
    }

    /** The ids of the uploads that have finished: what a draft keeps so a retry can claim them instead of sending the file again. */
    fun finished(uploads: Collection<EagerUpload>): Map<String, String> =
        uploads.filter { it.completed }.mapNotNull { upload -> upload.mintedId?.let { upload.key to it } }.toMap()

    /** Every file the story has is eager, and it has at least one (a card of only words goes the old way). */
    fun allEager(files: List<DraftFile>, ids: Map<String, String>): Boolean =
        files.isNotEmpty() && files.all { ids.containsKey(it.key) }

    private fun withUploadId(layer: JsonObject, ids: Map<String, String>): JsonObject {
        val id = (layer["id"] as? JsonPrimitive)?.content ?: return layer
        val upload = layer["upload"] as? JsonObject ?: return layer
        val uploadId = ids[id] ?: return layer
        return JsonObject(layer + ("upload" to JsonObject(upload + ("uploadId" to JsonPrimitive(uploadId)))))
    }

    /** Whether a refused create is the server saying an upload cannot be used (gone, not ours, a mismatch): go the old way. */
    fun unusable(status: Int): Boolean = status == 404 || status == 400

    /** Whether the PUT has not landed as far as the server can see: wait, and send the same create again. */
    fun notYet(status: Int): Boolean = status == 409

    /**
     * How many times a create that answered "not yet" is sent again, and how long to wait first. One: every create
     * counts against the story budget (a few a minute), and by the time a create is sent the PUT has already ended
     * on this side, so a 409 that lasts is an upload that is gone, and the files go the old way.
     */
    const val NOT_YET_ATTEMPTS = 1
    const val NOT_YET_WAIT_MS = 1_500L
}
