package gg.pqp.app.soundboard

import gg.pqp.app.core.PqpJson
import gg.pqp.app.protocol.RepoSources
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
}
