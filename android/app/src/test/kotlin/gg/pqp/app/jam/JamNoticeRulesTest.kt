package gg.pqp.app.jam

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pure rules behind the notices: which card is drawn, where a song's id leads, what an answer says. */
class JamNoticeRulesTest {

    private fun notice(id: String, kind: JamTakeNoticeKind = JamTakeNoticeKind.Take) =
        JamTakeNotice(id, kind, "s-$id", "Song $id", listOf(JamInstrument.Bass), 1)

    private fun item(id: String, songId: String, at: String = "2026-11-27T10:00:00.000Z", title: String = "T") =
        JamPublicInboxItem(songId, title, JamTrack(id = id, songId = songId, createdAt = at, instrument = JamInstrument.Drums))

    // --- which one is drawn ---

    @Test
    fun `the newest card is drawn, with how many wait behind it`() {
        val queue = JamNoticeRules.queue(listOf(notice("a"), notice("b"), notice("c")), toastWaiting = false, held = false)
        assertEquals("a", queue.card?.id)
        assertEquals(2, queue.more)
        assertEquals(false, queue.toast)
    }

    @Test
    fun `a toast comes first and holds the cards back, one at a time`() {
        val queue = JamNoticeRules.queue(listOf(notice("a")), toastWaiting = true, held = false)
        assertTrue(queue.toast)
        assertNull(queue.card)
    }

    @Test
    fun `nothing is drawn while a song or the studio is open, and what waits keeps its place`() {
        val held = JamNoticeRules.queue(listOf(notice("a")), toastWaiting = true, held = true)
        assertEquals(JamNoticeQueue(), held)
        // Back on the wall the same card is there.
        assertEquals("a", JamNoticeRules.queue(listOf(notice("a")), toastWaiting = false, held = false).card?.id)
    }

    @Test
    fun `no notices draws nothing`() {
        assertEquals(JamNoticeQueue(), JamNoticeRules.queue(emptyList(), toastWaiting = false, held = false))
    }

    // --- the starter's inbox ---

    @Test
    fun `the waiting takes of one song come oldest first`() {
        val inbox = listOf(
            item("t2", "s1", at = "2026-11-27T10:05:00.000Z"),
            item("t1", "s1", at = "2026-11-27T10:00:00.000Z"),
            item("t3", "s2"),
        )
        assertEquals(listOf("t1", "t2"), JamNoticeRules.pending(inbox, "s1").map { it.id })
        assertEquals(2, JamNoticeRules.waitingCount(inbox, "s1"))
        assertEquals(0, JamNoticeRules.waitingCount(inbox, "nope"))
    }

    @Test
    fun `songs with a part waiting are listed with their counts, and the wall asks only for its own`() {
        val inbox = listOf(item("t1", "s1", title = "Lua"), item("t2", "s1", title = "Lua"), item("t3", "s2", title = "Sol"))
        assertEquals(
            listOf(JamNoticeRules.WaitingSong("s1", "Lua", 2), JamNoticeRules.WaitingSong("s2", "Sol", 1)),
            JamNoticeRules.songsWaiting(inbox),
        )
        assertEquals(listOf("s2"), JamNoticeRules.waitingOn(inbox, setOf("s2", "s3")).map { it.songId })
        assertTrue(JamNoticeRules.waitingOn(inbox, emptySet()).isEmpty())
    }

    @Test
    fun `taking a part out of the inbox keeps its song's card until the last one is answered`() {
        val state = JamNoticeState(
            enabled = true,
            inbox = listOf(item("t1", "s1"), item("t2", "s1"), item("t3", "s2")),
            notices = listOf(
                JamTakeNotice("n1", JamTakeNoticeKind.Take, "s1", "x", emptyList(), 2),
                JamTakeNotice("n2", JamTakeNoticeKind.Accepted, "s1", "x", emptyList(), 1),
                JamTakeNotice("n3", JamTakeNoticeKind.Take, "s2", "x", emptyList(), 1),
            ),
        )
        val one = JamNoticeRules.afterDrop(state, "t1")
        assertEquals(listOf("n1", "n2", "n3"), one.notices.map { it.id })
        val two = JamNoticeRules.afterDrop(one, "t2")
        // The take card of s1 goes; the sender-side item of the same song is another matter and stays.
        assertEquals(listOf("n2", "n3"), two.notices.map { it.id })
        assertEquals(listOf("t3"), two.inbox.map { it.track.id })
        // A part that is not in the inbox changes nothing.
        assertEquals(two, JamNoticeRules.afterDrop(two, "ghost"))
    }

    // --- the Listen button's label follows real playback ---

    private val bass = JamTrack(id = "t1", songId = "s1", instrument = JamInstrument.Bass)
    private val drums = JamTrack(id = "t2", songId = "s1", instrument = JamInstrument.Drums)

    @Test
    fun `a part is listened to only while it plays or is about to`() {
        val chosen = mapOf(JamInstrument.Bass to "t1")
        assertEquals(setOf("t1"), JamNoticeRules.listening(listOf(bass, drums), chosen, playing = true, playPending = false))
        assertEquals("its file is still on its way", setOf("t1"), JamNoticeRules.listening(listOf(bass, drums), chosen, playing = false, playPending = true))
    }

    @Test
    fun `after the clip ends, or when playback was refused, nobody is listened to`() {
        val chosen = mapOf(JamInstrument.Bass to "t1")
        assertTrue(JamNoticeRules.listening(listOf(bass, drums), chosen, playing = false, playPending = false).isEmpty())
    }

    @Test
    fun `only the chosen take of an instrument is listened to`() {
        val chosen = mapOf(JamInstrument.Bass to "someone-else")
        assertTrue(JamNoticeRules.listening(listOf(bass), chosen, playing = true, playPending = false).isEmpty())
    }

    // --- where a song's id leads ---

    private fun place(server: String? = "srv", channel: String? = "chan") = JamSongPlace.Place("s1", server, channel, "Lua")

    @Test
    fun `a channel song of a server this account is in opens as a wall`() {
        assertEquals(JamSongOpening.InApp("srv", "chan"), JamSongOpening.of(place(), null) { it == "srv" })
    }

    @Test
    fun `a standalone public song has no phone screen, so the web opens it`() {
        assertEquals(JamSongOpening.Web, JamSongOpening.of(place(server = null, channel = null), null) { true })
        assertEquals(JamSongOpening.Web, JamSongOpening.of(place(channel = null), null) { true })
    }

    @Test
    fun `a song of a server this account is not in is not a dead wall, the web opens it`() {
        assertEquals(JamSongOpening.Web, JamSongOpening.of(place(), null) { false })
    }

    @Test
    fun `a missing song is gone and a failed read is failed, never guessed`() {
        assertEquals(JamSongOpening.Gone, JamSongOpening.of(null, 404) { true })
        assertEquals(JamSongOpening.Failed, JamSongOpening.of(null, null) { true })
        assertEquals(JamSongOpening.Failed, JamSongOpening.of(null, 500) { true })
        assertEquals(JamSongOpening.Failed, JamSongOpening.of(null, 403) { true })
    }

    @Test
    fun `the web address of a public song is the one the web's own push opens`() {
        assertEquals("https://pqp.gg/app/jam/abc", jamPublicSongAppLink("https://pqp.gg/", "abc"))
    }

    // --- what an answer says ---

    @Test
    fun `an accept box stays eight seconds and a taken-back one five`() {
        val accepted = JamAnswer(JamAnswerKind.Accepted, "t1", JamInstrument.Bass, "bob")
        assertEquals(8_000L, accepted.lifetimeMs)
        assertEquals(5_000L, accepted.copy(kind = JamAnswerKind.Undone).lifetimeMs)
        assertEquals(8_000L, accepted.copy(kind = JamAnswerKind.Refused).lifetimeMs)
    }
}
