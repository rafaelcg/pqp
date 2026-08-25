import Foundation
import AVFoundation
import CoreVideo
import WebRTC

/// One remote participant's connection state, as the UI needs it.
struct VoicePeerState: Identifiable, Hashable, Sendable {
    let peerId: String
    var displayName: String
    var userId: String
    var connection: String
    /// The roster carries it; the tile draws it. Optional and untrusted — a
    /// nil or unusable value is the monogram, never a broken frame.
    var avatarUrl: String?
    var isSpeaking: Bool = false
    var volume: Double = 1

    var id: String { peerId }
}

/// One peer's incoming video, already sorted into what it *shows*.
///
/// A video track on the wire says nothing about its subject; the roster does.
/// See `classifyVideo` below — this is the answer that classification produces,
/// and the only shape the UI ever sees.
///
/// `@unchecked Sendable` for the same reason `UncheckedBox` exists: `RTCVideoTrack`
/// is an Objective-C class, the reference *is* the value (it is what a renderer
/// attaches to), and it is handed from the actor to the main actor once and then
/// only read there.
struct PeerVideo: @unchecked Sendable, Equatable {
    var camera: RTCVideoTrack?
    var screen: RTCVideoTrack?

    var isEmpty: Bool { camera == nil && screen == nil }

    static func == (lhs: PeerVideo, rhs: PeerVideo) -> Bool {
        lhs.camera === rhs.camera && lhs.screen === rhs.screen
    }
}

/// Full-mesh WebRTC voice.
///
/// The server's default backend is a peer mesh and its signalling is a pure
/// relay, so this has to be real WebRTC rather than an SFU SDK — and it has to
/// agree with the web client on every rule below, because they are the peers on
/// the other end.
///
/// **Politeness must match `peer-connection-manager.ts` exactly.** There, the
/// peer whose id sorts *higher* is "impolite" and is the one that sends the
/// initial offer. Invert it and two peers either both offer (glare) or neither
/// does (silent deadlock) — and the failure is invisible until you have two
/// different clients in the same room, which is precisely the case nobody
/// tests.
actor VoiceClient {
    /// Shared across every connection. Creating one per peer is a documented
    /// way to leak audio devices and burn CPU.
    private let factory: RTCPeerConnectionFactory
    private var connections: [String: RTCPeerConnection] = [:]
    /// Glare bookkeeping, mirroring the web client's perfect-negotiation state.
    private var makingOffer: Set<String> = []
    private var pendingCandidates: [String: [RTCIceCandidate]] = [:]

    private var localAudioTrack: RTCAudioTrack?
    private var localStream: RTCMediaStream?
    /// Remote audio, kept so deafening can silence it. WebRTC plays received
    /// audio automatically, so without a reference there is no way to turn it
    /// off short of tearing the connection down. Per peer *and per track*: see
    /// `RemoteAudioMixer` for why one reference per peer was not enough.
    private var remoteAudio = RemoteAudioMixer<RTCAudioTrack>()
    private var statsTimer: Task<Void, Never>?
    private var speaking: Set<String> = []
    private var iceServers: [RTCIceServer] = []
    private var selfPeerId: String?

    private var onStateChange: (@Sendable ([VoicePeerState]) -> Void)?
    private var signal: (@Sendable (VoiceSignal) -> Void)?
    private var peerNames: [String: String] = [:]
    private var peerUserIds: [String: String] = [:]
    private var peerAvatarUrls: [String: String] = [:]
    private var peerConnectionState: [String: String] = [:]

    // MARK: - Video (conversation calls)
    //
    // Voice channels never touch any of this: nothing below runs until
    // `startCamera` is called, and no camera track is ever created for a server
    // voice room. It lives here rather than in a second RTC stack because a
    // camera is one more track on the same peer connections — a parallel
    // manager would mean two meshes to the same peers.

    /// Our own capture. The source outlives a camera flip; the capturer does not.
    private var cameraSource: RTCVideoSource?
    private var cameraCapturer: RTCCameraVideoCapturer?
    private var localVideoTrack: RTCVideoTrack?
    /// The MediaStream id our camera is published under. This is the value that
    /// travels on `set-camera` and comes back on everyone's roster as
    /// `cameraStreamId` — it is what lets receivers tell our face from a screen.
    private var localCameraStreamId: String?
    private var usesFrontCamera = true
    /// Our outgoing camera sender per peer, kept by role rather than found by
    /// `track.kind`: a screen share is also video.
    private var cameraSenders: [String: RTCRtpSender] = [:]

    // MARK: - Screen share (outgoing)
    //
    // Frames come from a ReplayKit broadcast extension in another process, so
    // there is no capturer here — `pushScreenFrame` is fed by
    // `ScreenShareReceiver`. Otherwise this is the camera's story again: one
    // source, one track, one sender per peer, published under its own stream id
    // so the far end classifies it as a screen and not a face.

    private var screenSource: RTCVideoSource?
    /// WebRTC insists a frame arrive "from" a capturer. Nothing captures here, so
    /// this is a bare instance that exists only to satisfy that signature.
    private var screenCapturer: RTCVideoCapturer?
    private var screenTrack: RTCVideoTrack?
    private var localScreenStreamId: String?
    private var screenSenders: [String: RTCRtpSender] = [:]
    /// The last geometry `adaptOutputFormat` was told about, so a rotated phone
    /// re-adapts and an unchanging screen does not.
    private var screenAdaptedSize: (width: Int32, height: Int32) = (0, 0)

    /// Every video track a peer is sending, keyed by peer then by *sender-side*
    /// stream id (`a=msid`, preserved across the wire).
    private var remoteVideoTracks: [String: [String: RTCVideoTrack]] = [:]
    /// The camera stream id each peer announced over the WS, or nil.
    private var remoteCameraStreamIds: [String: String] = [:]
    private var onVideoChange: (@Sendable ([String: PeerVideo]) -> Void)?
    /// Re-offer retries in flight, so a teardown can cancel them.
    private var renegotiationTasks: [String: Task<Void, Never>] = [:]

    enum VoiceSignal: Sendable {
        case offer(to: String, sdp: String)
        case answer(to: String, sdp: String)
        case candidate(to: String, sdp: String, sdpMid: String?, sdpMLineIndex: Int32)
    }

    init() {
        RTCInitializeSSL()
        // Software codecs only: the hardware video factories pull in encoders
        // this app has no use for, and audio-only is the whole feature.
        factory = RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory()
        )
    }

    func configure(
        selfPeerId: String,
        iceServers: [IceServerConfig],
        onStateChange: @escaping @Sendable ([VoicePeerState]) -> Void,
        signal: @escaping @Sendable (VoiceSignal) -> Void,
        onVideoChange: (@Sendable ([String: PeerVideo]) -> Void)? = nil
    ) {
        self.selfPeerId = selfPeerId
        self.onStateChange = onStateChange
        self.signal = signal
        self.onVideoChange = onVideoChange
        self.iceServers = iceServers.map { config in
            if let username = config.username, let credential = config.credential {
                return RTCIceServer(urlStrings: config.urlList,
                                    username: username,
                                    credential: credential)
            }
            return RTCIceServer(urlStrings: config.urlList)
        }
    }

    /// Opens the mic and configures the audio session for a call.
    func startAudio() throws {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        // `.voiceChat` is what enables echo cancellation and routes to the
        // earpiece/speaker sensibly; `.playAndRecord` alone does neither.
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)
        // Speaker by default: a group voice channel is nearly always a
        // hands-free situation, unlike a one-to-one phone call.
        try? session.overrideOutputAudioPort(.speaker)

        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let source = factory.audioSource(with: constraints)
        let track = factory.audioTrack(with: source, trackId: "pqp-audio-0")
        localAudioTrack = track
        let stream = factory.mediaStream(withStreamId: "pqp-stream-0")
        stream.addAudioTrack(track)
        localStream = stream
    }

    /// Set once the server assigns it in `welcome`. Politeness depends on it,
    /// so connecting before it is known would pick the wrong side.
    func setSelfPeerId(_ peerId: String) {
        selfPeerId = peerId
    }

    /// Switches the session between the voice-only and the with-video profile.
    ///
    /// `.videoChat` is not cosmetic: it is the mode iOS tunes for a call that is
    /// *also* showing a face, and it keeps the far end audible when the speaker
    /// is on and the phone is held at arm's length. `.voiceChat` is right for
    /// audio-only and is what the room reverts to when the camera goes off.
    func setVideoMode(_ on: Bool) {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        try? session.setMode(on ? .videoChat : .voiceChat)
    }

    func setMuted(_ muted: Bool) {
        localAudioTrack?.isEnabled = !muted
    }

    /// Earpiece or speaker.
    ///
    /// `.voiceChat` mode routes to the earpiece by default, which is right for
    /// a phone call held to your head and wrong for a group call on a desk.
    /// iOS has no way to ask for this on the user's behalf, so it is a control.
    func setSpeaker(_ on: Bool) {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        try? session.overrideOutputAudioPort(on ? .speaker : .none)
    }

    /// Deafening silences everyone else and forces your own mic off, matching
    /// the web client — being heard while hearing nothing is a trap.
    func setDeafened(_ deafened: Bool) {
        remoteAudio.setDeafened(deafened)
        if deafened {
            localAudioTrack?.isEnabled = false
        }
    }

    fileprivate func addRemoteTrack(_ box: UncheckedBox<RTCAudioTrack>, for peerId: String) {
        let track = box.value
        // Keyed by track id, not by peer: a peer sharing a screen with its
        // sound sends two. Deafen and volume are re-applied by the mixer.
        remoteAudio.add(track, id: track.trackId, for: peerId)
    }

    fileprivate func removeRemoteTrack(trackId: String, for peerId: String) {
        remoteAudio.remove(trackId: trackId, for: peerId)
    }

    /// Per-person playback level, 0…2 where 1 is unchanged.
    ///
    /// Keyed by peer id here, but the *caller* keys its own memory by user id —
    /// the server mints a fresh peer id on every join, so a peer-keyed
    /// preference would reset whenever that person reconnected.
    func setVolume(_ volume: Double, for peerId: String) {
        remoteAudio.setVolume(volume, for: peerId)
    }

    // MARK: - Camera

    /// Opens the camera and publishes it to every peer.
    ///
    /// Returns the local track (for the self preview) and the MediaStream id the
    /// caller must announce over `set-camera` — receivers cannot classify the
    /// arriving video without it. Announce *before* the track lands if possible;
    /// the roster re-check covers the other ordering.
    func startCamera() async -> (track: UncheckedBox<RTCVideoTrack>, streamId: String)? {
        if let localVideoTrack, let localCameraStreamId {
            return (UncheckedBox(localVideoTrack), localCameraStreamId)
        }
        guard let device = Self.captureDevice(front: usesFrontCamera),
              let format = Self.bestFormat(for: device) else { return nil }

        let source = factory.videoSource()
        let capturer = RTCCameraVideoCapturer(delegate: source)
        let fps = Int(min(30, format.videoSupportedFrameRateRanges
            .map(\.maxFrameRate).max() ?? 30))
        try? await capturer.startCapture(with: device, format: format, fps: fps)

        // Unique per capture, not per app: the id is the receiver's whole basis
        // for telling this stream from a screen share, and a constant would
        // collide with a rejoin's stale entry on the other side.
        let streamId = "pqp-camera-" + UUID().uuidString
        let track = factory.videoTrack(with: source, trackId: "pqp-video-0")
        cameraSource = source
        cameraCapturer = capturer
        localVideoTrack = track
        localCameraStreamId = streamId

        for (peerId, connection) in connections {
            cameraSenders[peerId] = connection.add(track, streamIds: [streamId])
        }
        // Adding a track needs a new offer regardless of politeness — the same
        // thing `setLocalCameraStream` does in the web client. Glare, if any, is
        // resolved by perfect negotiation on whichever side receives it.
        for peerId in connections.keys {
            await negotiate(with: peerId)
        }
        return (UncheckedBox(track), streamId)
    }

    /// Stops the capture and unpublishes. The capture is released rather than
    /// merely disabled: a camera light with nothing behind it is not acceptable.
    func stopCamera() async {
        guard localVideoTrack != nil else { return }
        await cameraCapturer?.stopCapture()
        for (peerId, sender) in cameraSenders {
            connections[peerId]?.removeTrack(sender)
        }
        cameraSenders.removeAll()
        cameraCapturer = nil
        cameraSource = nil
        localVideoTrack = nil
        localCameraStreamId = nil
        for peerId in connections.keys {
            await negotiate(with: peerId)
        }
    }

    /// Front ↔ back. The source and the track survive, so nothing renegotiates
    /// and the far end sees the picture change rather than a stream restart.
    func flipCamera() {
        guard let capturer = cameraCapturer else {
            usesFrontCamera.toggle()
            return
        }
        usesFrontCamera.toggle()
        guard let device = Self.captureDevice(front: usesFrontCamera),
              let format = Self.bestFormat(for: device) else { return }
        let fps = Int(min(30, format.videoSupportedFrameRateRanges
            .map(\.maxFrameRate).max() ?? 30))
        capturer.stopCapture()
        capturer.startCapture(with: device, format: format, fps: fps)
    }

    var isCameraOn: Bool { localVideoTrack != nil }

    // MARK: - Screen share

    /// Publishes a screen-share track and returns the MediaStream id it went out
    /// under, which is what the far end's classification keys off.
    ///
    /// Idempotent: a second call while a share is live returns the same id rather
    /// than opening a second stream, because the protocol allows exactly one
    /// presenter per room and the server enforces it.
    func startScreenShare() async -> String? {
        if let localScreenStreamId { return localScreenStreamId }
        let source = factory.videoSource()
        let capturer = RTCVideoCapturer(delegate: source)
        // Distinct from `pqp-camera-…` and unique per share: the id IS the
        // receiver's evidence that this is not a camera, and a reused one would
        // collide with a previous share's stale entry on the other side.
        let streamId = "pqp-screen-" + UUID().uuidString
        let track = factory.videoTrack(with: source, trackId: "pqp-screen-0")
        screenSource = source
        screenCapturer = capturer
        screenTrack = track
        localScreenStreamId = streamId
        screenAdaptedSize = (0, 0)

        for (peerId, connection) in connections {
            screenSenders[peerId] = connection.add(track, streamIds: [streamId])
        }
        for peerId in connections.keys {
            await negotiate(with: peerId)
        }
        return streamId
    }

    func stopScreenShare() async {
        guard screenTrack != nil else { return }
        for (peerId, sender) in screenSenders {
            connections[peerId]?.removeTrack(sender)
        }
        screenSenders.removeAll()
        screenTrack = nil
        screenSource = nil
        screenCapturer = nil
        localScreenStreamId = nil
        screenAdaptedSize = (0, 0)
        for peerId in connections.keys {
            await negotiate(with: peerId)
        }
    }

    var isSharingScreen: Bool { screenTrack != nil }

    /// Hands one bridged frame to WebRTC.
    ///
    /// Dropped silently when no share is published: the bridge and the room have
    /// independent lifetimes (a broadcast can outlive a call), and a frame with
    /// nowhere to go is not an error.
    func pushScreenFrame(
        _ box: UncheckedBox<CVPixelBuffer>,
        rotation: Int,
        timeStampNs: Int64
    ) {
        guard let screenSource, let screenCapturer else { return }
        let pixelBuffer = box.value
        let width = Int32(CVPixelBufferGetWidth(pixelBuffer))
        let height = Int32(CVPixelBufferGetHeight(pixelBuffer))
        // Told the source its own size, so WebRTC's degradation logic scales from
        // the truth rather than from the 0×0 it assumes for a manual source.
        if screenAdaptedSize != (width, height) {
            screenAdaptedSize = (width, height)
            screenSource.adaptOutputFormat(
                toWidth: width,
                height: height,
                fps: Int32(ScreenShareWire.defaultFrameRate)
            )
        }
        let frame = RTCVideoFrame(
            buffer: RTCCVPixelBuffer(pixelBuffer: pixelBuffer),
            rotation: Self.rtcRotation(rotation),
            timeStampNs: timeStampNs
        )
        screenSource.capturer(screenCapturer, didCapture: frame)
    }

    private static func rtcRotation(_ degrees: Int) -> RTCVideoRotation {
        switch degrees {
        case 90: ._90
        case 180: ._180
        case 270: ._270
        default: ._0
        }
    }

    private static func captureDevice(front: Bool) -> AVCaptureDevice? {
        let devices = RTCCameraVideoCapturer.captureDevices()
        return devices.first { $0.position == (front ? .front : .back) } ?? devices.first
    }

    /// The smallest format at or above 640×480.
    ///
    /// Deliberately not the best the camera can do: a mesh call encodes one
    /// stream per peer on a battery, and 720p of a face in a phone-sized tile
    /// buys nothing but heat.
    private static func bestFormat(for device: AVCaptureDevice) -> AVCaptureDevice.Format? {
        let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
        let sized = formats.map { format -> (AVCaptureDevice.Format, Int32) in
            let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            return (format, dimensions.width * dimensions.height)
        }
        let target: Int32 = 640 * 480
        return sized.filter { $0.1 >= target }.min { $0.1 < $1.1 }?.0
            ?? sized.max { $0.1 < $1.1 }?.0
    }

    /// File a peer's announced camera stream id, from the roster.
    ///
    /// Mirrors `setPeerCameraStreamId` in `peer-connection-manager.ts`, including
    /// the delete-on-null: a sender's `removeTrack` only *mutes* the receiving
    /// track per spec, so without dropping the stream outright a switched-off
    /// camera would be reclassified as a screen share and drawn as a frozen frame.
    func setPeerCameraStreamId(_ streamId: String?, for peerId: String) {
        let previous = remoteCameraStreamIds[peerId]
        guard previous != streamId else { return }
        remoteCameraStreamIds[peerId] = streamId
        if streamId == nil, let previous {
            remoteVideoTracks[peerId]?[previous] = nil
        }
        emitVideo()
    }

    fileprivate func addRemoteVideo(
        _ box: UncheckedBox<RTCVideoTrack>,
        streamIds: [String],
        for peerId: String
    ) {
        // No stream id at all should not happen on this protocol, but a track
        // filed under nothing is invisible — fall back to the track id so it at
        // least renders (as a share, which is the safe classification).
        let id = streamIds.first ?? box.value.trackId
        remoteVideoTracks[peerId, default: [:]][id] = box.value
        emitVideo()
    }

    fileprivate func removeRemoteVideo(trackId: String, for peerId: String) {
        guard var streams = remoteVideoTracks[peerId] else { return }
        let before = streams.count
        streams = streams.filter { $0.value.trackId != trackId }
        guard streams.count != before else { return }
        remoteVideoTracks[peerId] = streams
        emitVideo()
    }

    /// Re-derive which incoming video is a camera and which is a screen.
    ///
    /// Byte-for-byte the rule in `classifyVideo` on the web: the announced id
    /// wins, anything else is a share — which is also exactly the behaviour for
    /// a peer that never announces a camera at all. Run on both track arrival
    /// and roster arrival, because the two race.
    private func emitVideo() {
        var result: [String: PeerVideo] = [:]
        for (peerId, streams) in remoteVideoTracks {
            var camera: RTCVideoTrack?
            var screen: RTCVideoTrack?
            let announced = remoteCameraStreamIds[peerId]
            // Sorted so the choice among several shares is stable frame to
            // frame rather than dictionary order.
            for (id, track) in streams.sorted(by: { $0.key < $1.key }) {
                if let announced, id == announced {
                    camera = camera ?? track
                } else {
                    screen = screen ?? track
                }
            }
            let video = PeerVideo(camera: camera, screen: screen)
            if !video.isEmpty {
                result[peerId] = video
            }
        }
        onVideoChange?(result)
    }

    /// Polls each connection's audio level.
    ///
    /// WebRTC exposes no "is speaking" event, so this samples `audioLevel` from
    /// the stats report. 300ms is a deliberate compromise: fast enough that a
    /// ring appears while someone is still talking, slow enough that it is not
    /// a stats query per frame.
    private func startSpeakingPolling() {
        statsTimer?.cancel()
        statsTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(300))
                guard let self else { return }
                await self.sampleAudioLevels()
            }
        }
    }

    private func sampleAudioLevels() async {
        var loud: Set<String> = []
        for (peerId, connection) in connections {
            let report = await connection.statistics()
            for (_, stat) in report.statistics where stat.type == "inbound-rtp" {
                if let level = stat.values["audioLevel"] as? Double, level > 0.01 {
                    loud.insert(peerId)
                }
            }
        }
        guard loud != speaking else { return }
        speaking = loud
        emit()
    }

    /// Whether *we* open the connection to this peer.
    ///
    /// Identical to `isImpolite` in the web client: higher id offers.
    private func isImpolite(towards remotePeerId: String) -> Bool {
        guard let selfPeerId else { return false }
        return selfPeerId > remotePeerId
    }

    func connect(to participant: VoiceParticipant) async {
        guard connections[participant.peerId] == nil else { return }
        peerNames[participant.peerId] = participant.displayName
        peerUserIds[participant.peerId] = participant.userId
        peerAvatarUrls[participant.peerId] = participant.avatarUrl

        guard let connection = makeConnection(for: participant.peerId) else { return }
        connections[participant.peerId] = connection
        peerConnectionState[participant.peerId] = "connecting"
        startSpeakingPolling()
        emit()

        if isImpolite(towards: participant.peerId) {
            await negotiate(with: participant.peerId)
        }
    }

    func remove(peerId: String) {
        renegotiationTasks[peerId]?.cancel()
        renegotiationTasks[peerId] = nil
        connections[peerId]?.close()
        connections[peerId] = nil
        remoteAudio.remove(peerId: peerId)
        speaking.remove(peerId)
        pendingCandidates[peerId] = nil
        peerNames[peerId] = nil
        peerUserIds[peerId] = nil
        peerAvatarUrls[peerId] = nil
        peerConnectionState[peerId] = nil
        cameraSenders[peerId] = nil
        screenSenders[peerId] = nil
        remoteVideoTracks[peerId] = nil
        remoteCameraStreamIds[peerId] = nil
        delegates[peerId] = nil
        emitVideo()
        emit()
    }

    func disconnectAll() {
        statsTimer?.cancel()
        statsTimer = nil
        speaking.removeAll()
        remoteAudio.removeEverything()
        for task in renegotiationTasks.values { task.cancel() }
        renegotiationTasks.removeAll()
        for (_, connection) in connections { connection.close() }
        connections.removeAll()
        delegates.removeAll()
        pendingCandidates.removeAll()
        peerNames.removeAll()
        peerUserIds.removeAll()
        peerAvatarUrls.removeAll()
        peerConnectionState.removeAll()
        // The camera is hardware: leaving the capturer running after a hang-up
        // is a lit camera light on a call that ended.
        cameraCapturer?.stopCapture()
        cameraCapturer = nil
        cameraSource = nil
        localVideoTrack = nil
        localCameraStreamId = nil
        cameraSenders.removeAll()
        // The share dies with the room. The broadcast extension outlives this —
        // it is a system recording, not ours to stop — but the track it feeds is
        // gone, and `pushScreenFrame` drops its frames from here on.
        screenTrack = nil
        screenSource = nil
        screenCapturer = nil
        localScreenStreamId = nil
        screenSenders.removeAll()
        screenAdaptedSize = (0, 0)
        remoteVideoTracks.removeAll()
        remoteCameraStreamIds.removeAll()
        emitVideo()
        localAudioTrack = nil
        localStream = nil
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        try? session.setActive(false)
        session.unlockForConfiguration()
        emit()
    }

    // MARK: - Negotiation

    private func makeConnection(for peerId: String) -> RTCPeerConnection? {
        let config = RTCConfiguration()
        config.iceServers = iceServers
        config.sdpSemantics = .unifiedPlan
        // Trickle ICE, matching the web client — candidates are relayed as they
        // are discovered rather than waiting for gathering to finish.
        config.continualGatheringPolicy = .gatherContinually

        let constraints = RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: ["DtlsSrtpKeyAgreement": kRTCMediaConstraintsValueTrue]
        )
        let delegate = PeerDelegate(peerId: peerId, owner: self)
        guard let connection = factory.peerConnection(
            with: config, constraints: constraints, delegate: delegate
        ) else { return nil }
        // The factory does not retain the delegate, so it has to be kept alive
        // alongside the connection or callbacks stop arriving mid-call.
        delegates[peerId] = delegate

        if let localAudioTrack {
            connection.add(localAudioTrack, streamIds: ["pqp-stream-0"])
        }
        // A camera already running when this peer arrives has to be on their
        // connection from the start, or they never see it: nothing renegotiates
        // for a track that was added before the pair ever negotiated. The
        // deferred re-offer in `handleOffer` is the other half of that story.
        if let localVideoTrack, let localCameraStreamId {
            cameraSenders[peerId] = connection.add(
                localVideoTrack, streamIds: [localCameraStreamId]
            )
        }
        // Same for a share already in progress: someone joining a room mid-share
        // has to see it, and nothing renegotiates a track added before the pair
        // ever negotiated.
        if let screenTrack, let localScreenStreamId {
            screenSenders[peerId] = connection.add(
                screenTrack, streamIds: [localScreenStreamId]
            )
        }
        return connection
    }

    /// A local track that no negotiated m-line carries — invisible to the peer.
    ///
    /// `mid` is empty (not nil) on this SDK until the transceiver is associated.
    private func hasUnnegotiatedSender(_ connection: RTCPeerConnection) -> Bool {
        connection.transceivers.contains { transceiver in
            transceiver.mid.isEmpty && transceiver.sender.track != nil
        }
    }

    /// Offer an unnegotiated local track once the pair has settled.
    ///
    /// This is the iOS half of the deferred re-offer in
    /// `peer-connection-manager.ts`. An answer can only cover the m-lines the
    /// *offer* carried, so a camera that was already on when this peer joined
    /// sits on a transceiver with no mid and no code path would ever offer it —
    /// the polite side never initiates. Checked-and-retried rather than fired
    /// once: an offer sent in the same breath as our answer reaches a remote
    /// still applying that answer, reads as glare, and is dropped with nothing
    /// left to retry. Every attempt re-checks, so the loop is a no-op the moment
    /// the track has its m-line.
    private func scheduleRenegotiation(with peerId: String) {
        renegotiationTasks[peerId]?.cancel()
        renegotiationTasks[peerId] = Task { [weak self] in
            for attempt in 0..<5 {
                try? await Task.sleep(for: .milliseconds(400 * (attempt + 1)))
                guard !Task.isCancelled, let self else { return }
                if await !self.reofferIfNeeded(with: peerId) { return }
            }
        }
    }

    /// One attempt. Returns false when there is nothing left to do — the track
    /// got its m-line, or the peer is gone.
    private func reofferIfNeeded(with peerId: String) async -> Bool {
        guard let connection = connections[peerId] else { return false }
        guard hasUnnegotiatedSender(connection) else { return false }
        // Still unstable: leave it for the next attempt rather than producing
        // the very glare this delay exists to avoid.
        guard !makingOffer.contains(peerId),
              connection.signalingState == .stable else { return true }
        await negotiate(with: peerId)
        return true
    }

    private var delegates: [String: PeerDelegate] = [:]

    private func negotiate(with peerId: String) async {
        guard let connection = connections[peerId] else { return }
        makingOffer.insert(peerId)
        defer { makingOffer.remove(peerId) }

        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        do {
            let offer = try await connection.offer(for: constraints)
            try await connection.setLocalDescription(offer)
            signal?(.offer(to: peerId, sdp: offer.sdp))
        } catch {
            // Nothing to do but leave the peer in `connecting`; the UI shows it
            // and offers a retry.
        }
    }

    func handleOffer(from peerId: String, sdp: String) async {
        if connections[peerId] == nil {
            guard let connection = makeConnection(for: peerId) else { return }
            connections[peerId] = connection
            peerConnectionState[peerId] = "connecting"
            emit()
        }
        guard let connection = connections[peerId] else { return }

        // Perfect negotiation: on a collision the polite peer (lower id) drops
        // its own offer and takes theirs.
        let collision = makingOffer.contains(peerId) || connection.signalingState != .stable
        if collision && isImpolite(towards: peerId) {
            return
        }

        do {
            try await connection.setRemoteDescription(
                RTCSessionDescription(type: .offer, sdp: sdp)
            )
            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            let answer = try await connection.answer(for: constraints)
            try await connection.setLocalDescription(answer)
            signal?(.answer(to: peerId, sdp: answer.sdp))
            await drainCandidates(for: peerId)
            // Follow our answer with our own offer when we are holding a track
            // the answer could not carry. See `scheduleRenegotiation`.
            if hasUnnegotiatedSender(connection) {
                scheduleRenegotiation(with: peerId)
            }
        } catch {
            // Same as above — surfaced through connection state, not thrown.
        }
    }

    func handleAnswer(from peerId: String, sdp: String) async {
        guard let connection = connections[peerId] else { return }
        do {
            try await connection.setRemoteDescription(
                RTCSessionDescription(type: .answer, sdp: sdp)
            )
            await drainCandidates(for: peerId)
        } catch {}
    }

    func handleCandidate(from peerId: String, payload: IceCandidatePayload?) async {
        // A null candidate is the end-of-candidates marker, not an error.
        guard let payload, let sdp = payload.candidate, !sdp.isEmpty else { return }
        let candidate = RTCIceCandidate(
            sdp: sdp,
            sdpMLineIndex: Int32(payload.sdpMLineIndex ?? 0),
            sdpMid: payload.sdpMid
        )
        guard let connection = connections[peerId] else { return }
        // Candidates can arrive before the answer; adding one without a remote
        // description throws, so they are held until there is one.
        guard connection.remoteDescription != nil else {
            pendingCandidates[peerId, default: []].append(candidate)
            return
        }
        try? await connection.add(candidate)
    }

    private func drainCandidates(for peerId: String) async {
        guard let connection = connections[peerId],
              let queued = pendingCandidates[peerId] else { return }
        pendingCandidates[peerId] = nil
        for candidate in queued {
            try? await connection.add(candidate)
        }
    }

    // MARK: - Delegate callbacks

    fileprivate func noteState(peerId: String, state: RTCPeerConnectionState) {
        peerConnectionState[peerId] = switch state {
        case .connected: "connected"
        case .failed, .closed: "failed"
        case .disconnected: "connecting"
        default: "connecting"
        }
        emit()
    }

    /// Takes the candidate's fields rather than the object: `RTCIceCandidate`
    /// is an Objective-C class and not `Sendable`, so handing one across the
    /// actor boundary is a data race Swift 6 refuses outright.
    fileprivate func noteCandidate(
        peerId: String,
        sdp: String,
        sdpMid: String?,
        sdpMLineIndex: Int32
    ) {
        signal?(.candidate(to: peerId, sdp: sdp, sdpMid: sdpMid, sdpMLineIndex: sdpMLineIndex))
    }

    private func emit() {
        let states = connections.keys.map { peerId in
            VoicePeerState(
                peerId: peerId,
                displayName: peerNames[peerId] ?? "Someone",
                userId: peerUserIds[peerId] ?? "",
                connection: peerConnectionState[peerId] ?? "connecting",
                avatarUrl: peerAvatarUrls[peerId],
                isSpeaking: speaking.contains(peerId),
                volume: remoteAudio.volume(for: peerId)
            )
        }
        .sorted { $0.displayName < $1.displayName }
        onStateChange?(states)
    }
}

/// Carries a non-Sendable reference across an isolation boundary where the
/// handoff is known to be safe: the value is produced on one thread, handed
/// over once, and only ever used on the actor afterwards.
struct UncheckedBox<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

/// ICE server as `/api/ice-servers` returns it. `urls` is a string or an array
/// depending on the provider, so it decodes as either.
struct IceServerConfig: Decodable, Sendable {
    let urls: StringOrArray
    let username: String?
    let credential: String?

    var urlList: [String] { urls.values }
}

struct IceServersResponse: Decodable, Sendable {
    let iceServers: [IceServerConfig]
}

enum StringOrArray: Decodable, Sendable {
    case single(String)
    case many([String])

    var values: [String] {
        switch self {
        case .single(let value): [value]
        case .many(let values): values
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let single = try? container.decode(String.self) {
            self = .single(single)
        } else {
            self = .many(try container.decode([String].self))
        }
    }
}

/// WebRTC's delegate protocol is Objective-C and not async, so this bridges
/// each callback onto the actor.
private final class PeerDelegate: NSObject, RTCPeerConnectionDelegate, @unchecked Sendable {
    let peerId: String
    weak var owner: VoiceClient?

    init(peerId: String, owner: VoiceClient) {
        self.peerId = peerId
        self.owner = owner
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        Task { [owner, peerId] in await owner?.noteState(peerId: peerId, state: newState) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        // Copied out here, on the delegate's thread, so only Sendable values
        // cross into the actor.
        let sdp = candidate.sdp
        let sdpMid = candidate.sdpMid
        let index = candidate.sdpMLineIndex
        Task { [owner, peerId] in
            await owner?.noteCandidate(peerId: peerId, sdp: sdp, sdpMid: sdpMid, sdpMLineIndex: index)
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}

    /// The Plan-B-shaped callback. Kept because it is what this app's audio has
    /// always run on; `didAdd rtpReceiver:streams:` below is the unified-plan
    /// one, and both filing the same track is harmless (the maps are keyed by
    /// identity, so the second write is the first write).
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        if let track = stream.audioTracks.first {
            // `RTCAudioTrack` is an Objective-C class and not Sendable, but unlike
            // an ICE candidate its identity is the point — the reference is what
            // deafening toggles. Boxed rather than copied, and only ever touched on
            // the actor after this handoff.
            let box = UncheckedBox(track)
            Task { [owner, peerId] in await owner?.addRemoteTrack(box, for: peerId) }
        }
        let streamId = stream.streamId
        for video in stream.videoTracks {
            let box = UncheckedBox(video)
            Task { [owner, peerId] in
                await owner?.addRemoteVideo(box, streamIds: [streamId], for: peerId)
            }
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {
        let videoIds = stream.videoTracks.map(\.trackId)
        let audioIds = stream.audioTracks.map(\.trackId)
        Task { [owner, peerId] in
            for trackId in videoIds {
                await owner?.removeRemoteVideo(trackId: trackId, for: peerId)
            }
            for trackId in audioIds {
                await owner?.removeRemoteTrack(trackId: trackId, for: peerId)
            }
        }
    }

    /// Unified plan's "a receiver and its track were created".
    ///
    /// This is the callback that carries the *stream ids* a track was published
    /// under, which is the entire basis for telling a camera from a screen
    /// share (`voiceParticipantSchema.cameraStreamId`).
    func peerConnection(
        _ peerConnection: RTCPeerConnection,
        didAdd rtpReceiver: RTCRtpReceiver,
        streams mediaStreams: [RTCMediaStream]
    ) {
        let streamIds = mediaStreams.map(\.streamId)
        if let video = rtpReceiver.track as? RTCVideoTrack {
            let box = UncheckedBox(video)
            Task { [owner, peerId] in
                await owner?.addRemoteVideo(box, streamIds: streamIds, for: peerId)
            }
        } else if let audio = rtpReceiver.track as? RTCAudioTrack {
            let box = UncheckedBox(audio)
            Task { [owner, peerId] in await owner?.addRemoteTrack(box, for: peerId) }
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove rtpReceiver: RTCRtpReceiver) {
        guard let track = rtpReceiver.track else { return }
        let trackId = track.trackId
        let isAudio = track is RTCAudioTrack
        Task { [owner, peerId] in
            if isAudio {
                await owner?.removeRemoteTrack(trackId: trackId, for: peerId)
            } else {
                await owner?.removeRemoteVideo(trackId: trackId, for: peerId)
            }
        }
    }
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
