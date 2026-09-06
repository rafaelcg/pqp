package gg.pqp.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The branch that decides whether somebody joins a call or is sent away.
 *
 * Worth its own test because both of its wrong answers are silent. Refusing a
 * transport this client can run locks Android out of every room the server puts
 * on it, which is what shipped, and what people hit live. Accepting one it
 * cannot run is the opposite and worse: the person appears on everybody's
 * roster and hears nothing, and so does everybody else.
 */
class VoiceTransportKindTest {

    @Test
    fun `mesh is mesh`() {
        assertEquals(VoiceTransportKind.Mesh, voiceTransportKindFor("mesh"))
    }

    @Test
    fun `livekit is livekit`() {
        assertEquals(VoiceTransportKind.LiveKit, voiceTransportKindFor("livekit"))
    }

    /**
     * An absent transport is mesh, and that is not a guess.
     *
     * A `welcome` with no `transport` at all is what a pre-SFU server sends,
     * and mesh is the only thing it could have meant. Refusing here would break
     * this client against an older self-hosted instance for no reason.
     */
    @Test
    fun `an absent transport is mesh`() {
        assertEquals(VoiceTransportKind.Mesh, voiceTransportKindFor(null))
    }

    /**
     * Anything else refuses, including the transport that is next.
     *
     * `cloudflare-sfu` exists in the server's own backend enum today (as a stub
     * that falls back to mesh). The day it stops being a stub, this client must
     * refuse it rather than guess, because the server only ever names a
     * transport the client said it could run: an unrecognised value here means
     * the declaration and this function have drifted apart, and mesh is the one
     * answer that is certainly wrong.
     */
    @Test
    fun `an unknown transport refuses rather than guessing`() {
        assertNull(voiceTransportKindFor("cloudflare-sfu"))
        assertNull(voiceTransportKindFor(""))
        assertNull(voiceTransportKindFor("Mesh"))
        assertNull(voiceTransportKindFor("livekit "))
    }
}
