package gg.pqp.app.jam

import gg.pqp.app.core.ApiException
import gg.pqp.app.core.RealtimeState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The edit-song sheet's logic against a fake backend: a photo goes up when it is picked and is claimed when the person
 * saves, only what changed is sent, in order, each answer reaches the screen as it arrives, and a refusal is said in
 * the right words with the sheet still open.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class JamSongEditorTest {

    private class Backend : JamBackend {
        override val viewerId: String? = "me"
        override val frames = MutableSharedFlow<JamFrame>()
        override val connection = MutableStateFlow(RealtimeState.Ready)
        val calls = mutableListOf<String>()
        var songAnswer = JamSongSummary(id = "s", channelId = "c", title = "answer", updatedAt = "2026-11-01T10:00:00.000Z")
        var failUpdate: Throwable? = null
        var failCover: Throwable? = null
        var failUpload: Throwable? = null
        var uploadGate: CompletableDeferred<Unit>? = null
        var updateGate: CompletableDeferred<Unit>? = null

        /** Uploads of these sizes fail with an IOException after the gate, even when their job was cancelled meanwhile (an OkHttp call that is cancelled throws one). */
        var ioFailureSizes: Set<Int> = emptySet()

        override suspend fun config(serverId: String) = JamConfig(enabled = true, uploads = true)
        override suspend fun songs(channelId: String, cursor: String?, limit: Int) = JamSongListResponse()
        override suspend fun song(songId: String) = error("not used")
        override suspend fun vote(trackId: String, voted: Boolean) = error("not used")
        override suspend fun setInMix(trackId: String, inMix: Boolean) = error("not used")
        override suspend fun deleteTrack(trackId: String) = Unit
        override suspend fun deleteSong(songId: String) = Unit
        override suspend fun updateTrack(trackId: String, request: UpdateJamTrackRequest) = error("not used")

        override suspend fun updateSong(songId: String, patch: SongPatch): JamSongSummary {
            calls += "update ${patch.toJson()}"
            updateGate?.await()
            failUpdate?.let { throw it }
            return songAnswer.copy(title = patch.title ?: songAnswer.title)
        }

        override suspend fun uploadCover(songId: String, jpeg: ByteArray, onProgress: (Float) -> Unit): String {
            calls += "upload ${jpeg.size}"
            onProgress(0.5f)
            uploadGate?.let { gate -> kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { gate.await() } }
            if (jpeg.size in ioFailureSizes) throw java.io.IOException("Canceled")
            failUpload?.let { throw it }
            return "up-${jpeg.size}"
        }

        override suspend fun setCover(songId: String, uploadId: String): JamSongSummary {
            calls += "claim $uploadId"
            failCover?.let { throw it }
            return songAnswer.copy(coverUrl = "https://x/cover.jpg?sig=1")
        }

        override suspend fun removeCover(songId: String): JamSongSummary {
            calls += "remove"
            return songAnswer.copy(coverUrl = null)
        }

        override fun join(channelId: String) = Unit
        override fun leave(channelId: String) = Unit
    }

    private val song = JamSongSummary(id = "s", channelId = "c", title = "In Bloom", artist = "Nirvana", updatedAt = "2026-11-01T09:00:00.000Z")

    private class Harness(val backend: Backend, scope: TestScope) {
        val answers = mutableListOf<JamSongSummary>()
        var denied = 0
        val editor = JamSongEditor(backend, scope, "s", { answers += it }, { denied += 1 })
    }

    private fun TestScope.harness() = Harness(Backend(), TestScope(StandardTestDispatcher(testScheduler)))

    private fun jpeg(size: Int = 10) = ByteArray(size)

    @Test
    fun `nothing changed is nothing to save, and Save does nothing`() = runTest {
        val h = harness()
        h.editor.open()
        assertTrue(h.editor.plan(song).empty)
        h.editor.save(song)
        advanceUntilIdle()
        assertTrue(h.backend.calls.isEmpty())
        assertFalse(h.editor.ui.value.done)
    }

    @Test
    fun `a name and an artist go in one write, the answer reaches the screen, and the sheet is done`() = runTest {
        val h = harness()
        h.editor.open()
        h.editor.setTitle("Lithium")
        h.editor.setArtist("")
        h.editor.save(song)
        advanceUntilIdle()
        assertEquals(listOf("""update {"title":"Lithium","artist":null}"""), h.backend.calls)
        assertEquals(listOf("Lithium"), h.answers.map { it.title })
        assertTrue(h.editor.ui.value.done)
    }

    @Test
    fun `a photo goes up when it is picked, nothing claims it until Save, and closing leaves the song alone`() = runTest {
        val h = harness()
        h.editor.open()
        h.editor.photoReady(jpeg(7))
        advanceUntilIdle()
        assertEquals(listOf("upload 7"), h.backend.calls)
        assertEquals(CoverChoice.New("up-7"), h.editor.ui.value.cover)
        assertEquals(EditNote.Ready, h.editor.ui.value.note)
        assertTrue(h.answers.isEmpty())
        // Closing throws the pick away: nothing was claimed.
        h.editor.close()
        assertEquals(JamEditUi(), h.editor.ui.value)
        assertEquals(1, h.backend.calls.size)
    }

    @Test
    fun `Save claims the photo after the text, and each answer is applied as it arrives`() = runTest {
        val h = harness()
        h.editor.open()
        h.editor.setTitle("Lithium")
        h.editor.photoReady(jpeg(7))
        advanceUntilIdle()
        h.editor.save(song)
        advanceUntilIdle()
        assertEquals(listOf("upload 7", """update {"title":"Lithium"}""", "claim up-7"), h.backend.calls)
        assertEquals(2, h.answers.size)
        assertEquals("https://x/cover.jpg?sig=1", h.answers.last().coverUrl)
        assertTrue(h.editor.ui.value.done)
    }

    @Test
    fun `a save that got halfway is retried with only the picture`() = runTest {
        val h = harness()
        h.editor.open()
        h.editor.setTitle("Lithium")
        h.editor.photoReady(jpeg(7))
        advanceUntilIdle()
        h.backend.failCover = ApiException(500, null)
        h.editor.save(song)
        advanceUntilIdle()
        assertFalse(h.editor.ui.value.done)
        assertEquals(JamWriteFailure.Other, h.editor.ui.value.failure)
        // The name went: the song on screen is now "Lithium", so the plan asked again is the picture alone.
        val now = song.copy(title = "Lithium")
        assertNull(h.editor.plan(now).patch)
        assertEquals(CoverOp.Set("up-7"), h.editor.plan(now).cover)
        h.backend.failCover = null
        h.backend.calls.clear()
        h.editor.save(now)
        advanceUntilIdle()
        assertEquals(listOf("claim up-7"), h.backend.calls)
        assertTrue(h.editor.ui.value.done)
    }

    @Test
    fun `removing a cover that is there is a DELETE on Save, and one that was never there is nothing`() = runTest {
        val h = harness()
        val withCover = song.copy(coverUrl = "https://x/c.jpg?sig=1")
        h.editor.open()
        h.editor.removeCover(hadCover = true)
        assertEquals(EditNote.Removed, h.editor.ui.value.note)
        h.editor.save(withCover)
        advanceUntilIdle()
        assertEquals(listOf("remove"), h.backend.calls)
        h.editor.open()
        h.editor.removeCover(hadCover = false)
        assertTrue(h.editor.plan(song).empty)
    }

    @Test
    fun `a photo still going up blocks Save, and a newer pick replaces it`() = runTest {
        val h = harness()
        h.backend.uploadGate = CompletableDeferred()
        h.editor.open()
        h.editor.setTitle("Lithium")
        h.editor.photoReady(jpeg(7))
        advanceUntilIdle()
        assertTrue(h.editor.ui.value.uploading)
        h.editor.save(song)
        advanceUntilIdle()
        assertTrue("no write while the photo is on its way", h.backend.calls.none { it.startsWith("update") })
        // A second pick cancels the first: only the second can become the cover.
        h.backend.uploadGate!!.complete(Unit)
        h.editor.photoReady(jpeg(9))
        advanceUntilIdle()
        assertEquals(CoverChoice.New("up-9"), h.editor.ui.value.cover)
    }

    @Test
    fun `the failure of a photo that was replaced says nothing about the one that replaced it`() = runTest {
        val h = harness()
        h.backend.uploadGate = CompletableDeferred()
        h.backend.ioFailureSizes = setOf(7)
        h.editor.open()
        h.editor.photoReady(jpeg(7))
        advanceUntilIdle()
        h.editor.photoReady(jpeg(9))
        advanceUntilIdle()
        h.backend.uploadGate!!.complete(Unit)
        advanceUntilIdle()
        // The first upload died with an IOException (its call was cancelled); the second landed and is the choice.
        assertEquals(CoverChoice.New("up-9"), h.editor.ui.value.cover)
        assertEquals(CoverUpload.Idle, h.editor.ui.value.upload)
        assertNull(h.editor.ui.value.pending)
    }

    @Test
    fun `a save that outlives its sheet applies its answer but never closes or fails the next sheet`() = runTest {
        val h = harness()
        h.backend.updateGate = CompletableDeferred()
        h.editor.open()
        h.editor.setTitle("Lithium")
        h.editor.save(song)
        advanceUntilIdle()
        // The sheet is closed and opened again while the first save is still on the wire.
        h.editor.close()
        h.editor.open()
        h.editor.setTitle("Something else")
        h.backend.updateGate!!.complete(Unit)
        advanceUntilIdle()
        // The answer still reached the song (the write happened), and the new sheet is untouched.
        assertEquals(listOf("Lithium"), h.answers.map { it.title })
        assertFalse(h.editor.ui.value.done)
        assertFalse(h.editor.ui.value.saving)
        assertEquals("Something else", h.editor.ui.value.titleEdit)
    }

    @Test
    fun `a photo that failed to go up leaves the choice where it was and says why`() = runTest {
        val h = harness()
        h.editor.open()
        h.editor.photoReady(jpeg(7))
        advanceUntilIdle()
        h.backend.failUpload = ApiException(413, null)
        h.editor.photoReady(jpeg(8))
        advanceUntilIdle()
        // The first photo is still the one chosen, and the failure names the size.
        assertEquals(CoverChoice.New("up-7"), h.editor.ui.value.cover)
        assertEquals(CoverUpload.Failed(PhotoProblem.Write(JamWriteFailure.TooLarge)), h.editor.ui.value.upload)
        assertNull(h.editor.ui.value.pending)
        // A photo the phone refused (too small, not an image) is said in words and does not touch the song.
        h.editor.photoRejected(PhotoProblem.Small(300, 300))
        assertEquals(CoverUpload.Failed(PhotoProblem.Small(300, 300)), h.editor.ui.value.upload)
    }

    @Test
    fun `a 403 that is not the flag says the person cannot edit, keeps the sheet open and asks for a fresh read of the permissions`() = runTest {
        val h = harness()
        h.editor.open()
        h.editor.setTitle("Lithium")
        h.backend.failUpdate = ApiException(403, "You cannot edit this song")
        h.editor.save(song)
        advanceUntilIdle()
        assertEquals(JamWriteFailure.Denied, h.editor.ui.value.failure)
        assertEquals(1, h.denied)
        assertFalse(h.editor.ui.value.done)
        assertFalse(h.editor.ui.value.saving)
        // The flag off is a different sentence and does not ask for a re-read.
        h.backend.failUpdate = ApiException(403, "jam_channels_off")
        h.editor.save(song)
        advanceUntilIdle()
        assertEquals(JamWriteFailure.Off, h.editor.ui.value.failure)
        assertEquals(1, h.denied)
    }

    @Test
    fun `a title the server would refuse is not sent, and says so once Save was pressed`() = runTest {
        val h = harness()
        h.editor.open()
        h.editor.setTitle("​")
        h.editor.save(song)
        advanceUntilIdle()
        assertTrue(h.backend.calls.isEmpty())
        assertTrue(h.editor.ui.value.touched)
        h.editor.setTitle("")
        h.editor.save(song)
        advanceUntilIdle()
        assertTrue(h.backend.calls.isEmpty())
    }

    @Test
    fun `an untouched field follows the song, so a name changed elsewhere is not written back over`() = runTest {
        val h = harness()
        h.editor.open()
        h.editor.setArtist("Foo")
        val renamedElsewhere = song.copy(title = "Lithium")
        // Only the artist is this person's change; the title stays whatever the song now says.
        assertEquals(SongPatch(setArtist = true, artist = "Foo"), h.editor.plan(renamedElsewhere).patch)
    }

    @Test
    fun `the field limits hold as typed`() = runTest {
        val h = harness()
        h.editor.open()
        h.editor.setTitle("x".repeat(250))
        assertEquals(JamLimits.TITLE_MAX, h.editor.ui.value.titleEdit!!.length)
        h.editor.setArtist("y".repeat(250))
        assertEquals(JamText.ARTIST_MAX, h.editor.ui.value.artistEdit!!.length)
    }
}
