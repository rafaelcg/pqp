package gg.pqp.app.voice.telecom

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [TelecomCoordinator], one event at a time.
 *
 * The invariant this whole feature cannot ship without: **one Telecom
 * connection per voice room, never two, always torn down when the room is.**
 * A double `placeCall`/`addNewIncomingCall` for a room already on Telecom
 * throws or leaves a duplicate entry in the system's own call log; a missing
 * `EndConnection` leaves a ghost call sitting on the lock screen or the
 * system's in-call surface for a room this app has already left. Neither has
 * a symptom inside pqp itself — the same shape `TransportChangeTest`'s own
 * header describes for the promotion logic, and the reason this is a pure
 * function pinned by a test rather than something only a device could show.
 */
class TelecomModelsTest {

    private val room = "9f2b6f8a-0000-4000-8000-000000000001"
    private val other = "9f2b6f8a-0000-4000-8000-000000000002"

    private fun run(state: TelecomState, vararg events: TelecomEvent): Pair<TelecomState, List<TelecomEffect>> {
        var current = state
        val effects = mutableListOf<TelecomEffect>()
        events.forEach { event ->
            val (next, produced) = TelecomCoordinator.reduce(current, event)
            current = next
            effects += produced
        }
        return current to effects
    }

    // --- ringing ---

    @Test
    fun `a ring adds one incoming connection`() {
        val (state, effects) = run(TelecomState(), TelecomEvent.RingStarted(room, "u1", "Rafa"))
        assertEquals(listOf(TelecomEffect.AddIncomingCall(room, "u1", "Rafa")), effects)
        assertEquals(TelecomRoomInfo(room, "u1", "Rafa"), state.ringing[room])
    }

    @Test
    fun `a second ring for the same room is not a second connection`() {
        val (state, effects) = run(
            TelecomState(),
            TelecomEvent.RingStarted(room, "u1", "Rafa"),
            TelecomEvent.RingStarted(room, "u1", "Rafa"),
        )
        assertEquals(1, effects.filterIsInstance<TelecomEffect.AddIncomingCall>().size)
        assertEquals(1, state.ringing.size)
    }

    @Test
    fun `a ring ending unanswered ends its connection and is idempotent`() {
        val (state, effects) = run(
            TelecomState(),
            TelecomEvent.RingStarted(room, "u1", "Rafa"),
            TelecomEvent.RingEnded(room),
        )
        assertEquals(TelecomEffect.EndConnection(room, TelecomEndCause.Missed), effects.last())
        assertTrue(state.ringing.isEmpty())

        // A second "ended" for the same room — the server's own cancel
        // arriving after this device already declined it locally, say —
        // must not end a connection that is already gone.
        val (after, moreEffects) = run(state, TelecomEvent.RingEnded(room))
        assertTrue(moreEffects.isEmpty())
        assertEquals(state, after)
    }

    @Test
    fun `ringing about a room nobody rang is a no-op`() {
        val (state, effects) = run(TelecomState(), TelecomEvent.RingEnded(room))
        assertTrue(effects.isEmpty())
        assertEquals(TelecomState(), state)
    }

    @Test
    fun `a locally declined ring ends its connection as Rejected, not Missed`() {
        val (state, effects) = run(
            TelecomState(),
            TelecomEvent.RingStarted(room, "u1", "Rafa"),
            TelecomEvent.RingEnded(room, declined = true),
        )
        assertEquals(TelecomEffect.EndConnection(room, TelecomEndCause.Rejected), effects.last())
        assertTrue(state.ringing.isEmpty())
    }

    // --- answering ---

    @Test
    fun `answering a ring promotes it instead of placing a second call`() {
        val (state, effects) = run(
            TelecomState(),
            TelecomEvent.RingStarted(room, "u1", "Rafa"),
            TelecomEvent.RoomJoined(room, address = room, displayName = "#general"),
        )
        assertEquals(TelecomEffect.MarkAnswered(room), effects.last())
        assertTrue("the ring is promoted, not left behind", state.ringing.isEmpty())
        // The caller's own name from the ring is kept, not the bare room id
        // VoiceController's join carried.
        assertEquals(TelecomRoomInfo(room, "u1", "Rafa"), state.active)
    }

    @Test
    fun `answering a ring while a different room is still active ends the old connection first`() {
        // A move without a RoomLeft ever reaching this reducer in between --
        // the same shape the `else` (placing) branch already guards against,
        // now covered for the answer path too (Farol review, PR 678).
        val (state, effects) = run(
            TelecomState(),
            TelecomEvent.RoomJoined(room, room, "#general"),
            TelecomEvent.RingStarted(other, "u2", "Bob"),
            TelecomEvent.RoomJoined(other, address = other, displayName = "#watch-party"),
        )
        assertEquals(
            listOf(
                TelecomEffect.EndConnection(room, TelecomEndCause.Local),
                TelecomEffect.MarkAnswered(other),
            ),
            effects.takeLast(2),
        )
        assertEquals(TelecomRoomInfo(other, "u2", "Bob"), state.active)
    }

    @Test
    fun `joining the room we are already the active call in adds nothing twice`() {
        val (state, effects) = run(
            TelecomState(),
            TelecomEvent.RoomJoined(room, room, "#general"),
            TelecomEvent.RoomJoined(room, room, "#general"),
        )
        assertEquals(1, effects.filterIsInstance<TelecomEffect.PlaceCall>().size)
        assertEquals(TelecomRoomInfo(room, room, "#general"), state.active)
    }

    // --- placing ---

    @Test
    fun `a plain voice channel join places a call`() {
        val (state, effects) = run(TelecomState(), TelecomEvent.RoomJoined(room, room, "#general"))
        assertEquals(listOf(TelecomEffect.PlaceCall(room, room, "#general")), effects)
        assertEquals(TelecomRoomInfo(room, room, "#general"), state.active)
    }

    @Test
    fun `a fresh join while another room is still marked active ends the stale one first`() {
        val (state, effects) = run(
            TelecomState(),
            TelecomEvent.RoomJoined(room, room, "#general"),
            TelecomEvent.RoomJoined(other, other, "#watch-party"),
        )
        assertEquals(
            listOf(
                TelecomEffect.EndConnection(room, TelecomEndCause.Local),
                TelecomEffect.PlaceCall(other, other, "#watch-party"),
            ),
            effects.takeLast(2),
        )
        assertEquals(TelecomRoomInfo(other, other, "#watch-party"), state.active)
    }

    // --- leaving ---

    @Test
    fun `leaving ends the active connection, disconnect-on-leave`() {
        val (state, effects) = run(
            TelecomState(),
            TelecomEvent.RoomJoined(room, room, "#general"),
            TelecomEvent.RoomLeft,
        )
        assertEquals(TelecomEffect.EndConnection(room, TelecomEndCause.Local), effects.last())
        assertNull(state.active)
    }

    @Test
    fun `leaving with no active room is a no-op`() {
        val (state, effects) = run(TelecomState(), TelecomEvent.RoomLeft)
        assertTrue(effects.isEmpty())
        assertEquals(TelecomState(), state)
    }

    @Test
    fun `a ring outlives an unrelated room being left`() {
        // The active room ending must never touch a ring for a different
        // conversation still waiting on this device.
        val (state, effects) = run(
            TelecomState(),
            TelecomEvent.RingStarted(other, "u2", "Bob"),
            TelecomEvent.RoomJoined(room, room, "#general"),
            TelecomEvent.RoomLeft,
        )
        assertEquals(TelecomEffect.EndConnection(room, TelecomEndCause.Local), effects.last())
        assertEquals(TelecomRoomInfo(other, "u2", "Bob"), state.ringing[other])
    }

    // --- connection creation refused by Telecom ---

    @Test
    fun `a failed connection for a ringing room clears the ring, with no effects`() {
        val (ringing, _) = run(TelecomState(), TelecomEvent.RingStarted(room, "u1", "Rafa"))
        val (state, effects) = run(ringing, TelecomEvent.ConnectionFailed(room))
        assertTrue(effects.isEmpty())
        assertTrue(state.ringing.isEmpty())
    }

    @Test
    fun `a failed connection for the active room clears it, with no effects`() {
        val (active, _) = run(TelecomState(), TelecomEvent.RoomJoined(room, room, "#general"))
        val (state, effects) = run(active, TelecomEvent.ConnectionFailed(room))
        assertTrue(effects.isEmpty())
        assertNull(state.active)
    }

    @Test
    fun `a failed connection for a room nothing knows about is a no-op`() {
        val (state, effects) = run(TelecomState(), TelecomEvent.ConnectionFailed(room))
        assertTrue(effects.isEmpty())
        assertEquals(TelecomState(), state)
    }

    // --- mute mapping ---

    @Test
    fun `a system mute report that agrees with pqp's own state changes nothing`() {
        assertNull(muteChangeFrom(currentMuted = false, systemMuted = false))
        assertNull(muteChangeFrom(currentMuted = true, systemMuted = true))
    }

    @Test
    fun `a system mute report that disagrees is forwarded`() {
        assertEquals(true, muteChangeFrom(currentMuted = false, systemMuted = true))
        assertEquals(false, muteChangeFrom(currentMuted = true, systemMuted = false))
    }
}
