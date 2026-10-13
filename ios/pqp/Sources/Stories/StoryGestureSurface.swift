import SwiftUI
import UIKit

/// One transparent view over the canvas that owns every touch on the layers:
/// drag, pinch and twist at the same time, a tap and a long press. It is UIKit
/// because SwiftUI's drag, magnify and rotate gestures cannot be told to run
/// together on a thing chosen at touch-down, and because a pinch whose fingers
/// land beside a small layer (the usual case for one line of text) must still
/// scale it. The layer is chosen once, by the first finger, and keeps the
/// gesture until the last one lifts, the way Instagram's does.
struct StoryGestureSurface: UIViewRepresentable {
    let model: StoryEditorModel
    var isEnabled = true
    let onTap: (String?) -> Void
    let onLongPress: (String) -> Void

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        // Not an accessibility element: the layers underneath are, and a
        // screen reader reaches them directly.
        view.isAccessibilityElement = false

        let pan = UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.pan(_:)))
        pan.maximumNumberOfTouches = 2
        let pinch = UIPinchGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.pinch(_:)))
        let rotation = UIRotationGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.rotation(_:)))
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tap(_:)))
        let press = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.press(_:)))
        press.minimumPressDuration = 0.5
        press.allowableMovement = 8
        for recognizer in [pan, pinch, rotation, tap, press] as [UIGestureRecognizer] {
            recognizer.delegate = context.coordinator
            view.addGestureRecognizer(recognizer)
        }
        tap.require(toFail: press)
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.parent = self
        uiView.gestureRecognizers?.forEach { $0.isEnabled = isEnabled }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: StoryGestureSurface
        private var live = 0
        private var longPressed = false

        init(parent: StoryGestureSurface) { self.parent = parent }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            // Pan, pinch and twist run together; a tap or a press never
            // joins them.
            let movers: [AnyClass] = [UIPanGestureRecognizer.self, UIPinchGestureRecognizer.self, UIRotationGestureRecognizer.self]
            return movers.contains { g.isKind(of: $0) } && movers.contains { other.isKind(of: $0) }
        }

        private func started() { live += 1 }

        private var anyCancelled = false

        private func finished(cancelled: Bool = false) {
            if cancelled { anyCancelled = true }
            live = max(0, live - 1)
            guard live == 0 else { return }
            // A gesture the system interrupted is rolled back, never committed:
            // lifting over the bin deletes, being cut off over it does not.
            if anyCancelled { parent.model.cancelGesture() } else { parent.model.endGesture() }
            anyCancelled = false
        }

        @objc func pan(_ g: UIPanGestureRecognizer) {
            guard let view = g.view else { return }
            switch g.state {
            case .began:
                started()
                // A pan is only recognised after the finger has moved a few
                // points (a fast one, a lot more), so the layer is looked for
                // where the finger WENT DOWN, not where it is now.
                let now = g.location(in: view)
                let moved = g.translation(in: view)
                let down = CGPoint(x: now.x - moved.x, y: now.y - moved.y)
                if parent.model.beginGesture(at: down) {
                    parent.model.drag(translation: CGSize(width: moved.x, height: moved.y), touch: now)
                }
            case .changed:
                parent.model.drag(translation: CGSize(width: g.translation(in: view).x, height: g.translation(in: view).y),
                                  touch: g.location(in: view))
            case .ended:
                finished()
            case .cancelled:
                finished(cancelled: true)
            default: break
            }
        }

        @objc func pinch(_ g: UIPinchGestureRecognizer) {
            guard let view = g.view else { return }
            switch g.state {
            case .began:
                started()
                parent.model.beginGestureOnSelection(at: g.location(in: view))
                parent.model.beginPinch()
            case .changed:
                parent.model.pinch(scale: Double(g.scale))
            case .ended:
                finished()
            case .cancelled:
                finished(cancelled: true)
            default: break
            }
        }

        @objc func rotation(_ g: UIRotationGestureRecognizer) {
            guard let view = g.view else { return }
            switch g.state {
            case .began:
                started()
                parent.model.beginGestureOnSelection(at: g.location(in: view))
                parent.model.beginRotation()
            case .changed:
                parent.model.rotate(by: Double(g.rotation))
            case .ended:
                finished()
            case .cancelled:
                finished(cancelled: true)
            default: break
            }
        }

        @objc func tap(_ g: UITapGestureRecognizer) {
            guard g.state == .ended, let view = g.view else { return }
            let hit = StoryCanvas.topmost(parent.model.layers, sizes: parent.model.sizes, at: g.location(in: view), canvas: parent.model.canvas)
            parent.model.selectedId = hit?.id
            parent.onTap(hit?.id)
        }

        @objc func press(_ g: UILongPressGestureRecognizer) {
            guard g.state == .began, let view = g.view else { return }
            if let hit = StoryCanvas.topmost(parent.model.layers, sizes: parent.model.sizes, at: g.location(in: view), canvas: parent.model.canvas) {
                parent.model.selectedId = hit.id
                parent.onLongPress(hit.id)
            }
        }
    }
}
