import AVKit
import SwiftUI

/**
 THE PICTURE ITSELF, AND WHY IT IS NOT SwiftUI's `VideoPlayer` ANY MORE.

 A watch party is a film, and the first thing a person watching a film on a
 phone for two hours wants is for it to fill the phone. SwiftUI's `VideoPlayer`
 wraps this exact class and exposes almost none of it: no fullscreen button, no
 Picture in Picture, no AirPlay route picker, no video gravity. Every one of
 those already exists on the platform, is the control every other video on the
 phone draws, and rotating a custom pane into landscape by hand would be a
 reimplementation of machinery Apple ships and a viewer already knows.

 So the system owns the inside of the rectangle: its transport bar, which fades
 while you watch and comes back on a touch, its LIVE indicator, its expand
 button, its AirPlay picker. What pqp owns is the strip underneath, which is
 the part the system has no opinion about: whether this is live, how many
 people are here, and which rung is being decoded.

 IT REPORTS ITS OWN SIZE IN PIXELS, and that is not decoration. Nothing was
 setting `preferredMaximumResolution`, so `AVPlayer` climbed to the tallest
 rung a broadcast published and decoded 1080p to draw it into a strip a phone
 wide. `WatchLadder.resolutionCap` turns the size below into a ceiling, which
 means the same code holds 720p inline and allows 1080p the moment the viewer
 taps expand, without either being a hard coded number.
 */
struct WatchVideoSurface: UIViewControllerRepresentable {
    let player: AVPlayer
    /// The video rectangle in DEVICE PIXELS, whenever it changes. Pixels
    /// rather than points because a rendition is measured in pixels and a
    /// ceiling in points would mean three different things on three phones.
    let onSurfacePixels: (CGSize) -> Void

    func makeUIViewController(context: Context) -> WatchPlayerViewController {
        let controller = WatchPlayerViewController()
        controller.player = player
        // The transport bar is the whole reason this class is here: the expand
        // button that takes a film fullscreen in landscape lives in it.
        controller.showsPlaybackControls = true
        // A live broadcast has no aspect ratio of its own to respect. A screen
        // share is whatever shape the presenter's screen is, and cropping it
        // to fill would cut off the half of a game that matters.
        controller.videoGravity = .resizeAspect
        // Offered, never automatic. Automatic PiP on backgrounding needs a
        // delegate to put the app back together on the way out, and a viewer
        // who wanted a floating window can say so with one tap.
        controller.allowsPictureInPicturePlayback = true
        controller.canStartPictureInPictureAutomaticallyFromInline = false
        // A live stream never plays to an end, so neither of these should ever
        // fire. Stated anyway, because the defaults are the tvOS defaults and
        // a film that yanked itself fullscreen on the first frame would be the
        // worse surprise.
        controller.entersFullScreenWhenPlaybackBegins = false
        controller.exitsFullScreenWhenPlaybackEnds = false
        controller.onSurfacePixels = onSurfacePixels
        return controller
    }

    func updateUIViewController(_ controller: WatchPlayerViewController, context: Context) {
        // Identity, not equality. Handing the same player back is the common
        // case and re-assigning it would drop the current item and re-buffer,
        // which is the whole failure `WatchStreamSwap` exists to avoid.
        if controller.player !== player {
            controller.player = player
        }
        controller.onSurfacePixels = onSurfacePixels
    }
}

/// `AVPlayerViewController` that says how big its picture is.
///
/// A subclass rather than a KVO observer on `videoBounds`, because layout is
/// the moment the answer changes and `viewDidLayoutSubviews` is where layout
/// finishes. Fullscreen, rotation, the strip being collapsed and the keyboard
/// coming up all arrive here and nowhere else.
final class WatchPlayerViewController: AVPlayerViewController {
    var onSurfacePixels: ((CGSize) -> Void)?

    private var lastReported: CGSize = .zero

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // `videoBounds` is the picture inside the letterboxing, which is the
        // rectangle a rendition is actually drawn into. It is empty until the
        // first frame decodes, and the view's own bounds are the honest
        // stand-in until then.
        let rect = videoBounds.isEmpty ? view.bounds : videoBounds
        let scale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 3
        let pixels = CGSize(width: rect.width * scale, height: rect.height * scale)
        guard pixels.width > 0, pixels.height > 0 else { return }
        // Layout runs constantly. Re-tuning the player on every pass would set
        // `preferredMaximumResolution` dozens of times a second, and each set
        // is a decision the player has to act on.
        guard abs(pixels.height - lastReported.height) > 1
            || abs(pixels.width - lastReported.width) > 1
        else { return }
        lastReported = pixels
        onSurfacePixels?(pixels)
    }
}
