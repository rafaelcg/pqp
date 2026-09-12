import AVKit
import SwiftUI
import UIKit

/**
 Native watch-party fullscreen.

 A SwiftUI `.fullScreenCover` presented from `ChatView`'s top inset is not a
 film: the cover is a child of the transcript, the chat still owns the layout,
 and landscape is a request the inset cannot honour. So fullscreen is a real
 view controller presented `.fullScreen` from a hidden anchor, which is the
 iOS equivalent of the web's `webkitEnterFullscreen` path
 (`client/src/components/voice/watch-fullscreen.ts`).

 IT IS NOT AN `AVPlayerViewController`, AND THAT IS THE WHOLE POINT.

 Builds 28 and 30 presented one, with `showsPlaybackControls = false`, and hung
 our chrome inside it. Dumping the hierarchy of a presented, laid-out
 controller shows what that buys even with the system bar off: its content view
 carries FIFTEEN gesture recognisers, among them `AVTouchGestureRecognizer`,
 `AVCenterTapGestureRecognizer`, `AVUserInteractionObserverGestureRecognizer`
 and, by name, `AVExternalGestureRecognizerPreventer`. AVKit owns interaction
 in that controller and is built to outrank anything a caller adds. Hit testing
 was never the problem — a tap DOES land on our hosting view — the recognisers
 above it simply never let the tap become a tap. Which is exactly the shape of
 the report: pinch-to-zoom (AVKit's own) kept working while the X, the play
 button and the quality chip did nothing at all, on a phone the viewer then had
 to force-quit.

 So the theater is a plain `UIHostingController` holding the same SwiftUI
 picture the strip holds. No AVKit, no second player, no second layer: the
 `AVPlayerLayer` is re-parented into it by `WatchPicture`.
 */
@MainActor
protocol WatchTheaterAnchorDelegate: AnyObject {
    func theaterDidDismiss()
}

/// The full-screen film. Landscape is allowed here and nowhere else, and the
/// status bar and home indicator are out of the way of a film.
final class WatchTheaterController: UIHostingController<AnyView> {
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        .allButUpsideDown
    }
}

final class WatchTheaterAnchor: UIViewController {
    /// The presented film, and the only way out of it. Readable so a test can
    /// walk what is actually on screen: build 28 built chrome and added it to
    /// nothing, build 30 added it under a gesture stack that swallowed it, and
    /// both were green against a source-text assertion.
    private(set) var theater: WatchTheaterController?
    weak var delegate: WatchTheaterAnchorDelegate?

    override func loadView() {
        // Invisible. It only exists so there is a UIKit presenter that is
        // not the chat inset.
        view = UIView(frame: .zero)
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
    }

    func presentIfNeeded<Content: View>(content: Content) {
        if let theater {
            // Every SwiftUI tick refreshes the film so play/pause, the delay
            // and the audience count stay in step inside the theater.
            theater.rootView = AnyView(content)
            return
        }
        let controller = makeTheater(content: content)
        theater = controller
        WatchOrientation.enterTheater()
        let presenter = view.window != nil ? self : Self.topMost()
        presenter?.present(controller, animated: true)
    }

    /// Separated from the presentation so what the theater IS can be tested
    /// without a window.
    func makeTheater<Content: View>(content: Content) -> WatchTheaterController {
        let controller = WatchTheaterController(rootView: AnyView(content))
        controller.view.backgroundColor = .black
        controller.view.isUserInteractionEnabled = true
        // `.overFullScreen`, NOT `.fullScreen`, AND THIS IS THE WHOLE BUG.
        //
        // UIKit removes the presenting view controller's view from the window
        // when a `.fullScreen` presentation finishes. SwiftUI reads that as the
        // whole of `ChatView` going away and fires `onDisappear` on everything
        // in it, including the watch stage. The stage's `onDisappear` calls
        // `tearDown()` and `model.close()`: the player is paused and dropped,
        // the watchdog task is cancelled, and the `@State` box behind the view
        // stops driving anything. The theater is still on screen, holding the
        // last chrome SwiftUI drew for it, so from the sofa the film pauses and
        // no button does anything — including the X, whose `isFullscreen =
        // false` now writes into a view nothing is rendering. Rotation kept
        // working because rotation is UIKit's, not ours. That was builds 28,
        // 30 and 31, and it survived taking AVKit out because AVKit was never
        // the reason.
        //
        // `.overFullScreen` covers the screen identically and leaves the
        // presenter in the hierarchy. The theater's own view is opaque black,
        // so nothing shows through.
        controller.modalPresentationStyle = .overFullScreen
        controller.modalPresentationCapturesStatusBarAppearance = true
        return controller
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
            self?.delegate?.theaterDidDismiss()
        }
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

/// Hidden UIKit presenter sitting next to the SwiftUI picture. `presented`
/// is the only input: true presents, false dismisses, and every SwiftUI
/// tick refreshes the film so play/pause/live stay in step.
struct WatchTheaterPresenter<Content: View>: UIViewControllerRepresentable {
    var presented: Bool
    var content: Content
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
        if presented {
            anchor.presentIfNeeded(content: content)
        } else {
            anchor.dismissIfNeeded()
        }
    }

    @MainActor
    final class Coordinator: WatchTheaterAnchorDelegate {
        var onDismiss: () -> Void = {}
        func theaterDidDismiss() { onDismiss() }
    }
}
