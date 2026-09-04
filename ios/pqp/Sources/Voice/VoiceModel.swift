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

/// Owns a voice session: mic permission, the room, and the mesh underneath it.
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
    private(set) var localCamera: RTCVideoTrack?
    private(set) var isCameraOn = false
    /// A refusal worth putting in front of somebody: permission, or a camera
    /// that would not open. Cleared by the next successful toggle.
    private(set) var cameraError: String?
    /// The roster by peer id: who is muted, and who is presenting.
    private(set) var roster: [String: VoiceParticipant] = [:]
    /// Outgoing screen share, driven by the ReplayKit bridge.
    let screenShare = ScreenShareController()
    var isMuted = false {
        didSet {
            Task {
                await voice.setMuted(isMuted)
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
        didSet { Task { await voice.setSpeaker(isSpeakerOn) } }
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

    var screenPresenters: [(peerId: String, name: String, track: RTCVideoTrack)] {
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

    var remoteScreen: RTCVideoTrack? {
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

    // MARK: - Camera
    //
    // The same three calls `CallModel` makes for a DM call, against the same
    // `VoiceClient`. The mesh never cared which kind of room it was carrying;
    // what was missing was a screen with a button on it.

    func camera(for peerId: String) -> RTCVideoTrack? { video[peerId]?.camera }

    /// Everyone whose camera is on, in roster order, so the tiles do not
    /// reshuffle every time somebody starts speaking.
    var cameraPeers: [VoicePeerState] {
        peers.filter { video[$0.peerId]?.camera != nil }
    }

    /// Whether there is any picture of a person to show, ours included.
    var hasCameras: Bool { isCameraOn || !cameraPeers.isEmpty }

    func toggleCamera() async {
        if isCameraOn {
            await disableCamera()
        } else {
            await enableCamera()
        }
    }

    func flipCamera() async {
        await voice.flipCamera()
    }

    private func enableCamera() async {
        guard status == .connected else { return }
        guard await Self.requestCamera() else {
            cameraError = String(localized: "Camera access is off. Enable it in Settings.")
            return
        }
        guard let started = await voice.startCamera() else {
            cameraError = String(localized: "Could not start the camera.")
            return
        }
        localCamera = started.track.value
        isCameraOn = true
        cameraError = nil
        await voice.setVideoMode(true)
        // The announcement is what lets everyone file the arriving track as a
        // face rather than a screen. Sent after publishing because the stream id
        // does not exist until then; the roster re-check on the receiving side
        // (`setPeerCameraStreamId`) is what makes either ordering correct.
        await session?.realtime.setCamera(streamId: started.streamId)
    }

    private func disableCamera() async {
        isCameraOn = false
        localCamera = nil
        // Told before the track goes: a peer that watches the stream vanish with
        // no announcement reclassifies it as a screen share and draws the last
        // frame of your face forever.
        await session?.realtime.setCamera(streamId: nil)
        await voice.stopCamera()
        await voice.setVideoMode(false)
    }

    private static func requestCamera() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .denied, .restricted: return false
        default: return await AVCaptureDevice.requestAccess(for: .video)
        }
    }

    func join(channel: Channel, session: SessionStore, ratings: CallRatingModel? = nil) async {
        self.session = session
        self.ratings = ratings
        configureScreenShare()
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
            await session.realtime.joinVoice(channelId: channel.id)
        } catch {
            status = .failed((error as? APIError)?.errorDescription ?? error.localizedDescription)
        }
    }

    func leave() async {
        await screenShare.disarm()
        intendedChannel = nil
        VideoQualitySettings.shared.removeListener(handlerKey)
        VideoSendReport.shared.clear()
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
        status = .idle
        channelId = nil
        channelName = nil
        peers = []
        video = [:]
        roster = [:]
        selfPeerId = nil
        isMuted = false
        isDeafened = false
        localCamera = nil
        isCameraOn = false
        cameraError = nil
    }

    /// One moment of this call, for the rating that may follow it.
    ///
    /// `peerCount` excludes us, matching the web's `remotePeers.length`, and the
    /// screen-share flag counts anybody's screen including our own: the question
    /// it eventually answers is "was a screen being shared", not "whose".
    private var ratingSnapshot: CallSnapshot {
        CallSnapshot(
            peerCount: peers.count,
            // This app declares `transports: ["mesh"]` and refuses a room pinned
            // to anything else, so a connected call is always a mesh call.
            usingSfu: false,
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

    /// Wires the bridge to the mesh. Both directions are here rather than in the
    /// controller so the controller stays about *when* to share, not how.
    private func configureScreenShare() {
        screenShare.configure(
            onFrame: { [weak self] buffer, rotation in
                guard let self else { return }
                let timestamp = Int64(CACurrentMediaTime() * 1_000_000_000)
                Task {
                    await self.voice.pushScreenFrame(
                        buffer, rotation: rotation, timeStampNs: timestamp
                    )
                }
            },
            onStart: { [weak self] in
                guard let self else { return }
                // Announced first, matching the web client: the roster flag is
                // what draws "X is presenting", and the track behind it takes a
                // renegotiation to arrive.
                await self.session?.realtime.setSharingScreen(true)
                _ = await self.voice.startScreenShare()
                // Our own share never touches `video`, which is the far end's
                // tracks, so this is the only place it can be recorded.
                self.noteCallProgress()
            },
            onStop: { [weak self] in
                guard let self else { return }
                await self.session?.realtime.setSharingScreen(false)
                await self.voice.stopScreenShare()
            }
        )
    }

    func setVolume(_ volume: Double, for peer: VoicePeerState) {
        volumeByUser[peer.userId] = volume
        Task { await voice.setVolume(volume, for: peer.peerId) }
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
            Task {
                await voice.disconnectAll()
                // The capture went with the mesh, so the button has to go back
                // to off rather than claiming a camera that is no longer
                // publishing anywhere.
                self.localCamera = nil
                self.isCameraOn = false
                try? await voice.startAudio()
                await session?.realtime.joinVoice(channelId: intendedChannel.id)
            }

        case .voiceWelcome(let peerId, let voiceChannelId, let existing, _, let transport):
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
                    localCamera = nil
                    isCameraOn = false
                    status = .failed(String(
                        localized: "You joined another voice room, so this one was left."
                    ))
                    Task {
                        // The bridge belongs to the room, and the room is gone —
                        // leaving it armed would hold the App Group socket that
                        // whichever room displaced us now needs.
                        await screenShare.disarm()
                        await voice.disconnectAll()
                    }
                }
                return
            }
            // The room's transport is pinned by the server and binding. A
            // client that cannot speak it must refuse — joining anyway puts us
            // in the roster looking permanently muted to everyone else, which
            // is worse than an honest no. Absent means a pre-SFU server, which
            // is mesh by definition. We declare `transports: ["mesh"]` on join,
            // so a current server refuses us before this point; this branch is
            // the belt to that suspender.
            if let transport, transport != "mesh" {
                Task {
                    await session?.realtime.leaveVoice()
                    await voice.disconnectAll()
                }
                status = .failed(String(
                    localized: "This voice channel runs on \(transport), which the iOS app cannot join yet."
                ))
                intendedChannel = nil
                return
            }
            selfPeerId = peerId
            status = .connected
            for participant in existing { roster[participant.peerId] = participant }
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
            Task {
                await voice.connect(to: participant)
                await voice.setPeerCameraStreamId(
                    participant.cameraStreamId, for: participant.peerId
                )
                // Re-apply a remembered level for this person straight away.
                if let volume = volumeByUser[participant.userId] {
                    await voice.setVolume(volume, for: participant.peerId)
                }
            }

        // A rename or a new picture mid-call. The entry is replaced and that
        // is all: `voice.connect` here would renegotiate media with a peer
        // that is already connected, for a change that never touched media.
        // Only somebody already in the roster is updated; a frame for a peer
        // this client never saw join is not an invitation to draw them.
        case .voicePeerUpdated(let participant):
            guard roster[participant.peerId] != nil else { return }
            roster[participant.peerId] = participant

        case .voicePeerLeft(let peerId):
            roster[peerId] = nil
            Task { await voice.remove(peerId: peerId) }

        // The roster is how a share announces itself: `sharingScreen` and
        // `cameraStreamId` both arrive here, and both race the media.
        case .voiceRoster(let voiceChannelId, let participants):
            guard voiceChannelId == channelId, status == .connected else { return }
            for participant in participants where participant.peerId != selfPeerId {
                roster[participant.peerId] = participant
                Task {
                    await voice.setPeerCameraStreamId(
                        participant.cameraStreamId, for: participant.peerId
                    )
                }
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

        case .voiceTransportUnsupported(let voiceChannelId, let transport):
            guard voiceChannelId == channelId else { return }
            // Refused before a peer ever existed — nobody saw us appear.
            intendedChannel = nil
            status = .failed(String(
                localized: "This voice channel runs on \(transport), which the iOS app cannot join yet."
            ))

        case .voiceOffer(let from, let sdp):
            Task { await voice.handleOffer(from: from, sdp: sdp) }

        case .voiceAnswer(let from, let sdp):
            Task { await voice.handleAnswer(from: from, sdp: sdp) }

        case .voiceCandidate(let from, let payload):
            Task { await voice.handleCandidate(from: from, payload: payload) }

        default:
            break
        }
    }
}
