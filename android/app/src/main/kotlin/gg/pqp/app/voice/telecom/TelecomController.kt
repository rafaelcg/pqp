package gg.pqp.app.voice.telecom

import android.content.Context
import gg.pqp.app.R
import gg.pqp.app.voice.CallController
import gg.pqp.app.voice.CallTelecomHooks
import gg.pqp.app.voice.IncomingCall
import gg.pqp.app.voice.VoiceController
import gg.pqp.app.voice.VoiceStage
import gg.pqp.app.voice.VoiceState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Wires a pqp voice call to `android.telecom`, so it behaves like a phone
 * call: system incoming-call UI, the lock screen, Bluetooth and car head
 * units, and a `CallStyle` notification while it runs.
 *
 * Application-scoped, built once in `PqpApplication` alongside [VoiceController]
 * and [CallController] and living exactly as long as they do — a call outlives
 * every Activity, and [TelecomBridge] needs one fixed target for the whole
 * process's lifetime.
 *
 * All the actual deciding is [TelecomCoordinator]'s, a pure function fed one
 * event at a time from two places:
 *
 *  - [CallController], through [CallTelecomHooks], for the ringing half of a
 *    DM call (`call-incoming` arriving and a ring ending unanswered). This is
 *    a direct hook rather than a second collector on `CallController.state`,
 *    because `CallController.dispatch` updates its own state *before*
 *    running the effect that calls `VoiceController.join()` (see the comment
 *    on `CallController.notifyTelecom`), so watching that flow here would see
 *    an accepted ring's card disappear before the join it caused has
 *    happened, and read it as a decline.
 *  - [VoiceController.state], for everything about a room actually being
 *    live: a plain channel joined directly, a DM call this device placed, the
 *    join that answers an existing ring, and every kind of leaving one.
 *
 * If Telecom refuses to register this account — no `MANAGE_OWN_CALLS`, a
 * restricted profile, an OEM that does not implement self-managed accounts —
 * [TelecomGateway] no-ops every effect and the call proceeds exactly as it
 * did before this class existed. Nothing here is on the path a call needs to
 * connect; it is only on the path the *system* needs to know about one.
 */
class TelecomController(
    context: Context,
    private val voice: VoiceController,
    private val calls: CallController,
    private val scope: CoroutineScope,
    private val gateway: TelecomGateway = AndroidTelecomGateway(context),
) : CallTelecomHooks, TelecomConnectionCallbacks {

    private val context = context.applicationContext
    private var state = TelecomState()

    init {
        gateway.ensureRegistered()
        TelecomBridge.callbacks = this
        calls.telecomHooks = this

        scope.launch {
            var wasActive = false
            // Which room `markActive` has already been called for, so a busy
            // room's ordinary roster/mute/stage-unrelated VoiceState emissions
            // do not re-invoke it (a TelecomBridge lookup plus a
            // Connection.setActive() Binder call) on every single one — only
            // the actual transition into Connected does (Farol review, PR
            // 678). Reset on leaving, so the same room reconnecting later
            // marks active again.
            var markedActiveFor: String? = null
            voice.state.collect { vs ->
                val channelId = vs.channelId
                if (vs.isActive && channelId != null) {
                    wasActive = true
                    dispatch(TelecomEvent.RoomJoined(channelId, address = channelId, displayName = roomDisplayName(vs)))
                    if (vs.stage == VoiceStage.Connected && markedActiveFor != channelId) {
                        gateway.markActive(channelId)
                        markedActiveFor = channelId
                    }
                } else if (wasActive) {
                    wasActive = false
                    markedActiveFor = null
                    dispatch(TelecomEvent.RoomLeft)
                }
            }
        }
    }

    /**
     * What a plain voice-channel join, or a DM call this device placed, is
     * called on the lock screen.
     *
     * `channelName` is a DM's own title when [CallController.place] set it,
     * or an ordinary channel's bare name — this device has no server name to
     * decorate it with at the point a channel is joined (`ChatScreen`'s join
     * button knows only the channel), so "#general" rather than "#general @
     * pqp HQ" is what ships first. See `docs/ANDROID_TELECOM.md`.
     */
    private fun roomDisplayName(vs: VoiceState): String {
        val name = vs.channelName ?: return context.getString(R.string.voice_notification_title)
        return if (name.startsWith("#")) name else "#$name"
    }

    // --- CallTelecomHooks: the ringing half, from CallController ---

    override fun onIncomingCallArrived(call: IncomingCall) {
        dispatch(TelecomEvent.RingStarted(call.conversationId, call.caller.userId, call.caller.displayName))
    }

    override fun onIncomingCallEnded(conversationId: String, declined: Boolean) {
        dispatch(TelecomEvent.RingEnded(conversationId, declined))
    }

    // --- TelecomConnectionCallbacks: from the system, through PqpConnection ---

    override fun onAnswer(roomId: String) {
        // Same acceptance as tapping the in-app banner: CallMachine treats
        // joining the room as the whole answer, so this is the only call
        // needed. `voice.state` reaching Connected is what marks the
        // connection active (see the collector above).
        calls.accept(roomId)
    }

    override fun onReject(roomId: String) {
        calls.decline(roomId)
    }

    override fun onDisconnect(roomId: String) {
        // Two different things reach here through one callback: hanging up a
        // live call, and (some OEM in-call UIs) dismissing an unanswered ring
        // without going through onReject. Distinguished the only way that is
        // actually true: whether VoiceController is *in* this room right now.
        val current = voice.state.value
        if (current.channelId == roomId && current.isActive) {
            voice.leave()
        } else {
            calls.decline(roomId)
        }
    }

    override fun onAudioStateChanged(roomId: String, muted: Boolean) {
        // A callback from a connection that is not the current active room —
        // delayed delivery for a room this device already left, or for a
        // ringing room's connection before it is answered — must not mutate
        // whatever room actually IS active now (Farol review, PR 678).
        if (voice.state.value.channelId != roomId) return
        muteChangeFrom(voice.state.value.muted, muted)?.let(voice::setMuted)
    }

    override fun onShowIncomingCallUi(roomId: String, displayName: String) {
        IncomingCallNotifier.show(context, roomId, displayName)
    }

    override fun onConnectionFailed(roomId: String) {
        TelecomBridge.clearPending(roomId)
        dispatch(TelecomEvent.ConnectionFailed(roomId))
    }

    // --- the coordinator ---

    private fun dispatch(event: TelecomEvent) {
        val (next, effects) = TelecomCoordinator.reduce(state, event)
        state = next
        effects.forEach(::perform)
    }

    private fun perform(effect: TelecomEffect) {
        when (effect) {
            is TelecomEffect.AddIncomingCall -> gateway.addIncomingCall(effect.roomId, effect.address, effect.displayName)
            is TelecomEffect.PlaceCall -> gateway.placeCall(effect.roomId, effect.address, effect.displayName)
            is TelecomEffect.MarkAnswered -> gateway.markAnswered(effect.roomId)
            is TelecomEffect.EndConnection -> gateway.endConnection(effect.roomId, effect.cause)
        }
    }
}
