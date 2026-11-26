package gg.pqp.app.jam

import gg.pqp.app.jam.record.JamTakeEdit
import gg.pqp.app.protocol.RepoSources
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The arithmetic of "Ajustar", held against the web's: the same ranges, steps and rounding (`jam-take-edit.ts`,
 * `jam-clip.ts`), read the way the contract reads `offsetMs` (the song time of the stored file's FIRST sample, #1595).
 * The numbers are pinned to the web's source files, so a change there fails here instead of two clients disagreeing
 * about the same recording.
 */
class JamTrackEditTest {

    /** The worked example of the contract: a take with a one-bar count-in, `offsetMs -2023, trimStartMs 2023`, 62 023 ms long. */
    private val countIn = JamTrack(
        id = "t", songId = "s", authorId = "me", instrument = JamInstrument.Guitar, inMix = true,
        offsetMs = -2023.0, trimStartMs = 2023.0, trimEndMs = 0.0, durationMs = 62023.0, gain = 1.0,
        peaks = List(100) { (it % 10) / 10.0 },
    )

    private fun edits(track: JamTrack = countIn) = JamTrackEdit.editsFromTrack(track)

    // --- the numbers are the web's ---

    @Test
    fun `the ranges and steps are the web's own`() {
        val web = RepoSources.read("client/src/lib/jam-take-edit.ts")
        assertEquals(RepoSources.numberConstant("client/src/lib/jam-take-edit.ts", "MIN_AUDIBLE_MS").toDouble(), JamTrackEdit.MIN_AUDIBLE_MS, 0.0)
        assertEquals(RepoSources.numberConstant("client/src/lib/jam-take-edit.ts", "NUDGE_LIMIT_MS").toDouble(), JamTrackEdit.NUDGE_LIMIT_MS, 0.0)
        // The gain is clamped to 0..2 and a change under half a hundredth is no change.
        assertTrue(web.contains("Math.min(Math.max(gain, 0), 2)"))
        assertTrue(web.contains("Math.abs(edits.gain - track.gain) > 0.005"))
        assertTrue(web.contains("Math.round(edits.gain * 100) / 100"))
        assertEquals(2.0, JamLimits.GAIN_MAX, 0.0)
        // The hold's three steps, and the volume slider (0..200 by 1), are the clip editor's.
        val editor = RepoSources.read("client/src/components/jam/jam-clip-editor.tsx")
        assertTrue(editor.contains("heldMs >= 1500 ? 100 : heldMs >= 600 ? 50 : 10"))
        assertTrue(editor.contains("min={0}") && editor.contains("max={200}") && editor.contains("step={1}"))
        assertEquals(listOf(10, 50, 100), listOf(0L, 600L, 1500L).map { JamTakeEdit.stepFor(it) })
        assertEquals(200, JamTrackEdit.GAIN_MAX_PERCENT)
        assertEquals(1, JamTrackEdit.GAIN_STEP_PERCENT)
    }

    // --- clamping ---

    @Test
    fun `a nudge is whole milliseconds and stays within 500 either way`() {
        assertEquals(500.0, JamTrackEdit.withNudge(edits(), 9999.0).nudgeMs, 0.0)
        assertEquals(-500.0, JamTrackEdit.withNudge(edits(), -9999.0).nudgeMs, 0.0)
        assertEquals(13.0, JamTrackEdit.withNudge(edits(), 12.5).nudgeMs, 0.0)
        // JavaScript's Math.round puts a half up, also below zero: -12.5 is -12, not -13.
        assertEquals(-12.0, JamTrackEdit.withNudge(edits(), -12.5).nudgeMs, 0.0)
    }

    @Test
    fun `a head trim may go back to zero, never past what leaves 500 ms to hear, and is whole milliseconds`() {
        // The recorded head the engine hid is unknown for a posted track: the cut may be undone entirely.
        assertEquals(0.0, JamTrackEdit.withTrimStart(countIn, edits(), -50.0).trimStartMs, 0.0)
        // 62 023 total, nothing off the tail, 500 to keep: the most is 61 523.
        assertEquals(61523.0, JamTrackEdit.withTrimStart(countIn, edits(), 99999.0).trimStartMs, 0.0)
        assertEquals(1000.0, JamTrackEdit.withTrimStart(countIn, edits(), 999.6).trimStartMs, 0.0)
        // The room left depends on the other trim.
        val tail = edits().copy(trimEndMs = 60000.0)
        assertEquals(1523.0, JamTrackEdit.withTrimStart(countIn, tail, 5000.0).trimStartMs, 0.0)
    }

    @Test
    fun `a tail trim never leaves less than 500 ms to hear and never goes below zero`() {
        assertEquals(0.0, JamTrackEdit.withTrimEnd(countIn, edits(), -5.0).trimEndMs, 0.0)
        // 62 023 - 2 023 (the head already hidden) - 500 = 59 500.
        assertEquals(59500.0, JamTrackEdit.withTrimEnd(countIn, edits(), 99999.0).trimEndMs, 0.0)
    }

    @Test
    fun `a file shorter than the audible minimum keeps both trims at zero, so the server's trimStart plus trimEnd under duration holds`() {
        val short = countIn.copy(durationMs = 400.0, offsetMs = 0.0, trimStartMs = 0.0)
        val e = JamTrackEdit.editsFromTrack(short)
        assertEquals(0.0, JamTrackEdit.withTrimStart(short, e, 300.0).trimStartMs, 0.0)
        assertEquals(0.0, JamTrackEdit.withTrimEnd(short, e, 300.0).trimEndMs, 0.0)
    }

    @Test
    fun `the gain is clamped to 0 to 2 and the slider is whole percent`() {
        assertEquals(0.0, JamTrackEdit.withGain(edits(), -1.0).gain, 0.0)
        assertEquals(2.0, JamTrackEdit.withGain(edits(), 7.0).gain, 0.0)
        assertEquals(1.37, JamTrackEdit.gainOfPercent(137), 1e-9)
        assertEquals(2.0, JamTrackEdit.gainOfPercent(900), 0.0)
        assertEquals(0.0, JamTrackEdit.gainOfPercent(-4), 0.0)
        assertEquals(137, JamTrackEdit.percentOfGain(1.37))
        assertEquals(200, JamTrackEdit.percentOfGain(5.0))
    }

    // --- the request ---

    @Test
    fun `nothing edited is no request, and an edit sends only the field that changed`() {
        assertTrue(JamTrackEdit.patchFor(countIn, edits()).isEmpty)
        assertEquals(TrackPatch(gain = 1.25), JamTrackEdit.patchFor(countIn, JamTrackEdit.withGain(edits(), 1.25)))
        // A nudge adds to the STORED offset (-2023) and the trims are untouched.
        assertEquals(TrackPatch(offsetMs = -2000.0), JamTrackEdit.patchFor(countIn, JamTrackEdit.withNudge(edits(), 23.0)))
        assertEquals(TrackPatch(trimStartMs = 2523.0), JamTrackEdit.patchFor(countIn, JamTrackEdit.withTrimStart(countIn, edits(), 2523.0)))
        assertEquals(TrackPatch(trimEndMs = 750.0), JamTrackEdit.patchFor(countIn, JamTrackEdit.withTrimEnd(countIn, edits(), 750.0)))
        val all = JamTrackEdit.withGain(
            JamTrackEdit.withTrimEnd(countIn, JamTrackEdit.withTrimStart(countIn, JamTrackEdit.withNudge(edits(), -40.0), 2100.0), 300.0),
            0.5,
        )
        assertEquals(TrackPatch(-2063.0, 2100.0, 300.0, 0.5), JamTrackEdit.patchFor(countIn, all))
    }

    @Test
    fun `a gain moved by less than half a hundredth is no change, and one that did is rounded to a hundredth`() {
        assertTrue(JamTrackEdit.patchFor(countIn, edits().copy(gain = 1.004)).isEmpty)
        assertEquals(1.01, JamTrackEdit.patchFor(countIn, edits().copy(gain = 1.0123)).gain!!, 1e-9)
    }

    @Test
    fun `a stored fractional offset is compared whole, as the web compares it`() {
        val stored = countIn.copy(offsetMs = -2023.4)
        // Nothing edited: round(-2023.4) is round(-2023.4).
        assertTrue(JamTrackEdit.patchFor(stored, JamTrackEdit.editsFromTrack(stored)).isEmpty)
        // A nudge of 1 ms: round(-2022.4) = -2022, which differs from round(-2023.4) = -2023.
        assertEquals(-2022.0, JamTrackEdit.patchFor(stored, JamTrackEdit.withNudge(JamTrackEdit.editsFromTrack(stored), 1.0)).offsetMs!!, 0.0)
    }

    @Test
    fun `the request carries only the fields that changed, as the app's JSON writes them`() {
        val request = UpdateJamTrackRequest.of(TrackPatch(offsetMs = -2000.0, gain = 0.5))
        val json = gg.pqp.app.core.PqpJson.encodeToString(UpdateJamTrackRequest.serializer(), request)
        assertEquals("""{"offsetMs":-2000.0,"gain":0.5}""", json)
        assertEquals("""{"inMix":true}""", gg.pqp.app.core.PqpJson.encodeToString(UpdateJamTrackRequest.serializer(), UpdateJamTrackRequest(inMix = true)))
    }

    // --- what the engine plays ---

    @Test
    fun `the edits are laid on the stored numbers, a nudge moves the file and a trim only hides`() {
        val e = JamTrackEdit.withNudge(JamTrackEdit.withTrimStart(countIn, edits(), 2523.0), 100.0)
        val placed = JamTrackEdit.placed(countIn, e)
        assertEquals(-1923.0, placed.offsetMs, 0.0)
        assertEquals(2523.0, placed.trimStartMs, 0.0)
        // Heard from the file's first sample plus the head the trim hides: song time 600, not 100.
        assertEquals(600.0, placed.startMs, 0.0)
        // A trim alone does not move what is still heard: the file's own sample at song time t stays at t.
        val trimmedOnly = JamTrackEdit.placed(countIn, JamTrackEdit.withTrimStart(countIn, edits(), 2523.0))
        assertEquals(countIn.offsetMs, trimmedOnly.offsetMs, 0.0)
    }

    @Test
    fun `the volume reads as the web reads it`() {
        assertNull(JamTrackEdit.volumeDelta(1.0))
        assertEquals("+20%", JamTrackEdit.volumeDelta(1.2))
        assertEquals("-75%", JamTrackEdit.volumeDelta(0.25))
        assertEquals("-100%", JamTrackEdit.volumeDelta(0.0))
        assertEquals(1.0, JamTrackEdit.levelOfGain(1.0), 1e-9)
        assertEquals(0.3, JamTrackEdit.levelOfGain(0.0), 1e-9)
        assertEquals(1.12, JamTrackEdit.levelOfGain(2.0), 1e-9)
        assertEquals(0, JamTrackEdit.wholeMs(0.4))
        assertEquals(13, JamTrackEdit.wholeMs(-13.0))
    }

    // --- the clip editor's picture ---

    @Test
    fun `the span and the reach follow the edits, and the whole window does not move while the clip is dragged`() {
        val e = edits()
        assertEquals(ClipWindow(0.0, 60000.0), JamClip.span(countIn, e))
        assertEquals(ClipWindow(-2023.0, 60000.0), JamClip.reach(countIn, 0.0))
        val moved = JamTrackEdit.withNudge(e, 200.0)
        assertEquals(ClipWindow(200.0, 60200.0), JamClip.span(countIn, moved))
        assertEquals(JamClip.window(countIn, e, ClipZoom.Whole), JamClip.window(countIn, moved, ClipZoom.Whole))
        // Close: three seconds around where the take starts.
        assertEquals(ClipWindow(-1000.0, 2000.0), JamClip.window(countIn, e, ClipZoom.Close))
        assertEquals(ClipWindow(-800.0, 2200.0), JamClip.window(countIn, moved, ClipZoom.Close))
    }

    @Test
    fun `fractions are clamped and a pixel is a fixed number of milliseconds`() {
        val w = ClipWindow(0.0, 1000.0)
        assertEquals(0.0, JamClip.fraction(w, -5.0), 0.0)
        assertEquals(0.5, JamClip.fraction(w, 500.0), 1e-9)
        assertEquals(1.0, JamClip.fraction(w, 5000.0), 0.0)
        assertEquals(2.0, JamClip.msPerPixel(w, 500f), 1e-9)
    }

    @Test
    fun `the band is the loudest of the lanes in each slice, loudness per lane, silence where nobody plays`() {
        val loud = JamTrack(id = "a", songId = "s", offsetMs = 0.0, durationMs = 1000.0, peaks = listOf(1.0, 1.0, 1.0, 1.0))
        val quiet = JamTrack(id = "b", songId = "s", offsetMs = 500.0, durationMs = 500.0, peaks = listOf(0.1, 0.1))
        val bars = JamClip.bandEnvelope(listOf(loud, quiet), ClipWindow(-500.0, 1500.0), 4)
        // 500 ms slices: [-500,0) nobody, [0,500) loud, [500,1000) loud and quiet (the quiet lane is its own 1.0), [1000,1500) nobody.
        assertEquals(listOf(0f, 1f, 1f, 0f), bars)
        assertEquals(emptyList<Float>(), JamClip.bandEnvelope(emptyList(), ClipWindow(0.0, 1.0), 0))
    }

    @Test
    fun `the take's bars are scaled so the loudest is one, and a take with no peaks is a flat line`() {
        assertEquals(listOf(0.5f, 1f), JamClip.bars(listOf(0.25, 0.5), 2))
        assertEquals(listOf(0.3f, 0.3f, 0.3f), JamClip.bars(emptyList(), 3))
        assertEquals(emptyList<Float>(), JamClip.bars(listOf(1.0), 0))
    }
}
