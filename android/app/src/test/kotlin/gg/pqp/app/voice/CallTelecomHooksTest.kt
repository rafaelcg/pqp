package gg.pqp.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [telecomHookEvents], the diff `CallController` feeds `TelecomController`.
 *
 * The one rule that matters: a ring answered on this device must produce no
 * [TelecomHookEvent.Ended]. `TelecomCoordinator` finds out that room went
 * live from `VoiceController.state` instead (see its own class doc), and a
 * stray `Ended` here would race that promotion into ending the very
 * connection it is about to become the active call.
 */
class CallTelecomHooksTest {

    private val caller = CallerSummary("u-caller", "Rafa", null)
    private val ring = IncomingCall("c1", CallKind.Dm, caller)

    @Test
    fun `a ring arriving is reported once`() {
        val before = CallState()
        val transition = CallMachine.reduce(before, CallEvent.Frame(CallFrame.Incoming(ring)))
        assertEquals(listOf(TelecomHookEvent.Arrived(ring)), telecomHookEvents(before, transition))
    }

    @Test
    fun `declining is reported as ended, with a decline effect alongside it`() {
        val before = CallState(incoming = listOf(ring))
        val transition = CallMachine.reduce(before, CallEvent.Decline(ring.conversationId))
        assertTrue(transition.effects.any { it is CallEffect.SendDecline })
        assertEquals(listOf(TelecomHookEvent.Ended(ring.conversationId)), telecomHookEvents(before, transition))
    }

    @Test
    fun `dismissing is reported as ended too, even though it sends nothing`() {
        val before = CallState(incoming = listOf(ring))
        val transition = CallMachine.reduce(before, CallEvent.Dismiss(ring.conversationId))
        assertEquals(listOf(TelecomHookEvent.Ended(ring.conversationId)), telecomHookEvents(before, transition))
    }

    @Test
    fun `an uncancelled ring expiring is reported as ended`() {
        val before = CallState(incoming = listOf(ring))
        val transition = CallMachine.reduce(before, CallEvent.RingExpired(ring.conversationId))
        assertEquals(listOf(TelecomHookEvent.Ended(ring.conversationId)), telecomHookEvents(before, transition))
    }

    @Test
    fun `the caller cancelling the ring is reported as ended`() {
        val before = CallState(incoming = listOf(ring))
        val transition = CallMachine.reduce(
            before,
            CallEvent.Frame(CallFrame.RingCancelled(ring.conversationId, RingEnd.Cancelled)),
        )
        assertEquals(listOf(TelecomHookEvent.Ended(ring.conversationId)), telecomHookEvents(before, transition))
    }

    @Test
    fun `answering produces no Ended, only the join effect`() {
        val before = CallState(incoming = listOf(ring))
        val transition = CallMachine.reduce(before, CallEvent.Accept(ring.conversationId))
        assertTrue(transition.effects.any { it is CallEffect.JoinCall })
        assertTrue("answering must not tell Telecom to end the connection it is about to promote", telecomHookEvents(before, transition).isEmpty())
    }

    @Test
    fun `placing a call into a conversation that was already ringing us reports ended, harmlessly`() {
        // The rare mutual-call case: tapping Call on a conversation that is
        // also ringing us. CallMachine's CallEvent.Place carries no
        // CallEffect.JoinCall (only CallEvent.Accept does), even though
        // CallController.place already called voice.join() before this event
        // was dispatched. So telecomHookEvents reports this the same as any
        // other card going away: Ended. That is not wrong in a way that
        // breaks the call — TelecomCoordinator's own RingEnded handler is a
        // no-op once the room has already been promoted out of `ringing`
        // (see TelecomModelsTest), and a promotion that has not landed yet
        // just costs one extra EndConnection/PlaceCall pair on Telecom's own
        // call log rather than a lost connection. Documented here rather than
        // engineered away, because the scenario it costs anything in is two
        // people calling each other in the same second.
        val before = CallState(incoming = listOf(ring))
        val transition = CallMachine.reduce(before, CallEvent.Place(ring.conversationId))
        assertTrue(transition.state.incoming.isEmpty())
        assertEquals(listOf(TelecomHookEvent.Ended(ring.conversationId)), telecomHookEvents(before, transition))
    }

    @Test
    fun `no change in incoming means no hook events`() {
        val before = CallState()
        val transition = CallMachine.reduce(before, CallEvent.Voice(channelId = null, connected = false, others = 0))
        assertTrue(telecomHookEvents(before, transition).isEmpty())
    }
}
