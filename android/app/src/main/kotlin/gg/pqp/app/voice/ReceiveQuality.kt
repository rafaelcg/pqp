package gg.pqp.app.voice

import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoQuality

/**
 * Whether this client asks the SFU for a publication at all.
 *
 * The room is joined with `autoSubscribe = false` precisely so this decision
 * exists, and it is a top-level function rather than a `when` inside the
 * engine because it is the only part of the subscription path a test on this
 * machine can reach: nothing in that module can build a `Room` without a
 * device.
 *
 * **Audio, from any source.** A microphone is a voice and a
 * `SCREEN_SHARE_AUDIO` publication is a watch party's soundtrack; both are
 * small and both are wanted. The engine tells them apart afterwards: the
 * presentation's sound is silenced by deafen like everything else and is never
 * what makes somebody count as audible.
 *
 * **Video only when it is a screen share.** That is the thing a phone joins a
 * LiveKit room to watch, and the presenter now publishes simulcast layers
 * (`client/src/lib/video-quality.ts`), so there is a phone-sized copy on the
 * server to ask for; [screenReceiveLayerFor] names it. A camera is refused: this
 * client draws no camera tiles, so a subscribed camera could only be decoded
 * and dropped, which on Brazilian mobile data is somebody paying for frames
 * nobody sees. Anything LiveKit adds later is refused by default for the same
 * reason.
 */
fun livekitSubscribesTo(kind: Track.Kind, source: Track.Source): Boolean = when (kind) {
    Track.Kind.AUDIO -> true
    Track.Kind.VIDEO -> source == Track.Source.SCREEN_SHARE
    else -> false
}

/**
 * The largest simulcast layer this phone asks the SFU for, before anybody has
 * touched a setting.
 *
 * The web's `receive-quality.ts` decides the same thing from four browser
 * signals; on a phone three of them are always true, so what is left is the
 * link. A 100-viewer watch party on 5 Sep 2026 cost 323 GB of SFU downstream
 * in three and a half hours, and most of those viewers were phones drawing a
 * 1080p share into a 390-pixel-wide element.
 *
 * **720p (`MEDIUM`) on Wi-Fi.** A phone held sideways is a 720-line screen,
 * and adaptive stream still shrinks below this ceiling when the picture is
 * drawn smaller. The 1080p layer is never asked for by default: a tablet drawn
 * at full width would take it by accident and nobody would see the difference.
 *
 * **360p (`LOW`) on a metered link.** Mobile data is a fact about the bill,
 * not the screen: 360p of a share is readable text at phone size and a quarter
 * of the 720p layer's bytes. `ConnectivityManager.isActiveNetworkMetered` is
 * the signal, which also covers a hotspot the OS knows is metered.
 *
 * A ceiling, not a request: with adaptive stream on the room, LiveKit sends
 * the smaller of this and whatever layer covers the view (verified on the web
 * against livekit-client 2.21.0, and the Android SDK's
 * `RemoteTrackPublication` carries the same `videoQuality` and `videoDimensions`
 * pair to the signal). `HIGH` is the SDK's resting value, so this never
 * returns it: returning it would mean "no ceiling", which is the desktop
 * default and not a phone's.
 */
fun screenReceiveLayerFor(metered: Boolean): VideoQuality =
    if (metered) VideoQuality.LOW else VideoQuality.MEDIUM
