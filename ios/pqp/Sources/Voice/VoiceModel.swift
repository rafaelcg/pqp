import Foundation
import Observation
import AVFoundation

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
    private(set) var status: VoiceStatus = .idle
    private(set) var channelId: String?
    private(set) var channelName: String?
    private(set) var peers: [VoicePeerState] = []
    private(set) var selfPeerId: String?
    var isMuted = false {
        didSet { Task { await voice.setMuted(isMuted) } }
    }
    /// Deafening also mutes, matching the web client: being heard while
    /// hearing nothing is a trap rather than a feature.
    var isDeafened = false {
        didSet {
            if isDeafened { isMuted = true }
            Task { await voice.setDeafened(isDeafened) }
        }
    }

    var isSpeakerOn = true {
        didSet { Task { await voice.setSpeaker(isSpeakerOn) } }
    }

    /// The channel we intend to be in, kept across a socket drop so the call
    /// can be rebuilt rather than silently ending.
    private var intendedChannel: Channel?
    /// Keyed by *user* id, not peer id — a peer id is minted fresh on every
    /// join, so a peer-keyed level would reset whenever they reconnected.
    private var volumeByUser: [String: Double] = [:]

    private let voice = VoiceClient()
    private var session: SessionStore?
    private let handlerKey = "voice-" + UUID().uuidString

    var participantCount: Int { peers.count + (status == .connected ? 1 : 0) }

    func join(channel: Channel, session: SessionStore) async {
        self.session = session
        channelId = channel.id
        channelName = channel.name
        intendedChannel = channel
        status = .joining

        // Asked for before joining rather than after: joining a room you cannot
        // speak in, then discovering the mic is refused, is a worse first
        // experience than being asked plainly up front.
        guard await requestMicrophone() else {
            status = .failed("Microphone access is off. Enable it in Settings to talk.")
            return
        }

        session.eventHandlers[handlerKey] = { [weak self] event in
            self?.apply(event)
        }

        do {
            let ice: IceServersResponse = try await session.api.get("/api/ice-servers")
            try await voice.startAudio()
            await voice.configure(
                selfPeerId: "",
                iceServers: ice.iceServers,
                onStateChange: { [weak self] states in
                    Task { @MainActor in self?.peers = states }
                },
                signal: { [weak self] signal in
                    Task { @MainActor in await self?.relay(signal) }
                }
            )
            await session.realtime.joinVoice(channelId: channel.id)
        } catch {
            status = .failed((error as? APIError)?.errorDescription ?? error.localizedDescription)
        }
    }

    func leave() async {
        intendedChannel = nil
        session?.eventHandlers.removeValue(forKey: handlerKey)
        await session?.realtime.leaveVoice()
        await voice.disconnectAll()
        status = .idle
        channelId = nil
        channelName = nil
        peers = []
        selfPeerId = nil
        isMuted = false
        isDeafened = false
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
                try? await voice.startAudio()
                await session?.realtime.joinVoice(channelId: intendedChannel.id)
            }

        case .voiceWelcome(let peerId, let voiceChannelId, let existing, _):
            guard voiceChannelId == channelId else { return }
            selfPeerId = peerId
            status = .connected
            Task {
                // The id only exists once the server has assigned it, and the
                // politeness rule is derived from it — so it is set here rather
                // than at configure time.
                await voice.setSelfPeerId(peerId)
                for participant in existing {
                    await voice.connect(to: participant)
                }
            }

        case .voicePeerJoined(let participant):
            Task {
                await voice.connect(to: participant)
                // Re-apply a remembered level for this person straight away.
                if let volume = volumeByUser[participant.userId] {
                    await voice.setVolume(volume, for: participant.peerId)
                }
            }

        case .voicePeerLeft(let peerId):
            Task { await voice.remove(peerId: peerId) }

        case .voiceRoomFull(let limit):
            status = .failed("This voice channel is full (max \(limit)).")

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
