package gg.pqp.app.voice

import gg.pqp.app.R
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A watch party is a broadcast, not a call, and its own room must never
 * blame "the voice server" or say "this call" for a refusal -- see
 * [voiceRefusalStringRes]'s own doc. This is that claim, pinned refusal by
 * refusal rather than trusted to a screenshot: every failure a watch party's
 * room can plausibly produce gets a stream-flavoured sentence in that
 * context, and every string stays exactly what it always was outside one.
 */
class VoiceRefusalCopyTest {

    @Test
    fun `outside a watch party, every refusal keeps its ordinary call-flavoured sentence`() {
        assertEquals(R.string.voice_room_full, voiceRefusalStringRes(Refusal.RoomFull, inWatchParty = false))
        assertEquals(
            R.string.voice_transport_unsupported,
            voiceRefusalStringRes(Refusal.TransportUnsupported, inWatchParty = false),
        )
        assertEquals(
            R.string.voice_screen_share_denied,
            voiceRefusalStringRes(Refusal.ScreenShareDenied, inWatchParty = false),
        )
        assertEquals(
            R.string.voice_backend_unreachable,
            voiceRefusalStringRes(Refusal.VoiceBackendUnreachable, inWatchParty = false),
        )
        assertEquals(
            R.string.voice_token_refused,
            voiceRefusalStringRes(Refusal.VoiceTokenRefused, inWatchParty = false),
        )
        assertEquals(
            R.string.voice_transport_mismatch,
            voiceRefusalStringRes(Refusal.VoiceTransportMismatch, inWatchParty = false),
        )
        assertEquals(
            R.string.voice_backend_timeout,
            voiceRefusalStringRes(Refusal.VoiceBackendTimedOut, inWatchParty = false),
        )
        assertEquals(R.string.voice_join_refused, voiceRefusalStringRes(Refusal.JoinRefused, inWatchParty = false))
        assertEquals(R.string.voice_join_timeout, voiceRefusalStringRes(Refusal.JoinTimedOut, inWatchParty = false))
    }

    @Test
    fun `inside a watch party, every refusal that can plausibly fire there switches to stream wording`() {
        assertEquals(
            R.string.voice_transport_unsupported_watch_party,
            voiceRefusalStringRes(Refusal.TransportUnsupported, inWatchParty = true),
        )
        assertEquals(
            R.string.voice_screen_share_denied_watch_party,
            voiceRefusalStringRes(Refusal.ScreenShareDenied, inWatchParty = true),
        )
        assertEquals(
            R.string.voice_backend_unreachable_watch_party,
            voiceRefusalStringRes(Refusal.VoiceBackendUnreachable, inWatchParty = true),
        )
        assertEquals(
            R.string.voice_token_refused_watch_party,
            voiceRefusalStringRes(Refusal.VoiceTokenRefused, inWatchParty = true),
        )
        assertEquals(
            R.string.voice_transport_mismatch_watch_party,
            voiceRefusalStringRes(Refusal.VoiceTransportMismatch, inWatchParty = true),
        )
        assertEquals(
            R.string.voice_backend_timeout_watch_party,
            voiceRefusalStringRes(Refusal.VoiceBackendTimedOut, inWatchParty = true),
        )
        assertEquals(
            R.string.voice_join_refused_watch_party,
            voiceRefusalStringRes(Refusal.JoinRefused, inWatchParty = true),
        )
        assertEquals(
            R.string.voice_join_timeout_watch_party,
            voiceRefusalStringRes(Refusal.JoinTimedOut, inWatchParty = true),
        )
    }

    /**
     * "This channel is full" names neither "call" nor "voice server", so it
     * is the one refusal left alone in both contexts -- a watch party's own
     * room reads it exactly as it always did.
     */
    @Test
    fun `RoomFull is the one refusal with no watch-party variant, in or out of one`() {
        assertEquals(R.string.voice_room_full, voiceRefusalStringRes(Refusal.RoomFull, inWatchParty = true))
        assertEquals(R.string.voice_room_full, voiceRefusalStringRes(Refusal.RoomFull, inWatchParty = false))
    }
}
