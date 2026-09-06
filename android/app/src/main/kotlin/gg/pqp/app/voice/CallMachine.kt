package gg.pqp.app.voice

/**
 * Where an outgoing call is.
 *
 *  - `Joining`: we asked to join the conversation's room and are waiting to be
 *    genuinely in it. No ring has left yet.
 *  - `Ringing`: `call-ring` went out; nobody else is in the room.
 *  - `Answered`: somebody else is in the room. The ring is over.
 *  - `NoAnswer`: the ring ran its course with nobody arriving. We are still in
 *    the room, alone, and the server has posted the missed-call message.
 */
enum class OutgoingPhase { Joining, Ringing, Answered, NoAnswer }

data class OutgoingCall(
    val conversationId: String,
    val phase: OutgoingPhase,
    /** Rung participants who said no, oldest first. */
    val declinedUserIds: List<String> = emptyList(),
)

data class CallState(
    /** Conversations ringing this device, oldest first. */
    val incoming: List<IncomingCall> = emptyList(),
    /** The call this device placed, while it is still in that room. */
    val outgoing: OutgoingCall? = null,
    /** The voice room this device is in or joining, from [VoiceController]. */
    val activeChannelId: String? = null,
) {
    val isRinging: Boolean get() = incoming.isNotEmpty()
}

sealed interface CallEvent {
    data class Frame(val frame: CallFrame) : CallEvent

    /** The person tapped Call in a conversation. The room join is already under way. */
    data class Place(val conversationId: String) : CallEvent

    /**
     * A snapshot of [VoiceState], reduced to the three facts a call cares
     * about. `channelId` is null when this device is in no room at all;
     * `others` counts the roster minus ourselves.
     */
    data class Voice(val channelId: String?, val connected: Boolean, val others: Int) : CallEvent

    /** Our own ring reached the server's timeout with nobody arriving. */
    data class RingTimedOut(val conversationId: String) : CallEvent

    /**
     * An incoming ring that nothing cancelled. The server always sends
     * `call-ring-cancelled` at its timeout, but a socket that dropped in
     * between never hears it, and a card ringing forever is a stuck app.
     */
    data class RingExpired(val conversationId: String) : CallEvent

    data class Accept(val conversationId: String) : CallEvent
    data class Decline(val conversationId: String) : CallEvent

    /** Silence on this device only: no frame leaves, the call stays joinable. */
    data class Dismiss(val conversationId: String) : CallEvent
}

sealed interface CallEffect {
    data class SendRing(val conversationId: String) : CallEffect
    data class SendDecline(val conversationId: String) : CallEffect

    /** Join the room. There is no accept frame; this is the acceptance. */
    data class JoinCall(val call: IncomingCall) : CallEffect

    data object StartRinging : CallEffect
    data object StopRinging : CallEffect
}

data class Transition(val state: CallState, val effects: List<CallEffect> = emptyList())

/**
 * The ringing lifecycle, as a pure function of events.
 *
 * Kept free of Android, JSON and coroutines so the rules can be pinned by a
 * plain JVM test, the same way `VoiceController` cannot be. The controller
 * owns the clocks, the socket and the ringtone and feeds this one event at a
 * time on the main thread; everything that decides *what* happens is here.
 *
 * Mirrors `client/src/hooks/use-voice.ts` ("conversation calls"): a ring goes
 * out only once we are genuinely in the room, joining a conversation that is
 * ringing us IS the answer, and dismissing a card sends nothing.
 */
object CallMachine {

    fun reduce(state: CallState, event: CallEvent): Transition = when (event) {
        is CallEvent.Frame -> onFrame(state, event.frame)
        is CallEvent.Place -> {
            // Placing a call into a conversation that is ringing us is just
            // answering it by another door; the card comes down.
            val remaining = state.incoming.filterNot { it.conversationId == event.conversationId }
            Transition(
                state.copy(
                    outgoing = OutgoingCall(event.conversationId, OutgoingPhase.Joining),
                    incoming = remaining,
                ),
                stopIfEmptied(state, remaining),
            )
        }

        is CallEvent.Voice -> onVoice(state, event)
        is CallEvent.RingTimedOut -> {
            val outgoing = state.outgoing
            if (outgoing?.conversationId == event.conversationId && outgoing.phase == OutgoingPhase.Ringing) {
                Transition(state.copy(outgoing = outgoing.copy(phase = OutgoingPhase.NoAnswer)))
            } else {
                Transition(state)
            }
        }

        is CallEvent.Accept -> {
            val call = state.incoming.firstOrNull { it.conversationId == event.conversationId }
                ?: return Transition(state)
            val remaining = state.incoming - call
            Transition(
                state.copy(incoming = remaining),
                stopIfEmptied(state, remaining) + CallEffect.JoinCall(call),
            )
        }

        is CallEvent.Decline -> {
            val remaining = state.incoming.filterNot { it.conversationId == event.conversationId }
            if (remaining.size == state.incoming.size) return Transition(state)
            Transition(
                state.copy(incoming = remaining),
                listOf(CallEffect.SendDecline(event.conversationId)) + stopIfEmptied(state, remaining),
            )
        }

        is CallEvent.Dismiss -> drop(state, event.conversationId)
        is CallEvent.RingExpired -> drop(state, event.conversationId)
    }

    private fun onFrame(state: CallState, frame: CallFrame): Transition = when (frame) {
        is CallFrame.Incoming -> {
            val id = frame.call.conversationId
            when {
                // Already in, or joining, this very call: nothing to answer.
                state.activeChannelId == id -> Transition(state)
                state.incoming.any { it.conversationId == id } -> Transition(state)
                else -> Transition(
                    state.copy(incoming = state.incoming + frame.call),
                    if (state.incoming.isEmpty()) listOf(CallEffect.StartRinging) else emptyList(),
                )
            }
        }

        is CallFrame.RingCancelled -> drop(state, frame.conversationId)

        is CallFrame.Declined -> {
            val outgoing = state.outgoing
            if (outgoing?.conversationId == frame.conversationId && frame.userId !in outgoing.declinedUserIds) {
                Transition(
                    state.copy(outgoing = outgoing.copy(declinedUserIds = outgoing.declinedUserIds + frame.userId)),
                )
            } else {
                Transition(state)
            }
        }
    }

    private fun onVoice(state: CallState, voice: CallEvent.Voice): Transition {
        val effects = mutableListOf<CallEffect>()

        // Joining a conversation that was ringing us is the acceptance,
        // whichever screen the join came from.
        val incoming = if (voice.channelId == null) {
            state.incoming
        } else {
            state.incoming.filterNot { it.conversationId == voice.channelId }
        }
        effects += stopIfEmptied(state, incoming)

        val outgoing = state.outgoing?.let { outgoing ->
            when {
                // Hung up, refused, or moved elsewhere: the call we placed is over.
                voice.channelId != outgoing.conversationId -> null

                // Genuinely in the room now, so the ring may leave. Never
                // before: a join the server is about to refuse must not buzz
                // anybody.
                outgoing.phase == OutgoingPhase.Joining && voice.connected -> {
                    effects += CallEffect.SendRing(outgoing.conversationId)
                    outgoing.copy(phase = OutgoingPhase.Ringing)
                }

                // Somebody arrived. Whatever the ring was doing, it is answered.
                voice.others > 0 && outgoing.phase != OutgoingPhase.Answered ->
                    outgoing.copy(phase = OutgoingPhase.Answered)

                else -> outgoing
            }
        }

        return Transition(
            state.copy(incoming = incoming, outgoing = outgoing, activeChannelId = voice.channelId),
            effects,
        )
    }

    private fun drop(state: CallState, conversationId: String): Transition {
        val remaining = state.incoming.filterNot { it.conversationId == conversationId }
        if (remaining.size == state.incoming.size) return Transition(state)
        return Transition(state.copy(incoming = remaining), stopIfEmptied(state, remaining))
    }

    /** The ringtone stops with the last card, and only then. */
    private fun stopIfEmptied(before: CallState, after: List<IncomingCall>): List<CallEffect> =
        if (before.incoming.isNotEmpty() && after.isEmpty()) listOf(CallEffect.StopRinging) else emptyList()
}

/**
 * How loud an incoming call may be, given the phone's own switches.
 *
 * The ringer mode is the person's answer to exactly this question, so it is
 * obeyed rather than reinterpreted: silent is silent, vibrate is vibrate. Do
 * Not Disturb is the stricter of the two and wins outright. The card still
 * appears in every case; only the noise is gated.
 */
enum class RingBehaviour { Silent, VibrateOnly, Full }

enum class RingerMode { Silent, Vibrate, Normal }

fun ringBehaviourFor(mode: RingerMode, doNotDisturb: Boolean): RingBehaviour = when {
    doNotDisturb -> RingBehaviour.Silent
    mode == RingerMode.Silent -> RingBehaviour.Silent
    mode == RingerMode.Vibrate -> RingBehaviour.VibrateOnly
    else -> RingBehaviour.Full
}

/**
 * `CALL_RING_TIMEOUT_MS` in `server/src/ws/voice.ts`. The server is the clock
 * that matters; this copy only decides when the caller's bar stops saying
 * "Calling…" and when an uncancelled incoming card is taken down.
 */
const val CALL_RING_TIMEOUT_MS = 45_000L
