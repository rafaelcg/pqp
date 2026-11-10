package gg.pqp.app.activities

import gg.pqp.app.activities.bridge.ActivityTransport
import gg.pqp.app.activities.bridge.ActivityTransportError
import gg.pqp.app.activities.bridge.SeatSnapshot
import gg.pqp.app.core.RealtimeState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * One seat in one app session, over the app's `/ws`: the Kotlin counterpart of
 * `session-wire.ts`, for the single session an activity screen holds.
 *
 * RESUME IS THIS CLASS'S JOB, NOT THE BRIDGE'S. The server holds a dropped seat
 * for 90 seconds and a second `app-join` from the same account takes it back
 * with the same seat id. So when the socket comes back this re-sends `app-join`
 * for a seat it held, and the `app-session` snapshot that follows tells the
 * bridge to go back to `online`. The bridge only ever sees `reconnecting` and
 * `online`.
 *
 * A STATE WRITE IS ANSWERED BY THE NEXT `app-state`. The server coalesces a
 * session's writes (last value wins) and broadcasts the result to everybody,
 * the writer included, so the first `app-state` after a patch is the answer to
 * it. Another seat's write can land in between and answer first; the revision is
 * still monotonic, which is all the bridge promises. A patch nobody answers
 * within [patchTimeoutMs] is `unavailable` rather than a hang.
 *
 * All calls come in on the main thread (the bridge's, the collectors'), so the
 * state below needs no lock.
 */
class ActivitySeat(
    private val sessionId: String,
    private val scope: CoroutineScope,
    frames: Flow<JsonObject>,
    connection: Flow<RealtimeState>,
    private val send: (JsonObject) -> Boolean,
    private val endCall: suspend () -> Boolean,
    private val joinTimeoutMs: Long = JOIN_TIMEOUT_MS,
    private val patchTimeoutMs: Long = PATCH_TIMEOUT_MS,
) : ActivityTransport {
    private val handlers = LinkedHashSet<ActivityTransport.Handlers>()
    private var seated = false
    private var asSpectator = false
    private var finished = false
    private var online = true
    private var pendingJoin: CompletableDeferred<SeatSnapshot>? = null
    private var joinTimer: Job? = null
    private val patches = ArrayDeque<CompletableDeferred<Long>>()
    private var lastConnection = true

    private val _snapshot = MutableStateFlow<SeatSnapshot?>(null)

    /** The latest `app-session` snapshot: who is in, whether this seat is the host, as the screen draws them. */
    val snapshot: StateFlow<SeatSnapshot?> = _snapshot.asStateFlow()

    private val _linkUp = MutableStateFlow(true)

    /** False while the socket is down and the seat is held for its resume window. */
    val linkUp: StateFlow<Boolean> = _linkUp.asStateFlow()

    init {
        scope.launch { frames.collect { raw -> ActivityFrame.decode(raw)?.let(::onFrame) } }
        scope.launch {
            connection.collect { state ->
                when (state) {
                    RealtimeState.Ready -> setOnline(true)
                    // `Idle` is a socket nobody asked for yet (sign-out), the rest are a link coming back.
                    else -> setOnline(false)
                }
            }
        }
    }

    // --- ActivityTransport ---

    override suspend fun join(asSpectator: Boolean): SeatSnapshot {
        if (finished) throw ActivityTransportError("ended")
        pendingJoin?.let { return it.await() }
        this.asSpectator = asSpectator
        if (!online || !send(ActivityFrame.join(sessionId, asSpectator))) throw ActivityTransportError("unavailable")
        val pending = CompletableDeferred<SeatSnapshot>()
        pendingJoin = pending
        joinTimer = scope.launch {
            delay(joinTimeoutMs)
            settleJoin(ActivityTransportError("unavailable"))
        }
        return pending.await()
    }

    override fun leave() {
        val wasSeated = seated
        seated = false
        failPatches("unavailable")
        if (wasSeated || pendingJoin != null) send(ActivityFrame.leave(sessionId))
        settleJoin(ActivityTransportError("unavailable"))
    }

    override suspend fun patchState(patch: JsonElement, baseRev: Long?): Long {
        if (!online || !seated) throw ActivityTransportError("unavailable")
        if (!send(ActivityFrame.statePatch(sessionId, patch, baseRev))) throw ActivityTransportError("unavailable")
        val entry = CompletableDeferred<Long>()
        patches.addLast(entry)
        return try {
            withTimeout(patchTimeoutMs) { entry.await() }
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            patches.remove(entry)
            throw ActivityTransportError("unavailable")
        }
    }

    override fun sendEvent(name: String, data: JsonElement) {
        if (!online || !seated) return
        send(ActivityFrame.eventSend(sessionId, name, data))
    }

    override suspend fun end() {
        // `false` is "it was already over": the `app-ended` frame (or the next read) says so for everybody.
        try {
            endCall()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: gg.pqp.app.core.ApiException) {
            throw ActivityTransportError(if (e.status == 403) "not-allowed" else "unavailable")
        } catch (e: Exception) {
            throw ActivityTransportError("unavailable")
        }
    }

    override fun subscribe(handlers: ActivityTransport.Handlers): () -> Unit {
        this.handlers.add(handlers)
        // a late subscriber learns the link's state at once
        if (!lastConnection) handlers.onConnection(false)
        return { this.handlers.remove(handlers) }
    }

    // --- frames ---

    private fun onFrame(frame: ActivityFrame) {
        when (frame) {
            is ActivityFrame.Snapshot -> if (frame.sessionId == sessionId) {
                val snapshot = SeatSnapshot(
                    sessionId = frame.sessionId,
                    seatId = frame.seatId,
                    role = frame.role,
                    isHost = frame.isHost,
                    stateRev = frame.stateRev,
                    stateValue = frame.stateValue,
                    participants = frame.participants,
                )
                seated = true
                _snapshot.value = snapshot
                settleJoin(snapshot)
                for (h in handlers.toList()) h.onSession(snapshot)
                if (online) notifyConnection(true)
            }

            is ActivityFrame.State -> if (frame.sessionId == sessionId) {
                for (h in handlers.toList()) h.onState(frame.rev, frame.value)
                patches.removeFirstOrNull()?.complete(frame.rev)
            }

            is ActivityFrame.Event -> if (frame.sessionId == sessionId) {
                for (h in handlers.toList()) h.onEvent(frame.fromSeatId, frame.name, frame.data)
            }

            is ActivityFrame.Ended -> if (frame.sessionId == sessionId) finish(frame.reason)

            is ActivityFrame.Error -> if (frame.sessionId == sessionId) onError(frame)

            is ActivityFrame.ChannelApp -> Unit
        }
    }

    private fun onError(frame: ActivityFrame.Error) {
        when (frame.op) {
            "join" -> when {
                pendingJoin != null -> settleJoin(ActivityTransportError(frame.code))
                // a resume that found the session over, or a seat lost for good (the right to be here)
                seated && (frame.code == "ended" || frame.code == "not-allowed") -> finish(ENDED_WHILE_AWAY)
            }

            "state" -> failPatches(frame.code, count = 1)
            else -> if (frame.code == "ended") finish(ENDED_WHILE_AWAY)
        }
    }

    // --- bookkeeping ---

    private fun settleJoin(outcome: Any) {
        val pending = pendingJoin ?: return
        pendingJoin = null
        joinTimer?.cancel()
        joinTimer = null
        when (outcome) {
            is SeatSnapshot -> pending.complete(outcome)
            is ActivityTransportError -> pending.completeExceptionally(outcome)
        }
    }

    private fun failPatches(code: String, count: Int = Int.MAX_VALUE) {
        var left = count
        while (left > 0) {
            val patch = patches.removeFirstOrNull() ?: break
            patch.completeExceptionally(ActivityTransportError(code))
            left -= 1
        }
    }

    private fun notifyConnection(now: Boolean) {
        if (lastConnection == now) return
        lastConnection = now
        _linkUp.value = now
        for (h in handlers.toList()) h.onConnection(now)
    }

    private fun finish(reason: ActivityEndReason) {
        settleJoin(ActivityTransportError("ended"))
        failPatches("ended")
        seated = false
        finished = true
        for (h in handlers.toList()) h.onEnded(reason)
    }

    private fun setOnline(next: Boolean) {
        if (online == next) return
        online = next
        if (!next) {
            // a join in flight cannot complete on a dead link
            settleJoin(ActivityTransportError("unavailable"))
            failPatches("unavailable")
            if (seated) notifyConnection(false)
        } else if (seated) {
            // the socket authenticated again: take the same seat back
            send(ActivityFrame.join(sessionId, asSpectator))
        }
    }

    companion object {
        const val JOIN_TIMEOUT_MS = 8_000L
        const val PATCH_TIMEOUT_MS = 6_000L

        /**
         * What an app is told when the session ended while this phone could not hear: the resume
         * found nothing to resume. The screen says "terminou" without a cause in that case; the
         * app only needs some reason.
         */
        val ENDED_WHILE_AWAY = ActivityEndReason.Idle
    }
}
