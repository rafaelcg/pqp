package gg.pqp.app.voice.telecom

import android.telecom.CallAudioState
import android.telecom.Connection
import android.telecom.DisconnectCause
import android.telecom.TelecomManager

/**
 * One voice room's [Connection], from Telecom's point of view.
 *
 * Deliberately thin: every decision about what an answer, a reject, a hang
 * up or a mute report *means* for pqp lives in [TelecomController], reached
 * through [TelecomBridge.callbacks]. This class only translates between the
 * framework's callback shapes and that interface, and holds the bookkeeping
 * Telecom itself requires of a self-managed connection (capabilities, audio
 * mode, address).
 *
 * `roomId` is the voice channel or DM conversation id — [gg.pqp.app.voice.VoiceController]'s
 * `channelId` — baked in at construction, because that is the one piece of
 * context every framework callback on this object needs and none of them
 * carry.
 */
class PqpConnection(private val roomId: String) : Connection() {

    /** Guards [end] against running twice: the system (`onReject`,
     * `onDisconnect`, some OEMs' `onAbort`) and pqp's own state
     * ([TelecomGateway.endConnection], reached through [TelecomController])
     * can each try to end this connection, and either can get there first —
     * whether the app-side path runs synchronously with the framework
     * callback that triggered it is a coroutine-dispatch detail this class
     * has no business depending on. Calling `destroy()` twice on one
     * `Connection` is not guaranteed safe by the framework, so the second
     * caller here is a no-op instead of a race. Same shape as pitfall #13 in
     * CLAUDE.md: two teardown paths for one thing, made safe by refusing the
     * second one rather than by trusting an order neither path controls. */
    private var ended = false

    init {
        connectionProperties = PROPERTY_SELF_MANAGED
        // Hold is not a real pqp feature; it is offered so the platform (the
        // system call UI, a second incoming call, Android Auto) has a way to
        // pause this call's audio without hanging it up. Treated as a mute,
        // because that is the true, safe thing "paused" can mean for a call
        // with no server-side hold of its own.
        connectionCapabilities = CAPABILITY_HOLD or CAPABILITY_SUPPORT_HOLD or CAPABILITY_MUTE
        audioModeIsVoip = true
    }

    fun applyAddress(address: android.net.Uri, displayName: String) {
        setAddress(address, TelecomManager.PRESENTATION_ALLOWED)
        setCallerDisplayName(displayName, TelecomManager.PRESENTATION_ALLOWED)
    }

    /** The one path that actually tears this connection down. See [ended]. */
    fun end(cause: Int) {
        if (ended) return
        ended = true
        setDisconnected(DisconnectCause(cause))
        destroy()
        TelecomBridge.unregister(roomId, this)
    }

    // --- from Telecom / the system UI ---

    override fun onAnswer() {
        TelecomBridge.callbacks?.onAnswer(roomId)
        // Not `setActive()` here: the room is not live until VoiceController
        // says so. `TelecomCoordinator.MarkAnswered`, reached once
        // `voice.state` reports the join, is what calls it.
    }

    override fun onReject() {
        TelecomBridge.callbacks?.onReject(roomId)
        end(DisconnectCause.REJECTED)
    }

    override fun onDisconnect() {
        TelecomBridge.callbacks?.onDisconnect(roomId)
        end(DisconnectCause.LOCAL)
    }

    /** Some OEM in-call UIs call this instead of [onReject] for an unanswered
     * ring dismissed without an explicit decline. [TelecomController] tells
     * the two apart by whether this room is the one VoiceController is
     * actually in. */
    override fun onAbort() = onDisconnect()

    override fun onHold() {
        TelecomBridge.callbacks?.onAudioStateChanged(roomId, muted = true)
        setOnHold()
    }

    override fun onUnhold() {
        TelecomBridge.callbacks?.onAudioStateChanged(roomId, muted = false)
        setActive()
    }

    // The CallEndpoint-based replacement (`onMuteStateChanged`,
    // `onCallEndpointChanged`) is API 34+ only; `minSdk` here is 26, and this
    // one still works everywhere Telecom self-managed calls do.
    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onCallAudioStateChanged(state: CallAudioState) {
        TelecomBridge.callbacks?.onAudioStateChanged(roomId, state.isMuted)
    }

    override fun onShowIncomingCallUi() {
        TelecomBridge.callbacks?.onShowIncomingCallUi(roomId, callerDisplayName ?: roomId)
    }
}
