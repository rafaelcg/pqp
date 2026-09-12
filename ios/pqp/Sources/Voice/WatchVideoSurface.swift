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
 layer and the same overlay, moved into a full-screen controller of our own.

 IT STILL REPORTS ITS OWN SIZE IN PIXELS. `WatchLadder.resolutionCap` turns
 that into a ceiling, so Auto holds 720p in the strip and allows 1080p the
 moment the viewer opens the theater, without either number being hard coded.
 */
struct WatchVideoSurface: UIViewRepresentable {
    let picture: WatchPicture

    func makeUIView(context: Context) -> UIView {
        let holder = UIView()
        holder.backgroundColor = .black
        picture.mount(in: holder)
        return holder
    }

    func updateUIView(_ holder: UIView, context: Context) {
        picture.mount(in: holder)
    }

    /// Empty the rectangle that is going away, and NEVER touch the player.
    ///
    /// The layer is not this view's to destroy; it belongs to `WatchPicture`
    /// and it is on its way to the theater (or back from it). Whichever of
    /// mount and dismantle SwiftUI runs first, the result is the same layer in
    /// a new box, still holding the same `AVPlayer`, still decoding.
    static func dismantleUIView(_ holder: UIView, coordinator: ()) {
        for sub in holder.subviews where sub is WatchPlayerCanvas {
            sub.removeFromSuperview()
        }
    }
}

/**
 ONE `AVPlayer`, ONE LAYER, FOR THE WHOLE BROADCAST.

 THE BUG THIS TYPE EXISTS FOR. Build 30's theater made a SECOND render target
 (AVKit's playback controller has an `AVPlayerLayer` of its own) and handed it
 the same `AVPlayer` while the inline layer still held it. An `AVPlayer` drives
 one layer at a time. The loser keeps its last frame forever, and the player
 goes on reporting `timeControlStatus == .playing` throughout, because that is
 a property of the PLAYER and not of any layer. So every measurement the app
 takes said the film was playing: `isPlaying` was true, the overlay drew a
 pause button, the delay badge counted, the stall watchdog saw a moving
 playhead and had nothing to report. The only thing that was wrong was the one
 thing nothing measures, which is whether the frames are reaching the screen.

 So the layer stops being owned by a SwiftUI view at all. It is created once
 per broadcast, it is handed the player once, and going fullscreen MOVES it
 (`addSubview` re-parents) rather than building a second one. There is never a
 moment with two layers, so there is never a moment where one of them loses.
 */
@MainActor
final class WatchPicture {
    let canvas = WatchPlayerCanvas()
    private var pipController: AVPictureInPictureController?
    private var lastReported: CGSize = .zero

    /// The video rectangle in DEVICE PIXELS, whenever it changes. Pixels
    /// rather than points because a rendition is measured in pixels and a
    /// ceiling in points would mean three different things on three phones.
    var onSurfacePixels: ((CGSize) -> Void)?

    init() {
        canvas.playerLayer.videoGravity = .resizeAspect
        canvas.backgroundColor = .black
        canvas.onLayout = { [weak self] pixels in self?.report(pixels) }
    }

    /// Hand the layer its player. Called once per broadcast by the view that
    /// owns the player, and never by whichever rectangle is showing it.
    func show(_ player: AVPlayer?, pip: WatchPictureInPicture) {
        guard canvas.player !== player else { return }
        canvas.player = player
        lastReported = .zero
        guard player != nil, AVPictureInPictureController.isPictureInPictureSupported() else {
            pipController = nil
            pip.attach(nil)
            return
        }
        let controller = AVPictureInPictureController(playerLayer: canvas.playerLayer)
        controller?.canStartPictureInPictureAutomaticallyFromInline = false
        pipController = controller
        pip.attach(controller)
    }

    /// Put the picture in this rectangle. Idempotent, and a move rather than a
    /// copy: `addSubview` takes the canvas out of whatever held it before.
    /// Autoresizing rather than constraints precisely because it is a move —
    /// constraints tying it to the old box die with the old box.
    func mount(in holder: UIView) {
        guard canvas.superview !== holder else { return }
        canvas.frame = holder.bounds
        canvas.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        holder.addSubview(canvas)
    }

    private func report(_ pixels: CGSize) {
        guard pixels.width > 0, pixels.height > 0 else { return }
        guard abs(pixels.height - lastReported.height) > 1
            || abs(pixels.width - lastReported.width) > 1
        else { return }
        lastReported = pixels
        onSurfacePixels?(pixels)
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
 on the overlay. This is the handshake: the picture attaches whatever
 controller its layer can offer, and a tap asks this object to start.
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
