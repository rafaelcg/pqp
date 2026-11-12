package gg.pqp.app.jam.record

import android.media.AudioDeviceInfo

/*
 * THE AUDIO ROUTE A TAKE TRAVELS: which output the band plays on and which input
 * hears the person. A calibration is only true for the route it was measured on
 * (the phone's own speaker and microphone, a wired headset, a pair of Bluetooth
 * earbuds are four different latencies), so it is stored under the route's key
 * and a different route means "measure again".
 *
 * The decisions are pure over [Device] (a type and a name, the two things an
 * `AudioDeviceInfo` says that survive a reboot), so they run on the JVM
 * (`JamRouteTest`). The platform half, turning `AudioDeviceInfo` into [Device]
 * and asking the system what is routed, is at the bottom.
 */

/** What a device is, for the three questions the studio asks: bleed, latency, and what to call it. */
enum class RouteKind {
    /** The phone's loudspeaker or earpiece: the microphone hears the band. */
    Speaker,

    /** Wired headphones, a headset, a USB audio device: the microphone does not hear the band. */
    Wired,

    /** Bluetooth: 100 to 300 ms of delay that changes from session to session, which no calibration holds. */
    Bluetooth,
    Other,
}

data class Device(val type: Int, val name: String) {
    val kind: RouteKind get() = JamRoutes.kindOf(type)
}

data class JamRoute(val input: Device?, val output: Device?, val sampleRate: Int) {
    /**
     * The key a calibration is stored under. The name is in it because two
     * pairs of Bluetooth earbuds are the same type and different latencies; the
     * sample rate because a different rate is a different driver setup.
     */
    val key: String
        get() = "in:${tag(input)}|out:${tag(output)}|sr:$sampleRate"

    val outputKind: RouteKind get() = output?.kind ?: RouteKind.Other

    /** The microphone can hear the band: the speaker, or nothing known (assume the worst). */
    val bleeds: Boolean get() = outputKind == RouteKind.Speaker

    private fun tag(d: Device?) = if (d == null) "none" else "${d.type}:${d.name.trim().lowercase().replace(Regex("\\s+"), " ")}"
}

@android.annotation.SuppressLint("InlinedApi")
object JamRoutes {
    fun kindOf(type: Int): RouteKind = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
        AudioDeviceInfo.TYPE_BUILTIN_MIC,
        -> RouteKind.Speaker

        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_USB_DEVICE,
        AudioDeviceInfo.TYPE_USB_ACCESSORY,
        AudioDeviceInfo.TYPE_LINE_ANALOG,
        AudioDeviceInfo.TYPE_LINE_DIGITAL,
        AudioDeviceInfo.TYPE_AUX_LINE,
        AudioDeviceInfo.TYPE_DOCK,
        -> RouteKind.Wired

        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_BLE_SPEAKER,
        AudioDeviceInfo.TYPE_BLE_BROADCAST,
        AudioDeviceInfo.TYPE_HEARING_AID,
        -> RouteKind.Bluetooth

        else -> RouteKind.Other
    }

    /**
     * Which output the system is most likely playing media on when nothing is
     * playing yet: wired and USB first (plugging in is a deliberate act), then
     * Bluetooth, then the speaker. A PREVIEW: it only has to be right enough to
     * look up a stored calibration and warn about the speaker, and the real route
     * is read from the live `AudioTrack` the moment the band starts.
     */
    fun likelyOutput(outputs: List<Device>): Device? {
        fun rank(d: Device) = when (d.kind) {
            RouteKind.Wired -> 0
            RouteKind.Bluetooth -> 1
            RouteKind.Other -> 2
            RouteKind.Speaker -> if (d.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) 3 else 4
        }
        return outputs.minByOrNull(::rank)
    }

    /**
     * The microphone that goes with an output: a headset's own microphone when
     * the output is a wired or USB headset that has one, otherwise the phone's.
     * (Bluetooth earbuds in media mode have no microphone path; the phone's is
     * used, which is what Android does.)
     */
    fun likelyInput(inputs: List<Device>, output: Device?): Device? {
        val sameKind = if (output?.kind == RouteKind.Wired) inputs.firstOrNull { it.kind == RouteKind.Wired } else null
        return sameKind ?: inputs.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC } ?: inputs.firstOrNull()
    }

    fun preview(outputs: List<Device>, inputs: List<Device>, sampleRate: Int): JamRoute {
        val out = likelyOutput(outputs)
        return JamRoute(likelyInput(inputs, out), out, sampleRate)
    }

    fun device(info: AudioDeviceInfo?): Device? = info?.let { Device(it.type, it.productName?.toString().orEmpty()) }
}
