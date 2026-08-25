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
struct BroadcastPickerRepresentable: UIViewRepresentable {
    /// Called when Apple's own button reports a touch.
    ///
    /// The only signal the app can get that the control was actually used.
    /// Everything after the tap is the system's business, and the system says
    /// nothing, so without this a picker that finds no extension and a picker
    /// that was never tapped are the same silence. See `ScreenShareController`.
    var onTap: () -> Void = {}
    var side: CGFloat = BroadcastPickerRepresentable.side

    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let view = RPSystemBroadcastPickerView(
            frame: CGRect(x: 0, y: 0, width: side, height: side)
        )
        // Names our extension so the sheet opens on it instead of listing every
        // broadcaster installed on the phone.
        view.preferredExtension = ScreenShareWire.broadcastExtensionIdentifier
        // The app already owns the microphone for the call; ReplayKit's mic would
        // be a second, unmixable capture of the same room.
        view.showsMicrophoneButton = false
        // Invisible, but not to hit testing, and set HERE rather than with
        // SwiftUI's `.opacity`.
        //
        // WHY IT MATTERS WHERE THIS LIVES. UIKit refuses to hit-test a view whose
        // alpha is 0.01 or less, and SwiftUI's `.opacity` composes down the view
        // tree: the old `.opacity(0.02)` sat inside a control that `VoiceView`
        // then wrapped in `.opacity(0.4)` whenever the room was not yet
        // connected, which multiplies to 0.008 and puts the control under the
        // cliff. UIKit's hit test walks each view's own alpha instead of the
        // composed one, so an alpha set on this view cannot be multiplied under
        // the threshold by any ancestor. 0.04 rather than 0.02 for the same
        // reason: margin, on a value that is invisible either way.
        view.alpha = Self.hitTestableAlpha
        return view
    }

    func updateUIView(_ view: RPSystemBroadcastPickerView, context: Context) {
        Self.alignHitTarget(in: view)
        context.coordinator.attach(to: view, onTap: onTap)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// SwiftUI must not shrink this below the size the button is laid out for.
    /// A `UIViewRepresentable` with no opinion is sized by `systemLayoutSizeFitting`,
    /// and this view has no constraints to answer with.
    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: RPSystemBroadcastPickerView,
        context: Context
    ) -> CGSize? {
        CGSize(width: side, height: side)
    }

    /// Matches the painted control in `ScreenShareControlButton`.
    static let side: CGFloat = 62

    /// Above UIKit's 0.01 hit-test floor with room to spare. See `makeUIView`.
    static let hitTestableAlpha: CGFloat = 0.04

    /// Make Apple's button cover the whole control.
    ///
    /// WHY THIS IS NEEDED. `RPSystemBroadcastPickerView` lays its one `UIButton`
    /// subview out at **(5, 5) with the view's full width and height**, measured
    /// rather than guessed (`ScreenSharePickerTests`). Inside 62x62 bounds it
    /// runs from 5 to 67, so intersected with the bounds that actually hit-test,
    /// the live area is the 57x57 square in the bottom-right corner. The top and
    /// left five points of the circle we paint are dead: a tap there lands on the
    /// picker itself, which has no action, and nothing happens at all.
    ///
    /// Five points is not a rounding error on a 62-point target. It is the outer
    /// ring of a control people aim at with a thumb. Rather than paint around
    /// Apple's offset (which would move the moment they change it), the button is
    /// pinned to the bounds every layout pass, so what is painted and what is
    /// tappable are the same square by construction.
    static func alignHitTarget(in view: RPSystemBroadcastPickerView) {
        for case let button as UIButton in view.subviews {
            button.translatesAutoresizingMaskIntoConstraints = true
            button.frame = view.bounds
            button.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        }
    }

    /// Holds the target for Apple's button. A `UIButton` target is unretained,
    /// so this cannot be the struct.
    @MainActor
    final class Coordinator: NSObject {
        private var onTap: () -> Void = {}
        private weak var attached: UIButton?

        func attach(to view: RPSystemBroadcastPickerView, onTap: @escaping () -> Void) {
            self.onTap = onTap
            for case let button as UIButton in view.subviews where button !== attached {
                attached?.removeTarget(self, action: #selector(handleTap), for: .touchUpInside)
                button.addTarget(self, action: #selector(handleTap), for: .touchUpInside)
                attached = button
            }
        }

        @objc private func handleTap() { onTap() }
    }
}

/// Share / stop sharing. Matches the other call controls; the tap target is the
/// system picker underneath.
struct ScreenShareControlButton: View {
    var isSharing: Bool
    var identifier: String
    /// The painted circle, the picker and Apple's button are all this wide.
    /// They have to agree: whatever is painted is what people aim at.
    var side: CGFloat = BroadcastPickerRepresentable.side
    /// Told that the control was used, so a start that never happens can be
    /// reported instead of being indistinguishable from a missed tap.
    var onTap: () -> Void = {}

    var body: some View {
        ZStack {
            Circle()
                .fill(Palette.surfaceRaised.opacity(0.92))
            Image(systemName: isSharing
                  ? "rectangle.inset.filled.badge.record"
                  : "rectangle.on.rectangle")
                .font(.system(size: 19))
                .foregroundStyle(isSharing ? Palette.signal : Palette.paper)
            BroadcastPickerRepresentable(onTap: onTap, side: side)
        }
        .frame(width: side, height: side)
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
