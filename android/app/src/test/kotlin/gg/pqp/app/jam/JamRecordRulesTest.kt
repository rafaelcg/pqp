package gg.pqp.app.jam

import org.junit.Assert.assertEquals
import org.junit.Test

/** Whether the record button is offered, and the sentence when it is not: the web's `jam.song.cannot.*`. */
class JamRecordRulesTest {
    private fun song(mode: JamJoinMode = JamJoinMode.Open, wanted: List<JamInstrument> = emptyList(), missing: List<JamInstrument>? = null) =
        JamSongSummary(id = "s", channelId = "c", title = "t", joinMode = mode, wantedInstruments = wanted, missingInstruments = missing)

    private fun viewer(addable: List<JamInstrument>, author: Boolean = false) = JamSongViewer(isAuthor = author, addableInstruments = addable)

    private val on = JamConfig(enabled = true, uploads = true)

    @Test
    fun `an open song with something to add is open to record`() {
        assertEquals(RecordGate.Open, JamRecordRules.gate(on, song(), viewer(JamInstrument.entries)))
    }

    @Test
    fun `the flag and storage come before anything the song says`() {
        val closed = song(JamJoinMode.Closed)
        assertEquals(RecordGate.Blocked(RecordGate.Reason.Off), JamRecordRules.gate(JamConfig(enabled = false, uploads = true), closed, viewer(emptyList())))
        assertEquals(RecordGate.Blocked(RecordGate.Reason.UploadsOff), JamRecordRules.gate(JamConfig(enabled = true, uploads = false), song(), viewer(JamInstrument.entries)))
    }

    @Test
    fun `a closed song says so to everybody but its author, who may always add`() {
        assertEquals(RecordGate.Blocked(RecordGate.Reason.Closed), JamRecordRules.gate(on, song(JamJoinMode.Closed), viewer(emptyList())))
        assertEquals(RecordGate.Open, JamRecordRules.gate(on, song(JamJoinMode.Closed), viewer(JamInstrument.entries, author = true)))
    }

    @Test
    fun `nothing addable for any other reason is the general sentence`() {
        // A full song, a person at their own limit, somebody who cannot post here: the server's `addableInstruments` is empty.
        assertEquals(RecordGate.Blocked(RecordGate.Reason.Other), JamRecordRules.gate(on, song(), viewer(emptyList())))
        assertEquals(RecordGate.Blocked(RecordGate.Reason.Other), JamRecordRules.gate(on, song(JamJoinMode.Wanted, listOf(JamInstrument.Bass)), viewer(emptyList())))
    }

    @Test
    fun `starting a song needs the flag and storage and nothing else`() {
        assertEquals(RecordGate.Open, JamRecordRules.gateNewSong(on))
        assertEquals(RecordGate.Blocked(RecordGate.Reason.Off), JamRecordRules.gateNewSong(JamConfig.Off))
        assertEquals(RecordGate.Blocked(RecordGate.Reason.UploadsOff), JamRecordRules.gateNewSong(JamConfig(enabled = true, uploads = false)))
    }

    @Test
    fun `the instrument offered first is the one the song is missing, then a wanted one, then the first addable`() {
        val all = JamInstrument.entries
        assertEquals(JamInstrument.Vocals, JamRecordRules.firstChoice(all, song(missing = listOf(JamInstrument.Vocals))))
        assertEquals(JamInstrument.Bass, JamRecordRules.firstChoice(listOf(JamInstrument.Bass), song(JamJoinMode.Wanted, listOf(JamInstrument.Bass), missing = emptyList())))
        assertEquals(JamInstrument.Guitar, JamRecordRules.firstChoice(all, song()))
        assertEquals(JamInstrument.Keys, JamRecordRules.firstChoice(listOf(JamInstrument.Keys), song(missing = listOf(JamInstrument.Vocals))))
    }

    @Test
    fun `only a wanted song asks for instruments`() {
        assertEquals(listOf(JamInstrument.Bass), JamRecordRules.wanted(song(JamJoinMode.Wanted, listOf(JamInstrument.Bass))))
        assertEquals(emptyList<JamInstrument>(), JamRecordRules.wanted(song(JamJoinMode.Open, listOf(JamInstrument.Bass))))
    }
}
