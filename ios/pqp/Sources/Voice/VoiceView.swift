import SwiftUI

struct VoiceView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let channel: Channel

    @State private var model = VoiceModel()

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()

            VStack(spacing: 24) {
                header
                participants
                Spacer(minLength: 0)
                controls
            }
            .padding(.horizontal, Metrics.hPadding)
            .padding(.top, 12)
            .padding(.bottom, 20)
        }
        .navigationTitle(channel.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.join(channel: channel, session: session) }
        .onDisappear { Task { await model.leave() } }
    }

    private var header: some View {
        VStack(spacing: 8) {
            ZStack {
                Circle()
                    .fill(Palette.signal.opacity(0.12))
                    .frame(width: 96, height: 96)
                Image(systemName: "speaker.wave.2.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(Palette.signal)
            }
            // A quiet pulse while connecting, so "joining" is legible without
            // a spinner competing with the participant list.
            .scaleEffect(model.status == .joining ? 0.94 : 1)
            .animation(
                model.status == .joining
                    ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true)
                    : Motion.standard,
                value: model.status
            )

            Text(statusText)
                .font(Typography.callout)
                .foregroundStyle(statusColor)
                .animation(Motion.standard, value: model.status)
        }
    }

    private var statusText: String {
        switch model.status {
        case .idle: String(localized: "Not connected")
        case .joining: String(localized: "Connecting…")
        case .connected:
            model.peers.isEmpty
                ? String(localized: "You're the only one here")
                : String(localized: "\(model.participantCount) in this channel")
        case .failed(let message): message
        }
    }

    private var statusColor: Color {
        switch model.status {
        case .connected: Palette.paperMuted
        case .failed: Palette.danger
        default: Palette.paperMuted
        }
    }

    private var participants: some View {
        VStack(spacing: 8) {
            if case .connected = model.status {
                SelfRow(
                    isMuted: model.isMuted,
                    isDeafened: model.isDeafened,
                    name: session.currentUser?.displayName ?? "You"
                )
            }
            ForEach(model.peers) { peer in
                PeerRow(
                    peer: peer,
                    volume: model.volume(for: peer),
                    onVolume: { model.setVolume($0, for: peer) }
                )
            }
        }
    }

    private var controls: some View {
        HStack(spacing: 10) {
            Button {
                model.isMuted.toggle()
            } label: {
                Image(systemName: model.isMuted ? "mic.slash.fill" : "mic.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(model.isMuted ? Palette.danger : Palette.paper)
                    .frame(width: 60, height: 60)
                    .background(Circle().fill(Palette.surfaceRaised))
            }
            .accessibilityIdentifier("voice.mute")
            .accessibilityLabel(model.isMuted ? "Unmute" : "Mute")
            .disabled(model.status != .connected)

            Button {
                model.isDeafened.toggle()
            } label: {
                Image(systemName: model.isDeafened ? "speaker.slash.fill" : "headphones")
                    .font(.system(size: 20))
                    .foregroundStyle(model.isDeafened ? Palette.danger : Palette.paper)
                    .frame(width: 60, height: 60)
                    .background(Circle().fill(Palette.surfaceRaised))
            }
            .accessibilityIdentifier("voice.deafen")
            .accessibilityLabel(model.isDeafened ? "Undeafen" : "Deafen")
            .disabled(model.status != .connected)

            Button {
                model.isSpeakerOn.toggle()
            } label: {
                Image(systemName: model.isSpeakerOn ? "speaker.wave.3.fill" : "iphone.gen3")
                    .font(.system(size: 20))
                    .foregroundStyle(model.isSpeakerOn ? Palette.signal : Palette.paper)
                    .frame(width: 60, height: 60)
                    .background(Circle().fill(Palette.surfaceRaised))
            }
            .accessibilityIdentifier("voice.speaker")
            .accessibilityLabel(model.isSpeakerOn ? "Switch to earpiece" : "Switch to speaker")
            .disabled(model.status != .connected)

            Button {
                Task {
                    await model.leave()
                    dismiss()
                }
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(Palette.inkDeep)
                    .frame(width: 60, height: 60)
                    .background(Circle().fill(Palette.danger))
            }
        }
    }
}

private struct SelfRow: View {
    let isMuted: Bool
    let isDeafened: Bool
    let name: String

    var body: some View {
        HStack(spacing: 12) {
            Avatar(name: name, seed: "self", size: 40, isSpeaking: false)
            Text(name)
                .font(Typography.bodyMedium)
                .foregroundStyle(Palette.paper)
            Text("(you)")
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
            Spacer()
            if isDeafened {
                Image(systemName: "speaker.slash.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(Palette.danger)
            } else if isMuted {
                Image(systemName: "mic.slash.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(Palette.danger)
            }
        }
        .padding(12)
        .pqpSurface()
    }
}

private struct PeerRow: View {
    let peer: VoicePeerState
    var volume: Double = 1
    var onVolume: (Double) -> Void = { _ in }
    @State private var expanded = false

    private var stateColor: Color {
        switch peer.connection {
        case "connected": Palette.success
        case "failed": Palette.danger
        default: Palette.warning
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            Avatar(
                name: peer.displayName,
                seed: peer.userId.isEmpty ? peer.peerId : peer.userId,
                size: 40,
                isSpeaking: peer.isSpeaking
            )
            Text(peer.displayName)
                .font(Typography.bodyMedium)
                .foregroundStyle(Palette.paper)
                .lineLimit(1)
            Spacer()
            // Connection state is shown per peer rather than as one overall
            // status: in a mesh one leg can fail while the rest are fine, and
            // hiding that makes "I can't hear Sam" unexplainable.
            HStack(spacing: 5) {
                Circle().fill(stateColor).frame(width: 6, height: 6)
                Text(peer.connection)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            }
            .animation(Motion.standard, value: peer.connection)
        }
        .padding(12)
        // The slider is behind a tap rather than always shown: a row per person
        // with a permanent slider turns a four-person call into a mixing desk.
        .overlay(alignment: .bottom) {
            if expanded {
                HStack(spacing: 8) {
                    Image(systemName: volume == 0 ? "speaker.slash.fill" : "speaker.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(volume == 0 ? Palette.danger : Palette.paperMuted)
                    Slider(
                        value: Binding(get: { volume }, set: onVolume),
                        in: 0...2
                    )
                    .tint(Palette.signal)
                    Text("\(Int(volume * 100))%")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Palette.paperMuted)
                        .frame(width: 38, alignment: .trailing)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
                .offset(y: 26)
            }
        }
        .padding(.bottom, expanded ? 34 : 0)
        .pqpSurface()
        .onTapGesture { withAnimation(Motion.standard) { expanded.toggle() } }
    }
}
