import AVKit
import SwiftUI
import UIKit

/**
 Native watch-party fullscreen.

 A SwiftUI `.fullScreenCover` presented from `ChatView`'s top inset is not
 a film: the cover is a child of the transcript, the chat still owns the
 layout, and landscape is a request the inset cannot honour. This presents
 an `AVPlayerViewController` with `.fullScreen` from a hidden anchor, which
 is the iOS equivalent of the web's `webkitEnterFullscreen` path
 (`client/src/components/voice/watch-fullscreen.ts`). Our cinema chrome
 lives in `contentOverlayView`; the system transport bar does not.
 */
@MainActor
protocol WatchTheaterAnchorDelegate: AnyObject {
    func theaterDidDismiss()
}

final class WatchTheaterAnchor: UIViewController {
    private var theater: AVPlayerViewController?
    private var overlayHost: UIHostingController<AnyView>?
    weak var delegate: WatchTheaterAnchorDelegate?

    override func loadView() {
        // Invisible. It only exists so there is a UIKit presenter that is
        // not the chat inset.
        view = UIView(frame: .zero)
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
    }

    func presentIfNeeded<Overlay: View>(player: AVPlayer, overlay: Overlay) {
        if let theater {
            theater.player = player
            updateOverlay(overlay)
            return
        }
        let controller = AVPlayerViewController()
        controller.player = player
        controller.showsPlaybackControls = false
        controller.allowsPictureInPicturePlayback = true
        controller.videoGravity = .resizeAspect
        controller.modalPresentationStyle = .fullScreen
        controller.modalPresentationCapturesStatusBarAppearance = true
        controller.delegate = self

        let host = UIHostingController(rootView: AnyView(overlay))
        host.view.backgroundColor = .clear
        host.view.translatesAutoresizingMaskIntoConstraints = false
        if let canvas = controller.contentOverlayView {
            host.willMove(toParent: controller)
            controller.addChild(host)
            canvas.addSubview(host.view)
            NSLayoutConstraint.activate([
                host.view.leadingAnchor.constraint(equalTo: canvas.leadingAnchor),
                host.view.trailingAnchor.constraint(equalTo: canvas.trailingAnchor),
                host.view.topAnchor.constraint(equalTo: canvas.topAnchor),
                host.view.bottomAnchor.constraint(equalTo: canvas.bottomAnchor),
            ])
            host.didMove(toParent: controller)
        }
        overlayHost = host
        theater = controller
        WatchOrientation.enterTheater()
        let presenter = view.window != nil ? self : Self.topMost()
        presenter?.present(controller, animated: true)
    }

    func updateOverlay<Overlay: View>(_ overlay: Overlay) {
        overlayHost?.rootView = AnyView(overlay)
    }

    func dismissIfNeeded() {
        guard let theater else { return }
        WatchOrientation.leaveTheater()
        theater.dismiss(animated: true) { [weak self] in
            self?.tearDown()
        }
    }

    fileprivate func tearDown() {
        overlayHost?.willMove(toParent: nil)
        overlayHost?.view.removeFromSuperview()
        overlayHost?.removeFromParent()
        overlayHost = nil
        theater?.player = nil
        theater = nil
    }

    private static func topMost() -> UIViewController? {
        let root = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .rootViewController
        var current = root
        while let presented = current?.presentedViewController {
            current = presented
        }
        return current
    }
}

extension WatchTheaterAnchor: @preconcurrency AVPlayerViewControllerDelegate {
    func playerViewController(
        _ playerViewController: AVPlayerViewController,
        willBeginFullScreenPresentationWithAnimationCoordinator coordinator:
            UIViewControllerTransitionCoordinator
    ) {
        WatchOrientation.enterTheater()
    }

    func playerViewController(
        _ playerViewController: AVPlayerViewController,
        willEndFullScreenPresentationWithAnimationCoordinator coordinator:
            UIViewControllerTransitionCoordinator
    ) {
        WatchOrientation.leaveTheater()
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            self?.tearDown()
            self?.delegate?.theaterDidDismiss()
        }
    }
}

/// Hidden UIKit presenter sitting next to the SwiftUI picture. `presented`
/// is the only input: true presents, false dismisses, and every SwiftUI
/// tick refreshes the overlay so play/pause/live stay in step.
struct WatchTheaterPresenter<Overlay: View>: UIViewControllerRepresentable {
    var presented: Bool
    var player: AVPlayer?
    var overlay: Overlay
    var onDismiss: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIViewController(context: Context) -> WatchTheaterAnchor {
        let anchor = WatchTheaterAnchor()
        anchor.delegate = context.coordinator
        return anchor
    }

    func updateUIViewController(_ anchor: WatchTheaterAnchor, context: Context) {
        context.coordinator.onDismiss = onDismiss
        anchor.delegate = context.coordinator
        if presented, let player {
            anchor.presentIfNeeded(player: player, overlay: overlay)
        } else if !presented {
            anchor.dismissIfNeeded()
        }
    }

    @MainActor
    final class Coordinator: WatchTheaterAnchorDelegate {
        var onDismiss: () -> Void = {}
        func theaterDidDismiss() { onDismiss() }
    }
}
