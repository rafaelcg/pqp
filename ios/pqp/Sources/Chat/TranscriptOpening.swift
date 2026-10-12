import SwiftUI

/// How a channel's transcript appears when it opens: already on its latest
/// message, never scrolling there in front of the reader.
///
/// The positioning itself is `ChatView.positionTranscript` (a scroll needs the
/// view's proxy); this is the part that is a rule rather than a gesture, kept
/// here so it can be tested without a screen.
enum TranscriptOpening {
    /// Longest the list is held invisible while it waits for something to put
    /// on screen. A cached channel is positioned in a frame or two and never
    /// gets near this; it exists so a path that never positions (a refused
    /// fetch, a page that never comes) still ends on a drawn screen, error
    /// row and all, rather than a blank one.
    static let maxHold: Duration = .milliseconds(1200)

    /// Whether the transcript is drawn at opacity zero right now.
    ///
    /// Hidden only between "there are messages, or there may be" and "they
    /// have been put on the tail". A forum post is never held: it lands on its
    /// question or its first unread through `ForumLanding`, which has its own
    /// path, and its header is meant to be seen while that runs. An empty
    /// channel that has finished loading is drawn at once, because its empty
    /// state IS the content.
    static func isHidden(
        isForumPost: Bool,
        positioned: Bool,
        hasMessages: Bool,
        isLoading: Bool,
        holdExpired: Bool
    ) -> Bool {
        if isForumPost || positioned || holdExpired { return false }
        if !hasMessages && !isLoading { return false }
        return true
    }
}

/// Keeps a chat transcript pinned to its bottom edge through layout changes,
/// where the system can do that itself (iOS 18).
///
/// TWO ROLES, NOT THE ONE-ARGUMENT FORM. `.initialOffset` makes the very first
/// layout start at the bottom, and `.sizeChanges` keeps the bottom where it is
/// while the lazy stack swaps its estimated row heights for measured ones, a
/// picture with no declared size arrives, or the keyboard shrinks the view.
/// The third role, `.alignment`, is deliberately left out: it would push a
/// short channel's three messages down against the composer, which is a
/// different look and not what this is fixing.
///
/// iOS 17 has only the one-argument form, which includes that alignment, so
/// it gets nothing here and relies on `ChatView.positionTranscript` alone.
struct TranscriptBottomAnchor: ViewModifier {
    let enabled: Bool

    func body(content: Content) -> some View {
        if enabled, #available(iOS 18.0, *) {
            content
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .defaultScrollAnchor(.bottom, for: .sizeChanges)
        } else {
            content
        }
    }
}
