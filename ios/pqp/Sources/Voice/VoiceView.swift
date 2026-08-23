import SwiftUI

struct VoiceView: View {
    @Environment(SessionStore.self) private var session
    @Environment(CallRatingModel.self) private var ratings
    @Environment(\.dismiss) private var dismiss
    let channel: Channel

    @State private var model = VoiceModel()

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()

            VStack(spacing: 16) {
                // A share IS the screen while it lasts: the header shrinks to a
                // line and the people become a list under it. Discord makes the
                // same trade, for the same reason — a shared screen is unreadable
                // at thumbnail size and an avatar is not.
                if let screen = model.remoteScreen {
                    compactHeader
                    ScreenShareStage(
                        track: screen,
                        presenterName: model.presenterName,
                        presenters: model.screenPresenters.map {
                            ($0.peerId, $0.name)
                        },
                        focusedPeerId: model.resolvedScreenFocus,
                        onFocus: { model.focusScreen($0) }
                    )
                        .frame(maxHeight: 260)
                    participants
                } else {
                    header
                    participants
                }
                Spacer(minLength: 0)
                ScreenSharePresenterBanner(
                    isSharing: model.screenShare.isSharing,
                    errorMessage: model.screenShare.errorMessage
                )
                controls
            }
            .animation(Motion.standard, value: model.remoteScreen != nil)
            .padding(.horizontal, Metrics.hPadding)
            .padding(.top, 12)
            .padding(.bottom, 20)
        }
        .navigationTitle(channel.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.join(channel: channel, session: session, ratings: ratings) }
        .onDisappear { Task { await model.leave() } }
    }

    /// What the header becomes once a shared screen owns the space.
    private var compactHeader: some View {
        Text(statusText)
            .font(Typography.caption)
            .foregroundStyle(statusColor)
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
                    name: session.currentUser?.displayName ?? "You",
                    avatarUrl: session.currentUser?.avatarUrl
                )
            }
            ForEach(model.peers) { peer in
                PeerRow(
                    peer: peer,
                    volume: model.volume(for: peer),
                    onVolume: { model.setVolume($0, for: peer) },
                    isPresenting: model.video[peer.peerId]?.screen != nil
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

            // Only where a broadcast can actually happen. The extension cannot
            // run in the simulator, and the bridge refuses to arm there, so a
            // button that opened a sheet leading nowhere would be a lie.
            if model.screenShare.isAvailable {
                ScreenShareControlButton(
                    isSharing: model.screenShare.isSharing,
                    identifier: "voice.share"
                )
                .frame(width: 60, height: 60)
                .opacity(model.status == .connected ? 1 : 0.4)
                .allowsHitTesting(model.status == .connected)
            }

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
    var avatarUrl: String?

    var body: some View {
        HStack(spacing: 12) {
            Avatar(name: name, seed: "self", size: 40, isSpeaking: false, url: avatarUrl)
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
    var isPresenting: Bool = false
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
                isSpeaking: peer.isSpeaking,
                url: peer.avatarUrl
            )
            Text(peer.displayName)
                .font(Typography.bodyMedium)
                .foregroundStyle(Palette.paper)
                .lineLimit(1)
            if isPresenting {
                Image(systemName: "rectangle.on.rectangle")
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.signal)
                    .accessibilityLabel("Sharing their screen")
            }
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
