package gg.pqp.app.jam

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/*
 * THE EDIT-SONG SHEET'S LOGIC, off the screen (`JamSongEditorTest` runs it against a fake backend). The web's
 * `jam-edit-sheet.tsx` as a state machine:
 *
 *  - an untouched field FOLLOWS the song as it is now (null here), so a name changed on another device is never
 *    written back over;
 *  - the cover is uploaded WHEN IT IS PICKED, while the person goes on typing, and CLAIMED WHEN THEY SAVE: nothing about
 *    the song changes until "Salvar", so closing the sheet leaves the old picture exactly as it was;
 *  - Save sends only what changed, in the order name and artist, then the picture, and each answer is applied to the song
 *    on screen as it arrives (`onSong`), so a save that got halfway (the name went, the picture did not) leaves a sheet
 *    that, asked again, sends only the picture;
 *  - a 403 that is not the flag is "you cannot edit this song", and the screen is asked to read what this person may do
 *    again (`onDenied`).
 */

/** Why a photo did not become a cover, in the sheet's words. */
sealed interface PhotoProblem {
    /** Not an image at all. */
    data object Type : PhotoProblem
    data class Small(val width: Int, val height: Int) : PhotoProblem
    data object Unreadable : PhotoProblem

    /** The picture could not be turned into a cover (out of memory, a decoder that gave up). */
    data object Failed : PhotoProblem

    /** The server, or the network, said no. */
    data class Write(val failure: JamWriteFailure) : PhotoProblem
}

sealed interface CoverUpload {
    data object Idle : CoverUpload
    data class Uploading(val fraction: Float) : CoverUpload
    data class Failed(val problem: PhotoProblem) : CoverUpload
}

/** A picture as it was sent: identity equality on purpose, a new pick is a new picture even if the bytes match. */
class CoverPicture(val jpeg: ByteArray)

enum class EditNote { Ready, Removed }

data class JamEditUi(
    val titleEdit: String? = null,
    val artistEdit: String? = null,
    val cover: CoverChoice = CoverChoice.Keep,
    val upload: CoverUpload = CoverUpload.Idle,
    /** The photo that went up and is waiting to be claimed. */
    val preview: CoverPicture? = null,
    /** The photo going up now, drawn dimmed under the progress ring. */
    val pending: CoverPicture? = null,
    val note: EditNote? = null,
    val saving: Boolean = false,
    val failure: JamWriteFailure? = null,
    /** "Salvar" was pressed once: empty fields say so. */
    val touched: Boolean = false,
    /** The save landed: the sheet closes. */
    val done: Boolean = false,
) {
    val uploading: Boolean get() = upload is CoverUpload.Uploading
}

class JamSongEditor(
    private val backend: JamBackend,
    private val scope: CoroutineScope,
    private val songId: String,
    /** The answer to a write is the song as it now is: the screen applies it like the frame the room is getting. */
    private val onSong: (JamSongSummary) -> Unit,
    /** The server said this person may not edit: the screen reads their permissions again. */
    private val onDenied: () -> Unit,
) {
    private val _ui = MutableStateFlow(JamEditUi())
    val ui: StateFlow<JamEditUi> = _ui.asStateFlow()

    private var uploadJob: Job? = null

    /** Every time the sheet opens it starts from the song as it is now. */
    fun open() {
        uploadJob?.cancel()
        _ui.value = JamEditUi()
    }

    /** Closing counts as a pick too: a late answer is ignored, and nothing keeps a picked picture alive. */
    fun close() {
        uploadJob?.cancel()
        uploadJob = null
        _ui.value = JamEditUi()
    }

    fun setTitle(value: String) = _ui.update { it.copy(titleEdit = value.take(JamLimits.TITLE_MAX), failure = null) }

    fun setArtist(value: String) = _ui.update { it.copy(artistEdit = value.take(JamText.ARTIST_MAX), failure = null) }

    /** A photo that cannot be a cover: said in words, and the cover stays what it was. */
    fun photoRejected(problem: PhotoProblem) {
        uploadJob?.cancel()
        _ui.update { it.copy(upload = CoverUpload.Failed(problem), pending = null) }
    }

    /** The framed picture, as the JPEG that will be sent: it goes up now, and the song is not touched. */
    fun photoReady(jpeg: ByteArray) {
        uploadJob?.cancel()
        val picture = CoverPicture(jpeg)
        _ui.update { it.copy(upload = CoverUpload.Uploading(0f), pending = picture, note = null) }
        uploadJob = scope.launch {
            try {
                val uploadId = backend.uploadCover(songId, jpeg) { fraction ->
                    _ui.update { now -> if (now.pending === picture) now.copy(upload = CoverUpload.Uploading(fraction)) else now }
                }
                _ui.update {
                    it.copy(
                        cover = CoverChoice.New(uploadId),
                        preview = picture,
                        pending = null,
                        upload = CoverUpload.Idle,
                        note = EditNote.Ready,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // A failed replacement leaves the photo that was already chosen where it was.
                _ui.update { it.copy(pending = null, upload = CoverUpload.Failed(PhotoProblem.Write(jamWriteFailureOf(e)))) }
            }
        }
    }

    /** Take the picture off the song (or forget the one just picked). [hadCover] is whether the song has one now. */
    fun removeCover(hadCover: Boolean) {
        uploadJob?.cancel()
        _ui.update {
            it.copy(
                cover = CoverChoice.Remove,
                preview = null,
                pending = null,
                upload = CoverUpload.Idle,
                note = if (hadCover) EditNote.Removed else null,
            )
        }
    }

    /** What saving means right now, for the sheet's "Salvar" and its discard question. */
    fun plan(song: JamSongSummary): SongEditPlan {
        val ui = _ui.value
        return JamSongEdit.plan(song, ui.titleEdit ?: song.title, ui.artistEdit ?: song.artist.orEmpty(), ui.cover)
    }

    fun save(song: JamSongSummary) {
        val ui = _ui.value
        val title = ui.titleEdit ?: song.title
        val artist = ui.artistEdit ?: song.artist.orEmpty()
        _ui.update { it.copy(touched = true) }
        if (JamText.checkTitle(title) !is JamText.Checked.Ok || JamText.checkArtist(artist) !is JamText.Checked.Ok) return
        val plan = plan(song)
        if (ui.uploading || ui.saving || plan.empty) return
        _ui.update { it.copy(saving = true, failure = null) }
        scope.launch {
            try {
                // The text first, then the picture; each answer is the song as it now is.
                plan.patch?.let { onSong(backend.updateSong(song.id, it)) }
                when (val op = plan.cover) {
                    is CoverOp.Set -> onSong(backend.setCover(song.id, op.uploadId))
                    CoverOp.Remove -> onSong(backend.removeCover(song.id))
                    null -> Unit
                }
                _ui.update { it.copy(saving = false, done = true) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val failure = jamWriteFailureOf(e)
                _ui.update { it.copy(saving = false, failure = failure) }
                if (failure == JamWriteFailure.Denied) onDenied()
            }
        }
    }
}
