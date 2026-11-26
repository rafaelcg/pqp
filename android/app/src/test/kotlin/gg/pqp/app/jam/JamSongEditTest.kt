package gg.pqp.app.jam

import gg.pqp.app.core.PqpJson
import gg.pqp.app.protocol.RepoSources
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Title, artist and cover: the text rules (the server's own), what a save means, and the cover's numbers. */
class JamSongEditTest {

    private fun song(title: String = "In Bloom", artist: String? = "Nirvana", cover: String? = null) = JamSongSummary(
        id = "s", channelId = "c", title = title, artist = artist, coverUrl = cover,
    )

    private fun ok(value: String?) = JamText.Checked.Ok(value)

    // --- the text rule ---

    @Test
    fun `a title is cleaned the way the server cleans it, and refused for the reasons it refuses`() {
        assertEquals(ok("In Bloom"), JamText.checkTitle("  In   Bloom \n"))
        // Bidi override, embedding and isolate controls are stripped, not refused.
        assertEquals(ok("Song"), JamText.checkTitle("‮Song⁩"))
        assertEquals(JamText.Checked.Empty, JamText.checkTitle("   "))
        // Nothing but zero-width characters looks empty and is not: it has its own message.
        assertEquals(JamText.Checked.Invisible, JamText.checkTitle("​‍⠀"))
        assertEquals(JamText.Checked.Invalid, JamText.checkTitle("a\u0007b"))
        assertEquals(JamText.Checked.Long, JamText.checkTitle("x".repeat(JamLimits.TITLE_MAX + 1)))
        assertEquals(ok("x".repeat(JamLimits.TITLE_MAX)), JamText.checkTitle("x".repeat(JamLimits.TITLE_MAX)))
        // One visible character anywhere is enough: a ZWJ family, an Arabic word, a tone-marked syllable.
        assertEquals(ok("👨‍👩‍👧"), JamText.checkTitle("👨‍👩‍👧"))
        assertEquals(ok("مرحبا"), JamText.checkTitle("مرحبا"))
        assertEquals(ok("Việt"), JamText.checkTitle("Việt"))
    }

    @Test
    fun `an artist may be empty, which means an original, and is cut at its limit`() {
        assertEquals(ok(null), JamText.checkArtist(""))
        assertEquals(ok(null), JamText.checkArtist("   "))
        assertEquals(ok("Nirvana"), JamText.checkArtist(" Nirvana "))
        assertEquals(JamText.Checked.Invisible, JamText.checkArtist("​"))
        assertEquals(ok("a".repeat(JamText.ARTIST_MAX)), JamText.checkArtist("a".repeat(JamText.ARTIST_MAX + 40)))
    }

    @Test
    fun `the limits are the shared ones`() {
        assertEquals(RepoSources.numberConstant("packages/shared/src/jam.ts", "JAM_ARTIST_MAX"), JamText.ARTIST_MAX)
        assertEquals(RepoSources.numberConstant("packages/shared/src/jam.ts", "JAM_TITLE_MAX"), JamLimits.TITLE_MAX)
    }

    // --- what saving means ---

    @Test
    fun `an untouched sheet is nothing to save, a title edited back to what it was is not a write`() {
        assertTrue(JamSongEdit.plan(song(), "In Bloom", "Nirvana", CoverChoice.Keep).empty)
        assertTrue(JamSongEdit.plan(song(), "  In   Bloom ", "Nirvana ", CoverChoice.Keep).empty)
    }

    @Test
    fun `only the field that changed is sent`() {
        assertEquals(SongPatch(title = "Lithium"), JamSongEdit.plan(song(), "Lithium", "Nirvana", CoverChoice.Keep).patch)
        assertEquals(
            SongPatch(setArtist = true, artist = "Foo"),
            JamSongEdit.plan(song(), "In Bloom", "Foo", CoverChoice.Keep).patch,
        )
        assertEquals(
            SongPatch(title = "Lithium", setArtist = true, artist = "Foo"),
            JamSongEdit.plan(song(), "Lithium", "Foo", CoverChoice.Keep).patch,
        )
    }

    @Test
    fun `emptying the artist clears it with an explicit null, and the request body says so`() {
        val plan = JamSongEdit.plan(song(), "In Bloom", "", CoverChoice.Keep)
        assertEquals(SongPatch(setArtist = true, artist = null), plan.patch)
        // The app's JSON omits nulls, which would turn "clear it" into "nothing to update": the body is built by hand.
        val body = plan.patch!!.toJson()
        assertEquals(JsonNull, body["artist"])
        assertNull(body["title"])
        assertEquals("""{"artist":null}""", PqpJson.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), body))
        assertEquals(JsonPrimitive("Lithium"), SongPatch(title = "Lithium").toJson()["title"])
        assertNull(SongPatch(title = "Lithium").toJson()["artist"])
    }

    @Test
    fun `an original stays an original, and a song with no artist given one is a change`() {
        assertTrue(JamSongEdit.plan(song(artist = null), "In Bloom", "", CoverChoice.Keep).empty)
        assertEquals(SongPatch(setArtist = true, artist = "Foo"), JamSongEdit.plan(song(artist = null), "In Bloom", "Foo", CoverChoice.Keep).patch)
    }

    @Test
    fun `a title that will be refused is not a change`() {
        assertTrue(JamSongEdit.plan(song(), "", "Nirvana", CoverChoice.Keep).empty)
        assertTrue(JamSongEdit.plan(song(), "​", "Nirvana", CoverChoice.Keep).empty)
    }

    @Test
    fun `a row from before bidi controls were stripped is compared as the server would store it`() {
        assertTrue(JamSongEdit.plan(song(title = "‮In Bloom"), "In Bloom", "Nirvana", CoverChoice.Keep).empty)
    }

    @Test
    fun `the cover is set, removed only when there is one, and kept otherwise`() {
        val withCover = song(cover = "https://x/jam/s/cover.jpg?sig=1")
        assertEquals(CoverOp.Set("u1"), JamSongEdit.plan(song(), "In Bloom", "Nirvana", CoverChoice.New("u1")).cover)
        assertEquals(CoverOp.Remove, JamSongEdit.plan(withCover, "In Bloom", "Nirvana", CoverChoice.Remove).cover)
        // Removing a cover that is not there is nothing.
        assertTrue(JamSongEdit.plan(song(), "In Bloom", "Nirvana", CoverChoice.Remove).empty)
        assertNull(JamSongEdit.plan(withCover, "In Bloom", "Nirvana", CoverChoice.Keep).cover)
    }

    // --- the cover's numbers are the contract's ---

    @Test
    fun `the cover limits are the shared ones, and what the phone sends is allowed`() {
        val shared = "packages/shared/src/jam.ts"
        assertEquals(RepoSources.numberConstant(shared, "JAM_COVER_SIZE"), JamCover.SIZE)
        assertTrue(RepoSources.read(shared).contains("JAM_COVER_MAX_BYTES = 4 * 1024 * 1024"))
        assertEquals(4 * 1024 * 1024, JamCover.MAX_BYTES)
        val types = Regex("""JAM_COVER_CONTENT_TYPES\s*=\s*\[([^\]]*)]""").find(RepoSources.read(shared))!!.groupValues[1]
        assertEquals(JamCover.CONTENT_TYPES, Regex("\"([^\"]+)\"").findAll(types).map { it.groupValues[1] }.toList())
        assertTrue(JamCover.SEND_TYPE in JamCover.CONTENT_TYPES)
        // The smallest side is the web's.
        assertEquals(RepoSources.numberConstant("client/src/lib/jam-cover.ts", "JAM_COVER_MIN_SIDE"), JamCover.MIN_SIDE)
    }

    @Test
    fun `a photo is judged before it is decoded in full`() {
        assertEquals(JamCover.Verdict.Ok, JamCover.check(4000, 3000))
        assertEquals(JamCover.Verdict.Ok, JamCover.check(400, 400))
        assertEquals(JamCover.Verdict.Small(399, 4000), JamCover.check(399, 4000))
        assertEquals(JamCover.Verdict.Unreadable, JamCover.check(0, 0))
        assertEquals(JamCover.Verdict.Unreadable, JamCover.check(-1, 800))
    }

    @Test
    fun `the square is the centre, and a big photo is read at a power of two that keeps the 1024`() {
        assertEquals(Triple(500, 0, 3000), JamCover.centredSquare(4000, 3000))
        assertEquals(Triple(0, 250, 1000), JamCover.centredSquare(1000, 1500))
        assertEquals(1, JamCover.sampleSize(1500, 1200))
        assertEquals(2, JamCover.sampleSize(4000, 2200))
        assertEquals(4, JamCover.sampleSize(8000, 6000))
        // Never below the square it ends as.
        assertTrue(6000 / JamCover.sampleSize(8000, 6000) >= JamCover.SIZE)
    }
}
