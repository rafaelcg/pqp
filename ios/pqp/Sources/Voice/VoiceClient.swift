import Foundation
import AVFoundation
import WebRTC

/// One remote participant's connection state, as the UI needs it.
struct VoicePeerState: Identifiable, Hashable, Sendable {
    let peerId: String
    var displayName: String
    var userId: String
    var connection: String
    var isSpeaking: Bool = false

    var id: String { peerId }
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
    /// Remote audio, kept per peer so deafening can silence it. WebRTC plays
    /// received audio automatically, so without a reference there is no way to
    /// turn it off short of tearing the connection down.
    private var remoteTracks: [String: RTCAudioTrack] = [:]
    private var isDeafened = false
    private var statsTimer: Task<Void, Never>?
    private var speaking: Set<String> = []
    private var iceServers: [RTCIceServer] = []
    private var selfPeerId: String?

    private var onStateChange: (@Sendable ([VoicePeerState]) -> Void)?
    private var signal: (@Sendable (VoiceSignal) -> Void)?
    private var peerNames: [String: String] = [:]
    private var peerUserIds: [String: String] = [:]
    private var peerConnectionState: [String: String] = [:]

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
        signal: @escaping @Sendable (VoiceSignal) -> Void
    ) {
        self.selfPeerId = selfPeerId
        self.onStateChange = onStateChange
        self.signal = signal
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
        isDeafened = deafened
        for track in remoteTracks.values {
            track.isEnabled = !deafened
        }
        if deafened {
            localAudioTrack?.isEnabled = false
        }
    }

    fileprivate func addRemoteTrack(_ box: UncheckedBox<RTCAudioTrack>, for peerId: String) {
        let track = box.value
        track.isEnabled = !isDeafened
        remoteTracks[peerId] = track
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
        connections[peerId]?.close()
        connections[peerId] = nil
        remoteTracks[peerId] = nil
        speaking.remove(peerId)
        pendingCandidates[peerId] = nil
        peerNames[peerId] = nil
        peerUserIds[peerId] = nil
        peerConnectionState[peerId] = nil
        emit()
    }

    func disconnectAll() {
        statsTimer?.cancel()
        statsTimer = nil
        speaking.removeAll()
        remoteTracks.removeAll()
        isDeafened = false
        for (_, connection) in connections { connection.close() }
        connections.removeAll()
        pendingCandidates.removeAll()
        peerNames.removeAll()
        peerUserIds.removeAll()
        peerConnectionState.removeAll()
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
        return connection
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
                isSpeaking: speaking.contains(peerId)
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

    // Required by the protocol, unused for audio-only mesh.
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        guard let track = stream.audioTracks.first else { return }
        // `RTCAudioTrack` is an Objective-C class and not Sendable, but unlike
        // an ICE candidate its identity is the point — the reference is what
        // deafening toggles. Boxed rather than copied, and only ever touched on
        // the actor after this handoff.
        let box = UncheckedBox(track)
        Task { [owner, peerId] in await owner?.addRemoteTrack(box, for: peerId) }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
