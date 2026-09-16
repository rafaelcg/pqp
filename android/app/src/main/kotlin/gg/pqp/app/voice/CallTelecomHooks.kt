package gg.pqp.app.voice

/**
 * What [CallController] tells Telecom about the ringing half of a call.
 *
 * Set once, by `TelecomController`, after both it and [CallController] exist.
 * Left null on a device where Telecom refused to register the account (see
 * `TelecomGateway.ensureRegistered`): the ring behaves exactly as it did
 * before this feature existed, because nothing here is load-bearing for the
 * call itself — only for the system surfacing it.
 */
interface CallTelecomHooks {
    /** A `call-incoming` this device is now showing a card for. */
    fun onIncomingCallArrived(call: IncomingCall)

    /** The ring ended on this device without being answered here: declined,
     * dismissed, cancelled by the caller, or timed out. Not called for a ring
     * that turned into a join — see [CallEffect.JoinCall] at the call site. */
    fun onIncomingCallEnded(conversationId: String)
}

/** One thing [CallTelecomHooks] needs to hear about. */
internal sealed interface TelecomHookEvent {
    data class Arrived(val call: IncomingCall) : TelecomHookEvent
    data class Ended(val conversationId: String) : TelecomHookEvent
}

/**
 * What changed about `state.incoming` in one [CallMachine] transition, as data
 * rather than as direct calls, so the diff — not just the reducer it reads —
 * is unit-testable with no [CallTelecomHooks] in hand.
 *
 * The one rule worth stating: a conversation that left `incoming` because it
 * was **answered** (the transition carries a [CallEffect.JoinCall] for it)
 * produces no [TelecomHookEvent.Ended]. `TelecomCoordinator` finds out that
 * room is now live from `VoiceController.state` instead, and a stray `Ended`
 * here would end the very connection that join is about to promote to
 * active — the double-teardown [TelecomCoordinator] cannot see for itself,
 * because it never sees this diff, only the events built from it.
 */
internal fun telecomHookEvents(before: CallState, transition: Transition): List<TelecomHookEvent> {
    val beforeIds = before.incoming.map { it.conversationId }.toSet()
    val afterIds = transition.state.incoming.map { it.conversationId }.toSet()

    val arrived = transition.state.incoming
        .filter { it.conversationId !in beforeIds }
        .map { TelecomHookEvent.Arrived(it) }

    val answered = transition.effects
        .filterIsInstance<CallEffect.JoinCall>()
        .map { it.call.conversationId }
        .toSet()
    val ended = (beforeIds - afterIds)
        .filterNot { it in answered }
        .map { TelecomHookEvent.Ended(it) }

    return arrived + ended
}
