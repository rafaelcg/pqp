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

    private let voice = VoiceClient()
    private var session: SessionStore?
    private let handlerKey = "voice-" + UUID().uuidString

    var participantCount: Int { peers.count + (status == .connected ? 1 : 0) }

    func join(channel: Channel, session: SessionStore) async {
        self.session = session
        channelId = channel.id
        channelName = channel.name
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
        session?.eventHandlers.removeValue(forKey: handlerKey)
        await session?.realtime.leaveVoice()
        await voice.disconnectAll()
        status = .idle
        channelId = nil
        channelName = nil
        peers = []
        selfPeerId = nil
        isMuted = false
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
            Task { await voice.connect(to: participant) }

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
