package gg.pqp.app.voice

import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.VoiceParticipant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The target side of a server mute, and the wire field that carries it.
 *
 * `serverMuted` travels on every `VoiceParticipant` (`welcome`, `voice-roster`,
 * `peer-joined`, `peer-updated`) and an old server simply omits it, so the two
 * decode cases below are the whole compatibility story: present and true means
 * muted, absent means not. Everything else here is what this device does when
 * the roster says the flag is about *us*: the microphone is forced off, the
 * mute button goes inert, and lifting the flag hands nothing back without the
 * person asking.
 */
class ServerMuteTest {

    private fun participant(peerId: String, extra: String = ""): String = """
        {
          "peerId": "$peerId",
          "userId": "11111111-1111-1111-1111-111111111111",
          "displayName": "Rafa",
          "avatarUrl": null,
          "sharingScreen": false,
          "muted": false,
          "deafened": false$extra
        }
    """.trimIndent()

    private fun decode(json: String): VoiceParticipant =
        PqpJson.decodeFromString(VoiceParticipant.serializer(), json)

    // --- the wire field -----------------------------------------------------

    @Test
    fun `serverMuted decodes when the server sends it`() {
        assertTrue(decode(participant("p1", extra = ",\n  \"serverMuted\": true")).serverMuted)
        assertFalse(decode(participant("p1", extra = ",\n  \"serverMuted\": false")).serverMuted)
    }

    @Test
    fun `serverMuted defaults to false on a server that predates it`() {
        assertFalse(decode(participant("p1")).serverMuted)
    }

    // --- the local person ---------------------------------------------------

    private fun self(serverMuted: Boolean) =
        VoiceParticipant(peerId = "me", userId = "u", displayName = "Me", serverMuted = serverMuted)

    private fun bob(serverMuted: Boolean = false) =
        VoiceParticipant(peerId = "bob", userId = "u2", displayName = "Bob", serverMuted = serverMuted)

    private val inCall = VoiceState(stage = VoiceStage.Connected, localPeerId = "me")

    @Test
    fun `a roster that server-mutes us forces the microphone off`() {
        val state = inCall.absorbServerMute(listOf(self(true), bob()), "me")

        assertTrue(state.serverMuted)
        assertTrue(state.muted)
        assertFalse(state.muteControlEnabled)
    }

    @Test
    fun `lifting the flag leaves us muted until we unmute ourselves`() {
        val muted = inCall.absorbServerMute(listOf(self(true)), "me")

        val lifted = muted.absorbServerMute(listOf(self(false)), "me")

        assertFalse(lifted.serverMuted)
        assertTrue("A moderator's mute must not hand the microphone back unasked", lifted.muted)
        assertTrue(lifted.muteControlEnabled)
    }

    @Test
    fun `a self-mute already on survives the round trip`() {
        val state = inCall.copy(muted = true)
            .absorbServerMute(listOf(self(true)), "me")
            .absorbServerMute(listOf(self(false)), "me")
        assertTrue(state.muted)
    }

    @Test
    fun `somebody else being muted does not touch our microphone`() {
        val state = inCall.absorbServerMute(listOf(self(false), bob(serverMuted = true)), "me")

        assertFalse(state.serverMuted)
        assertFalse(state.muted)
        assertTrue(state.muteControlEnabled)
    }

    @Test
    fun `a roster we are not on keeps the last known flag`() {
        // `peer-joined` carries one peer, never us; it must not read as "unmuted".
        val muted = inCall.absorbServerMute(listOf(self(true)), "me")
        val after = muted.absorbServerMute(listOf(bob()), "me")
        assertTrue(after.serverMuted)
    }

    @Test
    fun `the unmute control is inert exactly while server-muted`() {
        assertTrue(inCall.copy(muted = true).muteControlEnabled)
        assertFalse(inCall.copy(muted = true, serverMuted = true).muteControlEnabled)
    }

    // --- the peers the bar lists --------------------------------------------

    @Test
    fun `the muted-peer list names the others and never us`() {
        val state = inCall.copy(participants = listOf(self(true), bob(serverMuted = true), bob().copy(peerId = "carol")))
        assertEquals(listOf("bob"), state.serverMutedPeers().map { it.peerId })
    }
}
