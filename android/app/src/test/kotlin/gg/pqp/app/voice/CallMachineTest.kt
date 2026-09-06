package gg.pqp.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The ringing lifecycle, one event at a time.
 *
 * This is the half of DM calls that has no media in it and therefore no
 * excuse for being untested: whether a ring goes out, whether a card comes
 * down, and which of the three answers sends a frame. Every rule here has a
 * counterpart in `client/src/hooks/use-voice.ts`, and where the two disagree
 * two people are on the phone and only one of them knows it.
 */
class CallMachineTest {

    private val caller = CallerSummary("u-caller", "Rafa", null)
    private val ring = IncomingCall("c1", CallKind.Dm, caller)

    private fun run(state: CallState, vararg events: CallEvent): Pair<CallState, List<CallEffect>> {
        var current = state
        val effects = mutableListOf<CallEffect>()
        events.forEach { event ->
            val transition = CallMachine.reduce(current, event)
            current = transition.state
            effects += transition.effects
        }
        return current to effects
    }

    private fun incoming(call: IncomingCall = ring) = CallEvent.Frame(CallFrame.Incoming(call))

    // --- receiving ---

    @Test
    fun `a ring raises a card and starts the ringtone`() {
        val (state, effects) = run(CallState(), incoming())
        assertEquals(listOf(ring), state.incoming)
        assertEquals(listOf(CallEffect.StartRinging), effects)
    }

    @Test
    fun `a second ring for the same conversation does not stack a second card`() {
        val (state, effects) = run(CallState(), incoming(), incoming())
        assertEquals(listOf(ring), state.incoming)
        assertEquals(listOf(CallEffect.StartRinging), effects)
    }

    /**
     * A group call and a DM can ring at once, and the ringtone starts once.
     * Two overlapping ringtones is the failure this asserts against.
     */
    @Test
    fun `a second conversation stacks a card without restarting the ringtone`() {
        val other = IncomingCall("c2", CallKind.Group, CallerSummary("u2", "Bia", null))
        val (state, effects) = run(CallState(), incoming(), incoming(other))
        assertEquals(listOf(ring, other), state.incoming)
        assertEquals(listOf(CallEffect.StartRinging), effects)
    }

    @Test
    fun `a ring for the room this device is already in is not an invitation`() {
        val (state, effects) = run(CallState(activeChannelId = "c1"), incoming())
        assertTrue(state.incoming.isEmpty())
        assertTrue(effects.isEmpty())
    }

    @Test
    fun `every cancel reason takes the card down and stops the ringtone`() {
        RingEnd.entries.forEach { reason ->
            val (state, effects) = run(
                CallState(),
                incoming(),
                CallEvent.Frame(CallFrame.RingCancelled("c1", reason)),
            )
            assertTrue("$reason left a card standing", state.incoming.isEmpty())
            assertEquals("$reason", listOf(CallEffect.StartRinging, CallEffect.StopRinging), effects)
        }
    }

    @Test
    fun `a cancel for some other conversation leaves this card alone`() {
        val (state, effects) = run(
            CallState(),
            incoming(),
            CallEvent.Frame(CallFrame.RingCancelled("c9", RingEnd.Timeout)),
        )
        assertEquals(listOf(ring), state.incoming)
        assertEquals(listOf(CallEffect.StartRinging), effects)
    }

    // --- the three answers ---

    @Test
    fun `accepting joins the room and sends no frame`() {
        val (state, effects) = run(CallState(), incoming(), CallEvent.Accept("c1"))
        assertTrue(state.incoming.isEmpty())
        assertEquals(
            listOf(CallEffect.StartRinging, CallEffect.StopRinging, CallEffect.JoinCall(ring)),
            effects,
        )
    }

    @Test
    fun `declining sends the frame and takes the card down`() {
        val (state, effects) = run(CallState(), incoming(), CallEvent.Decline("c1"))
        assertTrue(state.incoming.isEmpty())
        assertEquals(
            listOf(CallEffect.StartRinging, CallEffect.SendDecline("c1"), CallEffect.StopRinging),
            effects,
        )
    }

    /**
     * Dismissing is silence on this device: the caller keeps ringing until the
     * server's timeout and the call stays joinable. A frame here would be a
     * decline the person did not choose.
     */
    @Test
    fun `dismissing sends nothing`() {
        val (state, effects) = run(CallState(), incoming(), CallEvent.Dismiss("c1"))
        assertTrue(state.incoming.isEmpty())
        assertEquals(listOf(CallEffect.StartRinging, CallEffect.StopRinging), effects)
    }

    @Test
    fun `declining a conversation that is not ringing sends nothing`() {
        val (_, effects) = run(CallState(), CallEvent.Decline("c1"))
        assertTrue(effects.isEmpty())
    }

    @Test
    fun `the ringtone stops only with the last card`() {
        val other = IncomingCall("c2", CallKind.Dm, CallerSummary("u2", "Bia", null))
        val (state, effects) = run(CallState(), incoming(), incoming(other), CallEvent.Decline("c1"))
        assertEquals(listOf(other), state.incoming)
        assertTrue(CallEffect.StopRinging !in effects)
    }

    /**
     * Joining a conversation that is ringing us IS the acceptance, whichever
     * door the join came through: the conversation screen's own call button,
     * or another device.
     */
    @Test
    fun `walking into the ringing room takes the card down`() {
        val (state, effects) = run(
            CallState(),
            incoming(),
            CallEvent.Voice(channelId = "c1", connected = true, others = 1),
        )
        assertTrue(state.incoming.isEmpty())
        assertEquals(listOf(CallEffect.StartRinging, CallEffect.StopRinging), effects)
    }

    /** A ring the socket never heard cancelled must not buzz for ever. */
    @Test
    fun `an expired ring takes its own card down`() {
        val (state, effects) = run(CallState(), incoming(), CallEvent.RingExpired("c1"))
        assertTrue(state.incoming.isEmpty())
        assertEquals(listOf(CallEffect.StartRinging, CallEffect.StopRinging), effects)
    }

    // --- placing a call ---

    /**
     * The ring waits for the room. `call-ring` is only accepted from a live
     * peer of that room, so sending it on the tap would be dropped in silence
     * and nobody's phone would ever ring.
     */
    @Test
    fun `no ring leaves until the room is actually joined`() {
        val (state, effects) = run(
            CallState(),
            CallEvent.Place("c1"),
            CallEvent.Voice(channelId = "c1", connected = false, others = 0),
        )
        assertEquals(OutgoingPhase.Joining, state.outgoing?.phase)
        assertTrue(effects.isEmpty())
    }

    @Test
    fun `the ring goes out once the room is joined`() {
        val (state, effects) = run(
            CallState(),
            CallEvent.Place("c1"),
            CallEvent.Voice(channelId = "c1", connected = true, others = 0),
        )
        assertEquals(OutgoingPhase.Ringing, state.outgoing?.phase)
        assertEquals(listOf(CallEffect.SendRing("c1")), effects)
    }

    @Test
    fun `the ring goes out exactly once`() {
        val (_, effects) = run(
            CallState(),
            CallEvent.Place("c1"),
            CallEvent.Voice(channelId = "c1", connected = true, others = 0),
            CallEvent.Voice(channelId = "c1", connected = true, others = 0),
        )
        assertEquals(listOf(CallEffect.SendRing("c1")), effects)
    }

    /** A join that never came up must not buzz anybody. */
    @Test
    fun `a refused join never rings`() {
        val (state, effects) = run(
            CallState(),
            CallEvent.Place("c1"),
            CallEvent.Voice(channelId = null, connected = false, others = 0),
        )
        assertNull(state.outgoing)
        assertTrue(effects.isEmpty())
    }

    @Test
    fun `somebody arriving answers the call`() {
        val (state, _) = run(
            CallState(),
            CallEvent.Place("c1"),
            CallEvent.Voice(channelId = "c1", connected = true, others = 0),
            CallEvent.Voice(channelId = "c1", connected = true, others = 1),
        )
        assertEquals(OutgoingPhase.Answered, state.outgoing?.phase)
    }

    @Test
    fun `a timeout that arrives after somebody answered is ignored`() {
        val (state, _) = run(
            CallState(),
            CallEvent.Place("c1"),
            CallEvent.Voice(channelId = "c1", connected = true, others = 0),
            CallEvent.Voice(channelId = "c1", connected = true, others = 1),
            CallEvent.RingTimedOut("c1"),
        )
        assertEquals(OutgoingPhase.Answered, state.outgoing?.phase)
    }

    @Test
    fun `nobody comes, so the call reports no answer`() {
        val (state, _) = run(
            CallState(),
            CallEvent.Place("c1"),
            CallEvent.Voice(channelId = "c1", connected = true, others = 0),
            CallEvent.RingTimedOut("c1"),
        )
        assertEquals(OutgoingPhase.NoAnswer, state.outgoing?.phase)
    }

    @Test
    fun `a declining callee is recorded once and only for our own call`() {
        val (state, _) = run(
            CallState(),
            CallEvent.Place("c1"),
            CallEvent.Voice(channelId = "c1", connected = true, others = 0),
            CallEvent.Frame(CallFrame.Declined("c1", "u2")),
            CallEvent.Frame(CallFrame.Declined("c1", "u2")),
            CallEvent.Frame(CallFrame.Declined("c9", "u3")),
        )
        assertEquals(listOf("u2"), state.outgoing?.declinedUserIds)
    }

    @Test
    fun `hanging up ends the call this device placed`() {
        val (state, _) = run(
            CallState(),
            CallEvent.Place("c1"),
            CallEvent.Voice(channelId = "c1", connected = true, others = 1),
            CallEvent.Voice(channelId = null, connected = false, others = 0),
        )
        assertNull(state.outgoing)
    }

    /** Walking into a server voice channel is not this call, so the call ends. */
    @Test
    fun `moving to another room ends the call`() {
        val (state, _) = run(
            CallState(),
            CallEvent.Place("c1"),
            CallEvent.Voice(channelId = "c1", connected = true, others = 1),
            CallEvent.Voice(channelId = "other", connected = true, others = 3),
        )
        assertNull(state.outgoing)
        assertEquals("other", state.activeChannelId)
    }

    @Test
    fun `calling a conversation that is ringing us takes its card down`() {
        val (state, effects) = run(CallState(), incoming(), CallEvent.Place("c1"))
        assertTrue(state.incoming.isEmpty())
        assertEquals(listOf(CallEffect.StartRinging, CallEffect.StopRinging), effects)
    }

    // --- the phone's own switches ---

    @Test
    fun `silent is silent, vibrate is vibrate, and do not disturb wins`() {
        assertEquals(RingBehaviour.Full, ringBehaviourFor(RingerMode.Normal, doNotDisturb = false))
        assertEquals(RingBehaviour.VibrateOnly, ringBehaviourFor(RingerMode.Vibrate, doNotDisturb = false))
        assertEquals(RingBehaviour.Silent, ringBehaviourFor(RingerMode.Silent, doNotDisturb = false))
        RingerMode.entries.forEach { mode ->
            assertEquals(
                "Do Not Disturb has to win over $mode",
                RingBehaviour.Silent,
                ringBehaviourFor(mode, doNotDisturb = true),
            )
        }
    }
}
