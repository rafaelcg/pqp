import SwiftUI

/// Pinch-to-zoom plus an interactive swipe-down-to-dismiss, hosting either a
/// still image or a looping GIF.
///
/// Both gestures live together in one `UIView` on purpose. A `UIScrollView`
/// already owns pinch and its own pan (for moving around once zoomed in);
/// layering a *second*, SwiftUI-level `DragGesture` on top to catch the
/// swipe-to-dismiss would fight the scroll view for the same touches. Doing
/// the dismiss pan as a `UIPanGestureRecognizer` here instead — gated to only
/// fire when the content is at its resting zoom level — sidesteps that
/// entirely.
final class ZoomableMediaView: UIView {
    private let scrollView = UIScrollView()
    private let imageView = AnimatingImageView()
    private var contentSize: CGSize = .zero

    /// Called continuously while dragging to dismiss, with 0 at rest and 1 at
    /// the point release would dismiss — lets the SwiftUI host fade its
    /// backdrop and chrome in step with the finger.
    var onDragProgress: ((CGFloat) -> Void)?
    /// Called once the drag crosses the dismiss threshold on release.
    var onDismiss: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        clipsToBounds = true

        scrollView.delegate = self
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 4
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.bouncesZoom = true
        scrollView.contentInsetAdjustmentBehavior = .never
        addSubview(scrollView)

        imageView.contentMode = .scaleAspectFit
        scrollView.addSubview(imageView)

        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)

        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        pan.delegate = self
        addGestureRecognizer(pan)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    // MARK: - Content

    func configure(image: UIImage) {
        imageView.stop()
        imageView.image = image
        size(for: image.size)
    }

    func configure(frames: [GIFFrame], key: String) {
        imageView.setFrames(frames, key: key)
        if let first = frames.first {
            size(for: CGSize(width: first.image.width, height: first.image.height))
        }
    }

    /// Stops the GIF display link, if any is running. Called when SwiftUI
    /// tears this view down — see `AnimatingImageView`'s note on why that
    /// matters for its `deinit`.
    func stop() {
        imageView.stop()
    }

    private func size(for imageSize: CGSize) {
        guard imageSize.width > 0, imageSize.height > 0 else { return }
        contentSize = imageSize
        imageView.frame = CGRect(origin: .zero, size: imageSize)
        scrollView.contentSize = imageSize
        layoutZoomScale()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        scrollView.frame = bounds
        layoutZoomScale()
    }

    private func layoutZoomScale() {
        guard contentSize.width > 0, contentSize.height > 0, bounds.width > 0, bounds.height > 0 else { return }
        let widthScale = bounds.width / contentSize.width
        let heightScale = bounds.height / contentSize.height
        let fitScale = min(widthScale, heightScale)
        // Preserve an in-progress zoom (e.g. after a rotation) rather than
        // snapping back to fit every layout pass.
        let wasAtFit = scrollView.zoomScale <= scrollView.minimumZoomScale + 0.001
        scrollView.minimumZoomScale = fitScale
        scrollView.maximumZoomScale = fitScale * 4
        if wasAtFit {
            scrollView.zoomScale = fitScale
        }
        centerContent()
    }

    private func centerContent() {
        let boundsSize = scrollView.bounds.size
        var frame = imageView.frame
        frame.origin.x = frame.width < boundsSize.width ? (boundsSize.width - frame.width) / 2 : 0
        frame.origin.y = frame.height < boundsSize.height ? (boundsSize.height - frame.height) / 2 : 0
        imageView.frame = frame
    }

    // MARK: - Gestures

    @objc private func handleDoubleTap(_ gesture: UITapGestureRecognizer) {
        if scrollView.zoomScale > scrollView.minimumZoomScale + 0.001 {
            scrollView.setZoomScale(scrollView.minimumZoomScale, animated: true)
        } else {
            let target = scrollView.maximumZoomScale
            let point = gesture.location(in: imageView)
            let size = CGSize(
                width: scrollView.bounds.width / target,
                height: scrollView.bounds.height / target
            )
            let rect = CGRect(
                x: point.x - size.width / 2,
                y: point.y - size.height / 2,
                width: size.width,
                height: size.height
            )
            scrollView.zoom(to: rect, animated: true)
        }
    }

    /// The distance, in points, a downward drag needs to travel before
    /// release counts as "let go to dismiss" rather than "snap back."
    private let dismissDistance: CGFloat = 140

    @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
        let translation = gesture.translation(in: self)
        switch gesture.state {
        case .began, .changed:
            // Only a downward drag at resting zoom drives the dismiss —
            // anything else is the scroll view panning around a zoomed image.
            guard translation.y > 0, scrollView.zoomScale <= scrollView.minimumZoomScale + 0.001 else {
                resetTransform()
                return
            }
            let progress = min(translation.y / (dismissDistance * 2.5), 1)
            transform = CGAffineTransform(translationX: translation.x * 0.5, y: translation.y)
                .scaledBy(x: 1 - progress * 0.3, y: 1 - progress * 0.3)
            onDragProgress?(progress)
        case .ended, .cancelled:
            let velocity = gesture.velocity(in: self)
            if translation.y > dismissDistance || velocity.y > 1000 {
                onDismiss?()
            } else {
                UIView.animate(withDuration: 0.25, delay: 0, options: .curveEaseOut) {
                    self.resetTransform()
                    self.onDragProgress?(0)
                }
            }
        default:
            resetTransform()
        }
    }

    private func resetTransform() {
        transform = .identity
    }
}

extension ZoomableMediaView: UIScrollViewDelegate {
    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
    func scrollViewDidZoom(_ scrollView: UIScrollView) { centerContent() }
}

extension ZoomableMediaView: UIGestureRecognizerDelegate {
    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        true
    }
}

/// SwiftUI host for `ZoomableMediaView`, showing either a still image or a
/// looping GIF depending on which payload is supplied.
struct ZoomableMedia: UIViewRepresentable {
    enum Payload {
        case image(UIImage)
        case gif(frames: [GIFFrame], key: String)
    }

    let payload: Payload
    var onDragProgress: (CGFloat) -> Void = { _ in }
    var onDismiss: () -> Void = {}

    func makeUIView(context: Context) -> ZoomableMediaView {
        let view = ZoomableMediaView()
        view.onDragProgress = onDragProgress
        view.onDismiss = onDismiss
        apply(payload, to: view)
        return view
    }

    func updateUIView(_ uiView: ZoomableMediaView, context: Context) {
        uiView.onDragProgress = onDragProgress
        uiView.onDismiss = onDismiss
        apply(payload, to: uiView)
    }

    private func apply(_ payload: Payload, to view: ZoomableMediaView) {
        switch payload {
        case .image(let image):
            view.configure(image: image)
        case .gif(let frames, let key):
            view.configure(frames: frames, key: key)
        }
    }

    static func dismantleUIView(_ uiView: ZoomableMediaView, coordinator: ()) {
        uiView.stop()
    }
}
