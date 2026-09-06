package gg.pqp.app.voice

import android.content.Context
import android.util.Log
import gg.pqp.app.core.RealtimeState
import gg.pqp.app.core.SessionStore
import gg.pqp.app.social.SocialRepository
import gg.pqp.app.social.ui.titleOr
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Conversation calls, for the whole process.
 *
 * A call is a voice room plus a ring, and [VoiceController] already owns the
 * room. This owns the ring: which conversations are buzzing this device, the
 * call this device placed and whether anyone has come, and the ringtone. It
 * sits beside the voice controller rather than inside it because a ring is
 * something that happens *to* you wherever you are in the app, so it has to be
 * caught at application scope and drawn above every screen.
 *
 * Every decision is [CallMachine]'s. This class feeds it socket frames, the
 * voice state and the person's taps, and carries out the effects it answers
 * with: the two outbound frames, the room join, the ringer, and the two clocks
 * (our own ring's timeout, and a backstop for an incoming ring nothing
 * cancelled).
 *
 * Everything runs on the application scope, which is `Main.immediate`, so
 * `dispatch` is never re-entered from another thread.
 */
class CallController(
    context: Context,
    private val session: SessionStore,
    private val voice: VoiceController,
    private val scope: CoroutineScope,
    private val ringer: Ringer = Ringer(context),
) {
    private val _state = MutableStateFlow(CallState())
    val state: StateFlow<CallState> = _state.asStateFlow()

    /** One backstop per incoming card, keyed by conversation. */
    private val expiries = mutableMapOf<String, Job>()
    private var outgoingTimeout: Job? = null

    init {
        scope.launch {
            session.realtime.frames.collect { frame ->
                decodeCallFrame(frame)?.let { dispatch(CallEvent.Frame(it)) }
            }
        }
        scope.launch {
            voice.state.collect { voiceState ->
                dispatch(
                    CallEvent.Voice(
                        channelId = voiceState.channelId.takeIf { voiceState.isActive },
                        connected = voiceState.stage == VoiceStage.Connected,
                        // The roster carries us too once `welcome` has landed.
                        others = (voiceState.participants.size - 1).coerceAtLeast(0),
                    ),
                )
            }
        }
        scope.launch {
            session.realtime.state.collect { realtime ->
                // The account is gone from this socket; so is every ring the
                // server would have cancelled through it.
                if (realtime == RealtimeState.Refused) {
                    _state.value.incoming.forEach { dispatch(CallEvent.Dismiss(it.conversationId)) }
                }
            }
        }
    }

    /**
     * Call a conversation. The caller must already hold RECORD_AUDIO, for the
     * same reason [VoiceController.join] says so.
     *
     * The join goes first and the ring waits: `call-ring` is only accepted
     * from a live peer of the room, and the machine sends it once the voice
     * state says we are genuinely in.
     */
    fun place(conversationId: String, title: String) {
        voice.join(conversationId, title)
        dispatch(CallEvent.Place(conversationId))
    }

    /** Answer. Same permission rule as [place]. */
    fun accept(conversationId: String) = dispatch(CallEvent.Accept(conversationId))

    fun decline(conversationId: String) = dispatch(CallEvent.Decline(conversationId))

    fun dismiss(conversationId: String) = dispatch(CallEvent.Dismiss(conversationId))

    private fun dispatch(event: CallEvent) {
        val before = _state.value
        val transition = CallMachine.reduce(before, event)
        _state.value = transition.state
        transition.effects.forEach(::perform)
        reconcileClocks(before, transition.state)
    }

    private fun perform(effect: CallEffect) {
        when (effect) {
            is CallEffect.SendRing -> {
                val sent = session.realtime.send(callRingFrame(effect.conversationId))
                if (!sent) Log.w(TAG, "call-ring could not leave for ${effect.conversationId}")
            }

            is CallEffect.SendDecline -> session.realtime.send(callDeclineFrame(effect.conversationId))

            is CallEffect.JoinCall -> voice.join(effect.call.conversationId, titleFor(effect.call))

            CallEffect.StartRinging -> ringer.start()
            CallEffect.StopRinging -> ringer.stop()
        }
    }

    /**
     * Start and stop timers from the state diff rather than from inside the
     * machine, so the machine stays a pure function and a timer can never
     * outlive the thing it was timing.
     */
    private fun reconcileClocks(before: CallState, after: CallState) {
        val ringingNow = after.incoming.map { it.conversationId }.toSet()
        (expiries.keys - ringingNow).forEach { expiries.remove(it)?.cancel() }
        (ringingNow - expiries.keys).forEach { id ->
            expiries[id] = scope.launch {
                delay(CALL_RING_TIMEOUT_MS + RING_EXPIRY_GRACE_MS)
                dispatch(CallEvent.RingExpired(id))
            }
        }

        val wasRinging = before.outgoing?.phase == OutgoingPhase.Ringing
        val sameCall = before.outgoing?.conversationId == after.outgoing?.conversationId
        val ringingCall = after.outgoing?.takeIf { it.phase == OutgoingPhase.Ringing }
        if (ringingCall != null && (!wasRinging || !sameCall)) {
            outgoingTimeout?.cancel()
            val id = ringingCall.conversationId
            outgoingTimeout = scope.launch {
                delay(CALL_RING_TIMEOUT_MS)
                dispatch(CallEvent.RingTimedOut(id))
            }
        } else if (ringingCall == null) {
            outgoingTimeout?.cancel()
            outgoingTimeout = null
        }
    }

    /**
     * What the call bar calls the room. A 1:1 is the caller; a group is the
     * conversation's own title when this client has the list, else the caller
     * again, which is still a true sentence about who is in there.
     */
    private fun titleFor(call: IncomingCall): String {
        if (call.kind == CallKind.Dm) return call.caller.displayName
        val known = SocialRepository.of(session).conversations.value
            .firstOrNull { it.channelId == call.conversationId }
        return known?.titleOr(call.caller.displayName) ?: call.caller.displayName
    }

    companion object {
        private const val TAG = "pqp.call"

        /** The server's cancel normally arrives first; this only catches a lost socket. */
        private const val RING_EXPIRY_GRACE_MS = 5_000L
    }
}
