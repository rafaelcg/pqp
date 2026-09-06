package gg.pqp.app.voice

import io.livekit.android.room.Room
import io.livekit.android.room.track.RemoteVideoTrack

/**
 * Somebody else's video, as arrived over whichever transport the room runs on.
 *
 * One value for the UI to render, two shapes underneath, and the split is not
 * cosmetic. This process carries two unrelated libwebrtc builds (see
 * [VoiceTransport], "Two WebRTC namespaces"): the mesh decodes into
 * `org.webrtc` types and LiveKit into `livekit.org.webrtc` types. A video
 * track from one cannot be drawn by a renderer initialised on the other's GL
 * context; it compiles and then dies at the first frame. Keeping the two as
 * separate cases means the renderer for each is chosen by the compiler, not by
 * a cast that happens to work on the transport somebody tested.
 *
 * Both carry everything a renderer needs to be built, so the UI never reaches
 * back into a transport for a GL context that may belong to a room that has
 * since been released.
 *
 * **A feed, not a screen.** This type was born holding screen shares only
 * (PR #277) and was called `RemoteScreen`. Cameras arrive over exactly the same
 * two namespaces and are drawn by exactly the same two renderers, so they are
 * this type too; what a feed *is* lives in the map it came out of
 * ([VoiceController.remoteScreens] or [VoiceController.remoteCameras]) rather
 * than in the value, because the transports already label the two and a second
 * label here could disagree with them.
 */
sealed interface RemoteVideoFeed {

    /** A mesh peer's video: the track and the engine's own GL context. */
    data class Mesh(
        val track: org.webrtc.VideoTrack,
        val eglContext: org.webrtc.EglBase.Context,
    ) : RemoteVideoFeed

    /**
     * A LiveKit participant's video publication.
     *
     * The [room] is what initialises a renderer (`Room.initVideoRenderer`
     * hands it the SFU's GL context and registers the view with adaptive
     * stream, which is how the SFU learns how big a picture this phone is
     * actually drawing).
     */
    data class LiveKit(
        val track: RemoteVideoTrack,
        val room: Room,
    ) : RemoteVideoFeed
}
