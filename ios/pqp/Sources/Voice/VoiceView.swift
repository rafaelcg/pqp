import SwiftUI
import WebRTC

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
                    // A rail rather than a grid: the screen is what people are
                    // looking at, and faces beside it are for knowing who is
                    // still here.
                    cameraRail
                    participants
                } else if model.hasCameras {
                    // Faces take the space the speaker icon had. That icon says
                    // "this is audio", which stops being true the moment anyone
                    // turns a camera on.
                    compactHeader
                    cameraGrid
                    participants
                } else {
                    header
                    participants
                }
                Spacer(minLength: 0)
                if let message = model.cameraError {
                    Text(message)
                        .font(Typography.caption)
                        .foregroundStyle(Palette.danger)
                        .multilineTextAlignment(.center)
                        .padding(.bottom, 6)
                }
                ScreenSharePresenterBanner(
                    isSharing: model.screenShare.isSharing,
                    errorMessage: model.screenShare.errorMessage
                )
                controls
            }
            .animation(Motion.standard, value: model.remoteScreen != nil)
            .animation(Motion.standard, value: model.hasCameras)
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

    /// Every camera in the room, ours last.
    ///
    /// Ours last rather than first because the tile order is the roster's, and
    /// jumping our own face to the front would reorder everybody else's row the
    /// moment we joined the video.
    @ViewBuilder
    private var cameraGrid: some View {
        let columns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
        ScrollView {
            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(model.cameraPeers) { peer in
                    VoiceCameraTile(
                        track: model.camera(for: peer.peerId),
                        name: peer.displayName,
                        isSpeaking: peer.isSpeaking,
                        isMuted: model.isMuted(peer.peerId)
                    )
                    .aspectRatio(4 / 3, contentMode: .fit)
                }
                if model.isCameraOn, let local = model.localCamera {
                    VoiceCameraTile(
                        track: local,
                        name: String(localized: "You"),
                        isSpeaking: false,
                        isMuted: model.isMuted,
                        mirrored: true
                    )
                    .aspectRatio(4 / 3, contentMode: .fit)
                    .onTapGesture { Task { await model.flipCamera() } }
                    .accessibilityLabel("Flip camera")
                }
            }
        }
        .frame(maxHeight: 320)
    }

    @ViewBuilder
    private var cameraRail: some View {
        if model.hasCameras {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(model.cameraPeers) { peer in
                        VoiceCameraTile(
                            track: model.camera(for: peer.peerId),
                            name: peer.displayName,
                            isSpeaking: peer.isSpeaking,
                            isMuted: model.isMuted(peer.peerId)
                        )
                        .frame(width: 128, height: 96)
                    }
                    if model.isCameraOn, let local = model.localCamera {
                        VoiceCameraTile(
                            track: local,
                            name: String(localized: "You"),
                            isSpeaking: false,
                            isMuted: model.isMuted,
                            mirrored: true
                        )
                        .frame(width: 128, height: 96)
                        .onTapGesture { Task { await model.flipCamera() } }
                        .accessibilityLabel("Flip camera")
                    }
                }
            }
            .frame(height: 96)
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

    /// The control row.
    ///
    /// SIZED BY WHAT FITS, not by a constant. A camera button makes six
    /// controls, and six 60pt circles with 10pt between them is 410pt: wider
    /// than every iPhone this app supports. `ViewThatFits` takes the first row
    /// that does fit, so a large phone keeps the size this screen shipped with
    /// and a small one gets the same six controls slightly smaller, rather than
    /// a hang-up button pushed off the edge.
    private var controls: some View {
        ViewThatFits(in: .horizontal) {
            controlRow(side: 60, spacing: 10)
            controlRow(side: 52, spacing: 8)
            controlRow(side: 46, spacing: 6)
        }
    }

    private func controlRow(side: CGFloat, spacing: CGFloat) -> some View {
        HStack(spacing: spacing) {
            circleButton(
                icon: model.isMuted ? "mic.slash.fill" : "mic.fill",
                tint: model.isMuted ? Palette.danger : Palette.paper,
                side: side
            ) {
                model.isMuted.toggle()
            }
            .accessibilityIdentifier("voice.mute")
            .accessibilityLabel(model.isMuted ? "Unmute" : "Mute")
            .disabled(model.status != .connected)

            circleButton(
                icon: model.isDeafened ? "speaker.slash.fill" : "headphones",
                tint: model.isDeafened ? Palette.danger : Palette.paper,
                side: side
            ) {
                model.isDeafened.toggle()
            }
            .accessibilityIdentifier("voice.deafen")
            .accessibilityLabel(model.isDeafened ? "Undeafen" : "Deafen")
            .disabled(model.status != .connected)

            circleButton(
                icon: model.isCameraOn ? "video.fill" : "video.slash.fill",
                tint: model.isCameraOn ? Palette.signal : Palette.paper,
                side: side
            ) {
                Task { await model.toggleCamera() }
            }
            .accessibilityIdentifier("voice.camera")
            .accessibilityLabel(model.isCameraOn ? "Turn camera off" : "Turn camera on")
            .disabled(model.status != .connected)

            circleButton(
                icon: model.isSpeakerOn ? "speaker.wave.3.fill" : "iphone.gen3",
                tint: model.isSpeakerOn ? Palette.signal : Palette.paper,
                side: side
            ) {
                model.isSpeakerOn.toggle()
            }
            .accessibilityIdentifier("voice.speaker")
            .accessibilityLabel(model.isSpeakerOn ? "Switch to earpiece" : "Switch to speaker")
            .disabled(model.status != .connected)

            // Only where a broadcast can actually happen. The extension cannot
            // run in the simulator, and the bridge refuses to arm there, so a
            // button that opened a sheet leading nowhere would be a lie.
            if model.screenShare.isAvailable {
                // The size is passed *in* rather than imposed with an outer
                // `.frame`: the painted circle, the system picker and Apple's
                // own button all have to be the same square, or part of what
                // looks tappable is not. See `ScreenSharePickerTests`.
                ScreenShareControlButton(
                    isSharing: model.screenShare.isSharing,
                    identifier: "voice.share",
                    side: side,
                    onTap: { model.screenShare.noteTapped() }
                )
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
                    .font(.system(size: side / 3))
                    .foregroundStyle(Palette.inkDeep)
                    .frame(width: side, height: side)
                    .background(Circle().fill(Palette.danger))
            }
        }
    }

    private func circleButton(
        icon: String,
        tint: Color,
        side: CGFloat,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: side / 3))
                .foregroundStyle(tint)
                .frame(width: side, height: side)
                .background(Circle().fill(Palette.surfaceRaised))
        }
    }
}

/// One face on the voice-channel screen.
///
/// Never an empty rectangle: a track that has not produced its first frame is
/// indistinguishable from a broken one, so the ground shows through until it
/// does. The name sits on the picture rather than under it, because the tiles
/// are small and a caption row would take a third of the height.
private struct VoiceCameraTile: View {
    let track: RTCVideoTrack?
    let name: String
    var isSpeaking: Bool = false
    var isMuted: Bool = false
    var mirrored: Bool = false

    var body: some View {
        VideoTile(track: track, mirrored: mirrored)
            .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall,
                                        style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                    .strokeBorder(isSpeaking ? Palette.success : Palette.border,
                                  lineWidth: isSpeaking ? 2 : 1)
            )
            .overlay(alignment: .bottomLeading) {
                HStack(spacing: 4) {
                    if isMuted {
                        Image(systemName: "mic.slash.fill")
                            .font(.system(size: 9))
                            .foregroundStyle(Palette.danger)
                    }
                    Text(name)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Palette.paper)
                        .lineLimit(1)
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(Capsule().fill(Palette.inkDeep.opacity(0.7)))
                .padding(6)
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
                    Text(verbatim: "\(Int(volume * 100))%")
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
