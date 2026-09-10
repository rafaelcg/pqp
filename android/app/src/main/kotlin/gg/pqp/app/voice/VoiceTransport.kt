package gg.pqp.app.voice

import android.content.Intent
import gg.pqp.app.core.IceServer

/**
 * Which media transport a room runs on.
 *
 * The server decides this per room and pins it for the room's lifetime; the
 * client's only say is the `transports` array it declares on `join-voice-room`,
 * which is a list of what it *can* do, never a request. See
 * `server/src/ws/voice.ts`.
 */
enum class VoiceTransportKind {
    Mesh,
    LiveKit,
}

/**
 * The room's stated transport, or null when this client cannot run it.
 *
 * A separate pure function rather than a `when` inside [VoiceController]
 * because it is the branch that decides whether somebody joins a call or is
 * told to go away, and null has to keep meaning "refuse" rather than
 * "probably mesh". A transport this build has never heard of is exactly the
 * case that must refuse: the server only ever sends one it was told we could
 * do, so an unknown value means our declaration and this function disagree,
 * and guessing mesh there would put a mesh client in an SFU room.
 *
 * An **absent** transport is mesh, and that is not a guess: it is the only
 * shape a pre-SFU server's `welcome` ever had.
 */
fun voiceTransportKindFor(transport: String?): VoiceTransportKind? = when (transport) {
    null, "mesh" -> VoiceTransportKind.Mesh
    "livekit" -> VoiceTransportKind.LiveKit
    else -> null
}

/**
 * The media half of a call, whichever way the media actually travels.
 *
 * [VoiceController] keeps the roster, the foreground service, mute and deafen
 * state and the audio route; an implementation of this owns nothing but the
 * media path and is swapped out wholesale when a room's transport differs from
 * the last one's.
 *
 * The five signalling members are mesh's alone. On an SFU they are no-ops, and
 * deliberately so rather than absent: the frames still arrive on `/ws` (a room
 * can hold a mesh peer and this client is not the only thing on the socket),
 * and the server *drops and logs an error* for an `offer`, `answer` or
 * `ice-candidate` sent about a LiveKit room. Doing nothing is the correct
 * response to both directions.
 *
 * ### Two WebRTC namespaces, and why the types here are the mesh one
 *
 * `io.livekit:livekit-android` ships its own libwebrtc under
 * `livekit.org.webrtc.*` (its own `liblkjingle_peerconnection_so.so`), which
 * coexists with the app's `org.webrtc.*`. They are unrelated Java types: a
 * `livekit.org.webrtc.VideoTrack` cannot be handed to a renderer built on an
 * `org.webrtc.EglBase.Context`.
 *
 * [remoteScreenFor] and [remoteCameraFor] therefore hand out a
 * [RemoteVideoFeed], a sealed type with one case per namespace, each carrying
 * the GL context its own renderer must be initialised with. The UI picks the
 * renderer by `when` over the case, so the compiler is what keeps LiveKit video
 * away from the mesh renderer and the other way round; there is no shared
 * `VideoTrack` type to cast through.
 */
interface VoiceTransport {

    /** This device is capturing and publishing its screen. */
    val isSharingScreen: Boolean

    fun start(localPeerId: String, ice: List<IceServer>)

    fun setMuted(muted: Boolean)

    /**
     * Whether this seat may publish audio at all (`welcome.canSpeak`).
     *
     * Distinct from mute, which is the person's choice: this is the server's
     * rule. False before [start] means no microphone track is ever published;
     * true after false publishes it, muted, so the unmute stays the person's.
     */
    fun setCanPublishAudio(allowed: Boolean)

    /**
     * Whether this seat may put a screen on the stage right now
     * (`welcome.canStream`, then every `voice-speak-changed`).
     *
     * The twin of [setCanPublishAudio], and it exists for a sharper reason. On
     * the SFU the publish grant lives in a token minted once at connect and
     * never re-minted, so a moderator revoking the stage mid-party does not
     * invalidate it. A transport that remembered only the token would let a
     * revoked presenter press share again and publish anyway, which is a
     * moderation bypass rather than a stale flag. False must also take down a
     * share that is already running.
     */
    fun setCanPublishScreen(allowed: Boolean)

    /** Silences every remote track **and** forces the microphone off. */
    fun setDeafened(value: Boolean, mutedByUser: Boolean)

    // --- mesh signalling; no-ops on an SFU ---

    fun addPeer(remotePeerId: String)

    fun removePeer(remotePeerId: String)

    fun handleOffer(from: String, sdp: String)

    fun handleAnswer(from: String, sdp: String)

    fun handleCandidate(from: String, sdpMid: String?, sdpMLineIndex: Int?, candidate: String?)

    // --- roster facts about other people's video ---

    fun setPeerCameraStreamId(remotePeerId: String, streamId: String?)

    fun setPeerSharingScreen(remotePeerId: String, sharing: Boolean)

    // --- roster facts about other people's audio ---

    /**
     * A moderator muted, or unmuted, this peer. On mesh the receiver is the
     * whole enforcement; on an SFU the server already muted the publication.
     */
    fun setPeerServerMuted(remotePeerId: String, muted: Boolean)

    /** Which of a peer's audio streams is their screen's sound; a server mute spares it. */
    fun setPeerScreenAudioStreamId(remotePeerId: String, streamId: String?)

    // --- screen share ---

    /** False when this transport cannot publish a screen, or the capture failed. */
    fun startScreenShare(permission: Intent, profile: ScreenCaptureProfile): Boolean

    fun stopScreenShare()

    // --- lifecycle ---

    /** Tear the room down. The transport stays usable for the next call. */
    fun stop()

    /**
     * Give the process-global resources back: the factory, the audio device
     * module, the GL context.
     *
     * Called when the *transport* changes rather than when a call ends, and
     * that is the whole reason it exists. Both implementations hold an
     * `AudioDeviceModule` with an open `AudioRecord`, from two separate
     * libwebrtc builds that know nothing about each other. A device that joins
     * a mesh room and then a LiveKit room while the first one's module is still
     * alive has two of them contending for the microphone, which presents as
     * one of the two calls having no sound and no error anywhere.
     */
    fun dispose()

    /** The last stats sample for a peer, or null when there is none. */
    fun statsFor(remotePeerId: String): PeerMediaStats?

    /** This peer's incoming screen, with what a renderer needs to draw it. */
    fun remoteScreenFor(remotePeerId: String): RemoteVideoFeed?

    /** This peer's incoming camera, on the same terms. */
    fun remoteCameraFor(remotePeerId: String): RemoteVideoFeed?

    /**
     * The viewer for this peer's share opened or closed.
     *
     * Mesh ignores it: a mesh presenter encodes one stream per peer and the
     * receiver has no say in its size or whether it flows. On an SFU it is the
     * difference between paying for a share and not: delivery of the video is
     * paused while nobody is drawing it and the phone's layer ceiling is
     * re-applied when somebody is.
     */
    fun setWatchingScreen(remotePeerId: String, watching: Boolean)

    /**
     * A surface started or stopped drawing this peer's camera.
     *
     * Counted rather than flagged, because a rail tile and the full-screen
     * viewer can be drawing the same person at once; see [CameraDemand].
     *
     * Mesh ignores it for the same reason it ignores [setWatchingScreen], and
     * the reason matters here: on a mesh the camera is already arriving down
     * the peer connection whether or not anything draws it, so there is nothing
     * to save and nothing to ask for. On an SFU it is what keeps a room full of
     * faces from costing a phone twenty streams.
     */
    fun setCameraViewer(remotePeerId: String, surface: CameraSurface, viewing: Boolean)
}
