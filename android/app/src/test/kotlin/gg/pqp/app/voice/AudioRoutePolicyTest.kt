package gg.pqp.app.voice

import android.media.AudioDeviceInfo
import android.telecom.CallAudioState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A user on the Android app: the call did not use their headset.
 * `VoiceController.applyAudioRoute` asked for the loudspeaker on every call,
 * with `setCommunicationDevice(TYPE_BUILTIN_SPEAKER)` on API 31+ and
 * `isSpeakerphoneOn = true` below, and its comment said a headset would still
 * win. An explicit request beats the platform's preference, so it never did.
 *
 * [oldRoute] is that function's decision, kept here to show the bug: it
 * answers the loudspeaker whatever is plugged in.
 */
class AudioRoutePolicyTest {

    private val speaker = AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
    private val earpiece = AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
    private val wired = AudioDeviceInfo.TYPE_WIRED_HEADSET
    private val headphones = AudioDeviceInfo.TYPE_WIRED_HEADPHONES
    private val usb = AudioDeviceInfo.TYPE_USB_HEADSET
    private val sco = AudioDeviceInfo.TYPE_BLUETOOTH_SCO
    private val ble = AudioDeviceInfo.TYPE_BLE_HEADSET
    private val hearingAid = AudioDeviceInfo.TYPE_HEARING_AID
    private val a2dp = AudioDeviceInfo.TYPE_BLUETOOTH_A2DP

    /** A phone's own two, which every list below starts from. */
    private val phone = listOf(speaker, earpiece)

    private val modern = 31
    private val legacy = 30

    @Suppress("UNUSED_PARAMETER")
    private fun oldRoute(deviceTypes: List<Int>): AudioOutput = AudioOutput.Speaker

    private fun outputs(vararg types: Int, sdk: Int = modern) =
        AudioRoutePolicy.availableOutputs(phone + types.toList(), sdk)

    private fun auto(vararg types: Int, sdk: Int = modern) =
        AudioRoutePolicy.decide(phone + types.toList(), RoutePreference.Auto, sdk)

    @Test
    fun `the old route ignored a plugged headset`() {
        assertEquals(AudioOutput.Speaker, oldRoute(phone + wired))
        assertEquals(AudioOutput.WiredHeadset, auto(wired).output)
    }

    @Test
    fun `no headset is the loudspeaker, exactly as before`() {
        for (sdk in 26..37) {
            assertEquals("API $sdk", AudioOutput.Speaker, auto(sdk = sdk).output)
        }
        // A platform that has not listed anything yet still gets a speaker,
        // never the earpiece nobody can hear.
        assertEquals(AudioOutput.Speaker, AudioRoutePolicy.choose(emptySet(), RoutePreference.Auto))
    }

    @Test
    fun `a wired headset or headphones`() {
        assertEquals(AudioOutput.WiredHeadset, auto(wired).output)
        assertEquals(AudioOutput.WiredHeadset, auto(headphones).output)
        assertEquals(AudioOutput.WiredHeadset, auto(wired, sdk = legacy).output)
    }

    @Test
    fun `a USB headset`() {
        assertEquals(AudioOutput.UsbHeadset, auto(usb).output)
        assertEquals(AudioOutput.UsbHeadset, auto(usb, sdk = legacy).output)
    }

    @Test
    fun `a Bluetooth headset, by every name the platform gives one`() {
        assertEquals(AudioOutput.Bluetooth, auto(sco).output)
        assertEquals(AudioOutput.Bluetooth, auto(ble).output)
        assertEquals(AudioOutput.Bluetooth, auto(hearingAid).output)
        assertEquals(AudioOutput.Bluetooth, auto(sco, sdk = legacy).output)
    }

    @Test
    fun `below 31 only SCO is a Bluetooth route`() {
        // LE audio and hearing aids cannot be reached with the speakerphone
        // and SCO switches, so they are not offered as something to pick.
        assertEquals(AudioOutput.Speaker, auto(ble, sdk = legacy).output)
        assertEquals(AudioOutput.Speaker, auto(hearingAid, sdk = legacy).output)
    }

    @Test
    fun `media-only Bluetooth is not a call route`() {
        assertNull(AudioRoutePolicy.outputFor(a2dp, modern))
        assertEquals(AudioOutput.Speaker, auto(a2dp).output)
    }

    @Test
    fun `several headsets at once pick Bluetooth, then USB, then the jack`() {
        assertEquals(AudioOutput.Bluetooth, auto(wired, usb, sco).output)
        assertEquals(AudioOutput.UsbHeadset, auto(wired, usb).output)
        assertEquals(AudioOutput.WiredHeadset, auto(wired, a2dp).output)
    }

    @Test
    fun `a forced loudspeaker wins over every headset`() {
        for (types in listOf(listOf(wired), listOf(usb), listOf(sco), listOf(wired, usb, sco), emptyList())) {
            assertEquals(
                AudioOutput.Speaker,
                AudioRoutePolicy.decide(phone + types, RoutePreference.Speaker, modern).output,
            )
        }
    }

    @Test
    fun `the earpiece choice is the earpiece without a headset and the headset with one`() {
        val pref = RoutePreference.Earpiece
        assertEquals(AudioOutput.Earpiece, AudioRoutePolicy.choose(outputs(), pref))
        assertEquals(AudioOutput.WiredHeadset, AudioRoutePolicy.choose(outputs(wired), pref))
        assertEquals(AudioOutput.Bluetooth, AudioRoutePolicy.choose(outputs(sco), pref))
        // A tablet has no earpiece: the loudspeaker, not silence.
        assertEquals(AudioOutput.Speaker, AudioRoutePolicy.choose(setOf(AudioOutput.Speaker), pref))
    }

    @Test
    fun `API 31 and later name the device, older versions flip two switches`() {
        assertEquals(RouteAction.CommunicationDevice(AudioOutput.Bluetooth), auto(sco).action)
        assertEquals(RouteAction.Legacy(speakerphoneOn = false, bluetoothSco = true), auto(sco, sdk = legacy).action)
        assertEquals(RouteAction.Legacy(speakerphoneOn = true, bluetoothSco = false), auto(sdk = legacy).action)
        // Wired and USB below 31: both off, and the platform takes the jack.
        assertEquals(RouteAction.Legacy(speakerphoneOn = false, bluetoothSco = false), auto(wired, sdk = legacy).action)
        assertEquals(RouteAction.Legacy(speakerphoneOn = false, bluetoothSco = false), auto(usb, sdk = legacy).action)
        assertEquals(
            RouteAction.Legacy(speakerphoneOn = false, bluetoothSco = false),
            AudioRoutePolicy.decide(phone, RoutePreference.Earpiece, legacy).action,
        )
    }

    @Test
    fun `the button without a headset is speaker and earpiece, as it always was`() {
        val none = outputs()
        assertEquals(RoutePreference.Earpiece, AudioRoutePolicy.toggled(AudioOutput.Speaker, none))
        assertEquals(AudioOutput.Earpiece, AudioRoutePolicy.choose(none, RoutePreference.Earpiece))
        assertEquals(RoutePreference.Auto, AudioRoutePolicy.toggled(AudioOutput.Earpiece, none))
        assertEquals(AudioOutput.Speaker, AudioRoutePolicy.choose(none, RoutePreference.Auto))
    }

    @Test
    fun `the button with a headset is the headset and the loudspeaker`() {
        for (type in listOf(wired, usb, sco)) {
            val withHeadset = outputs(type)
            val onHeadset = AudioRoutePolicy.choose(withHeadset, RoutePreference.Auto)
            val forced = AudioRoutePolicy.toggled(onHeadset, withHeadset)
            assertEquals(RoutePreference.Speaker, forced)
            assertEquals(AudioOutput.Speaker, AudioRoutePolicy.choose(withHeadset, forced))
            val back = AudioRoutePolicy.toggled(AudioOutput.Speaker, withHeadset)
            assertEquals(RoutePreference.Auto, back)
            assertEquals(onHeadset, AudioRoutePolicy.choose(withHeadset, back))
        }
    }

    @Test
    fun `a tablet with no earpiece stays on the loudspeaker`() {
        val tablet = setOf(AudioOutput.Speaker)
        assertEquals(RoutePreference.Auto, AudioRoutePolicy.toggled(AudioOutput.Speaker, tablet))
    }

    @Test
    fun `plugging a headset in mid-call moves the call to it, unplugging returns to the loudspeaker`() {
        var pref = RoutePreference.Auto
        var devices = outputs()
        fun step(next: Set<AudioOutput>): AudioOutput {
            pref = AudioRoutePolicy.afterDevicesChanged(pref, devices, next)
            devices = next
            return AudioRoutePolicy.choose(devices, pref)
        }
        assertEquals(AudioOutput.Speaker, AudioRoutePolicy.choose(devices, pref))
        assertEquals(AudioOutput.WiredHeadset, step(outputs(wired)))
        assertEquals(AudioOutput.Bluetooth, step(outputs(wired, sco)))
        assertEquals(AudioOutput.WiredHeadset, step(outputs(wired)))
        assertEquals(AudioOutput.Speaker, step(outputs()))
        assertEquals(RoutePreference.Auto, pref)
    }

    @Test
    fun `a newly connected headset ends an earlier forced loudspeaker`() {
        val before = outputs(wired)
        val after = outputs(wired, sco)
        val pref = AudioRoutePolicy.afterDevicesChanged(RoutePreference.Speaker, before, after)
        assertEquals(RoutePreference.Auto, pref)
        assertEquals(AudioOutput.Bluetooth, AudioRoutePolicy.choose(after, pref))
    }

    @Test
    fun `losing a headset keeps a forced loudspeaker, and the earpiece choice follows headsets`() {
        assertEquals(
            RoutePreference.Speaker,
            AudioRoutePolicy.afterDevicesChanged(RoutePreference.Speaker, outputs(wired, sco), outputs(wired)),
        )
        // Unrelated churn (a media-only device) is not a new headset.
        assertEquals(
            RoutePreference.Speaker,
            AudioRoutePolicy.afterDevicesChanged(RoutePreference.Speaker, outputs(wired), outputs(wired, a2dp)),
        )
        var pref = RoutePreference.Earpiece
        pref = AudioRoutePolicy.afterDevicesChanged(pref, outputs(), outputs(usb))
        assertEquals(AudioOutput.UsbHeadset, AudioRoutePolicy.choose(outputs(usb), pref))
        pref = AudioRoutePolicy.afterDevicesChanged(pref, outputs(usb), outputs())
        assertEquals(AudioOutput.Earpiece, AudioRoutePolicy.choose(outputs(), pref))
    }

    @Test
    fun `a forced loudspeaker does not carry into the next call, the earpiece does`() {
        assertEquals(RoutePreference.Auto, AudioRoutePolicy.atCallStart(RoutePreference.Speaker))
        assertEquals(RoutePreference.Earpiece, AudioRoutePolicy.atCallStart(RoutePreference.Earpiece))
        assertEquals(RoutePreference.Auto, AudioRoutePolicy.atCallStart(RoutePreference.Auto))
    }

    @Test
    fun `with nothing chosen the label follows the platform's own order`() {
        assertEquals(AudioOutput.Earpiece, AudioRoutePolicy.platformDefault(outputs()))
        assertEquals(AudioOutput.WiredHeadset, AudioRoutePolicy.platformDefault(outputs(wired)))
        assertEquals(AudioOutput.Speaker, AudioRoutePolicy.platformDefault(setOf(AudioOutput.Speaker)))
    }

    @Test
    fun `Telecom's vocabulary round-trips, with USB as its wired route`() {
        for (output in AudioOutput.entries) {
            val route = AudioRoutePolicy.telecomRoute(output)
            val back = AudioRoutePolicy.fromTelecomRoute(route)
            val expected = if (output == AudioOutput.UsbHeadset) AudioOutput.WiredHeadset else output
            assertEquals(expected, back)
        }
        assertEquals(CallAudioState.ROUTE_WIRED_HEADSET, AudioRoutePolicy.telecomRoute(AudioOutput.UsbHeadset))
        assertNull(AudioRoutePolicy.fromTelecomRoute(CallAudioState.ROUTE_STREAMING))
    }
}
