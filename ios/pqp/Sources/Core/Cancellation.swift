import Foundation
import SwiftUI

/// Cancellation is never an error a person should read.
///
/// The bug this exists for: pulling to refresh showed "cancelled" in red.
/// SwiftUI runs a `.refreshable` action in a task it owns, and cancels that
/// task when the scroll view it is attached to leaves the hierarchy or is
/// rebuilt mid-pull (the hub swaps it for a spinner on an empty account; the
/// channel list swaps it for its error state). URLSession answers a cancelled
/// task with `URLError(.cancelled)`, whose `localizedDescription` is the word
/// "cancelled", and `APIClient` used to wrap that in `APIError.transport` like
/// any other network failure. Every catch block in the app then printed it.
///
/// Two halves fix it. `APIClient` turns a cancelled request into
/// `CancellationError` instead of a transport failure, and every place that
/// shows an error asks `userFacingMessage`, which has nothing to say about one.
extension Error {
    /// True when this error only says the work was called off: Swift's own
    /// `CancellationError`, or URLSession's cancelled request in either of its
    /// two spellings (`URLError` and the bridged `NSError`).
    var isCancellation: Bool {
        if self is CancellationError { return true }
        if let url = self as? URLError, url.code == .cancelled { return true }
        let ns = self as NSError
        return ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled
    }

    /// What to show for this error, or nil when there is nothing to show.
    ///
    /// Real failures (offline, a refusal, a 5xx) keep exactly the sentence they
    /// had before: the server's own words for an `APIError`, the system's for
    /// anything else. Only a cancellation is silent.
    var userFacingMessage: String? {
        if isCancellation { return nil }
        return (self as? APIError)?.errorDescription ?? localizedDescription
    }
}

/// Runs a pull-to-refresh where the gesture cannot cancel it.
///
/// `.refreshable` hands its action a task SwiftUI owns, and SwiftUI cancels it
/// whenever the view rebuilds under the pull, so the list often never got the
/// answer it asked for. The work runs in an unstructured task instead, which
/// inherits the main actor but not the caller's cancellation. The gesture still
/// awaits it, so the spinner stays up exactly as long as the fetch does.
enum PullToRefresh {
    @MainActor
    static func run(_ action: @escaping @MainActor () async -> Void) async {
        await Task { @MainActor in await action() }.value
    }
}

extension View {
    /// `.refreshable`, minus the cancellation. See `PullToRefresh`.
    func pullToRefresh(_ action: @escaping @MainActor () async -> Void) -> some View {
        refreshable { await PullToRefresh.run(action) }
    }
}
