import AVKit
import SwiftUI

/**
 THE PICTURE ITSELF, DRAWN BY A LAYER WE OWN.

 Build 21-23 handed the rectangle to the system playback controller. That
 bought fullscreen, AirPlay and PiP for free, and it also bought the system
 transport bar: a scrubber on a live window, a generic LIVE badge, and chrome
 that looks like every other video on the phone. A watch party is pqp's film,
 not the Videos app, so the layer stays and the chrome is ours (`WatchOverlay`).

 AirPlay is an `AVRoutePickerView` on the overlay. Picture in Picture is
 `AVPictureInPictureController` pointed at this layer. Fullscreen is the same
 overlay in a cover, not a second system player.

 IT STILL REPORTS ITS OWN SIZE IN PIXELS. `WatchLadder.resolutionCap` turns
 that into a ceiling, so Auto holds 720p in the strip and allows 1080p the
 moment the viewer opens the theater, without either number being hard coded.
 */
struct WatchVideoSurface: UIViewRepresentable {
    let player: AVPlayer
    let pip: WatchPictureInPicture
    /// The video rectangle in DEVICE PIXELS, whenever it changes. Pixels
    /// rather than points because a rendition is measured in pixels and a
    /// ceiling in points would mean three different things on three phones.
    let onSurfacePixels: (CGSize) -> Void

    func makeUIView(context: Context) -> WatchPlayerCanvas {
        let canvas = WatchPlayerCanvas()
        canvas.player = player
        canvas.playerLayer.videoGravity = .resizeAspect
        canvas.onLayout = { [weak coordinator = context.coordinator] pixels in
            coordinator?.report(pixels)
        }
        context.coordinator.onSurfacePixels = onSurfacePixels
        context.coordinator.bind(layer: canvas.playerLayer, pip: pip)
        return canvas
    }

    func updateUIView(_ canvas: WatchPlayerCanvas, context: Context) {
        if canvas.player !== player {
            canvas.player = player
            context.coordinator.bind(layer: canvas.playerLayer, pip: pip)
        }
        context.coordinator.onSurfacePixels = onSurfacePixels
        canvas.onLayout = { [weak coordinator = context.coordinator] pixels in
            coordinator?.report(pixels)
        }
    }

    /// ONE `AVPlayer`, ONE LAYER.
    ///
    /// Fullscreen hands the SAME player to the AVKit controller in
    /// `WatchTheater`, which has a layer of its own, while this one is being
    /// removed (`picture` draws a black hole instead). An `AVPlayer`
    /// renders into one layer at a time, so leaving this one holding it until
    /// SwiftUI gets round to releasing the view is how the theater opened on a
    /// still frame. Removal releases it here, on the spot.
    static func dismantleUIView(_ canvas: WatchPlayerCanvas, coordinator: Coordinator) {
        canvas.onLayout = nil
        canvas.player = nil
        coordinator.release()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    @MainActor
    final class Coordinator {
        var onSurfacePixels: ((CGSize) -> Void)?
        private var lastReported: CGSize = .zero
        private var pipController: AVPictureInPictureController?

        func bind(layer: AVPlayerLayer, pip: WatchPictureInPicture) {
            guard AVPictureInPictureController.isPictureInPictureSupported() else {
                pip.attach(nil)
                return
            }
            let controller = AVPictureInPictureController(playerLayer: layer)
            controller?.canStartPictureInPictureAutomaticallyFromInline = false
            pipController = controller
            pip.attach(controller)
        }

        /// PiP belongs to the layer. When the layer goes, so does it.
        func release() {
            pipController = nil
            onSurfacePixels = nil
        }

        func report(_ pixels: CGSize) {
            guard pixels.width > 0, pixels.height > 0 else { return }
            guard abs(pixels.height - lastReported.height) > 1
                || abs(pixels.width - lastReported.width) > 1
            else { return }
            lastReported = pixels
            onSurfacePixels?(pixels)
        }
    }
}

/// The one `AVPlayerLayer` the overlay, the theater and PiP all share.
final class WatchPlayerCanvas: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }

    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }

    var player: AVPlayer? {
        get { playerLayer.player }
        set { playerLayer.player = newValue }
    }

    var onLayout: ((CGSize) -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        let scale = window?.screen.scale ?? max(traitCollection.displayScale, 1)
        onLayout?(CGSize(width: bounds.width * scale, height: bounds.height * scale))
    }
}

/**
 The PiP controller lives on the layer, but the button that starts it lives
 on the overlay. This is the handshake: the surface attaches whatever
 controller the current layer can offer, and a tap asks this object to start.
 */
@MainActor
@Observable
final class WatchPictureInPicture {
    private(set) var canStart = false
    private weak var controller: AVPictureInPictureController?

    func attach(_ controller: AVPictureInPictureController?) {
        self.controller = controller
        canStart = controller != nil
            && AVPictureInPictureController.isPictureInPictureSupported()
    }

    func start() {
        guard let controller, !controller.isPictureInPictureActive else { return }
        controller.startPictureInPicture()
    }
}
