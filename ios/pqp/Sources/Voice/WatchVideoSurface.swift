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

 THE NEWEST RECTANGLE HOLDS THE PICTURE, WHATEVER ORDER SWIFTUI CALLS US IN.
 TestFlight 1.0.6 (106701): turn the phone and the film went black, and
 turning it back did not bring it back, while the camera corner kept playing.
 Since #833 the surface sits inside a `GeometryReader`, and on a rotation the
 outgoing reader lays its content out ONE more time after the incoming one has
 been made: make(new), update(old), dismantle(old). The old rule was "every
 update mounts here", so that last update pulled the layer back into the box
 that was about to be dismantled, the dismantle took it out of the window, and
 nothing ever updated the new box again. Reproduced on the simulator with
 exactly that call order. So a rectangle now CLAIMS the picture when it is
 made and GIVES IT BACK when it is dismantled, and an update only asks the
 picture to settle into the newest rectangle still standing.
 */
struct WatchVideoSurface: UIViewRepresentable {
    let picture: WatchPicture

    func makeUIView(context: Context) -> UIView {
        let holder = UIView()
        holder.backgroundColor = .black
        context.coordinator.picture = picture
        picture.claim(holder)
        return holder
    }

    func updateUIView(_ holder: UIView, context: Context) {
        if context.coordinator.picture !== picture {
            context.coordinator.picture?.release(holder)
            context.coordinator.picture = picture
            picture.claim(holder)
        }
        picture.settle()
    }

    /// Hand the layer on, and NEVER touch the player.
    ///
    /// The layer is not this view's to destroy; it belongs to `WatchPicture`
    /// and it is on its way to the theater (or back from it). Releasing moves
    /// it into whichever rectangle is still claiming it, so the result is the
    /// same layer in the new box, still holding the same `AVPlayer`, still
    /// decoding.
    static func dismantleUIView(_ holder: UIView, coordinator: Coordinator) {
        coordinator.picture?.release(holder)
        coordinator.picture = nil
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// Which picture this rectangle claimed, so the dismantle (a static
    /// function with no `self`) can give it back.
    @MainActor
    final class Coordinator {
        weak var picture: WatchPicture?
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

    /// Every rectangle currently offering to show the picture, oldest first.
    /// Weak, so a box SwiftUI dropped without a dismantle cannot keep a claim.
    private var claims: [WeakHolder] = []

    /// A rectangle was just made: it is the newest, so the picture goes there.
    func claim(_ holder: UIView) {
        claims.removeAll { $0.view == nil || $0.view === holder }
        claims.append(WeakHolder(view: holder))
        settle()
    }

    /// A rectangle is going away. If it was showing the picture, the picture
    /// moves to the newest one still standing; with none left it simply
    /// leaves the window, keeping its player, until the next claim.
    func release(_ holder: UIView) {
        claims.removeAll { $0.view == nil || $0.view === holder }
        if canvas.superview === holder { canvas.removeFromSuperview() }
        settle()
    }

    /// Put the picture in the newest rectangle still claiming it. Idempotent,
    /// and a move rather than a copy: `addSubview` takes the canvas out of
    /// whatever held it before. Autoresizing rather than constraints
    /// precisely because it is a move: constraints tying it to the old box
    /// die with the old box.
    ///
    /// NEVER "the rectangle that asked". An outgoing rectangle can still be
    /// updated after its replacement was made (see `WatchVideoSurface`), and
    /// letting it take the picture back is the black film of build 106701.
    func settle() {
        claims.removeAll { $0.view == nil }
        guard let newest = claims.last?.view, canvas.superview !== newest else { return }
        canvas.frame = newest.bounds
        canvas.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        newest.addSubview(canvas)
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

/// One claim on the picture. A struct around a weak reference, because an
/// array cannot hold weak references directly.
private struct WeakHolder {
    weak var view: UIView?
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
