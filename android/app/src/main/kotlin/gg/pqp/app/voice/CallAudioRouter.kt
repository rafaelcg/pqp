package gg.pqp.app.voice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat

/**
 * The one thing [CallAudioRouter] needs from Telecom, as an interface in this
 * package so the voice code does not depend on the telecom one (the same
 * seam as [CallTelecomHooks]).
 */
interface TelecomAudioRoute {
    /**
     * Ask the live Telecom connection for [roomId] to move the call to
     * [output]. False when there is no live connection, and the caller then
     * routes with `AudioManager` itself.
     */
    fun requestRoute(roomId: String, output: AudioOutput): Boolean
}

/**
 * Puts a call's sound where [AudioRoutePolicy] says, and keeps it there while
 * headsets come and go.
 *
 * THE BUG THIS REPLACES. The call used to ask for the loudspeaker
 * unconditionally (`setCommunicationDevice(TYPE_BUILTIN_SPEAKER)` on API 31+,
 * `isSpeakerphoneOn = true` below), on the theory that a headset would still
 * win. It does not: an explicit communication device beats the platform's own
 * preference, so a person with a wired, USB or Bluetooth headset heard the
 * call on the loudspeaker and was heard through the phone's own microphone.
 *
 * WHO ROUTES. Two possible actors, never both for one request:
 *
 *  - **Telecom**, when this call has a live self-managed connection
 *    ([TelecomAudioRoute]). Telecom runs its own route state machine for the
 *    call and reacts to headsets itself; asking it with `setAudioRoute` keeps
 *    that machine and this class agreeing. Changing the route underneath it
 *    with `AudioManager` is what Android's docs tell a self-managed app not to
 *    do, and on some versions Telecom answers by pushing its own route back.
 *  - **`AudioManager` directly**, when there is no connection (Telecom refused
 *    the account, or has not built the connection yet). The moment a
 *    connection does arrive, [onTelecomConnectionReady] hands the route over
 *    and releases what was held here.
 *
 * Re-applied only when the chosen output changes (a device came or went, the
 * button), never in answer to a route report. A report is a fact to show on
 * the button; answering it with a request would be a tug of war with Telecom
 * or with the system's own output switcher.
 *
 * Main thread only, like the rest of [VoiceController]: every callback here is
 * registered on the main looper.
 */
internal class CallAudioRouter(
    context: Context,
    private val audioManager: AudioManager,
    /** True when a live Telecom connection took the request. */
    private val telecomRequest: (AudioOutput) -> Boolean,
    /** Every change of preference or real route, for [VoiceState]. */
    private val onChanged: (RoutePreference, AudioOutput?) -> Unit,
) {
    private val context = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val sdk = Build.VERSION.SDK_INT

    var preference: RoutePreference = RoutePreference.Auto
        private set

    private var active = false
    private var available: Set<AudioOutput> = emptySet()
    private var target: AudioOutput? = null
    private var viaTelecom = false
    private var heldDirect = false
    private var telecomReported: AudioOutput? = null

    private var deviceCallback: AudioDeviceCallback? = null

    /** An `OnCommunicationDeviceChangedListener` on API 31+, typed loosely so this class loads on 26. */
    private var commListener: Any? = null

    // Below API 31 only: Bluetooth SCO, started by this class.
    private var scoReceiver: BroadcastReceiver? = null
    private var scoStarted = false
    private var scoConnected = false
    private var scoSeenConnecting = false

    /** SCO refused or dropped; Bluetooth is left out until the devices change. */
    private var scoFailed = false

    /** The sound is going somewhere right now; null outside a call. */
    var route: AudioOutput? = null
        private set

    /**
     * Start routing a call. Idempotent: `welcome` arrives again on a resume
     * inside the same call, and that must not register a second set of
     * listeners or reset a choice made a minute ago.
     */
    fun start(initial: RoutePreference) {
        if (active) {
            apply(force = true)
            return
        }
        active = true
        preference = AudioRoutePolicy.atCallStart(initial)
        available = readAvailable()
        register()
        apply(force = true)
    }

    /** The call ended: nothing listening, nothing held. */
    fun stop() {
        if (!active) return
        active = false
        unregister()
        releaseDirect()
        target = null
        viaTelecom = false
        telecomReported = null
        scoFailed = false
        available = emptySet()
        route = null
        onChanged(preference, null)
    }

    /** The call bar's button. Works before the call is up, too: it then only sets the preference. */
    fun toggle() {
        val devices = if (active) available else readAvailable()
        val current = route ?: AudioRoutePolicy.choose(devices, preference)
        preference = AudioRoutePolicy.toggled(current, devices)
        // Forced: a tap is an explicit request, and the sound may be somewhere
        // other than the last target (the system output switcher moved it),
        // in which case the target alone would look unchanged.
        if (active) apply(force = true) else onChanged(preference, null)
    }

    /** Telecom just built this room's connection: let it own the route from now on. */
    fun onTelecomConnectionReady() {
        if (!active) return
        apply(force = true)
    }

    /** Telecom's `CallAudioState.route`, as a fact about where the sound is. */
    fun onTelecomRouteReported(output: AudioOutput?) {
        telecomReported = output
        if (active) publish()
    }

    // --- deciding and applying ---

    private fun readAvailable(): Set<AudioOutput> {
        val types = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                audioManager.availableCommunicationDevices.map { it.type }
            } else {
                audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { it.type }
            }
        }.getOrDefault(emptyList())
        val outputs = AudioRoutePolicy.availableOutputs(types, sdk)
        return if (scoFailed) outputs - AudioOutput.Bluetooth else outputs
    }

    private fun onDevicesChanged() {
        if (!active) return
        // A device coming or going is a fresh chance for Bluetooth.
        scoFailed = false
        val before = available
        val after = readAvailable()
        available = after
        preference = AudioRoutePolicy.afterDevicesChanged(preference, before, after)
        apply(force = false)
    }

    private fun apply(force: Boolean) {
        val next = AudioRoutePolicy.choose(available, preference)
        if (!force && next == target) {
            publish()
            return
        }
        target = next
        if (telecomRequest(next)) {
            // Telecom owns it now. Anything this class asked AudioManager for
            // earlier would sit underneath Telecom's own request and win the
            // moment Telecom let go, so it goes.
            if (heldDirect) releaseDirect()
            viaTelecom = true
        } else {
            viaTelecom = false
            applyDirect(next)
        }
        publish()
    }

    private fun applyDirect(output: AudioOutput) {
        heldDirect = true
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                applyCommunicationDevice(output)
            } else {
                applyLegacy(AudioRoutePolicy.legacyAction(output))
            }
        }.onFailure { Log.w(TAG, "route to $output refused: ${it.message}") }
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun applyCommunicationDevice(output: AudioOutput) {
        val device = audioManager.availableCommunicationDevices.firstOrNull {
            AudioRoutePolicy.outputFor(it.type, sdk) == output
        }
        if (device == null) {
            audioManager.clearCommunicationDevice()
        } else if (audioManager.communicationDevice?.id != device.id) {
            audioManager.setCommunicationDevice(device)
        }
    }

    @Suppress("DEPRECATION")
    private fun applyLegacy(action: RouteAction.Legacy) {
        if (action.bluetoothSco) {
            audioManager.isSpeakerphoneOn = false
            if (!scoStarted) {
                scoStarted = true
                scoSeenConnecting = false
                audioManager.startBluetoothSco()
                audioManager.isBluetoothScoOn = true
            }
        } else {
            stopSco()
            audioManager.isSpeakerphoneOn = action.speakerphoneOn
        }
    }

    @Suppress("DEPRECATION")
    private fun stopSco() {
        if (!scoStarted) return
        scoStarted = false
        scoConnected = false
        scoSeenConnecting = false
        runCatching {
            audioManager.isBluetoothScoOn = false
            audioManager.stopBluetoothSco()
        }
    }

    @Suppress("DEPRECATION")
    private fun releaseDirect() {
        if (!heldDirect) return
        heldDirect = false
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                audioManager.clearCommunicationDevice()
            } else {
                stopSco()
                audioManager.isSpeakerphoneOn = false
            }
        }
    }

    /** Work out where the sound really is and report it if it moved. */
    private fun publish() {
        val real = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // The platform's own answer, whoever asked for it: this class,
            // Telecom, or the system's output switcher.
            runCatching { audioManager.communicationDevice }.getOrNull()
                ?.let { AudioRoutePolicy.outputFor(it.type, sdk) }
                ?: AudioRoutePolicy.platformDefault(available)
        } else if (viaTelecom) {
            telecomReported ?: target
        } else if (target == AudioOutput.Bluetooth && !scoConnected) {
            // Asked for, not there yet. What is playing meanwhile is what the
            // platform does with the speakerphone off and no SCO.
            AudioRoutePolicy.platformDefault(available - AudioOutput.Bluetooth)
        } else {
            target
        }
        route = real
        onChanged(preference, real)
    }

    // --- listening ---

    private fun register() {
        val callback = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) = onDevicesChanged()
            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) = onDevicesChanged()
        }
        deviceCallback = callback
        // Registering reports every device already there as "added", which
        // reads as no change against [available] and applies nothing new.
        runCatching { audioManager.registerAudioDeviceCallback(callback, main) }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            registerCommunicationListener()
        } else {
            registerScoReceiver()
        }
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun registerCommunicationListener() {
        val listener = AudioManager.OnCommunicationDeviceChangedListener { if (active) publish() }
        commListener = listener
        runCatching { audioManager.addOnCommunicationDeviceChangedListener(context.mainExecutor, listener) }
    }

    @Suppress("DEPRECATION")
    private fun registerScoReceiver() {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                // Registering replays the last state from before this call,
                // which says nothing about the request this call makes.
                if (isInitialStickyBroadcast) return
                onScoState(intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, AudioManager.SCO_AUDIO_STATE_ERROR))
            }
        }
        scoReceiver = receiver
        runCatching {
            ContextCompat.registerReceiver(
                context,
                receiver,
                IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED),
                ContextCompat.RECEIVER_NOT_EXPORTED,
            )
        }
    }

    private fun onScoState(state: Int) {
        if (!active || !scoStarted) return
        when (state) {
            AudioManager.SCO_AUDIO_STATE_CONNECTING -> scoSeenConnecting = true
            AudioManager.SCO_AUDIO_STATE_CONNECTED -> {
                scoConnected = true
                publish()
            }
            AudioManager.SCO_AUDIO_STATE_DISCONNECTED, AudioManager.SCO_AUDIO_STATE_ERROR -> {
                // A DISCONNECTED before this request ever got going is the
                // tail of an earlier SCO session, not an answer to this one.
                if (!scoSeenConnecting && !scoConnected && state != AudioManager.SCO_AUDIO_STATE_ERROR) return
                Log.w(TAG, "bluetooth SCO ended (state $state), falling back")
                stopSco()
                scoFailed = true
                available = available - AudioOutput.Bluetooth
                apply(force = false)
            }
        }
    }

    private fun unregister() {
        deviceCallback?.let { runCatching { audioManager.unregisterAudioDeviceCallback(it) } }
        deviceCallback = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (commListener as? AudioManager.OnCommunicationDeviceChangedListener)?.let {
                runCatching { audioManager.removeOnCommunicationDeviceChangedListener(it) }
            }
        }
        commListener = null
        scoReceiver?.let { runCatching { context.unregisterReceiver(it) } }
        scoReceiver = null
    }

    private companion object {
        const val TAG = "pqp.voice.route"
    }
}
