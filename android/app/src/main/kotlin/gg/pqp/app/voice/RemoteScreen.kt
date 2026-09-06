package gg.pqp.app.voice

import io.livekit.android.room.Room
import io.livekit.android.room.track.RemoteVideoTrack

/**
 * Somebody else's screen, as arrived over whichever transport the room runs on.
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
 */
sealed interface RemoteScreen {

    /** A mesh peer's screen: the track and the engine's own GL context. */
    data class Mesh(
        val track: org.webrtc.VideoTrack,
        val eglContext: org.webrtc.EglBase.Context,
    ) : RemoteScreen

    /**
     * A LiveKit participant's screen-share publication.
     *
     * The [room] is what initialises a renderer (`Room.initVideoRenderer`
     * hands it the SFU's GL context and registers the view with adaptive
     * stream, which is how the SFU learns how big a picture this phone is
     * actually drawing).
     */
    data class LiveKit(
        val track: RemoteVideoTrack,
        val room: Room,
    ) : RemoteScreen
}
