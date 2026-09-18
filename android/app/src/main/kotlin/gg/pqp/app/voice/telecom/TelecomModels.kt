package gg.pqp.app.voice.telecom

/**
 * The Telecom-facing call lifecycle, as a pure function of events.
 *
 * `android.telecom` is a framework surface no JVM test can build (a real
 * `Connection` needs a live framework, exactly like `LiveKitEngine` needs a
 * live SFU). So, the same way [gg.pqp.app.voice.CallMachine] keeps the ringing
 * rules out of Android and [gg.pqp.app.voice.transportChangePlan] keeps the
 * promotion rules out of it, the one invariant this feature cannot ship
 * without — **one Telecom connection per voice room, never two, always torn
 * down when the room is** — lives here as plain data and a pure reducer.
 * [TelecomController] feeds it events; [TelecomGateway] carries out the
 * effects it answers with.
 *
 * A pqp account is in at most one voice room at a time, so the room this
 * device has live media in (if any) is a single slot, [TelecomState.active],
 * separate from the rooms that are merely ringing it, [TelecomState.ringing].
 * A DM call is both in turn: it arrives as a ring, and if the person accepts
 * it becomes the active room without ever being torn down and rebuilt as a
 * second connection — that rebuild is exactly the double-add this reducer
 * exists to refuse.
 */
data class TelecomRoomInfo(
    val roomId: String,
    /** What the address bar of a phone call would be. Never shown as such: a
     * self-managed account has no dialer, so this only has to be a stable
     * identifier for the room (the other party's user id for a ring, the
     * channel id for a room this device is placing). */
    val address: String,
    /** What the lock screen and the call log show. */
    val displayName: String,
)

data class TelecomState(
    /** Rooms ringing this device, not yet answered here. Keyed by room id so a
     * second `call-incoming` for the same conversation cannot double-add. */
    val ringing: Map<String, TelecomRoomInfo> = emptyMap(),
    /** The one room this device currently has live media in, if any. */
    val active: TelecomRoomInfo? = null,
)

/** Why a Telecom connection is ending, so the system call log says something true. */
enum class TelecomEndCause { Missed, Rejected, Local, Error }

sealed interface TelecomEvent {
    /** `call-incoming` reached this device and nothing here already knows about it. */
    data class RingStarted(val roomId: String, val address: String, val displayName: String) : TelecomEvent

    /** The ring ended on this device without being answered here: declined,
     * dismissed, cancelled by the caller, or timed out. `declined` is true
     * only for a LOCAL decline (see [gg.pqp.app.voice.CallTelecomHooks.onIncomingCallEnded]);
     * everything else maps to [TelecomEndCause.Missed], which a decline used
     * to as well (Farol review, PR 678). */
    data class RingEnded(val roomId: String, val declined: Boolean = false) : TelecomEvent

    /** [gg.pqp.app.voice.VoiceController] reports live media in a room —
     * a plain voice channel joined directly, a DM call placed by this device,
     * or (see [TelecomCoordinator.reduce]) the answer to an existing ring. */
    data class RoomJoined(val roomId: String, val address: String, val displayName: String) : TelecomEvent

    /** [gg.pqp.app.voice.VoiceController] reports this device is in no room. */
    data object RoomLeft : TelecomEvent

    /** Telecom refused to build a connection for this room at all
     * (`onCreateOutgoingConnectionFailed` / `onCreateIncomingConnectionFailed`).
     * No [TelecomEffect] answers this: there is nothing left to tell Telecom
     * (it already refused) and nothing to tell pqp's own voice call (it was
     * never gated on Telecom succeeding) — this only clears local bookkeeping
     * so a later `markActive`/`endConnection` for this room, and a later ring
     * for the same conversation, are not confused by a connection that never
     * existed (Farol review, PR 678). */
    data class ConnectionFailed(val roomId: String) : TelecomEvent
}

sealed interface TelecomEffect {
    data class AddIncomingCall(val roomId: String, val address: String, val displayName: String) : TelecomEffect
    data class PlaceCall(val roomId: String, val address: String, val displayName: String) : TelecomEffect

    /** An existing ringing connection is now the live call: no new connection,
     * just tell Telecom (and its lock-screen UI) the ring is over. */
    data class MarkAnswered(val roomId: String) : TelecomEffect
    data class EndConnection(val roomId: String, val cause: TelecomEndCause) : TelecomEffect
}

object TelecomCoordinator {

    fun reduce(state: TelecomState, event: TelecomEvent): Pair<TelecomState, List<TelecomEffect>> = when (event) {
        is TelecomEvent.RingStarted -> onRingStarted(state, event)
        is TelecomEvent.RingEnded -> onRingEnded(state, event)
        is TelecomEvent.RoomJoined -> onRoomJoined(state, event)
        TelecomEvent.RoomLeft -> onRoomLeft(state)
        is TelecomEvent.ConnectionFailed -> onConnectionFailed(state, event)
    }

    private fun onRingStarted(state: TelecomState, event: TelecomEvent.RingStarted): Pair<TelecomState, List<TelecomEffect>> {
        // Already ringing, or already the live call (a stale re-delivered
        // frame for a room we are already in): no second connection.
        if (state.ringing.containsKey(event.roomId) || state.active?.roomId == event.roomId) {
            return state to emptyList()
        }
        val info = TelecomRoomInfo(event.roomId, event.address, event.displayName)
        return state.copy(ringing = state.ringing + (event.roomId to info)) to
            listOf(TelecomEffect.AddIncomingCall(event.roomId, event.address, event.displayName))
    }

    private fun onRingEnded(state: TelecomState, event: TelecomEvent.RingEnded): Pair<TelecomState, List<TelecomEffect>> {
        val info = state.ringing[event.roomId] ?: return state to emptyList()
        val cause = if (event.declined) TelecomEndCause.Rejected else TelecomEndCause.Missed
        return state.copy(ringing = state.ringing - event.roomId) to
            listOf(TelecomEffect.EndConnection(info.roomId, cause))
    }

    private fun onRoomJoined(state: TelecomState, event: TelecomEvent.RoomJoined): Pair<TelecomState, List<TelecomEffect>> = when {
        // Already the live room: nothing changed, nothing re-added.
        state.active?.roomId == event.roomId -> state to emptyList()

        // This room was ringing us: answering it is not a new call, it is the
        // ring's connection becoming the active one. Its caller-supplied
        // address/name (already on file from the ring) is kept rather than
        // whatever VoiceController's own join happened to carry, which for an
        // accepted DM call is nothing more specific than the room id.
        //
        // A DIFFERENT room can still be `active` here — this device joined a
        // call, then answered a ring for another conversation without a
        // RoomLeft for the first ever reaching this reducer — and answering
        // must not leave that connection behind: it is a leftover as real as
        // the one the `else` branch below already guards against (Farol
        // review, PR 678).
        state.ringing.containsKey(event.roomId) -> {
            val info = state.ringing.getValue(event.roomId)
            val previous = state.active
            val effects = buildList {
                if (previous != null && previous.roomId != event.roomId) {
                    add(TelecomEffect.EndConnection(previous.roomId, TelecomEndCause.Local))
                }
                add(TelecomEffect.MarkAnswered(event.roomId))
            }
            state.copy(ringing = state.ringing - event.roomId, active = info) to effects
        }

        // A genuinely new call this device is placing: a plain voice channel,
        // or a DM call this device rang out on. If another room's connection
        // is still marked active — a rebuild after a dropped socket lands
        // here as a fresh join with no RoomLeft in between — that stale
        // connection is ended first, so Telecom is never asked to run two
        // active self-managed calls for one account that can only be in one
        // room.
        else -> {
            val previous = state.active
            val info = TelecomRoomInfo(event.roomId, event.address, event.displayName)
            val effects = buildList {
                if (previous != null) add(TelecomEffect.EndConnection(previous.roomId, TelecomEndCause.Local))
                add(TelecomEffect.PlaceCall(event.roomId, event.address, event.displayName))
            }
            state.copy(active = info) to effects
        }
    }

    private fun onRoomLeft(state: TelecomState): Pair<TelecomState, List<TelecomEffect>> {
        val previous = state.active ?: return state to emptyList()
        return state.copy(active = null) to listOf(TelecomEffect.EndConnection(previous.roomId, TelecomEndCause.Local))
    }

    private fun onConnectionFailed(state: TelecomState, event: TelecomEvent.ConnectionFailed): Pair<TelecomState, List<TelecomEffect>> {
        if (state.ringing[event.roomId] == null && state.active?.roomId != event.roomId) {
            return state to emptyList()
        }
        val next = state.copy(
            ringing = state.ringing - event.roomId,
            active = state.active?.takeUnless { it.roomId == event.roomId },
        )
        return next to emptyList()
    }
}

/**
 * Whether a mute report from Telecom's [android.telecom.Connection.onCallAudioStateChanged]
 * — the Bluetooth headset's own mute button, the wired headset's, or the
 * system call UI's — should change pqp's own mute flag, and to what.
 *
 * `null` when it already agrees with what this device has. That is not an
 * optimisation: [gg.pqp.app.voice.VoiceController.setMuted] itself pushes a
 * `set-voice-state` frame and re-derives Telecom's own audio state in turn
 * (see [TelecomController]), and forwarding an unchanged report would be an
 * echo with no natural end.
 */
fun muteChangeFrom(currentMuted: Boolean, systemMuted: Boolean): Boolean? =
    if (systemMuted == currentMuted) null else systemMuted
