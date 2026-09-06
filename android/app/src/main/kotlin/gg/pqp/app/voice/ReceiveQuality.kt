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
 * **Video when it is a screen share, and now when it is a camera.** The share
 * is what a phone joins a LiveKit room to watch, and the presenter publishes
 * simulcast layers (`client/src/lib/video-quality.ts`), so there is a
 * phone-sized copy on the server to ask for; [screenReceiveLayerFor] names it.
 * A camera used to be refused here, because this client drew no camera tiles
 * and a subscribed camera could only be decoded and dropped. It draws them now
 * (the strip under the call bar and the viewer behind it), so refusing one
 * would mean a room where every face is missing on Android alone, which is what
 * the 5 Sep watch party looked like from a phone.
 *
 * Admitting a camera is only half of not paying for it: what keeps twenty of
 * them off a phone's bill is [CameraDemand], which pauses every camera no
 * surface is drawing, and [cameraReceiveLayerFor], which never asks for the top
 * layer. Subscribing is cheap; delivery is what costs, and delivery is off by
 * default.
 *
 * Anything LiveKit adds later is still refused by default, for the reason the
 * camera no longer is: there would be nothing on this client able to draw it.
 */
fun livekitSubscribesTo(kind: Track.Kind, source: Track.Source): Boolean = when (kind) {
    Track.Kind.AUDIO -> true
    Track.Kind.VIDEO -> source == Track.Source.SCREEN_SHARE || source == Track.Source.CAMERA
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
 * A ceiling, not a request: with adaptive stream on, LiveKit sends the smaller
 * of this and whatever layer covers the view (verified on the web against
 * livekit-client 2.21.0, and the Android SDK's `RemoteTrackPublication` carries
 * the same `videoQuality` and `videoDimensions` pair to the signal). `HIGH` is
 * the SDK's resting value, so this never returns it: returning it would mean
 * "no ceiling", which is the desktop default and not a phone's.
 */
fun screenReceiveLayerFor(metered: Boolean): VideoQuality =
    if (metered) VideoQuality.LOW else VideoQuality.MEDIUM

/**
 * The layer this phone asks for of somebody's **camera**, given how big the
 * surface drawing it is.
 *
 * A separate rule from [screenReceiveLayerFor] because the two are not the same
 * picture. A share is text somebody has to read, drawn one at a time and full
 * bleed; a camera is a face, and the common case is several of them at once in
 * a strip about a hundred dp wide. Asking for 720p of a face to draw it at
 * tile size is the exact waste the share rule was written to stop, multiplied
 * by however many people have their camera on.
 *
 * - **A tile takes the bottom layer**, on any link. At the rail's size that is
 *   more pixels than the tile has, and a room where six people are on camera
 *   costs a phone about what one share does.
 * - **The viewer takes 360p (`MEDIUM`) on Wi-Fi**, because it is the whole
 *   screen and a face at the bottom layer is visibly soft that big.
 * - **A metered link stays at the bottom layer even full screen.** Same
 *   argument as the share rule: mobile data is a fact about the bill.
 *
 * `HIGH` is never returned, for the same reason it never is for a share.
 *
 * **What this is worth today, stated honestly.** The web publishes its camera
 * with `simulcast: false` (`client/src/lib/livekit-session.ts`), so for a web
 * participant there is exactly one layer on the server and this ceiling has
 * nothing smaller to pick: the bytes saved for that publisher come entirely
 * from pausing cameras nobody is drawing. iOS publishes through
 * `setCamera`, which does simulcast, and a camera published with layers is
 * what this rule is already correct for. It is applied to every camera either
 * way, because the alternative is a rule that has to be remembered the day
 * simulcast is switched on.
 */
fun cameraReceiveLayerFor(metered: Boolean, surface: CameraSurface): VideoQuality = when {
    metered -> VideoQuality.LOW
    surface == CameraSurface.Fullscreen -> VideoQuality.MEDIUM
    else -> VideoQuality.LOW
}

/**
 * What to tell the SFU about one camera: whether to send it, and how big.
 *
 * A null [quality] means "do not say anything about the layer", which is not
 * the same as a low one: a publication being paused needs one message, and
 * naming a layer for a stream that is about to stop is a second message that
 * changes nothing.
 */
data class CameraDelivery(val enabled: Boolean, val quality: VideoQuality?)

/**
 * The whole camera delivery decision, in one pure place.
 *
 * It lives here rather than inside [LiveKitEngine] for the reason everything
 * else in this file does: nothing in that module can build a `Room` without a
 * device, so a rule left inside it is a rule nothing on this machine can check.
 * The engine's job is reduced to holding the lock, reading the three inputs and
 * making two SDK calls.
 *
 * - **No surface means paused**, which is the resting state of every camera in
 *   a room this phone has not scrolled to.
 * - **A muted camera is never delivered**, whatever any surface wants. There
 *   are no frames at the far end to send; asking for them is a subscription
 *   paying for keepalives, and the tile has been taken down anyway.
 * - Otherwise the layer is [cameraReceiveLayerFor] of the largest surface
 *   drawing it, sent *before* the resume so that the frames which arrive when
 *   it comes back are already the right size.
 */
fun cameraDeliveryFor(
    surface: CameraSurface?,
    muted: Boolean,
    metered: Boolean,
): CameraDelivery = if (surface == null || muted) {
    CameraDelivery(enabled = false, quality = null)
} else {
    CameraDelivery(enabled = true, quality = cameraReceiveLayerFor(metered, surface))
}
