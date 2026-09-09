package gg.pqp.app.voice

import android.content.Context
import android.content.Intent
import android.util.Log
import gg.pqp.app.core.IceServer
import gg.pqp.app.core.VoiceSessionResponse
import io.livekit.android.AudioOptions
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.AudioTrackPublishOptions
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.participant.VideoTrackPublishOptions
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.LocalAudioTrackOptions
import io.livekit.android.room.track.LocalScreencastVideoTrack
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.RemoteVideoTrack
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.TrackPublication
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoEncoding
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.RtpParameters

/**
 * LiveKit SFU audio, for a room the server put on the `livekit` transport.
 *
 * Presence, the roster and every refusal still ride `/ws`; only the media moves.
 * Read [VoiceTransport] first, in particular the note about there being two
 * WebRTC namespaces in this process, which is why nothing in this file imports
 * `org.webrtc`: every video type here is LiveKit's own, and it leaves as a
 * [RemoteVideoFeed.LiveKit] so a renderer on the other namespace can never be
 * handed it.
 *
 * ### What this does with video
 *
 * **Watches screen shares.** A `SCREEN_SHARE` publication is subscribed and
 * handed up as a [RemoteVideoFeed.LiveKit] for the call bar's Watch row, with
 * its `SCREEN_SHARE_AUDIO` companion playing as the presentation's sound. This
 * is where watch parties happen, and a phone that could hear the room but not
 * see the film was the platform gap. Two things keep it off the bill:
 *
 * - **Delivery is paused until somebody taps Watch.** The publication is
 *   `setEnabled(false)` the moment it is subscribed and only enabled by
 *   [setWatchingScreen], so a share in a room this phone is merely listening to
 *   is a subscription on paper and no bytes on the wire. The web does the same
 *   with `remote-video-delivery.ts`.
 * - **The layer is capped** by [screenReceiveLayerFor]: 720p on Wi-Fi, 360p on
 *   a metered link, so a phone never asks for the 1080p layer. Both of those
 *   controls require adaptive stream to be **off** in this SDK, which is not
 *   the web's setting and is explained where the room is built.
 *
 * **Draws cameras.** A `CAMERA` publication is subscribed and handed up the
 * same way, for the strip of faces under the call bar and the viewer behind it.
 * A room can hold many more cameras than screens, so the same two rules are
 * tighter here rather than absent:
 *
 * - **Delivery follows what is actually on screen**, counted by [CameraDemand]:
 *   a camera arrives flowing so the tile that binds a frame later is never
 *   black, and is paused a second afterwards if nothing drew it. A tile
 *   scrolled off the rail, a rail with no room for it and the app going to the
 *   background all pause it the same way. Nothing here is ever *unsubscribed*
 *   to save bytes: that is a renegotiation and a second of black, where
 *   `setEnabled` is one frame each way.
 * - **The layer is capped per surface** by [cameraReceiveLayerFor]: the bottom
 *   layer for a tile, 360p for the full-screen viewer on Wi-Fi, the bottom
 *   layer again on a metered link.
 *
 * ### What this deliberately does not do
 *
 * **Publish a screen.** [startScreenShare] answers false and the call bar hides
 * its button on this transport (`VoiceState.screenShareSupported`). A button
 * that raises Android's consent dialog, takes the grant and then publishes
 * nothing would be worse than no button, and mesh screen share is untouched.
 *
 * **Publish a camera.** This client has no camera capture at all, on either
 * transport. Receiving one is what changed.
 *
 * **Fall back to mesh.** There is no path in here that does. The server pins a
 * room's transport for its lifetime; a client that could not reach the SFU and
 * quietly built a mesh instead would be a participant on the roster that nobody
 * in the room can hear. A failure leaves the call and says so.
 *
 * ### Credentials
 *
 * `welcome` carries **no** LiveKit credentials, and this is the ordering that
 * matters: the token comes from `POST /api/voice/token`, which the server only
 * answers for a peer that is currently live and owned by the caller. So it can
 * only be asked for after `welcome` has named the peer id, never before.
 */
class LiveKitEngine(
    private val context: Context,
    private val scope: CoroutineScope,
    /** Mints a session for a peer the server has already accepted. */
    private val session: suspend (peerId: String) -> VoiceSessionResponse,
    private val onPeerState: (String, PeerMediaState) -> Unit,
    /** The media leg is gone. The caller leaves the call and says why. */
    private val onFailed: (String) -> Unit,
    /** Connected and publishing. The caller re-declares mute and deafen. */
    private val onConnected: () -> Unit,
    /** A participant's screen arrived or went away. Null means "gone". */
    private val onRemoteScreen: (String, RemoteVideoFeed?) -> Unit = { _, _ -> },
    /** A participant's camera arrived or went away. Null means "gone". */
    private val onRemoteCamera: (String, RemoteVideoFeed?) -> Unit = { _, _ -> },
    /**
     * Whether the active network is metered, read when a layer is chosen. A
     * function rather than a value because a phone walks from Wi-Fi to mobile
     * data mid-call, and the next share it opens should notice.
     */
    private val isMetered: () -> Boolean = { false },
    /**
     * The capture stopped without us asking: the system's own "Stop sharing"
     * chip, or the platform revoking the projection. A UI that still says
     * "sharing" after that is lying, and the roster claim behind it would put
     * an empty tile in front of everybody.
     */
    private val onScreenShareEnded: () -> Unit = {},
) : VoiceTransport {

    private var room: Room? = null
    private var joinJob: Job? = null

    /**
     * The room's event collector.
     *
     * Held so [stop] can cancel it. `room.events` is a `SharedFlow`, which
     * never completes, so a collector started per join and never cancelled is
     * one leaked coroutine per call, each still holding a reference to a room
     * that has been released.
     */
    private var eventsJob: Job? = null
    private var micTrack: LocalAudioTrack? = null

    private val peers = LiveKitPeerIndex()
    private val peerLock = Any()

    /**
     * The screen-share video being shown per peer. The index under [peerLock]
     * decides *which* sid is the screen; this only holds the track for it.
     */
    private val screens = HashMap<String, RemoteVideoTrack>()

    /** The camera being shown per peer, on the same terms as [screens]. */
    private val cameras = HashMap<String, RemoteVideoTrack>()

    /**
     * Which cameras somebody is actually drawing, and how big. The whole of
     * what keeps a room full of faces off a phone's data allowance.
     */
    private val cameraDemand = CameraDemand()

    /**
     * Pending pauses, one per peer, so a camera whose tile is scrolled away
     * and straight back does not flap.
     *
     * The Android half of `OFFSCREEN_GRACE_MS` in the web's
     * `remote-video-delivery.ts`. Cancelled by the next bind, and by [stop].
     */
    private val cameraPauseJobs = HashMap<String, Job>()

    /**
     * Presenters whose share a viewer is open on.
     *
     * Remembered rather than applied and forgotten, because a reconnect has to
     * be able to put delivery back the way it was: the SFU is told what to send
     * once, and a room that reconnects has no memory of a `setEnabled` from
     * before the drop. Without this a share being watched when the signal
     * blipped would come back subscribed and paused, which on screen is a
     * viewer that went black and stayed black.
     */
    private val watchedScreens = mutableSetOf<String>()

    /**
     * Peers the `/ws` roster currently says are presenting.
     *
     * The gate on a presentation's sound, exactly as on the web
     * (`audibleScreenPeerIds`): a `SCREEN_SHARE_AUDIO` publication nobody
     * announced over `set-sharing-screen` stays silent. The Watch row reads the
     * same roster fact, so sound and picture are offered together.
     */
    private val sharingByRoster = mutableSetOf<String>()

    @Volatile private var muted = false
    @Volatile private var deafened = false

    /**
     * `welcome.canSpeak`. False is a listen-only seat: no track is created and
     * nothing is published, because the server has already withheld the
     * LiveKit publish grant and asking anyway is a refused publish in the log
     * for every listener in a stage. Flipped to true mid-call, the microphone
     * is published then, muted, and the unmute stays the person's.
     */
    @Volatile private var canPublishAudio = true

    /** Non-null between [start] and [stop]. Guards late callbacks from an old room. */
    @Volatile private var localPeerId: String? = null

    private var screenTrack: LocalScreencastVideoTrack? = null

    override val isSharingScreen: Boolean get() = screenTrack != null

    /**
     * Whether the SFU token granted `SCREEN_SHARE`, from
     * `VoiceSessionResponse.stream`.
     *
     * Read here as well as in the caller because the two answers are minted at
     * different moments: the caller's comes from `welcome.canStream`, this one
     * from the token `POST /api/voice/token` returned, and a permissions edit
     * between them would let a capture start that the SFU then refuses. A
     * refused publish with the projection already taken is the worst version
     * of this, so it is checked before the grant is consumed.
     */
    @Volatile private var canPublishScreen = false

    /** The `/api/ice-servers` list of the current join; read once, at connect. */
    private var ice: List<IceServer> = emptyList()

    /**
     * [ice] is the list `GET /api/ice-servers` gave this join, the same one the
     * mesh path configures its peer connections with. It used to be ignored
     * here on the theory that the LiveKit server knows its own relays; it does,
     * and on the hosted deployment they are the media box itself, with a TLS
     * relay port that Caddy owns. It reaches the SDK only when it carries a
     * relay; see [sfuIceServers] for the rule and for what the SDK does with it.
     */
    override fun start(localPeerId: String, ice: List<IceServer>) {
        stop()
        this.localPeerId = localPeerId
        this.ice = ice

        joinJob = scope.launch {
            try {
                withTimeout(JOIN_TIMEOUT_MS) { connect(localPeerId) }
            } catch (timeout: TimeoutCancellationException) {
                Log.w(TAG, "SFU join timed out after ${JOIN_TIMEOUT_MS}ms", timeout)
                fail("join timed out")
            } catch (error: kotlinx.coroutines.CancellationException) {
                // The call was left while we were joining. Not a failure, and
                // reporting one here would raise an error over a hang-up.
                throw error
            } catch (error: Throwable) {
                Log.w(TAG, "SFU join failed", error)
                fail(error.message ?: error::class.java.simpleName)
            }
        }
    }

    /**
     * Nothing is pulled down off the SFU until this client asks for it by name.
     * With `autoSubscribe = true` a phone in a room where somebody is
     * presenting from the web receives and decodes that 1080p screen share in
     * full, on mobile data, to hand the frames to a `return` in
     * `onTrackSubscribed`. Subscribing deliberately is the difference between
     * not showing video and not paying for it.
     *
     * [relays] is the output of [sfuIceServers]. Empty means the join
     * response's servers, as before. Non-empty is passed as BOTH `rtcConfig`
     * and `iceServers`, because in livekit-android 2.28.1 `iceServers` alone is
     * ignored (`RTCEngine.makeRTCConfig` only merges it into a supplied
     * `rtcConfig`); the empty `RTCConfiguration` is what the SDK builds itself
     * on the other branch, so nothing else about the peer connections changes,
     * and `iceTransportPolicy` stays at its default. This is LiveKit's own
     * relocated WebRTC namespace (`livekit.org.webrtc`), not the mesh's
     * `org.webrtc`; see [VoiceTransport] on why the two must never meet.
     */
    private fun connectOptionsFor(relays: List<IceServer>): ConnectOptions {
        if (relays.isEmpty()) return ConnectOptions(autoSubscribe = false)
        val servers = relays.map { server ->
            PeerConnection.IceServer.builder(server.urlList)
                .setUsername(server.username.orEmpty())
                .setPassword(server.credential.orEmpty())
                .createIceServer()
        }
        return ConnectOptions(
            autoSubscribe = false,
            rtcConfig = PeerConnection.RTCConfiguration(emptyList()),
            iceServers = servers,
        )
    }

    private suspend fun connect(peerId: String) {
        val credentials = session(peerId)
        if (this.localPeerId != peerId) return

        val created = LiveKit.create(
            context.applicationContext,
            RoomOptions(
                // OFF, AND THAT IS THE OPPOSITE CALL FROM THE WEB'S, FOR A
                // REASON IN THIS SDK RATHER THAN A PREFERENCE.
                //
                // On the web the two compose: `adaptiveStream` measures the
                // element and a manual `setVideoQuality` is a ceiling over
                // that measurement, so the library sends the smaller of the
                // two. livekit-android 2.28.1 does not compose them, it
                // *replaces* them: `RemoteTrackPublication.setEnabled` and
                // `setVideoQuality` both begin `if (isAutoManaged()) return`,
                // and `isAutoManaged` is the track's `autoManageVideo`, which
                // the room sets from this flag (verified by reading the 2.28.1
                // bytecode). So with adaptive stream on, every line below that
                // pauses a share or caps its layer would compile, run, and do
                // nothing at all.
                //
                // The choice is therefore between the SDK measuring the view
                // and this client saying what it wants. Saying it wins,
                // because the thing to pause is a share *nobody has opened*,
                // which has no view to measure: a publication with no renderer
                // has never had a visibility computed, so it is delivered
                // until one is attached and removed. The viewer here is also a
                // full-screen dialog, so there is little for a measurement to
                // discover that `screenReceiveLayerFor` does not already know.
                adaptiveStream = false,
                dynacast = true,
            ),
            LiveKitOverrides(
                audioOptions = AudioOptions(
                    // THE AUDIO ROUTE IS NOT LIVEKIT'S TO DECIDE HERE.
                    //
                    // `VoiceController.acquireAudioFocus` / `applyAudioRoute`
                    // already set MODE_IN_COMMUNICATION, take audio focus and
                    // pin the communication device, and that code is shared
                    // with the mesh path so both transports sound the same.
                    // LiveKit's default `AudioSwitchHandler` does all three
                    // itself and would fight it: two components taking focus
                    // and choosing a device, with the last writer winning by
                    // timing. The visible result is a call routed to the
                    // earpiece at a volume nobody can hear, which reads as
                    // "voice does not work at all" rather than as a routing bug.
                    audioHandler = NoAudioHandler(),
                    // Same argument, second door. The workaround toggles the
                    // audio mode around playout starting and stopping, so it
                    // would move the mode out from under the controller.
                    disableCommunicationModeWorkaround = true,
                ),
            ),
        )
        room = created
        // What the token actually granted, rather than what the roster said a
        // moment ago. `stream` is `VoiceSessionResponse.stream`, which the
        // server derived from the same `resolveVoicePublish` the `welcome`
        // used, but minted later: a permissions edit in between lands here
        // first, and a capture started on the older answer would be a refused
        // publish with the whole screen already taken.
        canPublishScreen = credentials.stream

        eventsJob = scope.launch { listen(created) }

        created.connect(
            credentials.url,
            credentials.token,
            connectOptionsFor(sfuIceServers(ice)),
        )
        if (this.localPeerId != peerId) {
            // Left while the socket was coming up.
            runCatching { created.disconnect() }
            return
        }

        seedParticipants(created)
        if (canPublishAudio) publishMicrophone(created)
        onConnected()
        Log.i(TAG, "SFU connected as $peerId in room ${credentials.room}")
    }

    /**
     * The people who were already in the room when this device walked in.
     *
     * `RoomEvent.ParticipantConnected` fires for arrivals *after* the join, and
     * only for those: `Room.onJoinResponse` builds the participants the join
     * response listed directly, without emitting it. So a call that was already
     * in progress would otherwise be a room this client believes is empty, and
     * with the join no longer auto-subscribing, an empty room is also a silent
     * one, because these are exactly the publications nobody would ever ask for.
     */
    private fun seedParticipants(room: Room) {
        val participants = room.remoteParticipants.values.toList()
        val ids = participants.mapNotNull { it.identity?.value }
        synchronized(peerLock) { peers.seedAll(ids) }.forEach(::report)
        participants.forEach(::subscribeToPublications)
        Log.i(TAG, "SFU join found ${participants.size} participant(s) already in the room")
    }

    /** Ask for every wanted publication this participant already has. */
    private fun subscribeToPublications(participant: Participant) {
        participant.trackPublications.values.forEach(::subscribeIfWanted)
    }

    /**
     * The one place a subscription is ever asked for.
     *
     * A local publication is not a `RemoteTrackPublication` and is skipped:
     * `TrackPublished` covers this client's own microphone as well as other
     * people's tracks.
     */
    private fun subscribeIfWanted(publication: TrackPublication) {
        val remote = publication as? RemoteTrackPublication ?: return
        if (!livekitSubscribesTo(remote.kind, remote.source)) return
        // `isDesired` is "we have asked", which is the question here.
        // `subscribed` is not: it stays false between the ask and the track
        // arriving, so it would let a second request through on every event.
        if (remote.isDesired) return
        runCatching { remote.setSubscribed(true) }
            .onFailure { Log.w(TAG, "could not subscribe to ${remote.sid}", it) }
    }

    private suspend fun publishMicrophone(room: Room) {
        val track = room.localParticipant.createAudioTrack(
            LOCAL_AUDIO_ID,
            LocalAudioTrackOptions(
                noiseSuppression = true,
                echoCancellation = true,
                autoGainControl = true,
                highPassFilter = true,
                typingNoiseDetection = true,
            ),
        )
        micTrack = track
        // The mic goes up already carrying whatever mute state the person had
        // before they joined. Publishing live and then muting a moment later is
        // a moment of them being heard when they asked not to be.
        track.enabled = !(muted || deafened)
        room.localParticipant.publishAudioTrack(
            track,
            AudioTrackPublishOptions(
                source = Track.Source.MICROPHONE,
                // Both halves of what the web client publishes. DTX stops
                // sending during silence and RED carries a redundant copy of
                // the previous packet, which is what makes a lossy mobile
                // uplink survivable.
                dtx = true,
                red = true,
            ),
        )
        applyMuteToPublication()
    }

    private suspend fun listen(room: Room) {
        room.events.collect { event ->
            when (event) {
                is RoomEvent.TrackSubscribed -> onTrackSubscribed(event)
                is RoomEvent.TrackUnsubscribed -> onTrackUnsubscribed(event)
                is RoomEvent.ParticipantConnected -> {
                    val participant = event.participant
                    val peerId = participant.identity?.value ?: return@collect
                    if (synchronized(peerLock) { peers.seen(peerId) }) {
                        report(peerId)
                    }
                    // Somebody can arrive with publications already on them.
                    subscribeToPublications(participant)
                }

                // Somebody unmuted, published late, or started a share.
                // Nothing arrives on its own now that `autoSubscribe` is off,
                // so this is the only way a track that appears mid-call is
                // ever heard or seen.
                is RoomEvent.TrackPublished -> subscribeIfWanted(event.publication)

                // A camera the far end muted without unpublishing. Every pqp
                // client unpublishes instead, so this is the server-side mute
                // and anybody else's client; drawing through it would be a
                // tile frozen on the last frame that arrived.
                is RoomEvent.TrackMuted ->
                    onCameraMuteChanged(event.participant, event.publication, muted = true)

                is RoomEvent.TrackUnmuted ->
                    onCameraMuteChanged(event.participant, event.publication, muted = false)

                // The signal came back. Nothing about what this client had
                // asked for survives on the server side of a reconnect, so
                // both halves are re-stated: the subscriptions, and which of
                // them should be flowing and at what layer.
                is RoomEvent.Reconnected -> {
                    Log.i(TAG, "SFU reconnected; re-asking for the media we had")
                    seedParticipants(room)
                    reapplyVideoDelivery()
                }

                is RoomEvent.ParticipantDisconnected -> {
                    val peerId = event.participant.identity?.value ?: return@collect
                    forgetPeer(peerId)
                }

                is RoomEvent.Disconnected -> {
                    // Only a failure when we did not ask for it. `stop` clears
                    // `localPeerId` before disconnecting for exactly this test.
                    if (localPeerId != null) {
                        val reason = event.error?.message ?: event.reason.name
                        Log.w(TAG, "SFU disconnected: $reason")
                        fail(reason)
                    }
                }

                is RoomEvent.FailedToConnect -> {
                    Log.w(TAG, "SFU failed to connect", event.error)
                    fail(event.error.message ?: "failed to connect")
                }

                else -> Unit
            }
        }
    }

    private fun onTrackSubscribed(event: RoomEvent.TrackSubscribed) {
        val peerId = event.participant.identity?.value ?: return
        val track = event.track
        val publication = event.publication
        if (track is RemoteVideoTrack) {
            val source = publication.source
            if (source != Track.Source.SCREEN_SHARE && source != Track.Source.CAMERA) {
                // Only those two are ever asked for (see `livekitSubscribesTo`),
                // so anything else arriving here means the server subscribed us
                // to something we did not ask for. Dropped rather than
                // rendered, and said out loud rather than swallowed, because
                // silently decoding video is the bill nobody can explain.
                Log.w(TAG, "unexpected $source video from $peerId; ignoring")
                return
            }
            // A remote participant's publication always is one; the event's
            // static type is the base class because the same event shape
            // carries local publications elsewhere in the SDK.
            val remote = publication as? RemoteTrackPublication
            if (remote == null) {
                Log.w(TAG, "$source video from $peerId is not a remote publication; ignoring")
                return
            }
            if (source == Track.Source.CAMERA) {
                onCameraSubscribed(peerId, remote, track)
            } else {
                onScreenSubscribed(peerId, remote, track)
            }
            return
        }
        if (track !is RemoteAudioTrack) {
            Log.w(TAG, "unexpected ${track.kind} subscription from $peerId; ignoring")
            return
        }
        if (publication.source == Track.Source.SCREEN_SHARE_AUDIO) {
            // A presentation's sound, not a person's voice. It must not be what
            // makes somebody count as audible, it must still be silenced by
            // deafen, and it only plays for a presenter the roster announced.
            track.enabled = screenAudioEnabledFor(peerId)
            return
        }
        track.enabled = !deafened
        val sid = event.publication.sid
        if (synchronized(peerLock) { peers.voiceTrackAdded(peerId, sid) }) {
            report(peerId)
        }
    }

    private fun onTrackUnsubscribed(event: RoomEvent.TrackUnsubscribed) {
        val peerId = event.participant.identity?.value ?: return
        val sid = event.publications.sid
        if (event.track is RemoteVideoTrack) {
            // By sid rather than by the publication's source, because the two
            // slots are keyed by sid and the source on a torn-down publication
            // is the one thing here we do not have to trust.
            val screenGone = synchronized(peerLock) {
                peers.screenTrackRemoved(peerId, sid).also { if (it) screens.remove(peerId) }
            }
            if (screenGone) {
                synchronized(peerLock) { watchedScreens.remove(peerId) }
                onRemoteScreen(peerId, null)
                return
            }
            val cameraGone = synchronized(peerLock) {
                peers.cameraTrackRemoved(peerId, sid).also { if (it) cameras.remove(peerId) }
            }
            if (cameraGone) {
                forgetCameraDemand(peerId)
                onRemoteCamera(peerId, null)
            }
            return
        }
        if (event.track !is RemoteAudioTrack) return
        if (synchronized(peerLock) { peers.voiceTrackRemoved(peerId, sid) }) {
            report(peerId)
        }
    }

    /**
     * A screen-share video arrived. Filed, capped, paused, then announced.
     *
     * Paused before it is announced, in that order: `setEnabled(false)` tells
     * the SFU to stop forwarding this publication, and it goes out before the
     * call bar can offer a Watch button, so the window in which a share this
     * phone has not opened is costing anybody bytes is as short as the
     * signalling round trip. [setWatchingScreen] lifts it.
     *
     * The layer ceiling goes on at the same time, so that when delivery is
     * lifted the first frames are already the phone-sized layer rather than a
     * burst of 1080p while the ceiling catches up.
     */
    private fun onScreenSubscribed(
        peerId: String,
        publication: RemoteTrackPublication,
        track: RemoteVideoTrack,
    ) {
        val room = room ?: return
        val shown = synchronized(peerLock) {
            peers.screenTrackAdded(peerId, publication.sid).also { if (it) screens[peerId] = track }
        }
        if (!shown) {
            Log.w(TAG, "second screen share from $peerId while one is live; ignoring")
            return
        }
        applyScreenDelivery(publication, watching = false)
        onRemoteScreen(peerId, RemoteVideoFeed.LiveKit(track, room))
    }

    /**
     * A camera arrived. Filed, capped, delivered, then paused if nobody drew it.
     *
     * The opposite starting position from a share, and deliberately. A share is
     * paused on arrival because opening one is a decision somebody takes
     * seconds later, if at all. A camera is drawn by the rail the moment it
     * exists, and the tile can only bind *after* this announces the feed, so
     * starting paused would put a black rectangle in the strip for one
     * signalling round trip every single time somebody turns their camera on.
     * It starts flowing at the tile's layer instead, and the grace pause below
     * is what covers the camera nothing ever binds: a rail with more faces than
     * fit, or a phone whose screen is off.
     */
    private fun onCameraSubscribed(
        peerId: String,
        publication: RemoteTrackPublication,
        track: RemoteVideoTrack,
    ) {
        val room = room ?: return
        val filed = synchronized(peerLock) {
            peers.cameraTrackAdded(peerId, publication.sid).also { if (it) cameras[peerId] = track }
        }
        if (!filed) {
            Log.w(TAG, "second camera from $peerId while one is live; ignoring")
            return
        }
        val muted = synchronized(peerLock) {
            peers.setCameraMuted(peerId, publication.muted)
            peers.isCameraMuted(peerId)
        }
        if (muted) {
            // Subscribed and silent. Nothing is announced, so no tile appears
            // for a camera that would only ever show one frozen frame; the
            // unmute below brings both the delivery and the tile back.
            applyCameraDelivery(peerId, null)
            return
        }
        val wanted = synchronized(peerLock) { cameraDemand.wantedFor(peerId) }
        applyCameraDelivery(peerId, wanted ?: CameraSurface.Tile)
        onRemoteCamera(peerId, RemoteVideoFeed.LiveKit(track, room))
        if (wanted == null) scheduleCameraPause(peerId)
    }

    /**
     * The far end muted or unmuted a camera we hold.
     *
     * Only ever about a camera, and only ever about the publication currently
     * filed for that peer: `TrackMuted` also fires for microphones and for this
     * device's own publications, and neither is this rule's business.
     */
    private fun onCameraMuteChanged(
        participant: Participant,
        publication: TrackPublication,
        muted: Boolean,
    ) {
        if (publication.source != Track.Source.CAMERA) return
        val peerId = participant.identity?.value ?: return
        val changed = synchronized(peerLock) {
            if (peers.cameraTrackFor(peerId) != publication.sid) {
                false
            } else {
                peers.setCameraMuted(peerId, muted)
            }
        }
        if (!changed) return
        if (muted) {
            applyCameraDelivery(peerId, null)
            onRemoteCamera(peerId, null)
            return
        }
        val room = room ?: return
        val track = synchronized(peerLock) { cameras[peerId] } ?: return
        val wanted = synchronized(peerLock) { cameraDemand.wantedFor(peerId) }
        applyCameraDelivery(peerId, wanted ?: CameraSurface.Tile)
        onRemoteCamera(peerId, RemoteVideoFeed.LiveKit(track, room))
        if (wanted == null) scheduleCameraPause(peerId)
    }

    private fun applyScreenDelivery(publication: RemoteTrackPublication, watching: Boolean) {
        runCatching { publication.setVideoQuality(screenReceiveLayerFor(isMetered())) }
            .onFailure { Log.w(TAG, "SFU receive quality rejected; keeping the current layer", it) }
        runCatching { publication.setEnabled(watching) }
            .onFailure { Log.w(TAG, "could not ${if (watching) "resume" else "pause"} ${publication.sid}", it) }
    }

    private fun screenPublicationFor(peerId: String): RemoteTrackPublication? =
        publicationFor(peerId, synchronized(peerLock) { peers.screenTrackFor(peerId) })

    private fun cameraPublicationFor(peerId: String): RemoteTrackPublication? =
        publicationFor(peerId, synchronized(peerLock) { peers.cameraTrackFor(peerId) })

    private fun publicationFor(peerId: String, sid: String?): RemoteTrackPublication? {
        if (sid == null) return null
        val participant = room?.remoteParticipants?.values?.firstOrNull { it.identity?.value == peerId }
            ?: return null
        return participant.trackPublications[sid] as? RemoteTrackPublication
    }

    /**
     * Tell the SFU what to do with one peer's camera.
     *
     * Null means "nobody is drawing this": one `UpdateTrackSettings` frame that
     * stops the forwarding without touching the subscription, so resuming is
     * another single frame rather than a renegotiation. Otherwise the layer for
     * the largest surface drawing it goes out first and the resume second, so
     * the frames that arrive when it comes back are already the right size.
     *
     * A muted camera is never delivered whatever any surface wants: there are
     * no frames to send and asking for them would be a subscription paying for
     * keepalives.
     */
    private fun applyCameraDelivery(peerId: String, surface: CameraSurface?) {
        val publication = cameraPublicationFor(peerId) ?: return
        val muted = synchronized(peerLock) { peers.isCameraMuted(peerId) }
        val delivery = cameraDeliveryFor(surface, muted, isMetered())
        delivery.quality?.let { quality ->
            runCatching { publication.setVideoQuality(quality) }
                .onFailure {
                    Log.w(TAG, "SFU camera quality rejected; keeping the current layer", it)
                }
        }
        runCatching { publication.setEnabled(delivery.enabled) }
            .onFailure {
                val verb = if (delivery.enabled) "resume" else "pause"
                Log.w(TAG, "could not $verb the camera from $peerId", it)
            }
    }

    private fun scheduleCameraPause(peerId: String) {
        synchronized(peerLock) {
            cameraPauseJobs.remove(peerId)?.cancel()
            cameraPauseJobs[peerId] = scope.launch {
                delay(CAMERA_PAUSE_GRACE_MS)
                val idle = synchronized(peerLock) {
                    cameraPauseJobs.remove(peerId)
                    cameraDemand.wantedFor(peerId) == null
                }
                if (idle) applyCameraDelivery(peerId, null)
            }
        }
    }

    private fun cancelCameraPause(peerId: String) {
        synchronized(peerLock) { cameraPauseJobs.remove(peerId) }?.cancel()
    }

    /** The peer's camera went away: drop the demand and any pause owed for it. */
    private fun forgetCameraDemand(peerId: String) {
        cancelCameraPause(peerId)
        synchronized(peerLock) { cameraDemand.forget(peerId) }
    }

    /**
     * Say again what should be flowing, for every video this client holds.
     *
     * Called after a reconnect, which is the one moment the SFU's idea of what
     * this client wants and this client's own idea can silently differ: the
     * subscriptions are re-asked for by [seedParticipants], and this is the
     * other half, the `UpdateTrackSettings` that were sent once and are not
     * replayed by anybody.
     */
    private fun reapplyVideoDelivery() {
        val screenPeers = synchronized(peerLock) { peers.screenPeerIds() }
        screenPeers.forEach { peerId ->
            val watching = synchronized(peerLock) { peerId in watchedScreens }
            screenPublicationFor(peerId)?.let { applyScreenDelivery(it, watching) }
        }
        val cameraPeers = synchronized(peerLock) { peers.cameraPeerIds() }
        cameraPeers.forEach { peerId ->
            applyCameraDelivery(peerId, synchronized(peerLock) { cameraDemand.wantedFor(peerId) })
        }
    }

    /**
     * The viewer opened or closed on this peer's share.
     *
     * The only thing that starts and stops the video on this transport, since
     * the SDK's own visibility management is off (see the room options). One
     * `UpdateTrackSettings` frame each way: `disabled` for a share nobody is
     * looking at, and the chosen layer when somebody is.
     */
    override fun setWatchingScreen(remotePeerId: String, watching: Boolean) {
        synchronized(peerLock) {
            if (watching) watchedScreens.add(remotePeerId) else watchedScreens.remove(remotePeerId)
        }
        val publication = screenPublicationFor(remotePeerId) ?: return
        applyScreenDelivery(publication, watching)
    }

    /**
     * A tile or the viewer started or stopped drawing this peer's camera.
     *
     * The whole of the bandwidth rule for cameras, and the reason it is counted
     * rather than a boolean is in [CameraDemand]: the viewer is a dialog over a
     * rail that stays composed, so closing it must not pause the tile still on
     * screen behind it.
     *
     * Resuming is immediate and pausing waits [CAMERA_PAUSE_GRACE_MS], the same
     * asymmetry the web has: a tile scrolled just past the rail's edge and back
     * would otherwise cost two signalling frames and a blink for nothing, and a
     * person who came back to a paused picture would have noticed.
     */
    override fun setCameraViewer(remotePeerId: String, surface: CameraSurface, viewing: Boolean) {
        val wanted = synchronized(peerLock) {
            val changed = if (viewing) {
                cameraDemand.bind(remotePeerId, surface)
            } else {
                cameraDemand.release(remotePeerId, surface)
            }
            if (!changed) return
            cameraDemand.wantedFor(remotePeerId)
        }
        if (wanted == null) {
            scheduleCameraPause(remotePeerId)
            return
        }
        cancelCameraPause(remotePeerId)
        applyCameraDelivery(remotePeerId, wanted)
    }

    /** A presentation's sound plays only for an announced presenter, and never while deafened. */
    private fun screenAudioEnabledFor(peerId: String): Boolean =
        !deafened && synchronized(peerLock) { peerId in sharingByRoster }

    /** Re-apply deafen and the roster gate to every audio track of one participant. */
    private fun applyAudioEnabled(participant: Participant) {
        val peerId = participant.identity?.value ?: return
        participant.audioTrackPublications.forEach { (publication, track) ->
            val audio = track as? RemoteAudioTrack ?: return@forEach
            audio.enabled = if (publication.source == Track.Source.SCREEN_SHARE_AUDIO) {
                screenAudioEnabledFor(peerId)
            } else {
                !deafened
            }
        }
    }

    private fun forgetPeer(peerId: String) {
        cancelCameraPause(peerId)
        val (hadScreen, hadCamera) = synchronized(peerLock) {
            sharingByRoster.remove(peerId)
            watchedScreens.remove(peerId)
            cameraDemand.forget(peerId)
            peers.forget(peerId)
            (screens.remove(peerId) != null) to (cameras.remove(peerId) != null)
        }
        if (hadScreen) onRemoteScreen(peerId, null)
        if (hadCamera) onRemoteCamera(peerId, null)
    }

    private fun report(peerId: String) {
        onPeerState(peerId, synchronized(peerLock) { peers.stateFor(peerId) })
    }

    private fun fail(reason: String) {
        if (localPeerId == null) return
        localPeerId = null
        onFailed(reason)
    }

    override fun setMuted(muted: Boolean) {
        this.muted = muted
        micTrack?.enabled = !muted
        scope.launch { applyMuteToPublication() }
    }

    override fun setCanPublishAudio(allowed: Boolean) {
        canPublishAudio = allowed
        if (!allowed) {
            // The grant is gone and the SFU drops the publication itself;
            // the local track is silenced so nothing is captured meanwhile.
            micTrack?.enabled = false
            return
        }
        val room = room ?: return
        if (micTrack != null || localPeerId == null) return
        // Granted after a listen-only join: publish now, in whatever mute
        // state the controller has set (which is muted, by the rule).
        scope.launch {
            runCatching { publishMicrophone(room) }
                .onFailure { Log.w(TAG, "could not publish the microphone after SPEAK was granted", it) }
        }
    }

    /**
     * The second half of muting, and the half that other people can see.
     *
     * Disabling the local track stops the samples, but the SFU goes on
     * advertising the publication as live, so everybody else's client keeps
     * drawing a speaking ring around somebody who is sending silence. Both, or
     * neither.
     */
    private fun applyMuteToPublication() {
        val publication = room?.localParticipant
            ?.getTrackPublication(Track.Source.MICROPHONE)
            ?: return
        runCatching { publication.muted = muted || deafened }
    }

    override fun setDeafened(value: Boolean, mutedByUser: Boolean) {
        deafened = value
        room?.remoteParticipants?.values?.forEach(::applyAudioEnabled)
        // Being heard while hearing nothing is a trap rather than a feature,
        // and it is what the mesh path, the web and iOS all do.
        // `canPublishAudio` for the same reason as on the mesh path:
        // undeafening is the one route that enables the track without passing
        // through `setMuted`.
        micTrack?.enabled = !(value || mutedByUser) && canPublishAudio
        scope.launch { applyMuteToPublication() }
    }

    // --- mesh signalling: nothing to do, and saying so ---
    //
    // The server drops an `offer`, `answer` or `ice-candidate` about a LiveKit
    // room and logs an error, so these must not forward anything. Peers are
    // discovered from the SFU's own participant events; the `/ws` roster still
    // arrives and still drives the participant list in `VoiceController`.

    override fun addPeer(remotePeerId: String) = Unit

    override fun removePeer(remotePeerId: String) {
        forgetPeer(remotePeerId)
    }

    override fun handleOffer(from: String, sdp: String) = Unit

    override fun handleAnswer(from: String, sdp: String) = Unit

    override fun handleCandidate(
        from: String,
        sdpMid: String?,
        sdpMLineIndex: Int?,
        candidate: String?,
    ) = Unit

    /** Mesh classifies video by elimination; an SFU labels it. Nothing to feed. */
    override fun setPeerCameraStreamId(remotePeerId: String, streamId: String?) = Unit

    /**
     * The roster said this peer is or is not presenting.
     *
     * The SFU labels the video itself, so unlike the mesh this is not what
     * decides which track is the screen. It is the gate on the share's
     * *sound*: the roster is the source of who, and a `SCREEN_SHARE_AUDIO`
     * publication from somebody the roster never announced stays silent, as on
     * the web. Fed from every roster frame, so a repeat is absorbed.
     */
    override fun setPeerSharingScreen(remotePeerId: String, sharing: Boolean) {
        val changed = synchronized(peerLock) {
            if (sharing) sharingByRoster.add(remotePeerId) else sharingByRoster.remove(remotePeerId)
        }
        if (!changed) return
        room?.remoteParticipants?.values
            ?.firstOrNull { it.identity?.value == remotePeerId }
            ?.let(::applyAudioEnabled)
    }

    /** The SFU muted the publication itself; nothing reaches this phone to gate. */
    override fun setPeerServerMuted(remotePeerId: String, muted: Boolean) = Unit

    override fun setPeerScreenAudioStreamId(remotePeerId: String, streamId: String?) = Unit

    /**
     * Publish this device's screen to the SFU.
     *
     * This is what a watch party actually needs, because a watch party runs on
     * LiveKit by policy: a listed community or a server of ten or more is
     * pinned to the SFU, so until this existed a host on Android could not
     * present at all, and the button was hidden rather than left to fail.
     *
     * ### Why not `setScreenShareEnabled`
     *
     * The one-line SDK entry point starts LiveKit's OWN foreground service
     * (`ScreenCaptureService`) to carry the `mediaProjection` type. This app
     * already runs one, `VoiceService`, and it already juggles that type for
     * the mesh path; a second foreground service claiming the same projection
     * is either a duplicate notification or a fight over the grant. So the
     * track is built by hand and the service stays ours. The ordering rule is
     * unchanged and is [VoiceController.beginScreenCapture]'s: consent, then a
     * foreground service already carrying `mediaProjection`, and only then may
     * the projection be created. From Android 14 doing it the other way throws
     * inside the capturer, where it reads as a capture failure.
     *
     * ### The source is not cosmetic
     *
     * `Track.Source.SCREEN_SHARE` is what the HLS egress looks for: the server
     * lists the room's participants and takes the first track whose source is
     * `SCREEN_SHARE` (`defaultFindTracks` in `server/src/voice/hls-egress.ts`).
     * Publishing the same pixels under any other source is a share every human
     * in the room can see and no watch party can transcode.
     *
     * ### Simulcast is off, deliberately
     *
     * The web publishes a screen with `simulcast: false` for the reason in
     * `client/src/lib/livekit-session.ts`, and the egress transcodes from the
     * published track, so a second low layer buys the ladder nothing and costs
     * this phone a second encoder. `MAINTAIN_RESOLUTION` for the same reason
     * the mesh sender sets `isScreencast`: screen content is text and film, and
     * a link that dips should lose frames rather than pixels.
     *
     * Capture and publish are separate steps and the failure of either is
     * reported the same way, `false`, so the caller gives the projection back
     * rather than announcing a presenter with nothing behind them.
     */
    override fun startScreenShare(permission: Intent, profile: ScreenCaptureProfile): Boolean {
        val room = room ?: return false
        if (screenTrack != null) return true
        if (!canPublishScreen) {
            // The token says no. Consuming the grant to find that out from a
            // refused publish would take the whole screen for nothing.
            Log.w(TAG, "SFU token does not grant SCREEN_SHARE; refusing the capture")
            return false
        }

        val track = runCatching {
            room.localParticipant.createScreencastTrack(
                name = SCREEN_TRACK_NAME,
                mediaProjectionPermissionResultData = permission,
                options = LocalVideoTrackOptions(
                    isScreencast = true,
                    captureParams = VideoCaptureParameter(
                        width = profile.width,
                        height = profile.height,
                        maxFps = profile.frameRate,
                    ),
                ),
                // Posted, not run inline: this arrives on the projection's own
                // callback thread, from inside the capturer the caller is about
                // to dispose.
                onStop = { scope.launch { onScreenShareEnded() } },
            )
        }.getOrElse { error ->
            Log.w(TAG, "screen capture failed to start: ${error.message}")
            return false
        }

        screenTrack = track
        return runCatching {
            track.startCapture()
            scope.launch {
                runCatching {
                    room.localParticipant.publishVideoTrack(
                        track,
                        VideoTrackPublishOptions(
                            source = Track.Source.SCREEN_SHARE,
                            simulcast = false,
                            videoEncoding = VideoEncoding(
                                maxBitrate = sfuScreenBitrate(),
                                maxFps = profile.frameRate,
                            ),
                            degradationPreference =
                                RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION,
                        ),
                    )
                }.onFailure { error ->
                    // The roster already says this device is presenting, and
                    // the picture is not on the wire. Tear it down rather than
                    // leave an empty tile in front of the room.
                    Log.w(TAG, "screen publish refused: ${error.message}")
                    onScreenShareEnded()
                }
            }
            true
        }.getOrElse { error ->
            Log.w(TAG, "screen capture could not start: ${error.message}")
            releaseScreenTrack()
            false
        }
    }

    override fun stopScreenShare() {
        val track = screenTrack ?: return
        screenTrack = null
        scope.launch {
            runCatching { room?.localParticipant?.unpublishTrack(track) }
                .onFailure { Log.w(TAG, "could not unpublish the screen: ${it.message}") }
        }
        runCatching { track.stop() }
    }

    private fun releaseScreenTrack() {
        val track = screenTrack ?: return
        screenTrack = null
        runCatching { track.stop() }
    }

    override fun stop() {
        // Cleared first. `listen` reads it to tell a disconnect we asked for
        // from one that happened to us, and the room's own `Disconnected` event
        // is on its way as soon as the line below runs.
        localPeerId = null
        joinJob?.cancel()
        joinJob = null
        eventsJob?.cancel()
        eventsJob = null
        val leaving = room
        val mic = micTrack
        val screen = screenTrack
        room = null
        micTrack = null
        screenTrack = null
        canPublishScreen = false
        val (showing, oncamera) = synchronized(peerLock) {
            sharingByRoster.clear()
            watchedScreens.clear()
            cameraDemand.clear()
            cameraPauseJobs.values.forEach { it.cancel() }
            cameraPauseJobs.clear()
            peers.clear()
            val screenPeers = screens.keys.toList().also { screens.clear() }
            val cameraPeers = cameras.keys.toList().also { cameras.clear() }
            screenPeers to cameraPeers
        }
        showing.forEach { onRemoteScreen(it, null) }
        oncamera.forEach { onRemoteCamera(it, null) }
        // The capture first, then the room. `release` would take the track with
        // it, but only after `disconnect` has finished its round trip, and the
        // gap is a microphone still recording for somebody who has hung up.
        runCatching { mic?.stop() }
        // Same reasoning as the microphone: the capture is stopped before the
        // room's disconnect round trip, so nothing is still recording the
        // screen of somebody who has left.
        runCatching { screen?.stop() }
        runCatching { leaving?.disconnect() }
        runCatching { leaving?.release() }
    }

    /**
     * The same as [stop], and that is the whole of it on this transport.
     *
     * Not a shortcut past the audio device module. `Room.release` closes
     * LiveKit's `CloseableManager`, which is what holds the closers registered
     * by its Dagger graph: `JavaAudioDeviceModule.release`, `EglBase.release`
     * and the peer connection factory's dispose (`RTCModule.audioModule` /
     * `eglBase` / `peerConnectionFactoryManager`, verified by reading the
     * 2.28.1 bytecode). Those resources belong to a room here rather than to
     * the engine, so [stop] already gives them back at the end of every call
     * and there is nothing left for this to do.
     *
     * The mesh engine is the asymmetric one, and it has to be: it builds its
     * factory, module and GL context once and keeps them across calls, so
     * `VoiceEngine.dispose` is the only thing that ever releases them.
     */
    override fun dispose() {
        stop()
    }

    /**
     * Null on this transport, and it is a real gap rather than a shrug.
     *
     * [parseMediaStats] takes an `org.webrtc.RTCStatsReport`; LiveKit hands
     * back a `livekit.org.webrtc.RTCStatsReport`, an unrelated type from the
     * other libwebrtc in this process. Wiring them together means a second
     * parser, and a parser nobody has run against a real SFU report would be a
     * worse answer than an honest none.
     */
    override fun statsFor(remotePeerId: String): PeerMediaStats? = null

    override fun remoteScreenFor(remotePeerId: String): RemoteVideoFeed? {
        val room = room ?: return null
        val track = synchronized(peerLock) { screens[remotePeerId] } ?: return null
        return RemoteVideoFeed.LiveKit(track, room)
    }

    override fun remoteCameraFor(remotePeerId: String): RemoteVideoFeed? {
        val room = room ?: return null
        val track = synchronized(peerLock) {
            if (peers.isCameraMuted(remotePeerId)) null else cameras[remotePeerId]
        } ?: return null
        return RemoteVideoFeed.LiveKit(track, room)
    }

    companion object {
        private const val TAG = "pqp.voice"
        private const val LOCAL_AUDIO_ID = "pqp-mic"
        private const val SCREEN_TRACK_NAME = "pqp-screen"

        /**
         * How long a camera keeps flowing after the last surface stops drawing
         * it.
         *
         * The web's `OFFSCREEN_GRACE_MS`, and the same one second, chosen the
         * same way: long enough that a tile leaving and rejoining the rail
         * across a layout change costs nothing, short enough that a camera
         * nobody is looking at is off the wire before it is worth counting.
         */
        private const val CAMERA_PAUSE_GRACE_MS = 1_000L

        /**
         * The same 45s the web client allows.
         *
         * Generous on purpose: this covers minting a token over HTTP *and* the
         * SFU handshake, on a phone that may be on a slow mobile link. The
         * short timeout that looks reasonable in a test suite turns a call that
         * would have connected into a call that refuses.
         */
        private const val JOIN_TIMEOUT_MS = 45_000L
    }
}
