package gg.pqp.app.voicenotes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Hold, cancel and lock, as the machine sees them. The distances are
 * arbitrary round numbers: what is pinned is where the lines are, which line
 * wins, and that a decision is final.
 */
class RecordGestureTest {

    private val t = GestureThresholds(cancelPx = 100f, lockPx = 80f)

    private fun move(state: GestureState, dx: Float, dy: Float) =
        RecordGestureMachine.move(state, dx, dy, t)

    @Test
    fun `a finger down is holding`() {
        val state = RecordGestureMachine.down()
        assertEquals(GesturePhase.Holding, state.phase)
        assertTrue(state.isHolding)
    }

    @Test
    fun `releasing in place sends`() {
        val (state, effect) = RecordGestureMachine.up(RecordGestureMachine.down())
        assertEquals(GesturePhase.Released, state.phase)
        assertEquals(GestureEffect.Send, effect)
    }

    @Test
    fun `small drifts do nothing`() {
        var state = RecordGestureMachine.down()
        for ((dx, dy) in listOf(-20f to -10f, -60f to -30f, -99f to 0f, 0f to -79f, 30f to 30f)) {
            val (next, effect) = move(state, dx, dy)
            assertNull("at $dx,$dy", effect)
            assertTrue(next.isHolding)
            state = next
        }
    }

    @Test
    fun `sliding left to the line cancels`() {
        val (state, effect) = move(RecordGestureMachine.down(), -100f, 0f)
        assertEquals(GestureEffect.Cancel, effect)
        assertEquals(GesturePhase.Cancelled, state.phase)
    }

    @Test
    fun `sliding up to the line locks`() {
        val (state, effect) = move(RecordGestureMachine.down(), 0f, -80f)
        assertEquals(GestureEffect.Lock, effect)
        assertEquals(GesturePhase.Locked, state.phase)
    }

    @Test
    fun `one pixel short of either line is still holding`() {
        assertNull(move(RecordGestureMachine.down(), -99.9f, 0f).second)
        assertNull(move(RecordGestureMachine.down(), 0f, -79.9f).second)
    }

    @Test
    fun `sliding right or down never does anything`() {
        assertNull(move(RecordGestureMachine.down(), 500f, 0f).second)
        assertNull(move(RecordGestureMachine.down(), 0f, 500f).second)
    }

    @Test
    fun `a locked note stays locked and lifting the finger sends nothing`() {
        val (locked, _) = move(RecordGestureMachine.down(), 0f, -90f)
        // The finger keeps moving, even far left: not a cancel any more.
        val (still, effect) = move(locked, -400f, -90f)
        assertNull(effect)
        assertEquals(GesturePhase.Locked, still.phase)

        val (afterUp, upEffect) = RecordGestureMachine.up(still)
        assertNull(upEffect)
        assertEquals(GesturePhase.Locked, afterUp.phase)
    }

    @Test
    fun `a cancelled note stays cancelled even if the finger slides back`() {
        val (cancelled, _) = move(RecordGestureMachine.down(), -120f, 0f)
        val (back, effect) = move(cancelled, 0f, 0f)
        assertNull(effect)
        assertEquals(GesturePhase.Cancelled, back.phase)
        assertNull(RecordGestureMachine.up(back).second)
    }

    @Test
    fun `a diagonal flick that crosses both lines goes to the one it overshot more`() {
        // 150 left is 1.5 of the cancel line; 90 up is 1.125 of the lock line.
        assertEquals(GestureEffect.Cancel, move(RecordGestureMachine.down(), -150f, -90f).second)
        // 105 left is 1.05; 160 up is 2.0.
        assertEquals(GestureEffect.Lock, move(RecordGestureMachine.down(), -105f, -160f).second)
    }

    @Test
    fun `the system taking the touch cancels and never sends`() {
        val (state, effect) = RecordGestureMachine.interrupted(RecordGestureMachine.down())
        assertEquals(GestureEffect.Cancel, effect)
        assertEquals(GesturePhase.Cancelled, state.phase)
    }

    @Test
    fun `an interruption after a decision is not a second decision`() {
        val (locked, _) = move(RecordGestureMachine.down(), 0f, -90f)
        assertNull(RecordGestureMachine.interrupted(locked).second)
        val (cancelled, _) = move(RecordGestureMachine.down(), -120f, 0f)
        assertNull(RecordGestureMachine.interrupted(cancelled).second)
        assertNull(RecordGestureMachine.interrupted(GestureState()).second)
    }

    @Test
    fun `an idle machine ignores moves and releases`() {
        val idle = GestureState()
        assertNull(move(idle, -500f, -500f).second)
        assertNull(RecordGestureMachine.up(idle).second)
    }

    @Test
    fun `progress rises from zero to one as the finger nears each line`() {
        var state = RecordGestureMachine.down()
        assertEquals(0f, state.cancelProgress(t), 0f)
        assertEquals(0f, state.lockProgress(t), 0f)

        state = move(state, -50f, -40f).first
        assertEquals(0.5f, state.cancelProgress(t), 0.001f)
        assertEquals(0.5f, state.lockProgress(t), 0.001f)

        // Sliding the other way does not go negative.
        state = move(RecordGestureMachine.down(), 50f, 50f).first
        assertEquals(0f, state.cancelProgress(t), 0f)
        assertEquals(0f, state.lockProgress(t), 0f)
    }

    @Test
    fun `progress is zero once the gesture is decided`() {
        val (locked, _) = move(RecordGestureMachine.down(), 0f, -90f)
        assertEquals(0f, locked.lockProgress(t), 0f)
        assertFalse(locked.isHolding)
    }

    @Test
    fun `a recording shorter than the minimum is a tap, not a note`() {
        // The machine sends on release; the view model drops anything under
        // the minimum with a hint. The boundary is the shared contract's.
        assertTrue(299L < VOICE_NOTE_MIN_DURATION_MS)
        assertFalse(300L < VOICE_NOTE_MIN_DURATION_MS)
    }

    @Test
    fun `a call refuses the microphone before any other rule`() {
        assertEquals(
            RecordingRefusal.CallActive,
            recordingRefusal(enabled = true, alreadyRecording = false, editing = false, callActive = true),
        )
        // Even with the feature off or an edit open, a live call is the answer.
        assertEquals(
            RecordingRefusal.CallActive,
            recordingRefusal(enabled = false, alreadyRecording = false, editing = true, callActive = true),
        )
    }

    @Test
    fun `the other refusals, and the one yes`() {
        assertEquals(
            RecordingRefusal.AlreadyRecording,
            recordingRefusal(enabled = true, alreadyRecording = true, editing = false, callActive = false),
        )
        assertEquals(
            RecordingRefusal.Disabled,
            recordingRefusal(enabled = false, alreadyRecording = false, editing = false, callActive = false),
        )
        assertEquals(
            RecordingRefusal.Editing,
            recordingRefusal(enabled = true, alreadyRecording = false, editing = true, callActive = false),
        )
        assertNull(
            recordingRefusal(enabled = true, alreadyRecording = false, editing = false, callActive = false),
        )
    }
}
