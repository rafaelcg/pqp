package gg.pqp.app.soundboard

import gg.pqp.app.core.PqpJson
import gg.pqp.app.protocol.RepoSources
import kotlinx.coroutines.async
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The board's wire contract, read from `packages/shared/src/soundboard.ts`, and the budget it keeps in front of the socket. */
class SoundboardTest {

    private fun frame(json: String): JsonObject = PqpJson.decodeFromString(JsonObject.serializer(), json)

    @Test
    fun `the built-in clips are the shared ones, in the same order`() {
        val shared = RepoSources.read("packages/shared/src/soundboard.ts")
        val rows = Regex("""\{ id: "(builtin:[a-z-]+)", emoji: "([^"]+)", file: "([a-z-]+)\.mp3", durationMs: (\d+) \}""").findAll(shared).toList()
        assertEquals(SoundboardBuiltins.ALL.size, rows.size)
        rows.zip(SoundboardBuiltins.ALL).forEach { (row, ours) ->
            assertEquals(row.groupValues[1], ours.id)
            assertEquals(row.groupValues[2], ours.emoji)
            assertEquals(row.groupValues[4].toLong(), ours.durationMs)
        }
    }

    @Test
    fun `the bundled files are the web's own, byte for byte`() {
        val shared = RepoSources.read("packages/shared/src/soundboard.ts")
        val files = Regex("""file: "([a-z-]+\.mp3)"""").findAll(shared).map { it.groupValues[1] }.toList()
        for (file in files) {
            val web = java.io.File(RepoSources.root, "client/public/sounds/soundboard/$file")
            val ours = java.io.File(RepoSources.root, "android/app/src/main/res/raw/${file.replace('-', '_')}")
            assertTrue("$file is missing", web.exists() && ours.exists())
            assertTrue("$file differs from the web's copy", web.readBytes().contentEquals(ours.readBytes()))
        }
    }

    @Test
    fun `the play budget is the shared one`() {
        val shared = RepoSources.read("packages/shared/src/soundboard.ts")
        assertEquals(Regex("""SOUNDBOARD_PLAY_BURST = (\d+)""").find(shared)!!.groupValues[1].toInt(), PlayBudget.BURST)
        assertEquals(Regex("""SOUNDBOARD_PLAY_REFILL_MS = ([\d_]+)""").find(shared)!!.groupValues[1].replace("_", "").toLong(), PlayBudget.REFILL_MS)
    }

    @Test
    fun `a burst of five, then one every two seconds`() {
        val budget = PlayBudget()
        repeat(5) { assertTrue(budget.take(1_000)) }
        assertFalse(budget.take(1_000))
        assertFalse(budget.take(2_999))
        assertTrue(budget.take(3_000))
        assertFalse(budget.take(3_001))
        // Two full periods earn two.
        assertTrue(budget.take(7_000))
        assertTrue(budget.take(7_000))
        assertFalse(budget.take(7_000))
    }

    @Test
    fun `a play that could not leave gives its token back, and a full bucket banks no time`() {
        val budget = PlayBudget()
        repeat(5) { assertTrue(budget.take(0)) }
        budget.refund()
        assertTrue(budget.take(0))
        assertFalse(budget.take(0))
        val idle = PlayBudget()
        // A long quiet spell does not save up more than the burst.
        assertTrue(idle.take(1_000_000))
        repeat(4) { assertTrue(idle.take(1_000_000)) }
        assertFalse(idle.take(1_000_000))
    }

    @Test
    fun `a play frame names the channel and the clip, and only that`() {
        val played = SoundboardFrames.played(
            frame("""{"type":"soundboard-play","channelId":"c1","soundId":"builtin:risada","userId":"u1","displayName":"Ana","emoji":"x","playedAt":1}"""),
        )
        assertEquals(PlayedSound("c1", "builtin:risada", "u1"), played)
        assertNull(SoundboardFrames.played(frame("""{"type":"typing","channelId":"c1","soundId":"x"}""")))
        assertNull(SoundboardFrames.played(frame("""{"type":"soundboard-play","channelId":"c1"}""")))
        assertEquals(
            """{"type":"soundboard-play","channelId":"c1","soundId":"builtin:grilo"}""",
            SoundboardFrames.playFrame("c1", "builtin:grilo").toString(),
        )
    }

    @Test
    fun `the volume is the listener's level times the clip's, never above one`() {
        assertEquals(0.3f, SoundboardFrames.gain(0.6, 0.5), 0.0001f)
        assertEquals(0.6f, SoundboardFrames.gain(0.6, 1.0), 0.0001f)
        assertEquals(1f, SoundboardFrames.gain(3.0, 2.0), 0.0001f)
        assertEquals(0f, SoundboardFrames.gain(-1.0, 1.0), 0.0001f)
    }

    @Test
    fun `the catalog and the voice config decode what the server sends`() {
        val page = PqpJson.decodeFromString(
            SoundboardPage.serializer(),
            """{"sounds":[{"id":"s1","name":"Boom","emoji":"x","contentType":"audio/mpeg","byteSize":10,"durationMs":900,"volume":0.8,"url":"https://s/x","addedBy":null}],"maxSounds":6,"slotsUsed":1}""",
        )
        assertEquals("Boom", page.sounds.single().name)
        assertEquals(0.8, page.sounds.single().volume, 0.0)
        assertTrue(PqpJson.decodeFromString(VoiceConfig.serializer(), """{"audienceMode":false,"audioSelfHeal":true,"soundboard":true}""").soundboard)
        assertFalse(PqpJson.decodeFromString(VoiceConfig.serializer(), "{}").soundboard)
    }

    // --- which server holds the channel ---

    @Test
    fun `the search stops at the first server that holds the channel`() = kotlinx.coroutines.test.runTest {
        val owners = ChannelOwners()
        val asked = mutableListOf<String>()
        val found = owners.find("c2", listOf("s1", "s2", "s3", "s4")) { server ->
            asked += server
            if (server == "s2") listOf("c2" to "s2", "c9" to "s2") else listOf("x$server" to server)
        }
        assertEquals(ChannelOwners.Lookup.Found("s2"), found)
        assertEquals(listOf("s1", "s2"), asked)
    }

    @Test
    fun `what was read is remembered, and a server is never read twice`() = kotlinx.coroutines.test.runTest {
        val owners = ChannelOwners()
        val asked = mutableListOf<String>()
        val fetch: suspend (String) -> List<Pair<String, String>>? = { server ->
            asked += server
            listOf("c-$server" to server)
        }
        assertEquals(ChannelOwners.Lookup.Found("s1"), owners.find("c-s1", listOf("s1", "s2"), fetch))
        assertEquals(ChannelOwners.Lookup.Found("s1"), owners.find("c-s1", listOf("s1", "s2"), fetch))
        assertEquals(ChannelOwners.Lookup.Found("s2"), owners.find("c-s2", listOf("s1", "s2"), fetch))
        assertEquals(ChannelOwners.Lookup.None, owners.find("conversation", listOf("s1", "s2"), fetch))
        assertEquals(listOf("s1", "s2"), asked)
    }

    @Test
    fun `a server that could not be read concludes nothing, unless another holds the channel`() = kotlinx.coroutines.test.runTest {
        val owners = ChannelOwners()
        val down: suspend (String) -> List<Pair<String, String>>? = { server -> if (server == "s1") null else listOf("c-$server" to server) }
        assertEquals(ChannelOwners.Lookup.Failed, owners.find("conversation", listOf("s1", "s2"), down))
        assertEquals(ChannelOwners.Lookup.Found("s2"), owners.find("c-s2", listOf("s1", "s2"), down))
        // The failed server is tried again on the next ask.
        val up: suspend (String) -> List<Pair<String, String>>? = { server -> listOf("c-$server" to server) }
        assertEquals(ChannelOwners.Lookup.Found("s1"), owners.find("c-s1", listOf("s1", "s2"), up))
    }

    // --- one download per clip ---

    @Test
    fun `plays that arrive while a clip downloads wait for the same one`() = kotlinx.coroutines.test.runTest {
        val flights = SingleFlight<String, Boolean>(backgroundScope)
        var runs = 0
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        val results = (1..4).map {
            async {
                flights.run("clip") {
                    runs += 1
                    gate.await()
                    true
                }
            }
        }
        kotlinx.coroutines.yield()
        gate.complete(Unit)
        assertEquals(listOf(true, true, true, true), results.map { it.await() })
        assertEquals(1, runs)
    }

    @Test
    fun `a finished or failed download is forgotten, so the next play can try again`() = kotlinx.coroutines.test.runTest {
        val flights = SingleFlight<String, Boolean>(backgroundScope)
        var runs = 0
        assertFalse(flights.run("clip") { runs += 1; false })
        assertTrue(flights.run("clip") { runs += 1; true })
        // Other clips do not wait for each other.
        assertTrue(flights.run("other") { runs += 1; true })
        assertEquals(3, runs)
    }
}
