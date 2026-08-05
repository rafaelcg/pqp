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
        case .idle: "Not connected"
        case .joining: "Connecting…"
        case .connected:
            model.peers.isEmpty
                ? "You're the only one here"
                : "\(model.participantCount) in this channel"
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
                SelfRow(isMuted: model.isMuted, name: session.currentUser?.displayName ?? "You")
            }
            ForEach(model.peers) { peer in
                PeerRow(peer: peer)
            }
        }
    }

    private var controls: some View {
        HStack(spacing: 14) {
            Button {
                model.isMuted.toggle()
            } label: {
                Image(systemName: model.isMuted ? "mic.slash.fill" : "mic.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(model.isMuted ? Palette.danger : Palette.paper)
                    .frame(width: 60, height: 60)
                    .background(Circle().fill(Palette.surfaceRaised))
            }
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
    let name: String

    var body: some View {
        HStack(spacing: 12) {
            Avatar(name: name, seed: "self", size: 40)
            Text(name)
                .font(Typography.bodyMedium)
                .foregroundStyle(Palette.paper)
            Text("(you)")
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
            Spacer()
            if isMuted {
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

    private var stateColor: Color {
        switch peer.connection {
        case "connected": Palette.success
        case "failed": Palette.danger
        default: Palette.warning
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            Avatar(name: peer.displayName, seed: peer.userId.isEmpty ? peer.peerId : peer.userId, size: 40)
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
        .pqpSurface()
    }
}
