package gg.pqp.app.voice

import android.content.pm.ServiceInfo
import android.os.Build

/**
 * The foreground-service type set [VoiceService] declares, for a given
 * Android version.
 *
 * Pulled out of the service so the version arithmetic is a pure function a
 * unit test can walk across every release, because it was wrong on exactly the
 * releases nobody had a device for.
 *
 * ### Why Android 10 to 13 are not "no type"
 *
 * This used to return 0 below Android 14, on the theory that the types are an
 * Android 14 requirement and older releases would fall back to what the manifest
 * declares. They do not. `ServiceCompat.startForeground` passes the number on,
 * and `startForeground(id, notification, 0)` means "this service has no
 * foreground type": the manifest is only consulted for `-1`
 * (`FOREGROUND_SERVICE_TYPE_MANIFEST`), which is what the two-argument call
 * sends. A service running with type 0 has no `mediaProjection` type, and
 * `MediaProjectionManager.getMediaProjection` checks the *running* type from
 * Android 10: "Media projections require a foreground service of type
 * ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION". So on Android 10, 11,
 * 12 and 13 every screen share failed inside the capturer, the call bar said
 * "Android would not start the screen capture", and nothing else was wrong.
 * Reproduced on an API 33 emulator; Android 14 and later were never affected
 * because they got the full set below.
 *
 * Below Android 10 the platform has no per-type check at all and the type is
 * ignored by the compat call, so it is not worth a branch.
 *
 * `microphone` and `phoneCall` exist from Android 11 (API 30); on Android 10
 * only `mediaProjection` is a type that can be named.
 */
internal fun voiceForegroundTypes(sdkInt: Int, projecting: Boolean): Int {
    if (sdkInt >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        // `phoneCall` alongside `microphone`: every join also places or answers
        // a Telecom self-managed call (see `voice.telecom`), and declaring the
        // type is what the CallStyle notification is meant to sit under. Safe
        // to declare unconditionally: it only requires the (normal,
        // always-granted) MANAGE_OWN_CALLS permission, not that Telecom
        // actually accepted this particular call.
        var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
            ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
        if (projecting) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        return types
    }
    // Only a share needs a type before Android 14, and only that one is
    // changed: an ordinary call has run with 0 here since the first release and
    // that is not what this fixes.
    if (!projecting || sdkInt < Build.VERSION_CODES.Q) return 0
    var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
    if (sdkInt >= Build.VERSION_CODES.R) {
        types = types or
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
            ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
    }
    return types
}

/**
 * The type sets [VoiceService] offers `startForeground`, best first.
 *
 * ### Why there is more than one
 *
 * From Android 14, `startForeground` checks every type it is handed and throws
 * `SecurityException` from inside `onStartCommand` when one is not allowed
 * right now. `microphone` is the one that bites: it needs RECORD_AUDIO
 * granted AND the app in a state where a while-in-use permission counts
 * (on screen, or started by a tap on its own notification). Several ways
 * into a call meet neither: answering a DM call from the lock-screen
 * notification or a headset through Telecom when the microphone was never
 * granted (only the in-app buttons ask for it), and a call rebuilt from the
 * background after the socket dropped. Each of those crashed the whole app
 * on 0.4.28 (`VoiceService.onStartCommand`, `SecurityException`, Play vitals).
 *
 * So the first rung leaves `microphone` out when the permission is not held
 * at all (it would be refused, and a call with no microphone fails to join on
 * its own, cleanly), and the later rungs drop one restricted type at a time,
 * ending on the type that needs no while-in-use state at all: `phoneCall` on
 * Android 14 and later (MANAGE_OWN_CALLS, a normal permission), and no type
 * below it, which is what an ordinary call has always run with there. A call
 * held by a lesser rung stays alive with its notification; the next
 * `startForeground` asks for the full set again, and [ForegroundRung] is how the
 * app asks without waiting for one: when it comes back to the foreground and on
 * a mute toggle, the two moments Android counts the microphone as usable.
 */
internal fun voiceForegroundTypeLadder(
    sdkInt: Int,
    projecting: Boolean,
    microphoneGranted: Boolean,
): List<Int> {
    val mic = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    val projection = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
    var full = voiceForegroundTypes(sdkInt, projecting)
    if (!microphoneGranted) full = full and mic.inv()
    val floor = if (sdkInt >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
    } else {
        0
    }
    return listOf(
        full,
        full and mic.inv(),
        full and projection.inv(),
        floor,
    ).distinct()
}

/**
 * Walk [ladder] until [start] accepts a type set, and return that set.
 *
 * Only `SecurityException` moves to the next rung, because it is the one
 * Android throws for "this type is not allowed right now". When every rung
 * is refused the last refusal is rethrown: the app then fails exactly the way
 * it did before the ladder existed, never in a new way.
 */
internal inline fun startForegroundOnLadder(
    ladder: List<Int>,
    start: (types: Int) -> Unit,
    onRefused: (types: Int, error: SecurityException) -> Unit = { _, _ -> },
): Int {
    var last: SecurityException? = null
    for (types in ladder) {
        try {
            start(types)
            return types
        } catch (error: SecurityException) {
            last = error
            onRefused(types, error)
        }
    }
    throw last ?: IllegalStateException("no foreground type to try")
}

/**
 * True when a call wants the microphone type and the running set lacks it, the
 * state in which Android silences the recording while the app is in the
 * background and nothing on screen says so. [wanted] is the first rung of the
 * ladder, so a call that never asked for the type (no permission, Android 13 and
 * below) is never "paused".
 */
internal fun microphonePaused(wanted: Int, running: Int): Boolean {
    val mic = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    return wanted and mic != 0 && running and mic == 0
}

/**
 * The rungs a re-ask may try: the ones in [ladder] that hold everything
 * [running] holds and more, best first, then [running] itself as the last one.
 *
 * Both halves matter. Ending on the rung the service already holds is what makes
 * a refused re-ask a no-op. Keeping only supersets is what stops it falling
 * sideways: with `microphone + phoneCall` held, the ladder's next rung down from
 * the full set is `phoneCall + mediaProjection`, which is *above* the held one
 * in the list and *worse* for the call, because it trades the microphone for a
 * type the share no longer needs. A [running] that is not on the ladder (the
 * share state changed underneath) asks for nothing better than it has.
 */
internal fun reaskLadder(ladder: List<Int>, running: Int): List<Int> {
    if (running !in ladder) return listOf(running)
    val better = ladder.filter { it != running && it and running == running }
    return better + running
}

/**
 * [startForegroundOnLadder] for a service that is already foreground on
 * [running]: try to get back to a better rung, and when Android refuses every
 * one of them keep [running] and say nothing more. Never throws, because there
 * is nothing to crash over: the call is alive on the rung it had.
 */
internal inline fun reaskForegroundOnLadder(
    ladder: List<Int>,
    running: Int,
    start: (types: Int) -> Unit,
    onRefused: (types: Int, error: SecurityException) -> Unit = { _, _ -> },
): Int = try {
    startForegroundOnLadder(reaskLadder(ladder, running), start, onRefused)
} catch (_: SecurityException) {
    running
}

/**
 * What [VoiceService] is foreground with, against what the call wants.
 *
 * Kept apart from the service so the "should this ask again" decision is plain
 * state a unit test can drive. [running] is null while there is no service.
 * The ask is event driven and nothing else: no timer, no retry loop. A refused
 * re-ask leaves [running] where it was, so the next foreground or the next
 * toggle simply asks again, and a call already on its wanted rung asks nothing.
 */
internal class ForegroundRung {
    @Volatile var wanted: Int = 0
        private set
    @Volatile var running: Int? = null
        private set

    /** True while the service holds a rung other than the one the call wants. */
    val lesser: Boolean
        get() = running?.let { it != wanted } ?: false

    fun record(wanted: Int, running: Int) {
        this.wanted = wanted
        this.running = running
    }

    fun clear() {
        wanted = 0
        running = null
    }

    /** The app came to the foreground. [send] is the re-ask. */
    fun onAppForeground(send: () -> Unit) = reaskIfLesser(send)

    /** The person muted or unmuted from inside the app. [send] is the re-ask. */
    fun onMuteToggled(send: () -> Unit) = reaskIfLesser(send)

    private fun reaskIfLesser(send: () -> Unit) {
        if (lesser) send()
    }
}
