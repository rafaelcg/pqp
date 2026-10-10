package gg.pqp.app.bau

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.pqp.app.attachments.sanitizeAttachmentFilename
import gg.pqp.app.core.SessionStore
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/** A picked file, already copied somewhere this process owns. */
class BauLocalFile(val file: File, val filename: String, val contentType: String)

/** Why a pick did not become a file. */
enum class BauPickFailure { Unreadable, UnsupportedType, TooLarge }

/**
 * Reading the picker's result, behind an interface so the view model is
 * testable without a device. A `content://` URI is a call into another app,
 * which may have died or revoked the grant, so the real one is allowed to say
 * no and the caller says so on screen.
 */
fun interface BauFileSource {
    suspend fun read(uri: String): Result<BauLocalFile>
}

/**
 * The real one. The bytes are copied to a cache file rather than held in
 * memory, counting as they go, so a clip of any size costs the same RAM and
 * the length that gets signed is the length of the thing that gets sent.
 */
class ContentBauFiles(context: Context) : BauFileSource {
    private val app = context.applicationContext

    override suspend fun read(uri: String): Result<BauLocalFile> = withContext(Dispatchers.IO) {
        val parsed = Uri.parse(uri)
        val resolver = app.contentResolver
        val filename = sanitizeAttachmentFilename(
            runCatching {
                resolver.query(parsed, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst()) c.getString(0) else null
                }
            }.getOrNull() ?: parsed.lastPathSegment,
        )
        val type = try {
            bauMediaType(resolver.getType(parsed), filename)
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            return@withContext Result.failure(BauPickException(BauPickFailure.Unreadable))
        } ?: return@withContext Result.failure(BauPickException(BauPickFailure.UnsupportedType))

        val dir = File(app.cacheDir, "bau-compose").apply { mkdirs() }
        val target = File(dir, UUID.randomUUID().toString())
        var keep = false
        try {
            var total = 0L
            var tooLarge = false
            val opened = resolver.openInputStream(parsed)?.use { input ->
                target.outputStream().use { out ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        // A cancelled pick stops copying; `finally` deletes the file.
                        ensureActive()
                        val read = input.read(buffer)
                        if (read <= 0) break
                        total += read
                        // One byte past the cap is enough to know; stop reading.
                        if (total > BAU_MAX_BYTES) {
                            tooLarge = true
                            break
                        }
                        out.write(buffer, 0, read)
                    }
                }
                true
            } ?: false
            when {
                tooLarge -> Result.failure(BauPickException(BauPickFailure.TooLarge))
                !opened || total <= 0 -> Result.failure(BauPickException(BauPickFailure.Unreadable))
                else -> {
                    ensureActive()
                    keep = true
                    Result.success(BauLocalFile(target, filename, type))
                }
            }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            Result.failure(BauPickException(BauPickFailure.Unreadable))
        } finally {
            if (!keep) target.delete()
        }
    }
}

class BauPickException(val failure: BauPickFailure) : Exception(failure.name)

data class BauComposeState(
    val draft: BauComposeDraft = BauComposeDraft(),
    val posting: Boolean = false,
    /** Set when Post was tapped on a draft that is not ready; cleared by the next edit. */
    val problem: BauComposeProblem? = null,
    val pickFailure: BauPickFailure? = null,
    /** The server (or the network) said no to the last write. */
    val refusal: BauRefusal? = null,
    val posted: Boolean = false,
)

/**
 * One draft post for one server.
 *
 * A file starts uploading the moment it is picked, like a chat attachment, so
 * Post is a single small request when it is tapped. It never publishes with a
 * file that is still going up or has failed ([BauComposeDraft.problem]).
 */
class BauComposeViewModel(
    private val session: SessionStore,
    private val serverId: String,
    private val files: BauFileSource,
) : ViewModel() {

    private val _state = MutableStateFlow(BauComposeState())
    val state: StateFlow<BauComposeState> = _state.asStateFlow()

    private var uploadJob: Job? = null
    private var localFile: File? = null

    private fun edit(change: (BauComposeDraft) -> BauComposeDraft) {
        _state.value = _state.value.copy(
            draft = change(_state.value.draft),
            problem = null,
            refusal = null,
        )
    }

    fun setTitle(value: String) = edit { it.copy(title = value) }
    fun setBody(value: String) = edit { it.copy(body = value) }

    /** A pasted link replaces a file: the server takes one media source. */
    fun setLink(value: String) {
        if (value.isNotBlank()) dropMedia()
        edit { it.copy(link = value) }
    }

    fun pickMedia(uri: String) {
        dropMedia()
        _state.value = _state.value.copy(pickFailure = null, refusal = null, problem = null)
        uploadJob = viewModelScope.launch {
            val picked = files.read(uri).getOrElse { failure ->
                _state.value = _state.value.copy(
                    pickFailure = (failure as? BauPickException)?.failure ?: BauPickFailure.Unreadable,
                )
                return@launch
            }
            localFile = picked.file
            edit {
                it.copy(
                    link = "",
                    media = BauPickedMedia(
                        filename = picked.filename,
                        contentType = picked.contentType,
                        byteSize = picked.file.length(),
                        isVideo = picked.contentType.startsWith("video/"),
                        uploading = true,
                    ),
                )
            }
            try {
                val uploadId = BauMediaUploader(session.api)
                    .upload(serverId, picked.file, picked.contentType, picked.filename)
                setMedia { it.copy(uploadId = uploadId, uploading = false, failed = false) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                setMedia { it.copy(uploading = false, failed = true) }
                _state.value = _state.value.copy(refusal = BauRefusal.from(failure))
            }
        }
    }

    private fun setMedia(change: (BauPickedMedia) -> BauPickedMedia) {
        val current = _state.value
        val media = current.draft.media ?: return
        _state.value = current.copy(draft = current.draft.copy(media = change(media)))
    }

    fun removeMedia() {
        dropMedia()
        _state.value = _state.value.copy(pickFailure = null, refusal = null, problem = null)
    }

    private fun dropMedia() {
        uploadJob?.cancel()
        uploadJob = null
        localFile?.delete()
        localFile = null
        if (_state.value.draft.media != null) {
            _state.value = _state.value.copy(draft = _state.value.draft.copy(media = null))
        }
    }

    fun post() {
        val current = _state.value
        if (current.posting) return
        val request = current.draft.toRequest()
        if (request == null) {
            _state.value = current.copy(problem = current.draft.problem())
            return
        }
        _state.value = current.copy(posting = true, problem = null, refusal = null)
        viewModelScope.launch {
            runCatching { session.api.createBauPost(serverId, request) }
                .onSuccess { _state.value = _state.value.copy(posting = false, posted = true) }
                .onFailure { failure ->
                    if (failure is CancellationException) throw failure
                    val refusal = BauRefusal.from(failure)
                    _state.value = _state.value.copy(
                        posting = false,
                        refusal = if (refusal == BauRefusal.Network) BauRefusal.Unconfirmed else refusal,
                    )
                }
        }
    }

    /**
     * The composer is going away without posting: stop any upload and delete
     * the cached file. A post already in flight is not stopped (the screen
     * keeps Close disabled while it runs), because cancelling the coroutine
     * would not recall a request the server may already have.
     */
    fun discard() {
        if (_state.value.posting) return
        dropMedia()
    }

    /** True when closing would throw something away. */
    fun isDirty(): Boolean {
        val draft = _state.value.draft
        return draft.title.isNotBlank() || draft.body.isNotBlank() || draft.link.isNotBlank() || draft.media != null
    }

    override fun onCleared() {
        localFile?.delete()
    }

    companion object {
        fun factory(session: SessionStore, serverId: String, files: BauFileSource) =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    BauComposeViewModel(session, serverId, files) as T
            }
    }
}
