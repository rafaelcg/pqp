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

    // MARK: - Video
    //
    // Nothing below runs until `startCamera` is called, and it is called from a
    // voice channel and a DM call alike: the mesh does not know or care which
    // kind of room it is carrying, and it never did. It lives here rather than
    // in a second RTC stack because a camera is one more track on the same peer
    // connections; a parallel manager would mean two meshes to the same peers.

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

    // MARK: - Video quality
    //
    // See `VideoQuality.swift` for the ladder and for the scar it carries. The
    // three fields below are what turn a label into a picture: the choice, and
    // the two line counts the divisor has to be solved against.

    private var videoQuality: VideoQuality = .auto
    /// Lines the camera's chosen capture format really produces, measured on its
    /// short side, which is what "720p" means for a phone camera whichever way
    /// the phone is held. Zero until a capture starts.
    private var cameraCaptureLines = 0
    /// Lines the last screen frame really carried, once turned the right way up.
    /// Zero until a frame arrives.
    private var screenCaptureLines = 0
    private var onSendStats: (@Sendable (VideoSendSnapshot) -> Void)?
    /// Ticks of the 300ms speaking poll since the last video stats sample.
    private var sendStatsTick = 0
    /// Bytes and timestamp of the last sample per ssrc, so a rate can be
    /// derived. `outbound-rtp` reports totals, never a rate.
    private var lastSendBytes: [String: (bytes: Double, at: TimeInterval)] = [:]

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
        onVideoChange: (@Sendable ([String: PeerVideo]) -> Void)? = nil,
        onSendStats: (@Sendable (VideoSendSnapshot) -> Void)? = nil
    ) {
        self.selfPeerId = selfPeerId
        self.onStateChange = onStateChange
        self.signal = signal
        self.onVideoChange = onVideoChange
        self.onSendStats = onSendStats
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

    // MARK: - Quality

    /// Change what the camera and the screen are allowed to send.
    ///
    /// Safe at any moment, including with nothing publishing: the choice is kept
    /// and applied to whatever starts next. A live camera is re-captured at the
    /// new format on the *same* source and track, exactly the way `flipCamera`
    /// swaps devices, so nothing renegotiates and the far end sees the picture
    /// change rather than a stream restart.
    func setVideoQuality(_ quality: VideoQuality) async {
        guard quality != videoQuality else { return }
        videoQuality = quality
        await restartCameraCapture()
        tuneVideoSenders()
    }

    var currentVideoQuality: VideoQuality { videoQuality }

    /// Apply the chosen ladder to every video sender on every connection.
    ///
    /// WHY EVERY FIELD AND NOT JUST THE BITRATE. This is the mistake the web
    /// ladder shipped with, and the iOS mistake is its mirror image: this client
    /// has never called `setParameters` at all, so no sender has ever had a
    /// ceiling, a frame rate, a size, or a degradation preference. The default
    /// preference for a source that has not declared itself a screen is
    /// "maintain framerate", which means *shrink the picture* the moment the
    /// encoder is under pressure, and sharp text at a low frame rate keeps it
    /// under pressure permanently. A share documented as 720p was reported
    /// arriving at roughly 360p, which is two of those steps.
    ///
    /// So the screen asks for the opposite trade. A shared screen is read, and a
    /// slideshow of legible text beats a smooth blur of unreadable text; the
    /// frame rate is 12 to begin with, so there is very little of it left to
    /// protect. The camera keeps `maintainFramerate`, which is right for a face
    /// and is what the web client asks for.
    private func tuneVideoSenders() {
        let camera = cameraEncoding()
        for sender in cameraSenders.values {
            Self.apply(camera, to: sender, preference: .maintainFramerate)
        }
        let screen = screenEncoding()
        for sender in screenSenders.values {
            Self.apply(screen, to: sender, preference: .maintainResolution)
        }
    }

    /// The numbers one video sender is to be held to.
    private struct VideoEncoding {
        let maxBitrate: Int
        let frameRate: Int
        /// `scaleResolutionDownBy`, never below 1. See `videoScaleFactor`.
        let scale: Double
    }

    private func cameraEncoding() -> VideoEncoding {
        let profile = videoQuality.cameraProfile
        return VideoEncoding(
            maxBitrate: profile.maxBitrate,
            frameRate: profile.frameRate,
            scale: videoScaleFactor(
                for: videoQuality,
                sourceLines: cameraCaptureLines,
                fallbackLines: profile.lines
            )
        )
    }

    private func screenEncoding() -> VideoEncoding {
        VideoEncoding(
            maxBitrate: videoQuality.screenBitrate,
            frameRate: Int(ScreenShareWire.defaultFrameRate),
            scale: videoScaleFactor(
                for: videoQuality,
                sourceLines: screenCaptureLines,
                // The extension caps the long side, so an upright phone screen
                // arrives with about that many lines. A guess is only in force
                // until the first frame lands and re-tunes for real.
                fallbackLines: ScreenShareWire.maxLongSide
            )
        )
    }

    /// Writes the numbers onto a sender.
    ///
    /// Every field is applied on top of the parameters WebRTC already produced.
    /// Replacing the object wholesale would drop the SSRCs and RTX settings the
    /// connection is already using, which is the same rule the web client
    /// follows for the same reason.
    ///
    /// A sender whose parameters have no encodings yet is left alone rather than
    /// forced: that state means the transceiver has not been associated, and
    /// every path that produces one (a track added before the pair negotiated,
    /// a peer that has just arrived) re-tunes afterwards.
    private static func apply(
        _ encoding: VideoEncoding,
        to sender: RTCRtpSender,
        preference: RTCDegradationPreference
    ) {
        let parameters = sender.parameters
        guard !parameters.encodings.isEmpty else { return }
        parameters.degradationPreference = NSNumber(value: preference.rawValue)
        for entry in parameters.encodings {
            entry.maxBitrateBps = NSNumber(value: encoding.maxBitrate)
            entry.maxFramerate = NSNumber(value: encoding.frameRate)
            entry.scaleResolutionDownBy = NSNumber(value: encoding.scale)
        }
        sender.parameters = parameters
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
              let chosen = Self.bestFormat(for: device, lines: videoQuality.cameraProfile.lines)
        else { return nil }

        let source = factory.videoSource()
        let capturer = RTCCameraVideoCapturer(delegate: source)
        let fps = Self.captureFrameRate(for: chosen.format, ceiling: videoQuality.cameraProfile.frameRate)
        cameraCaptureLines = chosen.lines
        try? await capturer.startCapture(with: device, format: chosen.format, fps: fps)

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
        tuneVideoSenders()
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
        cameraCaptureLines = 0
        for peerId in connections.keys {
            await negotiate(with: peerId)
        }
    }

    /// Front ↔ back. The source and the track survive, so nothing renegotiates
    /// and the far end sees the picture change rather than a stream restart.
    func flipCamera() {
        usesFrontCamera.toggle()
        restartCapture()
    }

    /// Re-open the current camera at the current quality's format.
    ///
    /// A no-op with nothing running, which is what makes `setVideoQuality` safe
    /// to call from a settings screen with no call in progress.
    private func restartCameraCapture() async {
        guard cameraCapturer != nil else { return }
        restartCapture()
    }

    /// The shared half of flipping and re-sizing: same source, same track, new
    /// device or format. `cameraCaptureLines` is refreshed here because it is
    /// the divisor's denominator, and a stale one would size the encoder against
    /// a format that is no longer running.
    private func restartCapture() {
        guard let capturer = cameraCapturer else { return }
        guard let device = Self.captureDevice(front: usesFrontCamera),
              let chosen = Self.bestFormat(for: device, lines: videoQuality.cameraProfile.lines)
        else { return }
        let fps = Self.captureFrameRate(for: chosen.format, ceiling: videoQuality.cameraProfile.frameRate)
        cameraCaptureLines = chosen.lines
        capturer.stopCapture()
        capturer.startCapture(with: device, format: chosen.format, fps: fps)
        tuneVideoSenders()
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
        // NOT `videoSource(forScreenCast: true)`, and the reasoning is worth
        // keeping because the flag looks like the obvious answer here.
        //
        // What it would buy is turning the quality scaler off. That scaler
        // watches the encoder's QP and steps the *resolution* down whenever it
        // stays high, and sharp text at 12 fps keeps it high permanently, so its
        // steps only ever go one way. It is the likeliest explanation for a
        // share documented as 720p being reported arriving at roughly 360p,
        // which is two of those steps.
        //
        // But `degradationPreference = .maintainResolution` in `tuneVideoSenders`
        // turns the same scaler off, by the same code path, without the rest of
        // what the flag drags in: `is_screencast` also puts VP8 into
        // `ScreenshareLayers`, whose base temporal layer targets about 5 fps.
        // Between this app and a Chrome peer VP8 is entirely possible, so the
        // flag risks trading a resolution collapse for a framerate one, and
        // neither can be told apart from the other without a phone in hand.
        // The preference is the smaller instrument that does the same job.
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
        tuneVideoSenders()
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
        screenCaptureLines = 0
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
            // The divisor is solved against the picture the far end will see, so
            // a rotated buffer counts its width as its height. Re-tuned here
            // rather than only at publish time because a phone turning, and a
            // capture that has only just started, both move this number under a
            // sender that is already running.
            let lines = uprightVideoLines(
                width: Int(width), height: Int(height), rotation: rotation
            )
            if lines != screenCaptureLines {
                screenCaptureLines = lines
                let encoding = screenEncoding()
                for sender in screenSenders.values {
                    Self.apply(encoding, to: sender, preference: .maintainResolution)
                }
            }
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

    /// The smallest capture format that can carry the chosen number of lines.
    ///
    /// MEASURED ON THE SHORT SIDE, because that is what the label means for a
    /// camera: a phone's 720p format is 1280x720 whether the phone is upright or
    /// on its side, and picking on total pixels instead would call a 960x540
    /// format "720p" on a device that offers no 720 line format at all.
    ///
    /// Smallest-that-fits rather than best-available: a mesh call encodes one
    /// copy per peer on a battery, so capturing beyond the choice buys nothing
    /// but heat. And when nothing fits, the largest the device has, because the
    /// worst outcome allowed here is a smaller picture than asked for, never no
    /// camera at all, which is the promise `captureCamera` makes on the web.
    ///
    /// Returns the lines the format really carries as well as the format, since
    /// that is the denominator the encoder's divisor is solved against and
    /// re-deriving it at the call site is how the two drift apart.
    private static func bestFormat(
        for device: AVCaptureDevice,
        lines: Int
    ) -> (format: AVCaptureDevice.Format, lines: Int)? {
        let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
        let sized = formats.map { format -> (format: AVCaptureDevice.Format, lines: Int, pixels: Int) in
            let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            return (
                format,
                Int(min(dimensions.width, dimensions.height)),
                Int(dimensions.width) * Int(dimensions.height)
            )
        }
        let carriers = sized.filter { $0.lines >= lines }
        if let best = carriers.min(by: { $0.pixels < $1.pixels }) {
            return (best.format, best.lines)
        }
        guard let biggest = sized.max(by: { $0.pixels < $1.pixels }) else { return nil }
        return (biggest.format, biggest.lines)
    }

    /// What to ask the capture session for, bounded by what the format offers.
    ///
    /// A format that cannot reach the profile's rate would otherwise be started
    /// at a rate it refuses, and `startCapture` fails rather than approximating.
    private static func captureFrameRate(
        for format: AVCaptureDevice.Format,
        ceiling: Int
    ) -> Int {
        let supported = format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 30
        return max(1, Int(min(Double(ceiling), supported)))
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
        // One stats report answers both questions, so the video sample rides
        // along with the audio one rather than opening a second query loop over
        // the same connections. Every sixth tick is a shade under two seconds,
        // which is slow enough to be free and fast enough that somebody moving
        // the quality picker sees the number follow them.
        sendStatsTick += 1
        let wantsSendStats = onSendStats != nil && sendStatsTick % 6 == 0
        var snapshot = VideoSendSnapshot()

        var loud: Set<String> = []
        for (peerId, connection) in connections {
            let report = await connection.statistics()
            for (_, stat) in report.statistics where stat.type == "inbound-rtp" {
                if let level = stat.values["audioLevel"] as? Double, level > 0.01 {
                    loud.insert(peerId)
                }
            }
            guard wantsSendStats else { continue }
            let cameraSsrc = Self.ssrc(of: cameraSenders[peerId])
            let screenSsrc = Self.ssrc(of: screenSenders[peerId])
            for (_, stat) in report.statistics where stat.type == "outbound-rtp" {
                guard stat.values["kind"] as? String == "video" else { continue }
                guard let ssrc = (stat.values["ssrc"] as? NSNumber)?.uint32Value else { continue }
                guard let sample = sendSample(from: stat, ssrc: ssrc) else { continue }
                // The biggest picture any peer is being sent. A mesh encodes a
                // copy per peer and they adapt independently, so there is no one
                // answer; the largest is the one that says what this phone is
                // managing to produce, which is the question being asked.
                if ssrc == cameraSsrc {
                    snapshot.camera = Self.larger(snapshot.camera, sample)
                } else if ssrc == screenSsrc {
                    snapshot.screen = Self.larger(snapshot.screen, sample)
                }
            }
        }

        if wantsSendStats {
            onSendStats?(snapshot)
        }
        guard loud != speaking else { return }
        speaking = loud
        emit()
    }

    private static func ssrc(of sender: RTCRtpSender?) -> UInt32? {
        sender?.parameters.encodings.compactMap { $0.ssrc?.uint32Value }.first
    }

    private static func larger(_ a: VideoSendStats?, _ b: VideoSendStats) -> VideoSendStats {
        guard let a else { return b }
        return a.width * a.height >= b.width * b.height ? a : b
    }

    /// One `outbound-rtp` entry, turned into what a person can read.
    ///
    /// `frameWidth`/`frameHeight` are the encoded size, which is the number this
    /// whole exercise is about: what a sender *asked* for and what its encoder
    /// *produced* are different things, and only the second one reaches anybody.
    /// A stat with no size yet (nothing encoded since the track was added) is
    /// dropped rather than reported as 0x0.
    private func sendSample(from stat: RTCStatistics, ssrc: UInt32) -> VideoSendStats? {
        guard let width = (stat.values["frameWidth"] as? NSNumber)?.intValue,
              let height = (stat.values["frameHeight"] as? NSNumber)?.intValue,
              width > 0, height > 0 else { return nil }
        let bytes = (stat.values["bytesSent"] as? NSNumber)?.doubleValue ?? 0
        let now = Date().timeIntervalSince1970
        let key = String(ssrc)
        var kbps = 0
        if let previous = lastSendBytes[key] {
            let seconds = now - previous.at
            if seconds > 0.2, bytes >= previous.bytes {
                kbps = Int(((bytes - previous.bytes) * 8 / seconds) / 1000)
            }
        }
        lastSendBytes[key] = (bytes, now)
        return VideoSendStats(
            width: width,
            height: height,
            frameRate: Int(((stat.values["framesPerSecond"] as? NSNumber)?.doubleValue ?? 0).rounded()),
            kbps: kbps,
            limitation: stat.values["qualityLimitationReason"] as? String ?? "none"
        )
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
        cameraCaptureLines = 0
        // The share dies with the room. The broadcast extension outlives this —
        // it is a system recording, not ours to stop — but the track it feeds is
        // gone, and `pushScreenFrame` drops its frames from here on.
        screenTrack = nil
        screenSource = nil
        screenCapturer = nil
        localScreenStreamId = nil
        screenSenders.removeAll()
        screenAdaptedSize = (0, 0)
        screenCaptureLines = 0
        lastSendBytes.removeAll()
        sendStatsTick = 0
        onSendStats?(VideoSendSnapshot())
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
        // A sender is per connection, so the ladder has to be written onto each
        // new one. Without this the person who joined last is the only one
        // receiving an untuned stream, which is the hardest kind of report to
        // believe: everybody else in the room is looking at the right picture.
        tuneVideoSenders()
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
