package gg.pqp.app.jam

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a shared song asks for and which link goes with it: the web's rules (`jam-share-text.ts`, `jam-share-link.ts`). */
class JamShareTest {

    private fun song(
        mode: JamJoinMode,
        wanted: List<JamInstrument> = emptyList(),
        present: List<JamInstrument> = emptyList(),
    ) = JamSongSummary(id = "s1", channelId = "c1", title = "Lua", joinMode = mode, wantedInstruments = wanted, instruments = present)

    private fun take(author: String, instrument: JamInstrument, inMix: Boolean) =
        JamTrack(id = "$author-$instrument", songId = "s1", authorId = author, instrument = instrument, inMix = inMix)

    @Test
    fun `a wanted song still needs what it asks for minus what is in the band`() {
        val wanted = song(JamJoinMode.Wanted, listOf(JamInstrument.Bass, JamInstrument.Drums, JamInstrument.Vocals), listOf(JamInstrument.Guitar, JamInstrument.Bass))
        assertEquals(listOf(JamInstrument.Drums, JamInstrument.Vocals), JamShare.stillNeeds(wanted))
    }

    @Test
    fun `the parts the sender sent and that wait for the starter are not asked of their friends`() {
        val wanted = song(JamJoinMode.Wanted, listOf(JamInstrument.Bass, JamInstrument.Drums), listOf(JamInstrument.Guitar))
        assertEquals(listOf(JamInstrument.Drums), JamShare.stillNeeds(wanted, pending = listOf(JamInstrument.Bass)))
    }

    @Test
    fun `an open or a closed song names nothing`() {
        assertTrue(JamShare.stillNeeds(song(JamJoinMode.Open, listOf(JamInstrument.Bass))).isEmpty())
        assertTrue(JamShare.stillNeeds(song(JamJoinMode.Closed, listOf(JamInstrument.Bass))).isEmpty())
    }

    @Test
    fun `the message kind follows the join mode and what is missing`() {
        assertEquals(JamShare.Kind.Listen, JamShare.kind(JamJoinMode.Closed, listOf(JamInstrument.Bass)))
        assertEquals(JamShare.Kind.Needs, JamShare.kind(JamJoinMode.Wanted, listOf(JamInstrument.Bass)))
        assertEquals(JamShare.Kind.Needs, JamShare.kind(JamJoinMode.Open, listOf(JamInstrument.Bass)))
        assertEquals(JamShare.Kind.Open, JamShare.kind(JamJoinMode.Open, emptyList()))
        // A wanted song with nothing left to ask for is done: an invitation to listen.
        assertEquals(JamShare.Kind.Listen, JamShare.kind(JamJoinMode.Wanted, emptyList()))
    }

    @Test
    fun `only the sender's own parts out of the mix are pending, and a starter has none`() {
        val tracks = listOf(
            take("me", JamInstrument.Bass, inMix = false),
            take("me", JamInstrument.Bass, inMix = false),
            take("me", JamInstrument.Guitar, inMix = true),
            take("other", JamInstrument.Drums, inMix = false),
        )
        assertEquals(listOf(JamInstrument.Bass), JamShare.pendingOf(tracks, "me", isStarter = false))
        assertTrue(JamShare.pendingOf(tracks, "me", isStarter = true).isEmpty())
        assertTrue(JamShare.pendingOf(tracks, null, isStarter = false).isEmpty())
    }

    @Test
    fun `a share is offered only for a public live song with a channel, on an account with public jam`() {
        assertTrue(JamShare.offered(true, "live", "c1"))
        assertFalse("flag off", JamShare.offered(false, "live", "c1"))
        assertFalse("a private channel song keeps today's link", JamShare.offered(true, null, "c1"))
        assertFalse("waiting for review has no page that opens", JamShare.offered(true, "review", "c1"))
        assertFalse(JamShare.offered(true, "hidden", "c1"))
        assertFalse(JamShare.offered(true, "unpublished", "c1"))
        assertFalse("no channel", JamShare.offered(true, "live", null))
        assertFalse(JamShare.offered(true, "live", ""))
    }

    @Test
    fun `the hosted instance hands out the jam site's page with ref=share, a self-host its own`() {
        assertEquals("https://jam.pqp.gg/m/abc?ref=share", JamShare.publicLink("https://pqp.gg", "abc"))
        assertEquals("https://jam.pqp.gg/m/abc?ref=share", JamShare.publicLink("https://www.pqp.gg/", "abc"))
        assertEquals("https://chat.example.org/jam/m/abc?ref=share", JamShare.publicLink("https://chat.example.org", "abc"))
        assertEquals("http://localhost:5173/jam/m/abc?ref=share", JamShare.publicLink("http://localhost:5173/", "abc"))
    }

    /** Never an `/app/...` address: a stranger cannot open that. */
    @Test
    fun `a public link is never the app's own route`() {
        assertFalse(JamShare.publicLink("https://pqp.gg", "abc").contains("/app/"))
    }
}
