import UIKit

/// Waits until the app's navigation stacks have stopped moving.
///
/// WHY THIS EXISTS. A link that lands somewhere deep (a jam song: server, then
/// the jam wall, then the song) is several pushes in a row, and the second one
/// is set while the first is still sliding in. An alert raised in that window
/// is presented by the shell's root, and UIKit answers a presentation during a
/// push by quietly dropping the push: the person ended on the server's channel
/// list with the alert on top and the wall they were sent to nowhere in the
/// stack, or on the wall, depending on whether the song read happened to take
/// longer than the animation. "Depending on a race" is what this removes.
///
/// So anything that wants to say something about a link it could not finish
/// (`SessionStore.linkError`) says it after the stack is idle, and the screen
/// the alert lands on is always the one the link got to.
///
/// It reads real state, `UINavigationController.transitionCoordinator`, and
/// does not sleep for a guessed duration. Two idle readings a beat apart are
/// required, because between two pushes in a row there is an instant with no
/// transition at all.
@MainActor
enum NavigationSettle {
    /// How many consecutive idle readings count as "settled".
    static let idleReadingsNeeded = 2
    /// The gap between readings.
    static let readingInterval: Duration = .milliseconds(120)

    /// Returns when no stack is mid-transition, or after `timeout`, whichever
    /// comes first. The timeout is a safety net, never the mechanism: a stack
    /// that never settles must not hold a sentence back for ever.
    static func untilIdle(timeout: Duration = .seconds(2)) async {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        var idle = 0
        while idle < idleReadingsNeeded, clock.now < deadline {
            idle = isTransitioning() ? 0 : idle + 1
            if idle < idleReadingsNeeded {
                try? await Task.sleep(for: readingInterval)
                if Task.isCancelled { return }
            }
        }
    }

    static func isTransitioning() -> Bool {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows {
                if let root = window.rootViewController, isTransitioning(root) { return true }
            }
        }
        return false
    }

    private static func isTransitioning(_ controller: UIViewController) -> Bool {
        if controller.transitionCoordinator != nil { return true }
        if let navigation = controller as? UINavigationController,
           navigation.transitionCoordinator != nil {
            return true
        }
        if controller.children.contains(where: isTransitioning) { return true }
        if let presented = controller.presentedViewController, isTransitioning(presented) {
            return true
        }
        return false
    }
}
