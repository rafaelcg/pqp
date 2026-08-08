import SwiftUI

/// A `UIImageView` that plays decoded GIF frames back at their real,
/// possibly-variable, per-frame speed.
///
/// `UIImageView.animationImages` was the obvious built-in alternative and was
/// rejected: it takes one `animationDuration` for the whole sequence, spread
/// evenly across every frame, so a GIF whose author varied the delay between
/// frames (a common way to land on a beat, or hold the last frame of a loop)
/// plays at the wrong speed. Driving `image` from a `CADisplayLink` against
/// each frame's own duration reproduces the GIF as authored.
final class AnimatingImageView: UIImageView {
    private var frames: [GIFFrame] = []
    private var durations: [TimeInterval] = []
    private var displayLink: CADisplayLink?
    private var startTime: CFTimeInterval = 0
    private var lastShownIndex = -1
    /// The cache key frames were last set from, so a SwiftUI `updateUIView`
    /// triggered by unrelated state (a reaction on the same message, say)
    /// doesn't restart playback from frame 0 every time the view redraws.
    private var currentKey: String?

    func setFrames(_ frames: [GIFFrame], key: String) {
        guard key != currentKey else { return }
        currentKey = key
        stop()

        self.frames = frames
        durations = frames.map(\.duration)
        lastShownIndex = -1

        guard let first = frames.first else {
            image = nil
            return
        }
        image = UIImage(cgImage: first.image)
        lastShownIndex = 0

        // A single frame (or a decode that came back empty of a second one)
        // is just a still image — no point animating.
        guard frames.count > 1 else { return }

        startTime = CACurrentMediaTime()
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    func stop() {
        displayLink?.invalidate()
        displayLink = nil
    }

    @objc private func tick() {
        let elapsed = CACurrentMediaTime() - startTime
        let index = GIFTiming.frameIndex(at: elapsed, durations: durations)
        guard index != lastShownIndex, frames.indices.contains(index) else { return }
        lastShownIndex = index
        image = UIImage(cgImage: frames[index].image)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // Off-screen rows in a `LazyVStack` still exist as views; pausing
        // when they leave the window (and letting `setFrames` resume, or a
        // fresh `willMove` re-add the link) keeps a long scroll session from
        // ticking display links for GIFs nobody can see.
        if window == nil {
            displayLink?.isPaused = true
        } else {
            displayLink?.isPaused = false
        }
    }

    // No `deinit` cleanup here: `CADisplayLink` holds a strong reference to
    // its target, so as long as one is running this view cannot be
    // deallocated anyway. `GIFPlayerView.dismantleUIView` calls `stop()`
    // when SwiftUI tears the view down, which is what actually breaks that
    // cycle and lets deinit run.
}

/// SwiftUI host for `AnimatingImageView`. The single place that actually
/// plays a decoded GIF — used inline in chat, in the GIF picker's previews,
/// and in the fullscreen viewer, so there is exactly one animation
/// implementation to get right rather than three.
struct GIFPlayerView: UIViewRepresentable {
    let frames: [GIFFrame]
    let key: String
    var contentMode: UIView.ContentMode = .scaleAspectFit

    func makeUIView(context: Context) -> AnimatingImageView {
        let view = AnimatingImageView()
        view.contentMode = contentMode
        view.clipsToBounds = true
        return view
    }

    func updateUIView(_ uiView: AnimatingImageView, context: Context) {
        uiView.contentMode = contentMode
        uiView.setFrames(frames, key: key)
    }

    static func dismantleUIView(_ uiView: AnimatingImageView, coordinator: ()) {
        uiView.stop()
    }
}
