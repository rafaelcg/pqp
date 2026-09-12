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
 (`client/src/components/voice/watch-fullscreen.ts`). Our cinema chrome is a
 `UIHostingController` on the controller's own view; the system transport
 bar is off. See `makeTheater` for why it is not `contentOverlayView`.
 */
@MainActor
protocol WatchTheaterAnchorDelegate: AnyObject {
    func theaterDidDismiss()
}

final class WatchTheaterAnchor: UIViewController {
    private var theater: AVPlayerViewController?
    /// The cinema chrome, and the only way out of the theater. Readable so a
    /// test can assert it is actually IN a hierarchy: build 28 built it and
    /// dropped it on the floor. See `makeTheater`.
    private(set) var overlayHost: UIHostingController<AnyView>?
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
        let controller = makeTheater(player: player, overlay: overlay)
        theater = controller
        WatchOrientation.enterTheater()
        let presenter = view.window != nil ? self : Self.topMost()
        presenter?.present(controller, animated: true)
    }

    /**
     BUILD A THEATER WITH ITS CHROME ALREADY ON IT.

     Separated from the presentation because the mounting is the half that
     trapped a viewer in build 28 and the presentation is the half that needs
     a window: this can be tested, and is.

     WHAT WENT WRONG. `contentOverlayView` is nil until the controller's view
     is loaded, and nothing above it loads a view — `player`, `videoGravity`
     and the modal properties are all plain stores. So the `if let` fell
     through on a freshly allocated controller, the host was assigned to
     `overlayHost` without ever being added to anything, and with
     `showsPlaybackControls = false` the theater had NO controls at all. Not
     the play button, not the quality menu, and not the X that leaves. The
     one thing that still answered was AVKit's own pinch-to-zoom, which sits
     on the controller's view and never needed us. Fullscreen was a one-way
     door: a still frame you could pinch, and no way back.

     The chrome goes on `controller.view`, not on `contentOverlayView`.
     `contentOverlayView` is for content drawn between the video and the
     system transport bar; ours IS the transport bar, it has buttons, and it
     has to be the topmost thing in the controller and hit-testable. The
     system bar is off, so there is nothing above it to fight with.
     */
    func makeTheater<Overlay: View>(
        player: AVPlayer, overlay: Overlay
    ) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        controller.showsPlaybackControls = false
        // OFF, and not an oversight. `WatchVideoSurface` already owns an
        // `AVPictureInPictureController` on the inline layer, and the theater
        // overlay hides the PiP button anyway (`pipAvailable: isTheater ?
        // false`). Two PiP controllers on one `AVPlayer` is two owners of one
        // media session.
        controller.allowsPictureInPicturePlayback = false
        controller.videoGravity = .resizeAspect
        controller.modalPresentationStyle = .fullScreen
        controller.modalPresentationCapturesStatusBarAppearance = true
        controller.delegate = self
        // THE VIEW HAS TO EXIST BEFORE ANYTHING IS ADDED TO IT.
        controller.loadViewIfNeeded()

        let host = UIHostingController(rootView: AnyView(overlay))
        host.view.backgroundColor = .clear
        host.view.isUserInteractionEnabled = true
        host.view.translatesAutoresizingMaskIntoConstraints = false
        let canvas: UIView = controller.view
        canvas.isUserInteractionEnabled = true
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
        overlayHost = host
        return controller
    }

    func updateOverlay<Overlay: View>(_ overlay: Overlay) {
        overlayHost?.rootView = AnyView(overlay)
    }

    func dismissIfNeeded() {
        guard let theater else { return }
        // Cleared BEFORE the animation, not in its completion. SwiftUI calls
        // `updateUIViewController` on every tick and the watchdog produces one
        // a second, so a dismissal that takes 300 ms used to be asked to
        // dismiss again on the way out.
        self.theater = nil
        WatchOrientation.leaveTheater()
        theater.dismiss(animated: true) { [weak self] in
            self?.tearDown(theater)
        }
    }

    fileprivate func tearDown(_ controller: AVPlayerViewController? = nil) {
        overlayHost?.willMove(toParent: nil)
        overlayHost?.view.removeFromSuperview()
        overlayHost?.removeFromParent()
        overlayHost = nil
        // The player goes back to the inline layer, which is the only other
        // thing that may hold it. One `AVPlayer` renders into one layer.
        (controller ?? theater)?.player = nil
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
