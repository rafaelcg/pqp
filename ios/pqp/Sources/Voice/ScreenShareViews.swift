import ReplayKit
import SwiftUI
import WebRTC

/// The system's own broadcast picker, dressed as one of our controls.
///
/// There is no API to start a ReplayKit broadcast — the picker is the only door,
/// and Apple requires the *user* to tap its button. Rather than reach inside for
/// the private `UIButton` and fake a touch (which breaks whenever the view's
/// internals change, and is the kind of thing review notices), the real control
/// is laid over ours at an alpha UIKit still hit-tests. Every tap therefore goes
/// to Apple's button; ours is only paint.
///
/// The same sheet stops a live broadcast, which is why one button serves both
/// directions.
private struct BroadcastPickerRepresentable: UIViewRepresentable {
    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let view = RPSystemBroadcastPickerView(
            frame: CGRect(x: 0, y: 0, width: 62, height: 62)
        )
        // Names our extension so the sheet opens on it instead of listing every
        // broadcaster installed on the phone.
        view.preferredExtension = ScreenShareWire.broadcastExtensionIdentifier
        // The app already owns the microphone for the call; ReplayKit's mic would
        // be a second, unmixable capture of the same room.
        view.showsMicrophoneButton = false
        return view
    }

    func updateUIView(_ view: RPSystemBroadcastPickerView, context: Context) {}
}

/// Share / stop sharing. Matches the other call controls; the tap target is the
/// system picker underneath.
struct ScreenShareControlButton: View {
    var isSharing: Bool
    var identifier: String

    var body: some View {
        ZStack {
            Circle()
                .fill(Palette.surfaceRaised.opacity(0.92))
            Image(systemName: isSharing
                  ? "rectangle.inset.filled.badge.record"
                  : "rectangle.on.rectangle")
                .font(.system(size: 19))
                .foregroundStyle(isSharing ? Palette.signal : Palette.paper)
            // Invisible, but not to hit testing: UIKit skips views below alpha
            // 0.01, so this sits just above it.
            BroadcastPickerRepresentable()
                .opacity(0.02)
        }
        .frame(width: 62, height: 62)
        .accessibilityIdentifier(identifier)
        .accessibilityLabel(isSharing ? "Stop sharing your screen" : "Share your screen")
    }
}

/// Somebody's shared screen, as the stage of whatever room you are in.
///
/// Letterboxed, never cropped: a shared screen's aspect ratio is not ours to
/// choose, and cropping a slide to fill a phone hides the half with the point on
/// it. Tap for fullscreen, which is the only way a laptop screen is readable on a
/// phone.
struct ScreenShareStage: View {
    let track: RTCVideoTrack?
    let presenterName: String?
    var identifier: String = "voice.screenShare"
    var presenters: [(peerId: String, name: String)] = []
    var focusedPeerId: String? = nil
    var onFocus: ((String) -> Void)? = nil
    @State private var isFullscreen = false

    var body: some View {
        VStack(spacing: 6) {
            VideoTile(track: track, contentMode: .scaleAspectFit)
                .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadius,
                                            style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                        .strokeBorder(Palette.border, lineWidth: 1)
                )
                .overlay(alignment: .topTrailing) {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Palette.paper)
                        .padding(6)
                        .background(Circle().fill(Palette.inkDeep.opacity(0.7)))
                        .padding(8)
                }
                .onTapGesture { isFullscreen = true }
                .accessibilityIdentifier(identifier)
                .accessibilityLabel(presenterName.map { "\($0) is presenting" }
                                    ?? "Shared screen")
                .accessibilityAddTraits(.isButton)

            if presenters.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(presenters, id: \.peerId) { person in
                            Button {
                                onFocus?(person.peerId)
                            } label: {
                                Text(person.name)
                                    .font(Typography.caption)
                                    .foregroundStyle(person.peerId == focusedPeerId
                                                     ? Palette.signal
                                                     : Palette.paperMuted)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 5)
                                    .background(
                                        Capsule().fill(person.peerId == focusedPeerId
                                                       ? Palette.signal.opacity(0.18)
                                                       : Palette.surfaceRaised.opacity(0.9))
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            } else if let presenterName {
                Text("\(presenterName) is presenting")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                    .lineLimit(1)
            }
        }
        .fullScreenCover(isPresented: $isFullscreen) {
            ScreenShareFullscreenView(track: track, presenterName: presenterName)
        }
    }
}

/// A shared screen, filling the display.
///
/// The app is portrait-only, so this letterboxes rather than rotating: forcing a
/// landscape orientation for one screen leaves the rest of the app to recover
/// from it, and a wide screen shrunk to fit is still the whole picture.
struct ScreenShareFullscreenView: View {
    @Environment(\.dismiss) private var dismiss
    let track: RTCVideoTrack?
    let presenterName: String?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VideoSurface(track: track, contentMode: .scaleAspectFit)
                .ignoresSafeArea()

            VStack {
                HStack(alignment: .top) {
                    if let presenterName {
                        Text(presenterName)
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paper)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(Capsule().fill(Palette.inkDeep.opacity(0.7)))
                    }
                    Spacer()
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(Palette.paper)
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(Palette.inkDeep.opacity(0.75)))
                    }
                    .accessibilityIdentifier("voice.screenShare.close")
                    .accessibilityLabel("Close")
                }
                .padding(.horizontal, Metrics.hPadding)
                .padding(.top, 10)
                Spacer()
            }
        }
        .statusBarHidden()
    }
}

/// "You are presenting", plus whatever went wrong.
struct ScreenSharePresenterBanner: View {
    let isSharing: Bool
    let errorMessage: String?

    var body: some View {
        Group {
            if let errorMessage {
                label(errorMessage, tint: Palette.danger)
            } else if isSharing {
                label(String(localized: "You are presenting"), tint: Palette.signal)
            }
        }
        .accessibilityIdentifier("voice.presenting")
    }

    private func label(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(Typography.caption)
            .foregroundStyle(Palette.inkDeep)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Capsule().fill(tint.opacity(0.9)))
    }
}
