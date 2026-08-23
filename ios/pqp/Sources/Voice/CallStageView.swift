import SwiftUI
import WebRTC

/// The DM call surface.
///
/// Mirrors the web stage (`client/src/components/dm/dm-call-stage.tsx`): the
/// remote person *is* the stage and the self-view is a corner preview; a live
/// screen share takes the stage instead and pushes people into a rail; ringing
/// out is one large pulsing identity. Controls are mute, camera, share, speaker
/// and hang up; sharing goes through the system broadcast picker, because a
/// ReplayKit broadcast extension is the only way iOS lets an app send the screen.
struct CallStageView: View {
    @Environment(CallModel.self) private var call
    @Environment(SessionStore.self) private var session

    var body: some View {
        @Bindable var call = call

        ZStack {
            Palette.inkDeep.ignoresSafeArea()

            stage
                .ignoresSafeArea(edges: .bottom)

            VStack(spacing: 0) {
                topBar
                Spacer(minLength: 0)
                ScreenSharePresenterBanner(
                    isSharing: call.screenShare.isSharing,
                    errorMessage: call.screenShare.errorMessage
                )
                .padding(.bottom, 8)
                if let message = call.errorMessage {
                    Text(message)
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paper)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Capsule().fill(Palette.danger.opacity(0.9)))
                        .padding(.bottom, 10)
                        .transition(.opacity)
                }
                controls
            }
            .padding(.horizontal, Metrics.hPadding)
            .padding(.bottom, 18)

            if call.layout == .spotlight || call.layout == .ring {
                selfPreview
            }
        }
        .animation(Motion.standard, value: call.layout)
        .animation(Motion.standard, value: call.isCameraOn)
        .statusBarHidden(false)
    }

    // MARK: - Stage

    @ViewBuilder
    private var stage: some View {
        switch call.layout {
        case .screen:
            VStack(spacing: 10) {
                ScreenShareStage(
                    track: call.remoteScreen,
                    presenterName: call.presenterName,
                    identifier: "call.screenShare",
                    presenters: call.screenPresenters.map {
                        ($0.peerId, $0.name)
                    },
                    focusedPeerId: call.resolvedScreenFocus,
                    onFocus: { call.focusScreen($0) }
                )
                participantRail
                    .frame(height: 96)
            }
            .padding(.horizontal, 10)
            .padding(.top, 92)
            .padding(.bottom, 110)

        case .spotlight:
            if let peer = call.peers.first {
                PeerStageTile(peer: peer, track: call.camera(for: peer.peerId),
                              isMuted: call.isMuted(peer.peerId), large: true)
                    .ignoresSafeArea()
            }

        case .grid:
            let columns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
            ScrollView {
                LazyVGrid(columns: columns, spacing: 8) {
                    ForEach(call.peers) { peer in
                        PeerStageTile(peer: peer, track: call.camera(for: peer.peerId),
                                      isMuted: call.isMuted(peer.peerId), large: false)
                            .aspectRatio(3 / 4, contentMode: .fit)
                            .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadius,
                                                        style: .continuous))
                    }
                }
                .padding(.horizontal, 10)
                .padding(.top, 92)
                .padding(.bottom, 120)
            }

        case .ring:
            ringIdentity
        }
    }

    /// The person being called, pulsing. The only thing on screen while a ring
    /// is out, because there is nothing else true to show yet.
    private var ringIdentity: some View {
        VStack(spacing: 18) {
            PulsingAvatar(
                name: call.counterpart?.displayName ?? call.title,
                seed: call.counterpart?.id ?? call.conversationId ?? "call",
                url: call.counterpart?.avatarUrl,
                active: call.phase == .ringing || call.phase == .connecting
            )
            Text(call.title)
                .font(Typography.title(24))
                .foregroundStyle(Palette.paper)
                .lineLimit(1)
            Text(statusLine)
                .font(Typography.callout)
                .foregroundStyle(Palette.paperMuted)
        }
    }

    private var participantRail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(call.peers) { peer in
                    PeerStageTile(peer: peer, track: call.camera(for: peer.peerId),
                                  isMuted: call.isMuted(peer.peerId), large: false)
                        .frame(width: 128, height: 96)
                        .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall,
                                                    style: .continuous))
                }
                if call.isCameraOn, let local = call.localCamera {
                    VideoTile(track: local, mirrored: true)
                        .frame(width: 128, height: 96)
                        .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall,
                                                    style: .continuous))
                }
            }
        }
    }

    /// Our own camera, floating. Tap to flip; there is no other place on this
    /// screen where flipping belongs.
    @ViewBuilder
    private var selfPreview: some View {
        if call.isCameraOn, let local = call.localCamera {
            VStack {
                HStack {
                    Spacer()
                    VideoTile(track: local, mirrored: true)
                        .frame(width: 104, height: 148)
                        .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadius,
                                                    style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: Metrics.cornerRadius,
                                             style: .continuous)
                                .strokeBorder(Palette.border, lineWidth: 1)
                        )
                        .onTapGesture { Task { await call.flipCamera() } }
                        .accessibilityLabel("Flip camera")
                }
                Spacer()
            }
            .padding(.horizontal, Metrics.hPadding)
            .padding(.top, 92)
            .transition(.opacity.combined(with: .scale(scale: 0.9)))
        }
    }

    // MARK: - Chrome

    private var topBar: some View {
        HStack(spacing: 10) {
            Button {
                call.isCollapsed = true
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Palette.paper)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(Palette.surface.opacity(0.85)))
            }
            .accessibilityIdentifier("call.collapse")
            .accessibilityLabel("Keep chatting")

            VStack(alignment: .leading, spacing: 1) {
                Text(call.title)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                    .lineLimit(1)
                durationLabel
            }
            Spacer()
        }
        .padding(.top, 8)
    }

    /// A ticking clock needs a timeline of its own — rebuilding the whole stage
    /// once a second to move two digits would restart every video view's layout.
    @ViewBuilder
    private var durationLabel: some View {
        if let startedAt = call.startedAt, call.phase == .active {
            TimelineView(.periodic(from: startedAt, by: 1)) { context in
                Text(formatCallDuration(context.date.timeIntervalSince(startedAt)))
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundStyle(Palette.paperMuted)
            }
        } else {
            Text(statusLine)
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
        }
    }

    private var statusLine: String {
        switch call.phase {
        case .connecting: String(localized: "Connecting…")
        case .ringing: String(localized: "Calling…")
        case .active: String(localized: "Connected")
        case .ended(let reason): reason ?? CallEndReason.ended
        case .idle: ""
        }
    }

    private var controls: some View {
        @Bindable var call = call

        return HStack(spacing: 12) {
            CallControlButton(
                icon: call.isMuted ? "mic.slash.fill" : "mic.fill",
                isOn: !call.isMuted,
                tint: call.isMuted ? Palette.danger : Palette.paper
            ) {
                call.isMuted.toggle()
            }
            .accessibilityIdentifier("call.mute")
            .accessibilityLabel(call.isMuted ? "Unmute" : "Mute")

            CallControlButton(
                icon: call.isCameraOn ? "video.fill" : "video.slash.fill",
                isOn: call.isCameraOn,
                tint: call.isCameraOn ? Palette.signal : Palette.paper
            ) {
                Task { await call.toggleCamera() }
            }
            .accessibilityIdentifier("call.camera")
            .accessibilityLabel(call.isCameraOn ? "Turn camera off" : "Turn camera on")

            if call.screenShare.isAvailable {
                ScreenShareControlButton(
                    isSharing: call.screenShare.isSharing,
                    identifier: "call.share"
                )
            }

            CallControlButton(
                icon: call.isSpeakerOn ? "speaker.wave.3.fill" : "iphone.gen3",
                isOn: call.isSpeakerOn,
                tint: call.isSpeakerOn ? Palette.signal : Palette.paper
            ) {
                call.isSpeakerOn.toggle()
            }
            .accessibilityIdentifier("call.speaker")
            .accessibilityLabel(call.isSpeakerOn ? "Switch to earpiece" : "Switch to speaker")

            Button {
                Task { await call.hangUp() }
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 21))
                    .foregroundStyle(Palette.inkDeep)
                    .frame(width: 62, height: 62)
                    .background(Circle().fill(Palette.danger))
            }
            .accessibilityIdentifier("call.hangup")
            .accessibilityLabel("Hang up")
        }
    }
}

/// One remote participant on the stage: their camera if it is on, their identity
/// if it is not. Never an empty rectangle — a black tile is indistinguishable
/// from a broken one.
private struct PeerStageTile: View {
    let peer: VoicePeerState
    let track: RTCVideoTrack?
    var isMuted: Bool = false
    var large: Bool

    var body: some View {
        ZStack {
            if let track {
                VideoTile(track: track)
            } else {
                Palette.ink
                VStack(spacing: 10) {
                    Avatar(
                        name: peer.displayName,
                        seed: peer.userId.isEmpty ? peer.peerId : peer.userId,
                        size: large ? 108 : 46,
                        isSpeaking: peer.isSpeaking,
                        url: peer.avatarUrl
                    )
                    if large {
                        Text(peer.displayName)
                            .font(Typography.title(20))
                            .foregroundStyle(Palette.paper)
                    }
                }
            }
        }
        .overlay(alignment: .bottomLeading) {
            HStack(spacing: 5) {
                if isMuted {
                    Image(systemName: "mic.slash.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(Palette.danger)
                }
                if peer.connection != "connected" {
                    Text(peer.connection)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Palette.warning)
                }
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(Capsule().fill(Palette.inkDeep.opacity(0.7)))
            .padding(10)
            .opacity(isMuted || peer.connection != "connected" ? 1 : 0)
        }
    }
}

private struct CallControlButton: View {
    let icon: String
    var isOn: Bool = true
    var tint: Color = Palette.paper
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 19))
                .foregroundStyle(tint)
                .frame(width: 62, height: 62)
                .background(Circle().fill(Palette.surfaceRaised.opacity(0.92)))
        }
    }
}

/// The ringing identity. One slow breath, not a spinner — a call that is
/// *waiting* should feel like waiting.
private struct PulsingAvatar: View {
    let name: String
    let seed: String
    var url: String?
    var active: Bool
    @State private var expanded = false

    var body: some View {
        ZStack {
            Circle()
                .fill(Palette.signal.opacity(0.10))
                .frame(width: 190, height: 190)
                .scaleEffect(expanded ? 1.12 : 0.9)
                .opacity(expanded ? 0.25 : 0.7)
            Avatar(name: name, seed: seed, size: 132, url: url)
        }
        .onAppear {
            guard active else { return }
            withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) {
                expanded = true
            }
        }
    }
}

/// The banner a collapsed call leaves behind, so the chat under it can be read.
/// Tapping anywhere brings the stage back.
struct CallCollapsedBanner: View {
    @Environment(CallModel.self) private var call

    var body: some View {
        @Bindable var call = call

        return Button {
            call.isCollapsed = false
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "phone.fill")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Palette.inkDeep)
                    .frame(width: 26, height: 26)
                    .background(Circle().fill(Palette.signal))

                VStack(alignment: .leading, spacing: 1) {
                    Text(call.title)
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paper)
                        .lineLimit(1)
                    if let startedAt = call.startedAt, call.phase == .active {
                        TimelineView(.periodic(from: startedAt, by: 1)) { context in
                            Text(formatCallDuration(context.date.timeIntervalSince(startedAt)))
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(Palette.paperMuted)
                        }
                    } else {
                        Text("Calling…")
                            .font(.system(size: 10))
                            .foregroundStyle(Palette.paperMuted)
                    }
                }

                Spacer()

                Button {
                    Task { await call.hangUp() }
                } label: {
                    Image(systemName: "phone.down.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.inkDeep)
                        .frame(width: 26, height: 26)
                        .background(Circle().fill(Palette.danger))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Hang up")
            }
            .padding(.horizontal, Metrics.hPadding)
            .padding(.vertical, 8)
            .background(Palette.surface)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("call.expand")
    }
}

/// The ring, wherever you are in the app.
///
/// A banner rather than a full-screen takeover: without CallKit this can only
/// appear while the app is already open and foregrounded, and hijacking the
/// whole screen for something the user may well be expecting to ignore is worse
/// than a card they can decline in one tap.
struct IncomingCallBanner: View {
    @Environment(CallModel.self) private var call
    let incoming: IncomingCall

    var body: some View {
        HStack(spacing: 12) {
            Avatar(name: incoming.callerName, seed: incoming.callerUserId,
                   size: 44, url: incoming.callerAvatarUrl)

            VStack(alignment: .leading, spacing: 2) {
                Text(incoming.callerName)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                    .lineLimit(1)
                Text(incoming.kind == "group"
                     ? String(localized: "Group call")
                     : String(localized: "Incoming call"))
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            }

            Spacer(minLength: 4)

            Button {
                Task { await call.decline(incoming) }
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(Palette.inkDeep)
                    .frame(width: 42, height: 42)
                    .background(Circle().fill(Palette.danger))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("call.decline")
            .accessibilityLabel("Decline")

            Button {
                Task { await call.accept(incoming, withVideo: true) }
            } label: {
                Image(systemName: "video.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(Palette.paper)
                    .frame(width: 42, height: 42)
                    .background(Circle().fill(Palette.surfaceRaised))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("call.acceptVideo")
            .accessibilityLabel("Answer with video")

            Button {
                Task { await call.accept(incoming, withVideo: false) }
            } label: {
                Image(systemName: "phone.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(Palette.inkDeep)
                    .frame(width: 42, height: 42)
                    .background(Circle().fill(Palette.success))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("call.accept")
            .accessibilityLabel("Answer")
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                .fill(Palette.surface)
                .shadow(color: .black.opacity(0.4), radius: 18, y: 6)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                .strokeBorder(Palette.border, lineWidth: 1)
        )
        .padding(.horizontal, 10)
    }
}
