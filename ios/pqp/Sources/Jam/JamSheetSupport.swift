import SwiftUI
import UIKit

// WHAT THE EDIT SHEET AND THE ADJUSTER SHARE: a line that stays on screen
// (pinned to an edge of the sheet, never at the end of a scroll view where a
// refused Save is below the fold), the spoken announcement that goes with it,
// and the answer to a swipe down on a sheet that holds unsaved work.

/// A short sentence pinned to a sheet's edge: a refused write, a reason Save is
/// not available, or a note that the take changed elsewhere. Opaque palette
/// colours, one icon, always readable at the largest type (it grows).
struct JamNoticeBar: View {
    enum Tone { case problem, info }

    let text: String
    var tone: Tone = .problem
    var identifier: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: tone == .problem ? "exclamationmark.circle.fill" : "arrow.triangle.2.circlepath")
                .font(JamFont.text(14, .bold))
                .foregroundStyle(tone == .problem ? Palette.danger : Palette.signal)
                .accessibilityHidden(true)
            Text(verbatim: text)
                .font(JamFont.text(13, .semibold))
                .foregroundStyle(Palette.paper)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Palette.surfaceRaised)
        .overlay(alignment: .bottom) { Rectangle().fill(tone == .problem ? Palette.danger : Palette.border).frame(height: 1) }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
        .accessibilityIdentifier(identifier)
    }
}

extension View {
    /// Says a sentence to VoiceOver when it appears or changes (and never when it goes).
    func jamAnnounce(_ text: String?) -> some View {
        onChange(of: text) { _, now in
            guard let now, !now.isEmpty else { return }
            AccessibilityNotification.Announcement(now).post()
        }
    }

    /// `jamAnnounce` for a line that is CREATED when it has something to say (a
    /// refusal that appears, a status that comes up): `onChange` never fires for
    /// the value a view starts with, so it is said once as it appears too.
    func jamAnnounceNow(_ text: String) -> some View {
        onAppear {
            guard !text.isEmpty else { return }
            AccessibilityNotification.Announcement(text).post()
        }
        .jamAnnounce(text)
    }

    /// A sheet that holds unsaved work cannot be swiped away, and the attempt is
    /// answered (with the discard question) instead of being ignored.
    ///
    /// SwiftUI's `interactiveDismissDisabled` turns the swipe off WITHOUT telling
    /// anyone (on iOS 27 neither a delegate call nor `isModalInPresentation` moves),
    /// so the question cannot hear that it was tried. A pan recognizer that watches
    /// the sheet's top edge, where the swipe starts (the navigation bar, which does
    /// not scroll), hears it: a downward drag begun there while the sheet is dirty
    /// is the attempt.
    func jamGuardDismiss(isDirty: Bool, onAttempt: @escaping () -> Void) -> some View {
        interactiveDismissDisabled(isDirty)
            .background(JamDismissGuard(isDirty: isDirty, onAttempt: onAttempt))
    }
}

private struct JamDismissGuard: UIViewControllerRepresentable {
    let isDirty: Bool
    let onAttempt: () -> Void

    func makeCoordinator() -> Watcher { Watcher() }

    func makeUIViewController(context: Context) -> Probe { Probe() }

    func updateUIViewController(_ controller: Probe, context: Context) {
        context.coordinator.isDirty = isDirty
        context.coordinator.onAttempt = onAttempt
        controller.watcher = context.coordinator
        controller.attach()
        DispatchQueue.main.async { [weak controller] in controller?.attach() }
    }

    /// Finds the view of the sheet this lives in and puts the watcher on it.
    final class Probe: UIViewController {
        var watcher: Watcher?

        override func didMove(toParent parent: UIViewController?) {
            super.didMove(toParent: parent)
            attach()
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            attach()
        }

        func attach() {
            guard let watcher else { return }
            // The top of this controller's ancestors is the sheet's own hosting controller
            // (a child's `presentationController` answers with this probe as "presented"),
            // and its view is the whole sheet; this probe's view is an empty point.
            var top: UIViewController = self
            while let above = top.parent { top = above }
            guard top !== self, top.isViewLoaded else { return }
            watcher.attach(to: top.view)
        }
    }

    final class Watcher: NSObject, UIGestureRecognizerDelegate {
        var isDirty = false
        var onAttempt: () -> Void = {}

        private weak var host: UIView?
        private var pan: UIPanGestureRecognizer?
        private var startY: CGFloat = 0
        private var fired = false

        /// The top of the sheet that a swipe down starts in: the navigation bar.
        private static let grabZone: CGFloat = 130
        private static let distance: CGFloat = 40

        func attach(to view: UIView) {
            guard host !== view else { return }
            if let pan, let old = pan.view { old.removeGestureRecognizer(pan) }
            let recognizer = UIPanGestureRecognizer(target: self, action: #selector(handle(_:)))
            recognizer.delegate = self
            recognizer.cancelsTouchesInView = false
            view.addGestureRecognizer(recognizer)
            pan = recognizer
            host = view
        }

        @objc private func handle(_ recognizer: UIPanGestureRecognizer) {
            switch recognizer.state {
            case .began:
                startY = recognizer.location(in: recognizer.view).y
                fired = false
            case .changed:
                guard isDirty, !fired, startY < Self.grabZone,
                      recognizer.translation(in: recognizer.view).y > Self.distance else { return }
                fired = true
                onAttempt()
            default:
                break
            }
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool { true }
    }
}
