package gg.pqp.app.jam

import gg.pqp.app.core.ApiException
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The adjust editor's state against the live frames: what is heard while it is open, what a frame or an answer does to
 * it, who may open it, and what a refusal is called.
 */
class JamAdjustTest {

    private val channel = "00000000-0000-4000-8000-0000000000c1"

    private fun song(updated: String = "2026-11-01T10:00:00.000Z") =
        JamSongSummary(id = "s", channelId = channel, title = "Song", trackCount = 2, updatedAt = updated)

    private fun track(
        id: String,
        author: String = "me",
        instrument: JamInstrument = JamInstrument.Guitar,
        offset: Double = -2023.0,
        trimStart: Double = 2023.0,
        trimEnd: Double = 0.0,
        gain: Double = 1.0,
        inMix: Boolean = true,
    ) = JamTrack(
        id = id, songId = "s", authorId = author, instrument = instrument, inMix = inMix, offsetMs = offset,
        trimStartMs = trimStart, trimEndMs = trimEnd, durationMs = 62023.0, gain = gain,
    )

    private fun ui(vararg tracks: JamTrack, adjust: JamAdjust? = null) = JamSongUi(
        phase = JamSongUi.Phase.Ready,
        state = JamSongState(song(), tracks.toList(), JamSongViewer(isAuthor = true)),
        adjust = adjust,
    )

    // --- what is heard while the editor is open ---

    @Test
    fun `the engine plays the edits laid on the track being adjusted, and the stored numbers for every other`() {
        val mine = track("a")
        val theirs = track("b", author = "you", instrument = JamInstrument.Bass)
        val adjust = JamAdjusting.edit(
            JamAdjusting.open(mine),
            JamTrackEdit.withGain(JamTrackEdit.withNudge(JamTrackEdit.editsFromTrack(mine), 120.0), 0.5),
        )
        val live = ui(mine, theirs, adjust = adjust).liveTracks
        assertEquals(-1903.0, live.first { it.id == "a" }.offsetMs, 0.0)
        assertEquals(0.5, live.first { it.id == "a" }.gain, 0.0)
        assertSame(theirs, live.first { it.id == "b" })
        // With the editor closed the live tracks ARE the stored ones: closing without saving restores what is stored.
        assertEquals(listOf(mine, theirs), ui(mine, theirs).liveTracks)
    }

    @Test
    fun `the lanes and the stack draw the edited take, so a drag is seen where it is heard`() {
        val mine = track("a")
        val adjust = JamAdjusting.edit(JamAdjusting.open(mine), JamTrackEdit.withTrimStart(mine, JamTrackEdit.editsFromTrack(mine), 3023.0))
        val shown = ui(mine, adjust = adjust).stack.single()
        assertEquals(3023.0, shown.trimStartMs, 0.0)
        assertEquals(1000.0, shown.startMs - mine.startMs, 0.0)
    }

    // --- what a frame does to an open editor ---

    @Test
    fun `a frame that leaves the stored numbers alone keeps the person's edits`() {
        val mine = track("a")
        val edited = JamTrackEdit.withNudge(JamTrackEdit.editsFromTrack(mine), 80.0)
        val adjust = JamAdjusting.edit(JamAdjusting.open(mine), edited)
        // A vote, a label: the same stored numbers.
        val frame = JamFrame.TrackUpdated(channel, song("2026-11-01T10:05:00.000Z"), mine.copy(voteCount = 3))
        val after = ui(mine, adjust = adjust).let { u ->
            u.copy(state = u.state!!.apply(frame).state).reconciled()
        }
        assertEquals(edited, after.adjust!!.edits)
        assertEquals(0, after.adjust!!.resets)
    }

    @Test
    fun `stored numbers that moved under the editor start the edits again from them, and say so`() {
        val mine = track("a")
        val adjust = JamAdjusting.edit(JamAdjusting.open(mine), JamTrackEdit.withNudge(JamTrackEdit.editsFromTrack(mine), 80.0))
        // The same person adjusted it on another device: the stored offset is now -2000 and the gain 0.8.
        val moved = mine.copy(offsetMs = -2000.0, gain = 0.8)
        val frame = JamFrame.TrackUpdated(channel, song("2026-11-01T10:05:00.000Z"), moved)
        val applied = ui(mine, adjust = adjust).let { u -> u.state!!.apply(frame) }
        // The engine is told a stem moved, and the editor starts from the new numbers with no stale nudge on top.
        assertEquals(JamEffect.ReloadStems, applied.effect)
        val after = ui(mine, adjust = adjust).copy(state = applied.state).reconciled()
        val reset = after.adjust!!
        assertEquals(0.0, reset.edits.nudgeMs, 0.0)
        assertEquals(0.8, reset.edits.gain, 0.0)
        assertEquals(StoredTake.of(moved), reset.baseline)
        assertEquals(1, reset.resets)
        assertFalse(JamTrackEdit.isEdited(moved, reset.edits))
        // What the engine plays is the new stored track, with nothing laid over it.
        assertEquals(-2000.0, after.liveTracks.single().offsetMs, 0.0)
    }

    @Test
    fun `a save in flight is not disturbed by the frame that is its own echo`() {
        val mine = track("a")
        val edited = JamTrackEdit.withGain(JamTrackEdit.editsFromTrack(mine), 1.5)
        val saving = JamAdjusting.saving(JamAdjusting.edit(JamAdjusting.open(mine), edited))
        val echo = mine.copy(gain = 1.5)
        assertSame(saving, JamAdjusting.reconcile(saving, echo))
    }

    @Test
    fun `the editor closes with its track`() {
        val mine = track("a")
        val adjust = JamAdjusting.open(mine)
        val frame = JamFrame.TrackDeleted(channel, song("2026-11-01T10:05:00.000Z"), "a")
        val applied = ui(mine, track("b"), adjust = adjust).let { u -> u.copy(state = u.state!!.apply(frame).state).reconciled() }
        assertNull(applied.adjust)
        assertEquals(listOf("b"), applied.liveTracks.map { it.id })
    }

    @Test
    fun `an unrelated frame returns the very same state`() {
        val mine = track("a")
        val u = ui(mine, adjust = JamAdjusting.open(mine))
        assertSame(u, u.reconciled())
    }

    // --- the reducer ---

    @Test
    fun `an edit is dropped while saving, a failure keeps the edits, and reset goes back to what is stored`() {
        val mine = track("a")
        val open = JamAdjusting.open(mine)
        val e1 = JamTrackEdit.withGain(open.edits, 0.7)
        val edited = JamAdjusting.edit(open, e1)
        assertEquals(e1, edited.edits)
        val saving = JamAdjusting.saving(edited)
        assertSame(saving, JamAdjusting.edit(saving, JamTrackEdit.withGain(open.edits, 0.1)))
        val failed = JamAdjusting.failed(saving, JamWriteFailure.Network)
        assertFalse(failed.saving)
        assertEquals(JamWriteFailure.Network, failed.failure)
        assertEquals(e1, failed.edits)
        // Typing again clears the old failure.
        assertNull(JamAdjusting.edit(failed, JamTrackEdit.withGain(e1, 0.9)).failure)
        val back = JamAdjusting.reset(failed, mine)
        assertEquals(JamTrackEdit.editsFromTrack(mine), back.edits)
        assertNull(back.failure)
    }

    // --- who may ---

    @Test
    fun `only the track's author may adjust it, and only with the flag on`() {
        val mine = track("a", author = "me")
        assertTrue(JamEditPermissions.canAdjustTrack(mine, "me", flagOn = true))
        assertFalse(JamEditPermissions.canAdjustTrack(mine, "me", flagOn = false))
        assertFalse(JamEditPermissions.canAdjustTrack(mine, "you", flagOn = true))
        assertFalse(JamEditPermissions.canAdjustTrack(mine, null, flagOn = true))
        // The song's author and a moderator do not nudge somebody else's take.
        assertFalse(JamEditPermissions.canAdjustTrack(track("b", author = "you"), "me", flagOn = true))
    }

    @Test
    fun `the song's author or a moderator may edit it, with the flag on`() {
        assertTrue(JamEditPermissions.canEditSong(JamSongViewer(isAuthor = true), true))
        assertTrue(JamEditPermissions.canEditSong(JamSongViewer(canModerate = true), true))
        assertFalse(JamEditPermissions.canEditSong(JamSongViewer(), true))
        assertFalse(JamEditPermissions.canEditSong(JamSongViewer(isAuthor = true), false))
    }

    // --- what a refusal is called ---

    @Test
    fun `refusals are named the way the web names them, a permission apart from the flag`() {
        fun failure(status: Int, token: String? = null) = jamWriteFailureOf(ApiException(status, token))
        assertEquals(JamWriteFailure.Off, failure(403, "jam_channels_off"))
        assertEquals(JamWriteFailure.Denied, failure(403, "You cannot edit this song"))
        assertEquals(JamWriteFailure.Denied, failure(403))
        assertEquals(JamWriteFailure.Gone, failure(404, "Not found"))
        assertEquals(JamWriteFailure.RateLimited, failure(429))
        assertEquals(JamWriteFailure.RateLimited, failure(403, "jam_rate_limited"))
        assertEquals(JamWriteFailure.TooLarge, failure(413))
        assertEquals(JamWriteFailure.TooLarge, failure(422, "jam_upload_too_large"))
        assertEquals(JamWriteFailure.StorageOff, failure(503, "jam_storage_off"))
        assertEquals(JamWriteFailure.Invalid, failure(400))
        assertEquals(JamWriteFailure.Invalid, failure(422, "jam_trim_invalid"))
        assertEquals(JamWriteFailure.Other, failure(500))
        assertEquals(JamWriteFailure.Network, jamWriteFailureOf(IOException("offline")))
        assertEquals(JamWriteFailure.Other, jamWriteFailureOf(IllegalStateException()))
        assertNotNull(JamWriteFailure.entries)
    }
}
