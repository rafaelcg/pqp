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
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.LocalAudioTrackOptions
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.RemoteVideoTrack
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.TrackPublication
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

/**
 * LiveKit SFU audio, for a room the server put on the `livekit` transport.
 *
 * Presence, the roster and every refusal still ride `/ws`; only the media moves.
 * Read [VoiceTransport] first, in particular the note about there being two
 * WebRTC namespaces in this process, which is why nothing in this file imports
 * `org.webrtc`: every video type here is LiveKit's own, and it leaves as a
 * [RemoteScreen.LiveKit] so a renderer on the other namespace can never be
 * handed it.
 *
 * ### What this does with video
 *
 * **Watches screen shares.** A `SCREEN_SHARE` publication is subscribed and
 * handed up as a [RemoteScreen.LiveKit] for the call bar's Watch row, with its
 * `SCREEN_SHARE_AUDIO` companion playing as the presentation's sound. This is
 * where watch parties happen, and a phone that could hear the room but not see
 * the film was the platform gap. Two things keep it off the bill:
 *
 * - **Delivery is paused until somebody taps Watch.** The publication is
 *   `setEnabled(false)` the moment it is subscribed and only enabled by
 *   [setWatchingScreen], so a share in a room this phone is merely listening to
 *   is a subscription on paper and no bytes on the wire. The web does the same
 *   with `remote-video-delivery.ts`.
 * - **The layer is capped.** Adaptive stream is on, so LiveKit measures the
 *   renderer and asks the SFU for the smallest simulcast layer that covers it,
 *   and [screenReceiveLayerFor] lays a ceiling over that: 720p on Wi-Fi, 360p on
 *   a metered link. A phone never asks for the 1080p layer by default.
 *
 * ### What this deliberately does not do
 *
 * **Publish a screen.** [startScreenShare] answers false and the call bar hides
 * its button on this transport (`VoiceState.screenShareSupported`). A button
 * that raises Android's consent dialog, takes the grant and then publishes
 * nothing would be worse than no button, and mesh screen share is untouched.
 *
 * **Receive a camera.** Not by ignoring frames but by never asking for them:
 * the room is joined with `autoSubscribe = false` and this client subscribes
 * publication by publication. See [livekitSubscribesTo].
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
    private val onRemoteScreen: (String, RemoteScreen?) -> Unit = { _, _ -> },
    /**
     * Whether the active network is metered, read when a layer is chosen. A
     * function rather than a value because a phone walks from Wi-Fi to mobile
     * data mid-call, and the next share it opens should notice.
     */
    private val isMetered: () -> Boolean = { false },
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

    override val isSharingScreen: Boolean get() = false

    /**
     * [ice] is ignored, on purpose.
     *
     * The list from `GET /api/ice-servers` is for peer connections this client
     * builds. The SFU leg's ICE configuration comes from the LiveKit server in
     * its join response, which is the only thing that knows the relays that
     * deployment actually has.
     */
    override fun start(localPeerId: String, ice: List<IceServer>) {
        stop()
        this.localPeerId = localPeerId

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

    private suspend fun connect(peerId: String) {
        val credentials = session(peerId)
        if (this.localPeerId != peerId) return

        val created = LiveKit.create(
            context.applicationContext,
            RoomOptions(
                // On, as on the web. Adaptive stream measures the renderer a
                // subscribed video is drawn into and asks the SFU for the
                // smallest simulcast layer that covers it, and pauses the
                // video when no renderer is visible. The renderer has to be
                // registered through `Room.initVideoRenderer` for the SDK to
                // see it; `RemoteScreenView` does that. A manual
                // `setVideoQuality` is a ceiling laid over the measurement,
                // not a replacement for it: see `screenReceiveLayerFor`.
                adaptiveStream = true,
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

        eventsJob = scope.launch { listen(created) }

        created.connect(
            credentials.url,
            credentials.token,
            // Nothing is pulled down off the SFU until this client asks for it
            // by name. With `autoSubscribe = true` a phone in a room where
            // somebody is presenting from the web receives and decodes that
            // 1080p screen share in full, on mobile data, to hand the frames to
            // a `return` in `onTrackSubscribed`. Subscribing deliberately is
            // the difference between not showing video and not paying for it.
            ConnectOptions(autoSubscribe = false),
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
            if (publication.source != Track.Source.SCREEN_SHARE) {
                // Only a screen is ever asked for (see `livekitSubscribesTo`),
                // so a camera arriving here means the server subscribed us to
                // something we did not ask for. Dropped rather than rendered,
                // and said out loud rather than swallowed, because silently
                // decoding video is the bill nobody can explain.
                Log.w(TAG, "unexpected ${publication.source} video from $peerId; ignoring")
                return
            }
            // A remote participant's publication always is one; the event's
            // static type is the base class because the same event shape
            // carries local publications elsewhere in the SDK.
            val remote = publication as? RemoteTrackPublication
            if (remote == null) {
                Log.w(TAG, "screen share from $peerId is not a remote publication; ignoring")
                return
            }
            onScreenSubscribed(peerId, remote, track)
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
            val gone = synchronized(peerLock) {
                peers.screenTrackRemoved(peerId, sid).also { if (it) screens.remove(peerId) }
            }
            if (gone) onRemoteScreen(peerId, null)
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
        onRemoteScreen(peerId, RemoteScreen.LiveKit(track, room))
    }

    private fun applyScreenDelivery(publication: RemoteTrackPublication, watching: Boolean) {
        runCatching { publication.setVideoQuality(screenReceiveLayerFor(isMetered())) }
            .onFailure { Log.w(TAG, "SFU receive quality rejected; keeping the current layer", it) }
        runCatching { publication.setEnabled(watching) }
            .onFailure { Log.w(TAG, "could not ${if (watching) "resume" else "pause"} ${publication.sid}", it) }
    }

    private fun screenPublicationFor(peerId: String): RemoteTrackPublication? {
        val sid = synchronized(peerLock) { peers.screenTrackFor(peerId) } ?: return null
        val participant = room?.remoteParticipants?.values?.firstOrNull { it.identity?.value == peerId }
            ?: return null
        return participant.trackPublications[sid] as? RemoteTrackPublication
    }

    /**
     * The viewer opened or closed on this peer's share.
     *
     * Explicit on both ends rather than left to adaptive stream alone. The
     * SDK pauses a track once every renderer it was given has gone invisible,
     * but before a renderer has ever been attached it has nothing to compare
     * against and leaves the publication delivering. Naming the state here is
     * what makes the pause certain; the SDK's measurement then only ever
     * shrinks the layer below the ceiling while the viewer is open.
     */
    override fun setWatchingScreen(remotePeerId: String, watching: Boolean) {
        val publication = screenPublicationFor(remotePeerId) ?: return
        applyScreenDelivery(publication, watching)
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
        val hadScreen = synchronized(peerLock) {
            sharingByRoster.remove(peerId)
            peers.forget(peerId)
            screens.remove(peerId) != null
        }
        if (hadScreen) onRemoteScreen(peerId, null)
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
     * Refused, cleanly, every time.
     *
     * Not "not implemented yet" dressed up as a failure: the caller hides the
     * button on this transport, so this is the belt to that braces, and it
     * never touches the projection grant it was handed.
     */
    override fun startScreenShare(permission: Intent, profile: ScreenCaptureProfile): Boolean =
        false

    override fun stopScreenShare() = Unit

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
        room = null
        micTrack = null
        val showing = synchronized(peerLock) {
            sharingByRoster.clear()
            peers.clear()
            screens.keys.toList().also { screens.clear() }
        }
        showing.forEach { onRemoteScreen(it, null) }
        // The capture first, then the room. `release` would take the track with
        // it, but only after `disconnect` has finished its round trip, and the
        // gap is a microphone still recording for somebody who has hung up.
        runCatching { mic?.stop() }
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

    override fun remoteScreenFor(remotePeerId: String): RemoteScreen? {
        val room = room ?: return null
        val track = synchronized(peerLock) { screens[remotePeerId] } ?: return null
        return RemoteScreen.LiveKit(track, room)
    }

    companion object {
        private const val TAG = "pqp.voice"
        private const val LOCAL_AUDIO_ID = "pqp-mic"

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
