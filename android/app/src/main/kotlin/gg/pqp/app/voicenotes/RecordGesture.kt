package gg.pqp.app.voicenotes

/**
 * The hold-to-record gesture, WhatsApp style, as a pure state machine.
 *
 * Hold the microphone to record. Slide **left** past the cancel distance to
 * discard. Slide **up** past the lock distance to keep recording hands-free.
 * Lift the finger anywhere else to send.
 *
 * Pure for the same reason `CallMachine` is: every mistake in a gesture is a
 * thing the person feels as "it did something I did not mean", and a test can
 * pin the thresholds, the ordering and the "once decided, stays decided" rule
 * where a touch screen cannot. The composable only translates pointer events
 * into [RecordGestureMachine] calls and acts on the effect it gets back.
 *
 * Distances are in pixels and passed in, so the machine never learns what a dp
 * is.
 */
data class GestureThresholds(
    /** How far left the finger travels to cancel. */
    val cancelPx: Float,
    /** How far up the finger travels to lock. */
    val lockPx: Float,
)

enum class GesturePhase {
    /** Nothing is happening. */
    Idle,

    /** The finger is down and a note is being recorded. */
    Holding,

    /** Slid up: recording continues with the finger off the screen. */
    Locked,

    /** Slid left: the note was thrown away. */
    Cancelled,

    /** The finger lifted: the note goes. */
    Released,
}

/**
 * Where the finger is. [dx] is negative to the left and [dy] is negative
 * upward, which is the sign pointer coordinates already have, so nothing here
 * flips an axis.
 */
data class GestureState(
    val phase: GesturePhase = GesturePhase.Idle,
    val dx: Float = 0f,
    val dy: Float = 0f,
) {
    val isHolding: Boolean get() = phase == GesturePhase.Holding

    /** 0 at rest, 1 at the cancel line. Drives the "slide to cancel" fade. */
    fun cancelProgress(t: GestureThresholds): Float =
        if (!isHolding || t.cancelPx <= 0f) 0f else (-dx / t.cancelPx).coerceIn(0f, 1f)

    /** 0 at rest, 1 at the lock line. Drives the lock padlock rising. */
    fun lockProgress(t: GestureThresholds): Float =
        if (!isHolding || t.lockPx <= 0f) 0f else (-dy / t.lockPx).coerceIn(0f, 1f)
}

/** What the screen has to do now. Null from the machine means nothing. */
enum class GestureEffect {
    /** Keep recording, show the locked controls, give the lock haptic. */
    Lock,

    /** Throw the recording away, give the cancel haptic. */
    Cancel,

    /** Stop and send. */
    Send,
}

object RecordGestureMachine {

    /** The finger landed. */
    fun down(): GestureState = GestureState(phase = GesturePhase.Holding)

    /**
     * The finger moved to [dx], [dy] away from where it landed.
     *
     * Whichever line is crossed first decides, and the decision is final: a
     * finger that slides past cancel and drifts back is still cancelled,
     * because the note is already gone and un-cancelling it would need a
     * recording nobody has. When one move crosses both lines (a fast diagonal
     * flick between two frames) the line crossed by the greater margin wins,
     * so a flick that is mostly leftward cancels and a flick that is mostly
     * upward locks.
     *
     * Moves outside [GesturePhase.Holding] are ignored: a finger that already
     * locked keeps moving for as long as it stays down, and none of that is a
     * gesture any more.
     */
    fun move(
        state: GestureState,
        dx: Float,
        dy: Float,
        thresholds: GestureThresholds,
    ): Pair<GestureState, GestureEffect?> {
        if (!state.isHolding) return state to null

        val cancelMargin = if (thresholds.cancelPx > 0f) -dx / thresholds.cancelPx else 0f
        val lockMargin = if (thresholds.lockPx > 0f) -dy / thresholds.lockPx else 0f
        val cancels = cancelMargin >= 1f
        val locks = lockMargin >= 1f

        return when {
            cancels && (!locks || cancelMargin >= lockMargin) ->
                state.copy(phase = GesturePhase.Cancelled, dx = dx, dy = dy) to GestureEffect.Cancel

            locks ->
                state.copy(phase = GesturePhase.Locked, dx = dx, dy = dy) to GestureEffect.Lock

            else -> state.copy(dx = dx, dy = dy) to null
        }
    }

    /**
     * The finger lifted. Only a finger still holding sends: a locked note is
     * finished with its own send button, and a cancelled one is already gone.
     */
    fun up(state: GestureState): Pair<GestureState, GestureEffect?> =
        if (state.isHolding) {
            state.copy(phase = GesturePhase.Released) to GestureEffect.Send
        } else {
            state to null
        }

    /**
     * The system took the touch away (a notification shade, a permission
     * dialog, a palm). Never a send: a recording the person did not choose to
     * release is not one they chose to send.
     */
    fun interrupted(state: GestureState): Pair<GestureState, GestureEffect?> =
        if (state.isHolding) {
            state.copy(phase = GesturePhase.Cancelled) to GestureEffect.Cancel
        } else {
            state to null
        }
}
