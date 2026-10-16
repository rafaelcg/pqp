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
