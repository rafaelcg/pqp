package gg.pqp.app.voice

import android.annotation.SuppressLint
import android.media.AudioDeviceInfo
import android.os.Build
import android.telecom.CallAudioState

/**
 * Where a call's sound goes. One value per thing a person can tell apart by
 * ear, not one per [AudioDeviceInfo] type: a Bluetooth headset is a Bluetooth
 * headset whether the platform calls it SCO, LE audio or a hearing aid.
 */
enum class AudioOutput(val isHeadset: Boolean) {
    Bluetooth(true),
    UsbHeadset(true),
    WiredHeadset(true),
    Speaker(false),
    Earpiece(false),
}

/**
 * What the person asked for, which is not the same as where the sound is.
 *
 * - [Auto], the default: a connected headset, else the loudspeaker. Without a
 *   headset this is exactly what every call did before headsets were handled.
 * - [Speaker]: the loudspeaker even with a headset connected. Only reachable
 *   from the call bar while a headset is connected.
 * - [Earpiece]: the private choice. A headset if one is connected, else the
 *   earpiece. This is the old "speakerphone off" and nobody loses it.
 */
enum class RoutePreference { Auto, Speaker, Earpiece }

/**
 * How a route is put into effect on this API level.
 *
 * API 31+ names the device ([CommunicationDevice]). Below that there is no
 * such call, only two switches: the speakerphone, and Bluetooth SCO. A wired
 * or USB headset needs neither, because with the speakerphone off the
 * platform already prefers it over the earpiece.
 */
sealed interface RouteAction {
    data class CommunicationDevice(val output: AudioOutput) : RouteAction
    data class Legacy(val speakerphoneOn: Boolean, val bluetoothSco: Boolean) : RouteAction
}

data class RouteDecision(val output: AudioOutput, val action: RouteAction)

/**
 * Every routing decision a call makes, as pure functions, so the whole policy
 * is pinned by JVM tests (`AudioRoutePolicyTest`) and [CallAudioRouter] is
 * left with nothing to decide, only `AudioManager` and Telecom calls to make.
 *
 * Inputs are plain device type ints and an API level rather than
 * [AudioDeviceInfo] objects, which no JVM test can build.
 */
object AudioRoutePolicy {

    /**
     * Headsets in the order they win when several are connected at once. The
     * Bluetooth one first because it is the one a person most often connects
     * on purpose for a call; then USB, then the jack.
     */
    private val headsetOrder = listOf(AudioOutput.Bluetooth, AudioOutput.UsbHeadset, AudioOutput.WiredHeadset)

    /**
     * Which output a platform device type is, on this API level, or null for
     * a device a call cannot be routed to here.
     *
     * Below 31 the only Bluetooth path for a call is SCO: LE audio devices do
     * not exist yet as a type and a hearing aid cannot be selected with the
     * speakerphone and SCO switches, so both are left out rather than offered
     * as a route this code could never actually take.
     */
    @SuppressLint("InlinedApi")
    fun outputFor(deviceType: Int, sdk: Int): AudioOutput? = when (deviceType) {
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> AudioOutput.Bluetooth
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_HEARING_AID,
        -> if (sdk >= Build.VERSION_CODES.S) AudioOutput.Bluetooth else null
        AudioDeviceInfo.TYPE_USB_HEADSET -> AudioOutput.UsbHeadset
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        -> AudioOutput.WiredHeadset
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> AudioOutput.Speaker
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> AudioOutput.Earpiece
        else -> null
    }

    fun availableOutputs(deviceTypes: Collection<Int>, sdk: Int): Set<AudioOutput> =
        deviceTypes.mapNotNullTo(mutableSetOf()) { outputFor(it, sdk) }

    /**
     * Where the sound should go.
     *
     * Falls back to the loudspeaker whenever what was asked for is not there
     * (an earpiece on a tablet), and assumes a loudspeaker exists even when
     * the list is empty: every Android phone has one, and an empty list is a
     * platform that has not answered yet, not a phone without a speaker.
     */
    fun choose(available: Set<AudioOutput>, preference: RoutePreference): AudioOutput {
        val headset = headsetOrder.firstOrNull { it in available }
        return when (preference) {
            RoutePreference.Speaker -> AudioOutput.Speaker
            RoutePreference.Auto -> headset ?: AudioOutput.Speaker
            RoutePreference.Earpiece -> headset
                ?: if (AudioOutput.Earpiece in available) AudioOutput.Earpiece else AudioOutput.Speaker
        }
    }

    /** [choose] plus how to put it into effect on [sdk]. */
    fun decide(deviceTypes: Collection<Int>, preference: RoutePreference, sdk: Int): RouteDecision {
        val output = choose(availableOutputs(deviceTypes, sdk), preference)
        val action = if (sdk >= Build.VERSION_CODES.S) {
            RouteAction.CommunicationDevice(output)
        } else {
            legacyAction(output)
        }
        return RouteDecision(output, action)
    }

    /**
     * Below API 31: speakerphone on only for the speaker, SCO on only for
     * Bluetooth. Earpiece, wired and USB are all "both off", and the platform
     * picks a plugged headset over the earpiece by itself.
     */
    fun legacyAction(output: AudioOutput): RouteAction.Legacy = RouteAction.Legacy(
        speakerphoneOn = output == AudioOutput.Speaker,
        bluetoothSco = output == AudioOutput.Bluetooth,
    )

    /**
     * What the call bar's one button does, read off where the sound actually
     * is right now ([current]) rather than off the stored preference, so a
     * route somebody else changed (the system output switcher, a headset's
     * own button) is toggled from what the person hears.
     *
     * - On a headset: to the loudspeaker.
     * - On the loudspeaker with a headset connected: back to the headset.
     * - On the loudspeaker with no headset: to the earpiece, today's toggle.
     *   On a device with no earpiece there is nowhere else to go.
     * - On the earpiece: to the loudspeaker. Forced when a headset is
     *   connected (the system put the call on the earpiece anyway), because
     *   Auto would resolve to the headset instead.
     */
    fun toggled(current: AudioOutput, available: Set<AudioOutput>): RoutePreference = when {
        current.isHeadset -> RoutePreference.Speaker
        current == AudioOutput.Earpiece ->
            if (available.any { it.isHeadset }) RoutePreference.Speaker else RoutePreference.Auto
        available.any { it.isHeadset } -> RoutePreference.Auto
        AudioOutput.Earpiece in available -> RoutePreference.Earpiece
        else -> RoutePreference.Auto
    }

    /**
     * The preference after the set of connected devices changed mid-call.
     *
     * Plugging in a headset is the strongest statement a person can make
     * about where they want to hear the call, so a newly connected headset
     * ends an earlier "loudspeaker please". Nothing else changes the
     * preference: unplugging falls back through [choose] on its own, and the
     * private choice ([RoutePreference.Earpiece]) already follows headsets.
     */
    fun afterDevicesChanged(
        preference: RoutePreference,
        before: Set<AudioOutput>,
        after: Set<AudioOutput>,
    ): RoutePreference {
        val newHeadset = after.any { it.isHeadset && it !in before }
        return if (newHeadset && preference == RoutePreference.Speaker) RoutePreference.Auto else preference
    }

    /**
     * The preference a new call starts with. A forced loudspeaker does not
     * outlive the call it was chosen in: carried over, it is the original
     * bug again (a headset on, the call on the loudspeaker). The earpiece
     * choice carries, as it always did.
     */
    fun atCallStart(preference: RoutePreference): RoutePreference =
        if (preference == RoutePreference.Speaker) RoutePreference.Auto else preference

    /**
     * Where the platform sends a voice call when nobody has picked a device
     * (API 31+ reports no communication device): a plugged headset, else the
     * earpiece, else the loudspeaker. Only used to label the button
     * truthfully, never to route.
     */
    fun platformDefault(available: Set<AudioOutput>): AudioOutput =
        headsetOrder.firstOrNull { it in available }
            ?: if (AudioOutput.Earpiece in available) AudioOutput.Earpiece else AudioOutput.Speaker

    /**
     * The same output in Telecom's vocabulary. Telecom has no separate USB
     * route: its wired route covers USB headsets.
     */
    fun telecomRoute(output: AudioOutput): Int = when (output) {
        AudioOutput.Bluetooth -> CallAudioState.ROUTE_BLUETOOTH
        AudioOutput.UsbHeadset, AudioOutput.WiredHeadset -> CallAudioState.ROUTE_WIRED_HEADSET
        AudioOutput.Speaker -> CallAudioState.ROUTE_SPEAKER
        AudioOutput.Earpiece -> CallAudioState.ROUTE_EARPIECE
    }

    /** Telecom's reported route, or null for one this code has no label for. */
    fun fromTelecomRoute(route: Int): AudioOutput? = when (route) {
        CallAudioState.ROUTE_BLUETOOTH -> AudioOutput.Bluetooth
        CallAudioState.ROUTE_WIRED_HEADSET -> AudioOutput.WiredHeadset
        CallAudioState.ROUTE_SPEAKER -> AudioOutput.Speaker
        CallAudioState.ROUTE_EARPIECE -> AudioOutput.Earpiece
        else -> null
    }
}
