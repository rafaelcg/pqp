import Foundation
import Observation
import AVFoundation
import CoreVideo
import QuartzCore
import WebRTC

enum VoiceStatus: Equatable, Sendable {
    case idle
    case joining
    case connected
    case failed(String)
}

/// Owns a voice session: mic permission, the room, and the media underneath it,
/// which is a mesh or a LiveKit room depending on what the server pinned.
@MainActor
@Observable
final class VoiceModel {
    /// `didSet` rather than a line in `join`/`leave`, because a voice channel
    /// has more exits than it has handlers: the button, the socket dropping,
    /// being displaced by another room, and popping the screen off the
    /// navigation stack. Hanging the rating on the one state every one of them
    /// has to pass through is the only version that cannot be forgotten.
    private(set) var status: VoiceStatus = .idle {
        didSet {
            guard status != oldValue else { return }
            if status == .connected { noteCallProgress() } else { endCallRating() }
        }
    }
    private(set) var channelId: String?
    private(set) var channelName: String?
    /// The room this session is in or joining, for the stage that is presented
    /// from the app root. Nil once left. Distinct from `intendedChannel`, which
    /// is cleared on eviction while the screen is still up.
    private(set) var channel: Channel?
    /// "Tuck the call away and read": the stage is dismissed but the session
    /// stays up. Set by the swipe-down path and the collapse control, cleared
    /// by Join or by tapping the banner. Same shape as `CallModel.isCollapsed`.
    var isCollapsed = false
    /// Whether there is a session worth a surface: joining, connected, or a
    /// failure that has not been dismissed yet.
    var isLive: Bool { status != .idle }
    private(set) var peers: [VoicePeerState] = [] {
        didSet { noteCallProgress() }
    }
    private(set) var selfPeerId: String?
    /// Per-peer incoming video, already sorted into camera vs screen by
    /// `VoiceClient`.
    ///
    /// Both halves are used. This model classified `cameraStreamId` from the
    /// day the roster carried it and then drew nothing with the result, so a
    /// voice channel received everybody's camera and showed none of them: the
    /// tracks arrived, were filed correctly, and were dropped on the floor one
    /// layer above. The web client has published cameras into voice channels
    /// since PR #77.
    private(set) var video: [String: PeerVideo] = [:] {
        didSet { noteCallProgress() }
    }
    /// Our own capture, for the self preview. Never handed to a renderer twice.
    private(set) var localCamera: VideoFeed?
    /// What `welcome` said this room runs on. Nil until it has; the handlers
    /// below switch on it, and `ratingSnapshot` reports it.
    private(set) var transport: VoiceRoomTransport?
    private(set) var isCameraOn = false
    /// A refusal worth putting in front of somebody: permission, or a camera
    /// that would not open. Cleared by the next successful toggle.
    private(set) var cameraError: String?
    /// The roster by peer id: who is muted, and who is presenting.
    private(set) var roster: [String: VoiceParticipant] = [:]
    /// Outgoing screen share, driven by the ReplayKit bridge.
    let screenShare = ScreenShareController()
    /// The server's SPEAK rule for this seat, from `welcome.canSpeak` and
    /// `voice-speak-changed`. False locks the microphone control and publishes
    /// no audio. Always true in a call that has no roles. See `VoiceSpeakRule`.
    private(set) var canSpeak = true
    /// The server's STREAM rule: whether this seat may turn on a camera or
    /// share a screen. A SEPARATE grant from `canSpeak` on the server, and now
    /// separate here.
    ///
    /// It used to be read off `canSpeak`, so somebody with a microphone and no
    /// STREAM grant was offered the camera, had it refused, and was told the
    /// call "already has the maximum number of cameras". That sends a person
    /// to ask why rather than to the permission that is missing, and it is
    /// wrong about the room as well as about them.
    private(set) var canStream = true
    /// Why the microphone is locked, or that it has just been unlocked.
    /// Cleared on leave and by the next rule change.
    private(set) var speakNotice: String?
    /// The room moved onto the voice server while we were in it, and this is
    /// the sentence that says why. Set by `followPromotion` and cleared on
    /// leave; deliberately not an error, because nothing went wrong.
    ///
    /// It exists because the move is AUDIBLE: the mesh is torn down before the
    /// SFU room is up, so there is a second or so of quiet. A line explaining
    /// it is the difference between a call that grew and a call that glitched.
    private(set) var transportNotice: String?

    /// Whether to draw the share control at all.
    var offersScreenShare: Bool {
        // STREAM, not SPEAK: sharing a screen is publishing, and the server
        // gates it on the same bit the camera uses.
        screenShareIsOffered(isAvailable: screenShare.isAvailable, canSpeak: canStream)
    }
    var isMuted = false {
        didSet {
            // A listen-only seat cannot unmute, whatever asked. The control is
            // disabled in the view; this is the belt to that suspender, so a
            // stale tap or a deafen-then-undeafen cannot open the microphone.
            if !canSpeak && !isMuted {
                isMuted = true
                return
            }
            Task {
                // Both transports, unconditionally: the one this room is not
                // on holds no track and the call is a no-op, and forwarding to
                // both is what keeps a mute decided before `welcome` true on
                // whichever one the room turns out to be.
                await voice.setMuted(isMuted)
                await sfu.setMuted(isMuted)
                await reportVoiceState()
            }
        }
    }
    /// Deafening also mutes, matching the web client: being heard while
    /// hearing nothing is a trap rather than a feature.
    var isDeafened = false {
        didSet {
            if isDeafened { isMuted = true }
            Task {
                await voice.setDeafened(isDeafened)
                await sfu.setDeafened(isDeafened)
                await reportVoiceState()
            }
        }
    }

    /// Tell the room what this client's microphone is doing.
    ///
    /// A voice channel's roster carries `muted` and `deafened` for everybody in
    /// it — it is what draws the crossed-out microphone beside a name, here and
    /// in every web client in the room — and this app was never sending it. The
    /// symptom was silent by construction: you could hear yourself go quiet, and
    /// nobody else could see it, so a muted person read as one who had simply
    /// stopped talking. `CallModel` has always reported it; this is the same two
    /// lines for server voice channels.
    ///
    /// Reads the properties at execution time rather than taking them as
    /// arguments, so the two `didSet` observers above cannot race into
    /// declaring a stale pair: whichever task runs last still reports what is
    /// true now. Display state only, never enforcement — the server treats it
    /// as self-reported, and drops a no-op or a flood.
    private func reportVoiceState() async {
        await session?.realtime.setVoiceState(muted: isMuted, deafened: isDeafened)
    }

    var isSpeakerOn = true {
        didSet {
            Task {
                await voice.setSpeaker(isSpeakerOn)
                await sfu.setSpeaker(isSpeakerOn)
            }
        }
    }

    /// A moderator muted us, per our own roster entry. Not ours to clear: the
    /// server refuses `set-muted false` from the target and snaps the roster
    /// back, so the unmute control is disabled rather than left to pretend.
    private(set) var isServerMuted = false

    /// Whether the mic button does anything right now. See `ServerMute`.
    var canToggleMute: Bool {
        ServerMute.muteControlIsEnabled(connected: status == .connected, selfServerMuted: isServerMuted)
            && canSpeak
    }

    /// The channel we intend to be in, kept across a socket drop so the call
    /// can be rebuilt rather than silently ending.
    private var intendedChannel: Channel?
    /// Set when the server dropped our peer because this socket joined another
    /// voice room. Suppresses the departing `leave-voice-room` — see `leave()`.
    private var wasEvicted = false
    /// Keyed by *user* id, not peer id — a peer id is minted fresh on every
    /// join, so a peer-keyed level would reset whenever they reconnected.
    private var volumeByUser: [String: Double] = [:]

    private let voice = VoiceClient()
    /// The SFU half. Idle in a mesh room; in a LiveKit room it is the media.
    private let sfu = LiveKitVoiceClient()
    /// The token-and-connect in flight for a LiveKit room, so a leave that
    /// lands mid-join can cancel it rather than race it.
    private var sfuJoin: Task<Void, Never>?
    /// Read synchronously off the last join outcome, because the `welcome`
    /// handler that needs it is not async. Kept in step by `startSfuSession`
    /// and by `leave`.
    private var sfuIsConnected = false
    /// The `/api/ice-servers` list fetched for the current join, kept so an
    /// SFU room built later in the same join gets the same list the mesh
    /// would, with no second fetch.
    private var iceServers: [IceServerConfig] = []
    /// Whether this DEPLOYMENT has an SFU, read once per join from
    /// `GET /api/voice/backend`. One of three inputs to
    /// `declaresVoiceResume`, and never the answer on its own: it says nothing
    /// about the room being joined, which is how it used to leave a ghost seat
    /// behind every mesh call.
    private var deploymentRunsLiveKit = false
    /// What this build promises the server about holding its seat across a
    /// socket drop, resolved per join frame rather than stored once. See
    /// `declaresVoiceResume`.
    private var declaresResume: Bool {
        declaresVoiceResume(
            roomKind: .serverChannel,
            knownTransport: transport,
            deploymentRunsLiveKit: deploymentRunsLiveKit
        )
    }
    /// What the last `welcome` handed back, presented on the rejoin after a
    /// socket drop so the server reattaches our seat instead of minting a new one.
    private var resumeClaim: VoiceResumeClaim?
    private var session: SessionStore?
    private let handlerKey = "voice-" + UUID().uuidString
    /// Accumulates the shape of the call while it runs. Ignored by Observation
    /// on purpose: it changes on nearly every peer event and nothing should
    /// redraw because a high-water mark moved.
    @ObservationIgnored private var ratingTracker = CallRatingTracker()
    /// App-wide, because the prompt has to outlive this screen: `VoiceView` is
    /// pushed on a navigation stack, and popping it is one of the ways a call
    /// ends.
    @ObservationIgnored private weak var ratings: CallRatingModel?

    var participantCount: Int { peers.count + (status == .connected ? 1 : 0) }

    /// Screens currently on the wire, one per peer who is presenting.
    ///
    /// The server allows two on mesh and four on LiveKit. Focus is local: the
    /// phone shows one picture at a time and the chips switch who that is.
    var focusedScreenPeerId: String?

    var screenPresenters: [(peerId: String, name: String, track: VideoFeed)] {
        peers.compactMap { peer in
            guard let screen = video[peer.peerId]?.screen else { return nil }
            return (peer.peerId, peer.displayName, screen)
        }
    }

    var resolvedScreenFocus: String? {
        if let focused = focusedScreenPeerId,
           video[focused]?.screen != nil {
            return focused
        }
        return screenPresenters.first?.peerId
    }

    var remoteScreen: VideoFeed? {
        if let focused = resolvedScreenFocus {
            return video[focused]?.screen
        }
        return nil
    }

    /// Who that screen belongs to, for the presenter line.
    var presenterName: String? {
        guard let focused = resolvedScreenFocus else { return nil }
        return screenPresenters.first(where: { $0.peerId == focused })?.name
    }

    func focusScreen(_ peerId: String) {
        focusedScreenPeerId = peerId
    }

    func isMuted(_ peerId: String) -> Bool { roster[peerId]?.muted ?? false }

    /// Muted by a moderator, as opposed to by themselves. The two glyphs differ
    /// because the two facts do: one is a choice the person can undo, the other
    /// is something done to them that they cannot.
    func isServerMuted(_ peerId: String) -> Bool { roster[peerId]?.serverMuted ?? false }

    /// The roster entry that is us. The only field on it that changes anything
    /// here is `serverMuted`: while it is set we show ourselves muted and stop
    /// the mic, because on mesh our own client is the only thing that can stop
    /// the bytes leaving, and every receiver is already playing us at zero.
    /// When it clears the mic STAYS off. Coming back unmuted the instant a
    /// moderator lets go would put whatever was being said mid-sentence into
    /// the room; tapping unmute is the person's own decision.
    private func applySelf(_ participant: VoiceParticipant) {
        let wasServerMuted = isServerMuted
        isServerMuted = participant.serverMuted
        guard participant.serverMuted, !wasServerMuted else { return }
        let muted = ServerMute.selfMuted(currentlyMuted: isMuted, serverMuted: true)
        if muted != isMuted { isMuted = muted }
    }

    /// One peer's roster flag, handed to the mixer. Idempotent and cheap, so
    /// every frame that carries a participant calls it rather than trying to
    /// diff: a flag that is re-applied is a no-op, a flag that is missed is a
    /// person the whole room agreed not to hear still playing on this phone.
    private func applyServerMute(_ participant: VoiceParticipant) {
        Task {
            await voice.setPeerScreenAudioStreamId(
                participant.screenAudioStreamId, for: participant.peerId
            )
            await voice.setServerMuted(participant.serverMuted, for: participant.peerId)
        }
    }

    // MARK: - Camera
    //
    // The same three calls `CallModel` makes for a DM call, against the same
    // `VoiceClient`. The mesh never cared which kind of room it was carrying;
    // what was missing was a screen with a button on it.

    func camera(for peerId: String) -> VideoFeed? { video[peerId]?.camera }

    /// Everyone whose camera is on, in roster order, so the tiles do not
    /// reshuffle every time somebody starts speaking.
    var cameraPeers: [VoicePeerState] {
        peers.filter { video[$0.peerId]?.camera != nil }
    }

    /// Whether there is any picture of a person to show, ours included.
    var hasCameras: Bool { isCameraOn || !cameraPeers.isEmpty }

    /// True while a start or a stop is running, so the control can be shown as
    /// working rather than as ignoring taps. See `CameraGate`.
    private(set) var isCameraBusy = false
    private var cameraWatchdog: Task<Void, Never>?

    func toggleCamera() async {
        switch CameraGate.act(
            isOn: isCameraOn, isBusy: isCameraBusy,
            isLive: status == .connected, canPublish: canStream
        ) {
        case .start: await enableCamera()
        case .stop: await disableCamera()
        case .ignore: return
        }
    }

    func flipCamera() async {
        if transport == .livekit {
            await sfu.flipCamera()
        } else {
            await voice.flipCamera()
        }
    }

    private func enableCamera() async {
        guard status == .connected, canStream else { return }
        isCameraBusy = true
        defer { isCameraBusy = false }
        guard await Self.requestCamera() else {
            cameraError = CameraFailure.permission.message
            return
        }
        // `status` is re-read: asking for permission can take as long as the
        // person takes to answer a system alert, and the room may be gone.
        guard status == .connected, canStream else { return }
        let started: (feed: VideoFeed, streamId: String)
        do {
            if transport == .livekit {
                started = try await sfu.startCamera()
            } else {
                let mesh = try await voice.startCamera()
                started = (.mesh(mesh.track.value), mesh.streamId)
            }
        } catch {
            cameraError = (error as? CameraFailure ?? .captureFailed).message
            return
        }
        localCamera = started.feed
        isCameraOn = true
        cameraError = nil
        // Only on the mesh: LiveKit owns its own audio session, and the mesh's
        // `RTCAudioSession` writing a mode into it from here is a change the
        // SFU never asked for.
        if transport != .livekit {
            await voice.setVideoMode(true)
        }
        // The announcement is what lets everyone file the arriving track as a
        // face rather than a screen. Sent after publishing because the stream id
        // does not exist until then; the roster re-check on the receiving side
        // (`setPeerCameraStreamId`) is what makes either ordering correct.
        await session?.realtime.setCamera(streamId: started.streamId)
        watchForFirstFrame()
    }

    private func disableCamera() async {
        isCameraBusy = true
        defer { isCameraBusy = false }
        cameraWatchdog?.cancel()
        cameraWatchdog = nil
        isCameraOn = false
        localCamera = nil
        // Told before the track goes: a peer that watches the stream vanish with
        // no announcement reclassifies it as a screen share and draws the last
        // frame of your face forever.
        await session?.realtime.setCamera(streamId: nil)
        if transport == .livekit {
            await sfu.stopCamera()
        } else {
            await voice.stopCamera()
        }
        if transport != .livekit {
            await voice.setVideoMode(false)
        }
    }

    /// A capture that opened and never produced a picture is still a failure.
    ///
    /// iOS can interrupt a capture session the instant it starts and report
    /// nothing back through the API that started it, so the only honest test is
    /// whether a frame arrived. Same shape as the broadcast watchdog in
    /// `ScreenShareController`, and the same reason for existing: silence is
    /// the one outcome a person cannot act on.
    private func watchForFirstFrame() {
        cameraWatchdog?.cancel()
        cameraWatchdog = Task { [weak self] in
            try? await Task.sleep(for: CameraFailure.firstFrameDeadline)
            guard !Task.isCancelled, let self, self.isCameraOn else { return }
            let sawFrames = self.transport == .livekit
                ? await self.sfu.cameraHasFrames()
                : await self.voice.cameraHasFrames()
            guard !Task.isCancelled, self.isCameraOn, !sawFrames else { return }
            self.cameraError = CameraFailure.noFrames.message
        }
    }

    private static func requestCamera() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .denied, .restricted: return false
        default: return await AVCaptureDevice.requestAccess(for: .video)
        }
    }

    func join(channel: Channel, session: SessionStore, ratings: CallRatingModel? = nil) async {
        // One session per app, so a join from another room is a move, and the
        // room being left must hear about it before this one is entered. The
        // same room is a no-op: the stage was reopened, not rejoined.
        if status != .idle {
            if channelId == channel.id { return }
            await leave()
        }
        self.session = session
        self.ratings = ratings
        configureScreenShare()
        self.channel = channel
        channelId = channel.id
        channelName = channel.name
        intendedChannel = channel
        status = .joining

        // Asked for before joining rather than after: joining a room you cannot
        // speak in, then discovering the mic is refused, is a worse first
        // experience than being asked plainly up front.
        guard await requestMicrophone() else {
            status = .failed(String(localized: "Microphone access is off. Enable it in Settings to talk."))
            return
        }

        session.eventHandlers[handlerKey] = { [weak self] event in
            self?.apply(event)
        }

        do {
            let ice: IceServersResponse = try await session.api.get("/api/ice-servers")
            iceServers = ice.iceServers
            // Advisory, never binding: `welcome` says what the room runs on.
            // This is the DEPLOYMENT's default, and it is only half an answer
            // to whether our seat should be held across a socket drop: right
            // for a LiveKit room, and a 90-second ghost in everyone's roster
            // for a mesh one. `declaresVoiceResume` is where the two halves
            // meet. A failure here is not a failure to join; it is a join that
            // cannot resume.
            let backend: VoiceBackendInfo? = try? await session.api.get("/api/voice/backend")
            deploymentRunsLiveKit = backend?.runsLiveKit ?? false
            try await voice.startAudio()
            // "Mute microphone when joining voice", which Settings has been
            // writing since the screen existed and nothing has ever read.
            //
            // HERE, between the track being created and the first peer
            // connection being built, for the same reason the web client
            // applies `startMuted` before its own track exists: a preference
            // that takes effect a moment *after* the join is a preference that
            // let a room hear the first thing you said.
            //
            // Awaited directly as well as set, because the property's `didSet`
            // hands its work to an unstructured Task that need not have run by
            // the time `joinVoice` below returns a peer to connect to.
            isMuted = session.preferences.muteOnJoin ?? false
            await voice.setMuted(isMuted)
            await voice.configure(
                selfPeerId: "",
                iceServers: ice.iceServers,
                onStateChange: { [weak self] states in
                    Task { @MainActor in self?.peers = states }
                },
                signal: { [weak self] signal in
                    Task { @MainActor in await self?.relay(signal) }
                },
                // Passing this is the whole difference between a voice channel
                // that can show a shared screen and one that silently discards
                // every video track that arrives: `emitVideo` classifies them
                // either way, then hands the answer to nobody.
                onVideoChange: { [weak self] video in
                    Task { @MainActor in self?.video = video }
                },
                onSendStats: { snapshot in
                    Task { @MainActor in VideoSendReport.shared.apply(snapshot) }
                }
            )
            await voice.setVideoQuality(VideoQualitySettings.shared.quality)
            // A choice made in Settings has to reach senders that are already on
            // the wire, and Settings is presented from a screen that is not this
            // one, so the push is a registration rather than an `onChange` on
            // a view that may not be in the hierarchy when the picker moves.
            VideoQualitySettings.shared.addListener(handlerKey) { [weak self] quality in
                guard let self else { return }
                Task { await self.voice.setVideoQuality(quality) }
            }
            // The same two callbacks the mesh gets, so whichever transport the
            // room turns out to be, the screen is fed from one pair of fields.
            await sfu.configure(
                onStateChange: { [weak self] states in
                    Task { @MainActor in self?.peers = states }
                },
                onVideoChange: { [weak self] video in
                    Task { @MainActor in self?.video = video }
                }
            )
            await session.realtime.joinVoice(channelId: channel.id, declaresResume: declaresResume)
        } catch {
            status = .failed((error as? APIError)?.errorDescription ?? error.localizedDescription)
        }
    }

    func leave() async {
        sfuJoin?.cancel()
        sfuJoin = nil
        await screenShare.disarm()
        intendedChannel = nil
        VideoQualitySettings.shared.removeListener(handlerKey)
        VideoSendReport.shared.clear()
        cameraWatchdog?.cancel()
        cameraWatchdog = nil
        isCameraBusy = false
        // Announced before the socket work below, while the frame can still be
        // sent: a room that never hears the camera go off keeps drawing the last
        // thing it saw of you.
        if isCameraOn {
            await session?.realtime.setCamera(streamId: nil)
        }
        session?.eventHandlers.removeValue(forKey: handlerKey)
        // Skipped when the server already took our peer: this socket's peer now
        // belongs to whatever displaced us, so the frame would hang *that* up.
        if !wasEvicted {
            await session?.realtime.leaveVoice()
        }
        wasEvicted = false
        await voice.disconnectAll()
        await sfu.disconnect()
        sfuIsConnected = false
        transport = nil
        resumeClaim = nil
        status = .idle
        channel = nil
        isCollapsed = false
        channelId = nil
        channelName = nil
        peers = []
        video = [:]
        roster = [:]
        selfPeerId = nil
        canSpeak = true
        speakNotice = nil
        isMuted = false
        isDeafened = false
        isServerMuted = false
        localCamera = nil
        isCameraOn = false
        cameraError = nil
        canSpeak = true
        canStream = true
        transportNotice = nil
    }

    /// Apply the server's SPEAK and STREAM rules to the local media.
    /// See `VoiceSpeakRule`.
    private func applySpeakRule(
        _ next: Bool, stream: Bool, source: VoiceSpeakRule.Source
    ) {
        let outcome = VoiceSpeakRule.apply(
            canSpeak: next, canStream: stream,
            wasSpeak: canSpeak, wasStream: canStream,
            source: source
        )
        canSpeak = outcome.canSpeak
        canStream = outcome.canStream
        if let notice = outcome.notice {
            speakNotice = notice.text
        } else if outcome.canSpeak && outcome.canStream {
            speakNotice = nil
        }
        if outcome.mute, !isMuted {
            // Through the property, so both transports and the roster hear it.
            isMuted = true
        }
        // NOT nested under the mute. STREAM is its own grant, so somebody who
        // keeps their microphone and loses the camera still has to stop
        // publishing one; hanging this off `mute` meant a STREAM revoke did
        // nothing at all and the camera stayed on in a channel that had just
        // forbidden it.
        guard outcome.stopPublishing else { return }
        let wasSharing = screenShare.isSharing
        let message = outcome.canSpeak
            ? VoiceSpeakRule.Notice.streamDenied.text
            : VoiceSpeakRule.Notice.listenOnly.text
        Task {
            if isCameraOn { await disableCamera() }
            if wasSharing {
                // `refuse` stops the announce and the outgoing track and
                // keeps later frames from re-announcing until the
                // broadcast is stopped, which is exactly a revoke.
                await screenShare.refuse(message: message)
            }
        }
    }

    /// One moment of this call, for the rating that may follow it.
    ///
    /// `peerCount` excludes us, matching the web's `remotePeers.length`, and the
    /// screen-share flag counts anybody's screen including our own: the question
    /// it eventually answers is "was a screen being shared", not "whose".
    private var ratingSnapshot: CallSnapshot {
        CallSnapshot(
            peerCount: peers.count,
            usingSfu: transport == .livekit,
            screenSharing: remoteScreen != nil || screenShare.isSharing,
            channelId: channelId
        )
    }

    private func noteCallProgress() {
        guard status == .connected else { return }
        ratingTracker.observe(ratingSnapshot)
    }

    private func endCallRating() {
        ratings?.finish(&ratingTracker)
    }

    /// Wires the bridge to whichever transport the room runs on. Both
    /// directions are here rather than in the controller so the controller
    /// stays about *when* to share, not how. The bridge is the same socket
    /// and the same NV12 frames either way; only the track they land in
    /// differs.
    private func configureScreenShare() {
        screenShare.configure(
            onFrame: { [weak self] buffer, rotation in
                guard let self else { return }
                let timestamp = Int64(CACurrentMediaTime() * 1_000_000_000)
                let usesSfu = self.transport == .livekit
                Task {
                    if usesSfu {
                        await self.sfu.pushScreenFrame(
                            buffer, rotation: rotation, timeStampNs: timestamp
                        )
                    } else {
                        await self.voice.pushScreenFrame(
                            buffer, rotation: rotation, timeStampNs: timestamp
                        )
                    }
                }
            },
            onStart: { [weak self] in
                guard let self else { return }
                // Announced first, matching the web client: the roster flag is
                // what draws "X is presenting", and the track behind it takes a
                // renegotiation (or a first frame, on the SFU) to arrive.
                await self.session?.realtime.setSharingScreen(true)
                if self.transport == .livekit {
                    _ = await self.sfu.startScreenShare(
                        quality: VideoQualitySettings.shared.quality
                    )
                } else {
                    _ = await self.voice.startScreenShare()
                }
                // Our own share never touches `video`, which is the far end's
                // tracks, so this is the only place it can be recorded.
                self.noteCallProgress()
            },
            onStop: { [weak self] in
                guard let self else { return }
                await self.session?.realtime.setSharingScreen(false)
                await self.sfu.stopScreenShare()
                await self.voice.stopScreenShare()
            }
        )
    }

    func setVolume(_ volume: Double, for peer: VoicePeerState) {
        volumeByUser[peer.userId] = volume
        Task {
            await voice.setVolume(volume, for: peer.peerId)
            await sfu.setVolume(volume, for: peer.peerId)
        }
    }

    func volume(for peer: VoicePeerState) -> Double {
        volumeByUser[peer.userId] ?? 1
    }

    private func requestMicrophone() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default:
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        }
    }

    private func relay(_ signal: VoiceClient.VoiceSignal) async {
        guard let session, let selfPeerId else { return }
        switch signal {
        case .offer(let to, let sdp):
            await session.realtime.sendOffer(to: to, from: selfPeerId, sdp: sdp)
        case .answer(let to, let sdp):
            await session.realtime.sendAnswer(to: to, from: selfPeerId, sdp: sdp)
        case .candidate(let to, let sdp, let sdpMid, let index):
            await session.realtime.sendCandidate(
                to: to, from: selfPeerId, sdp: sdp, sdpMid: sdpMid, sdpMLineIndex: index
            )
        }
    }

    private func apply(_ event: RealtimeEvent) {
        switch event {
        // The socket came back. The server dropped our voice peer when it
        // closed, and a reconnect mints a *new* peer id — so the old mesh is
        // unusable and has to be torn down and rebuilt rather than resumed.
        case .ready:
            guard let intendedChannel, status != .idle else { return }
            // A LiveKit room does not care that `/ws` blinked: the media is a
            // separate connection to a separate host, and it is still up. So
            // the room is kept and the seat is reclaimed, by presenting the
            // claim the last `welcome` issued. If the server honours it the
            // next `welcome` says `resumed` and nothing is rebuilt; if it does
            // not, that `welcome` mints a new id and media is reconnected once.
            if transport == .livekit {
                let claim = resumeClaim
                Task {
                    await session?.realtime.joinVoice(
                        channelId: intendedChannel.id,
                        declaresResume: declaresResume,
                        resume: claim
                    )
                }
                return
            }
            Task {
                await voice.disconnectAll()
                // The capture went with the mesh, so the button has to go back
                // to off rather than claiming a camera that is no longer
                // publishing anywhere.
                self.cameraWatchdog?.cancel()
                self.cameraWatchdog = nil
                self.localCamera = nil
                self.isCameraOn = false
                try? await voice.startAudio()
                await session?.realtime.joinVoice(
                    channelId: intendedChannel.id, declaresResume: declaresResume
                )
            }

        case .voiceWelcome(let peerId, let voiceChannelId, let existing, let selfPeer, let transport,
                           let resumed, let resumeToken, let seatCanSpeak, let seatCanStream):
            guard voiceChannelId == channelId else {
                // A `welcome` for another room means this socket joined one —
                // and the server keeps exactly one peer per socket, so ours is
                // already gone and everyone here has watched us leave. Tearing
                // down locally is the difference between an honest exit and a
                // screen still claiming to be in a channel nobody can hear us
                // in. Local only: no frame goes out, because the socket's peer
                // now belongs to whatever displaced us.
                if status != .idle {
                    wasEvicted = true
                    intendedChannel = nil
                    peers = []
                    selfPeerId = nil
                    cameraWatchdog?.cancel()
                    cameraWatchdog = nil
                    localCamera = nil
                    isCameraOn = false
                    isServerMuted = false
                    status = .failed(String(
                        localized: "You joined another voice room, so this one was left."
                    ))
                    sfuJoin?.cancel()
                    sfuJoin = nil
                    Task {
                        // The bridge belongs to the room, and the room is gone —
                        // leaving it armed would hold the App Group socket that
                        // whichever room displaced us now needs.
                        await screenShare.disarm()
                        await voice.disconnectAll()
                        await sfu.disconnect()
                    }
                }
                return
            }
            // The room's transport is pinned by the server and binding. A
            // client that cannot speak it must refuse — joining anyway puts us
            // in the roster looking permanently muted to everyone else, which
            // is worse than an honest no. We declare what we can run on join,
            // so a current server refuses us before this point; this branch is
            // the belt to that suspender.
            let plan = VoiceTransportPlan(transport: transport)
            if case .unsupported(let name) = plan {
                Task {
                    await session?.realtime.leaveVoice()
                    await voice.disconnectAll()
                }
                status = .failed(String(
                    localized: "This voice channel runs on \(name), which the iOS app cannot join yet."
                ))
                intendedChannel = nil
                return
            }
            if let resumeToken {
                resumeClaim = VoiceResumeClaim(peerId: peerId, token: resumeToken)
            }
            // Before any media is built or resumed, so a listen-only seat is
            // muted from the first packet and the SFU join below publishes
            // nothing at all.
            applySpeakRule(seatCanSpeak, stream: seatCanStream, source: .welcome)
            if plan == .livekit {
                self.transport = .livekit
                for participant in existing { roster[participant.peerId] = participant }
                Task {
                    await sfu.setRoster(existing)
                    for participant in existing {
                        if let volume = volumeByUser[participant.userId] {
                            await sfu.setVolume(volume, for: participant.peerId)
                        }
                    }
                }
                // The socket blinked and came back to the same seat, and the
                // LiveKit room never noticed. Nothing to rebuild.
                if keepsSfuSession(
                    resumed: resumed, welcomePeerId: peerId,
                    currentPeerId: selfPeerId, sfuConnected: sfuIsConnected
                ) {
                    status = .connected
                    Task { await reportVoiceState() }
                    return
                }
                selfPeerId = peerId
                // Not `.connected` yet. On this transport `welcome` is half a
                // join; the other half is media, and "Connecting" until it is
                // up is the honest state, as on the web. The share bridge is
                // armed once the media is, in `startSfuSession`: armed now it
                // would announce a share that no track can back yet.
                status = .joining
                startSfuSession(peerId: peerId, channelId: voiceChannelId)
                return
            }
            self.transport = .mesh
            selfPeerId = peerId
            status = .connected
            for participant in existing { roster[participant.peerId] = participant }
            // A mute that outlived our last socket, or was placed before we
            // walked in, arrives on `welcome` and nowhere else.
            applySelf(selfPeer)
            // The bridge only listens while there is a room to share into.
            screenShare.arm()
            Task {
                // The id only exists once the server has assigned it, and the
                // politeness rule is derived from it — so it is set here rather
                // than at configure time.
                await voice.setSelfPeerId(peerId)
                for participant in existing {
                    await voice.connect(to: participant)
                    // Without this every arriving video track classifies as a
                    // screen share. In a voice channel that happens to be right,
                    // but it is right by accident — file the announcement so the
                    // classification is the same one the web client makes.
                    await voice.setPeerCameraStreamId(
                        participant.cameraStreamId, for: participant.peerId
                    )
                    await voice.setPeerScreenAudioStreamId(
                        participant.screenAudioStreamId, for: participant.peerId
                    )
                    await voice.setServerMuted(participant.serverMuted, for: participant.peerId)
                }
                // The peer the server just minted for us starts at "unmuted,
                // undeafened", whatever this client had already decided —
                // joining with "mute on join" set is exactly that case. The
                // server expects this re-declaration after every join and
                // drops it when it says nothing new.
                await reportVoiceState()
            }

        case .voicePeerJoined(let participant):
            roster[participant.peerId] = participant
            if transport == .livekit {
                // The SFU delivers the media; this frame only names the person.
                Task {
                    await sfu.setRoster([participant])
                    if let volume = volumeByUser[participant.userId] {
                        await sfu.setVolume(volume, for: participant.peerId)
                    }
                }
                return
            }
            Task {
                await voice.connect(to: participant)
                await voice.setPeerCameraStreamId(
                    participant.cameraStreamId, for: participant.peerId
                )
                // Re-apply a remembered level for this person straight away.
                if let volume = volumeByUser[participant.userId] {
                    await voice.setVolume(volume, for: participant.peerId)
                }
                // Somebody muted elsewhere who then joins here is still muted.
                await voice.setPeerScreenAudioStreamId(
                    participant.screenAudioStreamId, for: participant.peerId
                )
                await voice.setServerMuted(participant.serverMuted, for: participant.peerId)
            }

        // A rename or a new picture mid-call. The entry is replaced and that
        // is all: `voice.connect` here would renegotiate media with a peer
        // that is already connected, for a change that never touched media.
        // Only somebody already in the roster is updated; a frame for a peer
        // this client never saw join is not an invitation to draw them.
        //
        // `serverMuted` travels on this frame too, and it is the one field that
        // does reach media: not by renegotiating, but by telling the mixer to
        // play this person at zero. Our own entry is never in `roster`, so a
        // moderator muting *us* is the frame that would otherwise be dropped
        // by the guard below.
        case .voicePeerUpdated(let participant):
            if participant.peerId == selfPeerId {
                applySelf(participant)
                return
            }
            guard roster[participant.peerId] != nil else { return }
            roster[participant.peerId] = participant
            if transport == .livekit {
                Task { await sfu.setRoster([participant]) }
            }
            applyServerMute(participant)

        case .voicePeerLeft(let peerId):
            roster[peerId] = nil
            Task {
                await voice.remove(peerId: peerId)
                await sfu.forgetPeer(peerId)
            }

        // A role or override edit mid-call. `false` is the safety half: the
        // SFU has already dropped the grant, and in a mesh room this branch is
        // the only thing that closes the microphone.
        case .voiceSpeakChanged(let voiceChannelId, let next, let nextStream):
            guard voiceChannelId == channelId, status != .idle else { return }
            applySpeakRule(next, stream: nextStream, source: .change)

        // The roster is how a share announces itself: `sharingScreen` and
        // `cameraStreamId` both arrive here, and both race the media. It is
        // also how a server mute lands on every phone at once.
        case .voiceRoster(let voiceChannelId, let participants):
            guard voiceChannelId == channelId, status == .connected else { return }
            for participant in participants {
                if participant.peerId == selfPeerId {
                    // A permission change also reaches us as a roster with our
                    // own entry re-resolved, not only as `voice-speak-changed`.
                    applySpeakRule(
                        participant.canSpeak, stream: participant.canStream, source: .change
                    )
                    applySelf(participant)
                    continue
                }
                roster[participant.peerId] = participant
                Task {
                    await voice.setPeerCameraStreamId(
                        participant.cameraStreamId, for: participant.peerId
                    )
                    await voice.setPeerScreenAudioStreamId(
                        participant.screenAudioStreamId, for: participant.peerId
                    )
                    await voice.setServerMuted(participant.serverMuted, for: participant.peerId)
                }
            }
            if transport == .livekit {
                let others = participants.filter { $0.peerId != selfPeerId }
                Task { await sfu.setRoster(others) }
            }

        case .voiceScreenShareDenied(let voiceChannelId):
            guard voiceChannelId == channelId else { return }
            Task {
                await screenShare.refuse(message: String(
                    localized: "This call already has the maximum number of screen shares."
                ))
            }

        case .voiceCameraDenied(let voiceChannelId):
            guard voiceChannelId == channelId else { return }
            Task {
                await disableCamera()
                cameraError = String(
                    localized: "This call already has the maximum number of cameras."
                )
            }

        case .voiceRoomFull(let limit):
            status = .failed(String(localized: "This voice channel is full (max \(limit))."))

        /**
         THE REJOIN WAS REFUSED, AND WE ARE HOLDING LIVE MEDIA.

         Sent when a resume could not be honoured (a permission edit during
         the gap, the 90 second window elapsed, a block) or when a cold mesh
         join cannot be relayed by this instance. Either way we are NOT in the
         room: nobody can hear us and we are in nobody's roster.

         So this hangs up rather than doing nothing, which is what it did
         before. A client that keeps a live microphone and a call screen after
         this frame is the same silent broken call as a released seat, except
         that this one lasts until the person notices nobody is answering.

         Matched against `intendedChannel` as well as `channelId`, because a
         refusal for a rejoin in flight arrives while the model still holds the
         room it is trying to get back into.
         */
        case .voiceJoinRefused(let voiceChannelId, _):
            guard status != .idle,
                  voiceChannelId == channelId || voiceChannelId == intendedChannel?.id
            else { return }
            intendedChannel = nil
            resumeClaim = nil
            status = .failed(String(
                localized: "Could not rejoin this call. Join again to come back."
            ))
            Task {
                await screenShare.disarm()
                await voice.disconnectAll()
                await sfu.disconnect()
            }
            sfuJoin?.cancel()
            sfuJoin = nil
            sfuIsConnected = false
            peers = []
            video = [:]
            selfPeerId = nil
            isCameraOn = false
            localCamera = nil

        case .voiceTransportUnsupported(let voiceChannelId, let transport, let reason):
            guard voiceChannelId == channelId else { return }
            intendedChannel = nil
            // Two different events wear this frame, and telling somebody the
            // app "cannot join" a room it was sitting in a moment ago is a
            // sentence that reads as a bug.
            //
            // Without `reason` the join was refused before a peer existed and
            // nobody saw us appear. With `promoted` we WERE seated: the room
            // moved to the voice server and the server released the seat
            // because this socket did not follow. Since this build declares
            // `voice-transport-changed`, that second case now means the two
            // ends disagree, which is a real failure and gets copy that says
            // what to do rather than copy that blames the platform.
            status = .failed(
                reason == "promoted"
                    ? String(localized: "This call became a large room and this app could not follow it. Join again to come back.")
                    : String(localized: "This voice channel runs on \(transport), which the iOS app cannot join yet.")
            )

        case .voiceTransportChanged(let voiceChannelId, let transport, let reason, let participants):
            followPromotion(
                voiceChannelId: voiceChannelId, transport: transport,
                reason: reason, participants: participants
            )

        // Mesh signalling. The server drops these in an SFU room, and so does
        // this client: a peer connection built here would be to nobody.
        case .voiceOffer(let from, let sdp):
            guard transport != .livekit else { return }
            Task { await voice.handleOffer(from: from, sdp: sdp) }

        case .voiceAnswer(let from, let sdp):
            guard transport != .livekit else { return }
            Task { await voice.handleAnswer(from: from, sdp: sdp) }

        case .voiceCandidate(let from, let payload):
            guard transport != .livekit else { return }
            Task { await voice.handleCandidate(from: from, payload: payload) }

        default:
            break
        }
    }

    // MARK: - SFU

    /// The media half of a LiveKit join: a token for the peer id `welcome`
    /// minted, then the room. One clock over both, and one outcome.
    ///
    /// **Never a mesh instead.** If the token call fails, the room refuses, or
    /// `sfuJoinTimeout` runs out, this leaves the WS room and says so. The rest
    /// of the call is on the SFU and would neither hear a mesh peer nor see it
    /// drop out; that silent split is the bug `docs/voice-backends.md` "One
    /// room, one transport" exists to make impossible.
    ///
    /// `promoted` is the mid-call version of the same work (`followPromotion`).
    /// It changes two things and nothing else. The status this expects to still
    /// be holding is `.connected` rather than `.joining`, because a promotion
    /// never left the call; and on success the capture that was running on the
    /// mesh is started again on the SFU, which is what makes the move a handover
    /// rather than a camera and a share that quietly went off.
    private func startSfuSession(peerId: String, channelId: String, promoted: Bool = false) {
        let expected: VoiceStatus = promoted ? .connected : .joining
        // WHAT WAS SWITCHED ON, READ AND THEN CLEARED IN ONE PLACE.
        //
        // The reading has to happen before `connectSfu` tears the mesh down,
        // because the capture goes with it, and the clearing has to happen
        // after the reading or the intent is gone before anybody looked at it.
        // Those two lines being adjacent is the whole invariant: an earlier
        // version cleared the camera flag in `followPromotion` and read it
        // here, so a promotion always turned the camera off and never back on,
        // and nothing said a word about it.
        let hadCamera = promoted && isCameraOn
        let wasSharing = promoted && screenShare.isSharing
        if promoted {
            // The button goes back to off rather than claiming a capture that
            // is about to be destroyed with the mesh. It comes back on below
            // once the SFU room is up.
            cameraWatchdog?.cancel()
            cameraWatchdog = nil
            localCamera = nil
            isCameraOn = false
        }
        sfuJoin?.cancel()
        sfuJoin = Task { [weak self] in
            guard let self else { return }
            let outcome: Result<Void, SfuJoinError>
            do {
                try await withSfuTimeout {
                    try await self.connectSfu(peerId: peerId, channelId: channelId)
                }
                outcome = .success(())
            } catch let error as SfuJoinError {
                outcome = .failure(error)
            } catch {
                outcome = .failure(.connect(String(describing: error)))
            }
            // A leave, or a displacement, that landed while this was in flight
            // has already reset the model. Nothing here may write over it.
            guard !Task.isCancelled, self.selfPeerId == peerId, self.status == expected else {
                if case .success = outcome { await self.sfu.disconnect() }
                return
            }
            switch outcome {
            case .success:
                self.sfuIsConnected = true
                self.status = .connected
                // Media is up, so a share now has a room to land in. A no-op
                // on the promoted path: the bridge was armed for the mesh and
                // `arm()` is idempotent, which is exactly what keeps a live
                // broadcast from being interrupted by the move.
                self.screenShare.arm()
                await self.reportVoiceState()
                if wasSharing {
                    // The broadcast never stopped and the bridge never stopped
                    // delivering, but the track those frames were going into
                    // died with the mesh. Creating the SFU one is all that is
                    // needed: `pushScreenFrame` publishes on the first frame,
                    // and the next one is milliseconds away.
                    _ = await self.sfu.startScreenShare(
                        quality: VideoQualitySettings.shared.quality
                    )
                    await self.session?.realtime.setSharingScreen(true)
                }
                if hadCamera {
                    // A fresh capture on the SFU. Cannot be handed over: the
                    // mesh capture belongs to the WebRTC framework and this one
                    // to LiveKit's, and the two never hold the device at once.
                    await self.enableCamera()
                }
            case .failure(let error):
                guard let message = sfuFailureMessage(error) else { return }
                // EXACTLY THE BEHAVIOUR THIS APP HAD BEFORE IT FOLLOWED
                // PROMOTIONS, which is the point: leave, and say so. The rest
                // of the room is on the voice server and would neither hear a
                // mesh peer nor see it drop out, so rebuilding the mesh would
                // leave this person alone in a call that looks fine. Only the
                // sentence differs, because "you have not joined this call" is
                // false about a call somebody was in a moment ago.
                self.transportNotice = nil
                self.intendedChannel = nil
                self.resumeClaim = nil
                self.status = .failed(promoted ? sfuPromotionFailureMessage() : message)
                await self.session?.realtime.leaveVoice()
                await self.sfu.disconnect()
                self.sfuIsConnected = false
                self.peers = []
                self.video = [:]
                self.selfPeerId = nil
            }
        }
    }

    /**
     THE ROOM MOVED AND WE MOVE WITH IT, KEEPING THE SEAT.

     Not a rejoin. The seat, the peer id and everyone else's view of us are
     unchanged, so there is no leave and no arrival: only the media path is
     rebuilt, from the participant list the frame carried rather than from a
     roster we would otherwise have to wait for.

     The order matters. The roster and the transport are written first, so a
     `voice-roster` arriving during the reconnect is read as an SFU room; the
     local camera flags are cleared next, because `connectSfu` tears the mesh
     down and the capture goes with it and a button still claiming "on" would
     be lying; and `startSfuSession(promoted:)` restarts whatever was running
     once the room is up.

     Status stays `.connected` throughout, matching `use-voice.ts`. Dropping to
     `.joining` for a second would be honest about the media and dishonest
     about the call: nobody left, nobody has to do anything, and the stage
     flashing "Connecting" is how a working promotion reads as a dropped call.
     */
    private func followPromotion(
        voiceChannelId: String, transport: String, reason: String?,
        participants: [VoiceParticipant]
    ) {
        guard case .follow(let next) = voicePromotionAction(
            frameChannelId: voiceChannelId,
            frameTransport: transport,
            currentChannelId: channelId,
            currentTransport: self.transport,
            isLive: status == .connected,
            selfPeerId: selfPeerId
        ) else { return }
        guard let peerId = selfPeerId else { return }
        self.transport = next
        transportNotice = voicePromotionNotice(reason: reason)
        // Self included in this frame, unlike `welcome.peers`, so it is
        // filtered out here: `roster` holds other people, and our own entry
        // going in would draw us as a second tile in our own call.
        let others = participants.filter { $0.peerId != peerId }
        for participant in others { roster[participant.peerId] = participant }
        // The local camera and share flags are deliberately NOT touched here.
        // `startSfuSession(promoted:)` reads what was switched on and clears it
        // in the same breath, which is the only ordering that cannot lose it.
        Task {
            await sfu.setRoster(others)
            for participant in others {
                if let volume = volumeByUser[participant.userId] {
                    await sfu.setVolume(volume, for: participant.peerId)
                }
            }
        }
        startSfuSession(peerId: peerId, channelId: voiceChannelId, promoted: true)
    }

    private func connectSfu(peerId: String, channelId: String) async throws {
        guard let session else { throw SfuJoinError.superseded }
        // The mesh's audio session is released first: two WebRTC builds each
        // holding `AVAudioSession` is a fight the SDK that publishes should win
        // outright, and the mic track the mesh created is not the one that goes
        // on the wire here.
        await voice.disconnectAll()
        sfuIsConnected = false
        let info: VoiceSessionInfo
        do {
            info = try await session.api.post(
                "/api/voice/token",
                body: VoiceSessionRequest(voiceChannelId: channelId, peerId: peerId)
            )
        } catch {
            throw SfuJoinError.token((error as? APIError)?.errorDescription ?? error.localizedDescription)
        }
        try Task.checkCancellation()
        try await sfu.connect(
            info, muted: isMuted || isDeafened, speaker: isSpeakerOn, publishMicrophone: canSpeak,
            iceServers: iceServers
        )
        if isDeafened { await sfu.setDeafened(true) }
    }
}
