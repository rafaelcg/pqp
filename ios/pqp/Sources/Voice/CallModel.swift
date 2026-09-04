import Foundation
import Observation
import AVFoundation
import CoreVideo
import QuartzCore
import WebRTC

/// Owns the one DM call this device can be in.
///
/// A conversation call is a voice room on the conversation's channel id — same
/// join, same mesh, same signalling as a server voice channel — plus a *ring*:
/// the caller joins first and tells the server to buzz everyone who is not in
/// the room yet. That is the whole difference, and it is why this is a separate
/// model from `VoiceModel` rather than a mode of it: a voice channel is a place
/// you walk into, a call is something that happens *to* you, so its state has to
/// outlive whichever screen you are looking at.
///
/// Long-lived and app-wide, therefore: it is injected at the root and holds its
/// realtime handler for the whole session, because `call-incoming` has to be
/// caught wherever the user is.
@MainActor
@Observable
final class CallModel {
    /// `didSet` rather than a line in `hangUp`, because a call has more endings
    /// than it has handlers: hanging up, the far end leaving, a ring that ran
    /// out, being displaced by another voice room. Every one of them moves the
    /// phase, so that is where the rating hangs.
    private(set) var phase: CallPhase = .idle {
        didSet {
            guard phase != oldValue else { return }
            if phase.isInRoom {
                noteCallProgress()
            } else if oldValue.isInRoom {
                endCallRating()
            }
        }
    }
    private(set) var conversationId: String?
    /// Who we are talking to, for the avatars and the title. Synthesised from
    /// the ring when we answer a call for a conversation this device has never
    /// opened.
    private(set) var conversation: DmSummary?
    private(set) var peers: [VoicePeerState] = [] {
        didSet { noteCallProgress() }
    }
    /// Per-peer incoming video, already sorted into camera vs screen share by
    /// `VoiceClient`. Screen shares are view-only on iOS — see `toggleCamera`.
    private(set) var video: [String: PeerVideo] = [:] {
        didSet { noteCallProgress() }
    }
    /// Our own capture, for the self preview. Never sent to a renderer twice.
    private(set) var localCamera: RTCVideoTrack?
    /// Rings arriving at this device, oldest first. Not call state of ours until
    /// one is accepted, so it survives starting/ending unrelated calls.
    private(set) var incoming: [IncomingCall] = []
    private(set) var declinedUserIds: Set<String> = []
    /// When the *conversation* became a call — i.e. when somebody else arrived.
    /// Ringing has no duration worth showing.
    private(set) var startedAt: Date?
    private(set) var selfPeerId: String?
    private(set) var errorMessage: String?
    private(set) var isCameraOn = false
    /// The roster, by peer id: mute badges and the screen-share flag.
    private(set) var roster: [String: VoiceParticipant] = [:]
    /// Outgoing screen share, driven by the ReplayKit bridge.
    let screenShare = ScreenShareController()

    var isMuted = false {
        didSet {
            guard isMuted != oldValue else { return }
            Task {
                await voice.setMuted(isMuted)
                await session?.realtime.setVoiceState(muted: isMuted, deafened: false)
            }
        }
    }

    /// Speaker or earpiece. A DM call is the one place on this platform where
    /// the earpiece is a reasonable default — but the far end is often on a
    /// laptop, so it stays a control rather than a guess.
    var isSpeakerOn = true {
        didSet {
            guard isSpeakerOn != oldValue else { return }
            Task { await voice.setSpeaker(isSpeakerOn) }
        }
    }

    /// Tucked into a banner so the chat underneath can be read. Session-scoped
    /// and deliberately not persisted: "let me read this during THIS call" is
    /// not an account setting.
    var isCollapsed = false

    private let voice = VoiceClient()
    private var session: SessionStore?
    private static let handlerKey = "dm-call"
    /// Send `call-ring` when `welcome` lands — set only for a call we placed.
    private var ringOnWelcome = false
    /// The camera the user asked for before the room existed (the video button).
    private var wantsCamera = false
    /// Peers the server says are in the room. `peers` is the *mesh's* view and
    /// arrives a beat later; this is what decides "did everyone leave".
    private var knownPeerIds: Set<String> = []
    private var ringTimeout: Task<Void, Never>?
    private var endedReset: Task<Void, Never>?
    /// Accumulates the shape of the call while it runs. Ignored by Observation
    /// on purpose: it changes on nearly every peer event and nothing should
    /// redraw because a high-water mark moved.
    @ObservationIgnored private var ratingTracker = CallRatingTracker()
    @ObservationIgnored private weak var ratings: CallRatingModel?

    // MARK: - Lifecycle

    /// Register the one long-lived handler. Idempotent: called from the root
    /// view's `task`, which re-runs on every re-entry into the signed-in shell.
    func attach(session: SessionStore, ratings: CallRatingModel? = nil) {
        self.session = session
        if let ratings { self.ratings = ratings }
        configureScreenShare()
        session.eventHandlers[Self.handlerKey] = { [weak self] event in
            self?.apply(event)
        }
    }

    /// Place a call. `withVideo` opens the camera as soon as the room exists.
    func start(conversation: DmSummary, withVideo: Bool) async {
        guard !phase.isLive else { return }
        reset()
        self.conversation = conversation
        conversationId = conversation.channelId
        ringOnWelcome = true
        wantsCamera = withVideo
        phase = .connecting
        await connect()
    }

    /// Answer a ring. There is no accept frame — joining the room *is* the
    /// answer, and the server reads it as one (`noteConversationCallJoin`).
    func accept(_ call: IncomingCall, withVideo: Bool) async {
        dismiss(call.conversationId)
        guard !phase.isLive else { return }
        reset()
        conversationId = call.conversationId
        // Enough of a conversation to draw the stage. The chat screen has the
        // real summary when it is open; answering from the servers tab does not.
        conversation = DmSummary(
            channelId: call.conversationId,
            kind: call.kind,
            participants: [PublicUser(
                id: call.callerUserId,
                displayName: call.callerName,
                username: nil,
                tag: nil,
                avatarUrl: call.callerAvatarUrl
            )],
            lastMessageAt: nil,
            unread: DmUnread(count: 0, mentions: 0)
        )
        ringOnWelcome = false
        wantsCamera = withVideo
        phase = .connecting
        await connect()
    }

    /// Refuse a ring. The caller stops waiting for us and our other devices stop
    /// ringing; the call itself continues for anyone else in it.
    func decline(_ call: IncomingCall) async {
        await session?.realtime.declineCall(conversationId: call.conversationId)
        dismiss(call.conversationId)
    }

    /// Drop the banner on this device only. No frame — everyone else keeps
    /// ringing and the call stays joinable from the conversation.
    func dismiss(_ conversationId: String) {
        incoming.removeAll { $0.conversationId == conversationId }
    }

    func hangUp(reason: String? = nil) async {
        guard conversationId != nil else { return }
        ringTimeout?.cancel()
        ringTimeout = nil
        if isCameraOn {
            await session?.realtime.setCamera(streamId: nil)
        }
        // Unpublishes and stops listening. The *broadcast* is not ours to stop —
        // it is a system recording — but the track it feeds dies with the call,
        // and iOS keeps showing its own red indicator either way.
        await screenShare.disarm()
        await session?.realtime.leaveVoice()
        await voice.disconnectAll()
        clearCallState()
        phase = .ended(reason)
        // The closing sentence needs a moment to be read; then the stage goes
        // away on its own rather than leaving a dead screen to dismiss.
        endedReset?.cancel()
        endedReset = Task { [weak self] in
            try? await Task.sleep(for: .seconds(reason == nil ? 0.6 : 1.6))
            guard !Task.isCancelled, let self else { return }
            if case .ended = self.phase { self.phase = .idle }
        }
    }

    // MARK: - Controls

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
        guard phase == .active || phase == .ringing else { return }
        guard await Self.requestCamera() else {
            errorMessage = String(localized: "Camera access is off. Enable it in Settings.")
            return
        }
        guard let started = await voice.startCamera() else {
            errorMessage = String(localized: "Could not start the camera.")
            return
        }
        localCamera = started.track.value
        isCameraOn = true
        errorMessage = nil
        await voice.setVideoMode(true)
        // The announcement is what lets the far end file the arriving track as a
        // face rather than a screen. Sent after the track is published rather
        // than before, because the capture id does not exist until then — the
        // receiver's roster re-check (`setPeerCameraStreamId`) is what makes
        // either ordering correct.
        await session?.realtime.setCamera(streamId: started.streamId)
    }

    private func disableCamera() async {
        isCameraOn = false
        localCamera = nil
        // Told before the track goes: a peer that sees the stream vanish with no
        // announcement reclassifies it as a screen share and draws a frozen frame.
        await session?.realtime.setCamera(streamId: nil)
        await voice.stopCamera()
        await voice.setVideoMode(false)
    }

    // MARK: - Derived, for the stage

    /// Whether this call belongs to a given chat screen.
    func isCurrent(_ channelId: String) -> Bool {
        conversationId == channelId && phase.isLive
    }

    /// Screens currently on the wire. The server caps concurrent shares (two
    /// on mesh, four on LiveKit); the phone still shows one at a time.
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

    /// Whose screen it is, for the presenter line.
    var presenterName: String? {
        guard let focused = resolvedScreenFocus else { return nil }
        return screenPresenters.first(where: { $0.peerId == focused })?.name
    }

    func focusScreen(_ peerId: String) {
        focusedScreenPeerId = peerId
    }

    var layout: CallStageLayout {
        callStageLayout(remoteCount: peers.count, hasScreenShare: remoteScreen != nil)
    }

    var title: String {
        conversation?.title ?? String(localized: "Call")
    }

    /// The person on the other end of a 1:1, for the ring avatar.
    var counterpart: PublicUser? { conversation?.participants.first }

    func camera(for peerId: String) -> RTCVideoTrack? { video[peerId]?.camera }

    func isMuted(_ peerId: String) -> Bool { roster[peerId]?.muted ?? false }

    // MARK: - Joining

    private func connect() async {
        guard let session, let conversationId else { return }
        guard await Self.requestMicrophone() else {
            fail(String(localized: "Microphone access is off. Enable it in Settings to call."))
            return
        }
        // Asked for before the room exists so the permission sheet is not the
        // first thing that happens *during* a live call.
        if wantsCamera {
            _ = await Self.requestCamera()
        }
        do {
            let ice: IceServersResponse = try await session.api.get("/api/ice-servers")
            try await voice.startAudio()
            // "Mute microphone when joining voice" covers a DM call too, which
            // is how the web client reads it: `handleConversationCall` passes
            // the same `startMuted` its voice-channel join does. Applied
            // between the track existing and the room being joined; the
            // re-declaration on `welcome` is what tells the other end.
            isMuted = session.preferences.muteOnJoin ?? false
            await voice.setMuted(isMuted)
            await voice.setSpeaker(isSpeakerOn)
            await voice.configure(
                selfPeerId: "",
                iceServers: ice.iceServers,
                onStateChange: { [weak self] states in
                    Task { @MainActor in self?.peers = states }
                },
                signal: { [weak self] signal in
                    Task { @MainActor in await self?.relay(signal) }
                },
                onVideoChange: { [weak self] video in
                    Task { @MainActor in self?.video = video }
                },
                onSendStats: { snapshot in
                    Task { @MainActor in VideoSendReport.shared.apply(snapshot) }
                }
            )
            await voice.setVideoQuality(VideoQualitySettings.shared.quality)
            // Registered rather than observed in a view, because the one screen
            // that could observe it is routinely not on screen: a collapsed call
            // is still publishing a camera behind a chat transcript.
            VideoQualitySettings.shared.addListener(Self.handlerKey) { [weak self] quality in
                guard let self else { return }
                Task { await self.voice.setVideoQuality(quality) }
            }
            await session.realtime.joinVoice(channelId: conversationId)
        } catch {
            fail((error as? APIError)?.errorDescription ?? error.localizedDescription)
        }
    }

    /// One moment of this call, for the rating that may follow it.
    ///
    /// The clock starts when we are actually in the room, not at `.connecting`:
    /// that phase is the microphone sheet and an ICE fetch, and counting it
    /// would let a slow permission prompt push a ten-second call over the
    /// one-minute gate.
    private var ratingSnapshot: CallSnapshot {
        CallSnapshot(
            peerCount: peers.count,
            // The DM room is mesh like every other room this app joins.
            usingSfu: false,
            screenSharing: remoteScreen != nil || screenShare.isSharing,
            channelId: conversationId
        )
    }

    private func noteCallProgress() {
        guard phase.isInRoom else { return }
        ratingTracker.observe(ratingSnapshot)
    }

    private func endCallRating() {
        ratings?.finish(&ratingTracker)
    }

    /// Wires the ReplayKit bridge to the mesh. See `VoiceModel` for the twin —
    /// the two rooms differ in everything but this.
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

    // MARK: - Events

    private func apply(_ event: RealtimeEvent) {
        switch event {
        // --- ringing, which arrives whether or not we are in a call ---
        case .callIncoming(let call):
            // Already in this exact call on this device: there is nothing to
            // answer, and a banner over your own call is nonsense.
            if conversationId == call.conversationId, phase.isLive { return }
            guard !incoming.contains(where: { $0.conversationId == call.conversationId })
            else { return }
            incoming.append(call)
            // Belt to the server's own 45s timer: if the cancellation frame is
            // lost to a reconnect, the banner must still go away.
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(callRingTimeout + 2))
                self?.dismiss(call.conversationId)
            }

        case .callRingCancelled(let conversationId, _):
            dismiss(conversationId)

        case .callDeclined(let conversationId, let userId):
            guard conversationId == self.conversationId else { return }
            declinedUserIds.insert(userId)
            // A 1:1 with the only callee refusing is over. In a group the call
            // stands — the others may still pick up.
            if conversation?.kind != "group", phase == .ringing {
                Task { await self.hangUp(reason: CallEndReason.declined) }
            }

        // --- the room ---
        case .ready:
            // The socket came back and the server dropped our peer with it. A
            // reconnect mints a new peer id, so the mesh is unusable and is
            // rebuilt rather than resumed. The ring is NOT re-sent: the server
            // refuses a second one, and the far end never stopped ringing.
            guard let conversationId, phase.isLive else { return }
            Task {
                await voice.disconnectAll()
                self.localCamera = nil
                self.isCameraOn = false
                try? await voice.startAudio()
                await session?.realtime.joinVoice(channelId: conversationId)
            }

        case .voiceWelcome(let peerId, let voiceChannelId, let existing, _, let transport):
            guard voiceChannelId == conversationId else {
                // A `welcome` for somewhere else means this socket joined
                // another voice room, and the server keeps exactly one peer per
                // socket (`socketToPeerId`) — so our call's peer has already
                // been dropped and everyone else has seen us leave. Ending it
                // here is the difference between an honest hang-up and a stage
                // that keeps showing a call nobody is in.
                if phase.isLive {
                    Task { await self.hangUp(reason: CallEndReason.ended) }
                }
                return
            }
            // The room's transport is the server's to pin and binding on us.
            // We declare `transports: ["mesh"]` at join so a current server
            // refuses us before a peer exists; this is the belt to that suspender.
            if let transport, transport != "mesh" {
                Task {
                    await session?.realtime.leaveVoice()
                    await voice.disconnectAll()
                }
                fail(String(localized: "This call runs on \(transport), which the iOS app cannot join yet."))
                return
            }
            selfPeerId = peerId
            screenShare.arm()
            knownPeerIds = Set(existing.map(\.peerId))
            for participant in existing { roster[participant.peerId] = participant }
            if existing.isEmpty {
                phase = .ringing
            } else {
                phase = .active
                startedAt = startedAt ?? Date()
            }
            let shouldRing = ringOnWelcome
            ringOnWelcome = false
            Task {
                await voice.setSelfPeerId(peerId)
                for participant in existing {
                    await voice.connect(to: participant)
                    await voice.setPeerCameraStreamId(
                        participant.cameraStreamId, for: participant.peerId
                    )
                }
                if shouldRing {
                    await session?.realtime.ringCall(conversationId: voiceChannelId)
                }
                await session?.realtime.setVoiceState(muted: isMuted, deafened: false)
                if wantsCamera, !isCameraOn {
                    wantsCamera = false
                    await enableCamera()
                }
            }
            if shouldRing { startRingTimeout() }

        case .voicePeerJoined(let participant):
            guard phase.isLive else { return }
            knownPeerIds.insert(participant.peerId)
            roster[participant.peerId] = participant
            ringTimeout?.cancel()
            ringTimeout = nil
            phase = .active
            startedAt = startedAt ?? Date()
            Task {
                await voice.connect(to: participant)
                await voice.setPeerCameraStreamId(
                    participant.cameraStreamId, for: participant.peerId
                )
            }

        case .voicePeerLeft(let peerId):
            guard phase.isLive else { return }
            knownPeerIds.remove(peerId)
            roster[peerId] = nil
            Task { await voice.remove(peerId: peerId) }
            // The last person left. A 1:1 with nobody on the other end is over —
            // sitting on an empty stage waiting for a rejoin that has no reason
            // to come is the worse of the two guesses.
            if knownPeerIds.isEmpty, phase == .active {
                Task { await self.hangUp(reason: CallEndReason.ended) }
            }

        case .voiceRoster(let voiceChannelId, let participants):
            guard voiceChannelId == conversationId, phase.isLive else { return }
            for participant in participants where participant.peerId != selfPeerId {
                roster[participant.peerId] = participant
                Task {
                    await voice.setPeerCameraStreamId(
                        participant.cameraStreamId, for: participant.peerId
                    )
                }
            }

        case .voiceRoomFull(let limit):
            guard phase.isLive else { return }
            fail(String(localized: "This call is full (max \(limit))."))

        case .voiceScreenShareDenied(let voiceChannelId):
            guard voiceChannelId == conversationId else { return }
            Task {
                await screenShare.refuse(message: String(
                    localized: "This call already has the maximum number of screen shares."
                ))
            }

        case .voiceCameraDenied(let voiceChannelId):
            guard voiceChannelId == conversationId else { return }
            Task {
                await disableCamera()
                errorMessage = String(
                    localized: "This call already has the maximum number of cameras."
                )
            }

        case .voiceTransportUnsupported(let voiceChannelId, let transport):
            guard voiceChannelId == conversationId else { return }
            fail(String(localized: "This call runs on \(transport), which the iOS app cannot join yet."))

        case .voiceOffer(let from, let sdp):
            guard phase.isLive else { return }
            Task { await voice.handleOffer(from: from, sdp: sdp) }

        case .voiceAnswer(let from, let sdp):
            guard phase.isLive else { return }
            Task { await voice.handleAnswer(from: from, sdp: sdp) }

        case .voiceCandidate(let from, let payload):
            guard phase.isLive else { return }
            Task { await voice.handleCandidate(from: from, payload: payload) }

        default:
            break
        }
    }

    /// The caller's own 45s clock.
    ///
    /// The server ends the ring at `CALL_RING_TIMEOUT_MS` and records a missed
    /// call, but it only tells the people it *rang* — `endConversationRing`
    /// notifies `ring.rung`, which never includes the caller. Without this the
    /// calling side sits on "Calling…" forever.
    private func startRingTimeout() {
        ringTimeout?.cancel()
        ringTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(callRingTimeout))
            guard !Task.isCancelled, let self, self.phase == .ringing else { return }
            await self.hangUp(reason: CallEndReason.noAnswer)
        }
    }

    private func fail(_ message: String) {
        errorMessage = message
        Task { await hangUp(reason: message) }
    }

    /// Everything about the call itself. `incoming` is deliberately spared: a
    /// second person ringing while this call ends is a separate invitation.
    private func clearCallState() {
        VideoQualitySettings.shared.removeListener(Self.handlerKey)
        VideoSendReport.shared.clear()
        conversationId = nil
        conversation = nil
        peers = []
        video = [:]
        roster = [:]
        localCamera = nil
        isCameraOn = false
        selfPeerId = nil
        knownPeerIds = []
        declinedUserIds = []
        startedAt = nil
        isCollapsed = false
        isMuted = false
        wantsCamera = false
        ringOnWelcome = false
    }

    private func reset() {
        endedReset?.cancel()
        clearCallState()
        errorMessage = nil
        phase = .idle
    }

    // MARK: - Permissions

    private static func requestMicrophone() async -> Bool {
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

    private static func requestCamera() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .denied, .restricted: return false
        default: return await AVCaptureDevice.requestAccess(for: .video)
        }
    }
}
