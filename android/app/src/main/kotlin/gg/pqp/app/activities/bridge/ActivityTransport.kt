package gg.pqp.app.activities.bridge

import gg.pqp.app.activities.ActivityEndReason
import gg.pqp.app.activities.SeatParticipant
import kotlinx.serialization.json.JsonElement

/**
 * What the bridge host needs from the session on the server
 * (`AppSessionTransport` in `client/src/lib/apps/types.ts`). The live
 * implementation is [gg.pqp.app.activities.ActivitySeat], which puts these
 * calls on the app's one WebSocket; tests wire a fake. Every call that can be
 * refused throws an [ActivityTransportError].
 */
interface ActivityTransport {
    /** Sends `app-join`; returns the `app-session` snapshot that answers it. */
    suspend fun join(asSpectator: Boolean): SeatSnapshot

    /** Sends `app-leave`: the seat is released, not held for the resume window. */
    fun leave()

    /** Sends `app-state-patch`; returns the revision the server gave the write. */
    suspend fun patchState(patch: JsonElement, baseRev: Long?): Long

    /** Sends `app-event-send`. Not acknowledged: events are ephemeral. */
    fun sendEvent(name: String, data: JsonElement)

    /** Ends the session for everybody (the host, or someone with MANAGE_CHANNELS). */
    suspend fun end()

    /** Starts listening; returns the unsubscribe. */
    fun subscribe(handlers: Handlers): () -> Unit

    interface Handlers {
        /** A fresh snapshot for this seat: after `join`, after a resume, whenever the roster changes. */
        fun onSession(snapshot: SeatSnapshot)

        fun onState(rev: Long, value: JsonElement)
        fun onEvent(fromSeatId: String, name: String, data: JsonElement)

        /** The socket dropped (`false`: the seat is held 90 s) or the seat is back (`true`). */
        fun onConnection(online: Boolean)

        /** `app-ended`, or the seat being refused for good. */
        fun onEnded(reason: ActivityEndReason)
    }
}

/** The `app-session` frame, as the bridge reads it (a pqp user id included: the bridge strips it). */
data class SeatSnapshot(
    val sessionId: String,
    val seatId: String,
    val role: String,
    val isHost: Boolean,
    val stateRev: Long,
    val stateValue: JsonElement,
    val participants: List<SeatParticipant>,
)

/** A refused transport call: one of the `app-error` codes the server speaks (`APP_ERROR_CODES`). */
class ActivityTransportError(val code: String) : Exception("app session call failed: $code")
